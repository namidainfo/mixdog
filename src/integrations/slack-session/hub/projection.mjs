import { redactToolCallArgumentsValue } from '../../../runtime/agent/orchestrator/session/compact/text-utils.mjs';
import { recordLabel, recordTypes } from './records.mjs';
import { parseToolArgs, normalizeToolName } from '../../../runtime/shared/tool-primitives.mjs';

const text = (value) => typeof value === 'string' ? redactToolCallArgumentsValue(value) : '';
const heading = (value) => value.split(/\r?\n/u).find((line) => line.trim()) || '내용 없음';
export function successfulToolItems(items) {
  return items.flatMap((item) => item.aggregate === true && Array.isArray(item.toolMembers)
    ? item.toolMembers.map((member, index) => ({ ...member, kind: 'tool', id: member.id ?? `${item.id}:${index}` }))
    : [item]).filter((item) => item.kind === 'tool'
      && (item.completedAt != null || (item.completedCount === undefined
        ? item.result != null || item.rawResult != null : item.completedCount >= (item.count || 1)))
      && !item.isError && !item.isCallError && !item.isExitError
      && item.result?.isError !== true && item.rawResult?.isError !== true
      && !Number(item.errorCount) && !Number(item.callErrorCount) && !Number(item.exitErrorCount)
      && !/^(?:casebook error:|Error:)/imu.test(String(item.result ?? item.rawResult ?? '')));
}
function resultRecords(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') {
    try { return resultRecords(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (typeof value !== 'object' || value.isError === true || value.ok === false || value.error) return [];
  if (value.structuredContent) return resultRecords(value.structuredContent, depth + 1);
  if (Array.isArray(value.content)) return value.content.flatMap((part) =>
    part.type === 'text' ? resultRecords(part.text, depth + 1) : []);
  return [value];
}
export function producedPaths(items) {
  const paths = new Set();
  for (const item of successfulToolItems(items)) {
    const name = normalizeToolName(item.name), args = parseToolArgs(item.args);
    const patch = args.patch ?? args.value;
    if (name === 'apply_patch' && typeof patch === 'string') {
      let target = null;
      for (const line of patch.split(/\r?\n/u)) {
        const header = /^\*\*\* (Add File|Update File|Move to|Delete File): (.+)$/u.exec(line);
        if (!header) continue;
        if (header[1] === 'Move to' && target) paths.delete(target);
        target = header[2].trim();
        if (header[1] === 'Delete File') paths.delete(target); else paths.add(target);
      }
    }
    if (name === 'edit' && typeof args.file_path === 'string') paths.add(args.file_path);
    const action = typeof item.args === 'object' ? item.args?.action : args.action;
    if (name === 'visualize' && action === 'export' && typeof args.output === 'string') paths.add(args.output);
    // Only structured receipts for authored artifacts; never guess paths from prose.
    if (['office', 'media', 'visualize'].includes(name)) {
      for (const result of resultRecords(item.result ?? item.rawResult)) {
        if (['running', 'failed', 'canceled', 'cancelled'].includes(result.status)) continue;
        for (const artifact of result.artifacts || []) {
          if (['create', 'edit'].includes(artifact.operation) && typeof artifact.path === 'string') paths.add(artifact.path);
        }
        if (result.ok === true && (result.status === 'done' || (name === 'media' && result.status === undefined))
          && typeof result.output === 'string') paths.add(result.output);
        if (name === 'visualize' && args.action === 'export' && typeof result.path === 'string') paths.add(result.path);
      }
    }
  }
  return [...paths];
}
export function projectHubState(state) {
  const records = [];
  for (const item of successfulToolItems(state.items || [])) {
    const match = /^(?:functions\.)?mcp__worktrail__(note_turn|decide|declare|constrain|rule_out|define|open_thread|close_thread)$/u.exec(item.name || '');
    if (!match) continue;
    const args = parseToolArgs(item.args), action = match[1];
    const kind = action === 'note_turn' || action === 'declare' ? args.kind : {
      decide: 'decision', constrain: 'constraint', rule_out: 'ruled_out',
      define: 'term', open_thread: 'opened', close_thread: 'closed',
    }[action];
    if (!Object.hasOwn(recordTypes, kind)) continue;
    const body = text(args.observed || args.statement || args.result || args.first_input || args.meaning || args.title);
    records.push({ id: String(item.callId || item.id), kind, label: recordLabel(kind),
      title: heading(body), body, conclusion: text(args.conclusion), next: text(args.next),
      owner: text(args.owner), at: item.completedAt ?? item.startedAt ?? null });
  }
  const messages = (state.items || []).filter((item) =>
    ['user', 'assistant', 'error'].includes(item.kind) && item.streaming !== true && item.channel !== 'analysis'
  ).map((item) => {
    let body = text(item.text);
    if (item.kind === 'user' && /^\[Slack request slack:/u.test(body)) {
      const marker = '\n[현재 사용자 요청]\n', start = body.indexOf(marker);
      if (start >= 0) body = body.slice(start + marker.length).split('\n[사용자가 이 요청에 첨부한 파일')[0];
    }
    return { id: String(item.messageId || item.id), by: item.kind, text: body, at: item.at ?? item.createdAt ?? null };
  });
  const lastTurn = (state.items || []).findLast((item) => item.kind === 'turndone');
  return { id: state.sessionId, cwd: state.cwd, messages, records,
    state: state.toolApproval || state.userQuestion ? 'waiting' : state.busy ? 'running'
      : lastTurn?.status === 'done' ? 'done' : lastTurn ? 'error' : 'idle',
    waitingFor: state.toolApproval ? '도구 승인' : state.userQuestion ? '사용자 답변' : null,
    producedPaths: producedPaths(state.items || []) };
}
export function composeSessionDocument(snapshot) {
  const notes = ['change', 'verified', 'finding'].map((kind) => snapshot.records.findLast((record) => record.kind === kind)).filter(Boolean);
  const directions = snapshot.records.filter((record) => !['change', 'verified', 'finding'].includes(record.kind));
  return [`# ${snapshot.title}`, '', `출처: SOFTON 세션 ${snapshot.id} · ${snapshot.userName}`,
    `조회 시점: ${snapshot.updatedAt}`, `세션 상태: ${snapshot.state}`, '',
    '세션에서 저장 성공이 확인된 최근 바꿈·확인·발견 각 1건과 최근 방향·판단 6건을 정리한 초안입니다. 아래 판단은 검증 결과와 구분합니다.',
    '', '## 작업 및 확인 기록',
    ...(notes.length ? notes.flatMap((record) => [`### ${recordLabel(record.kind)} · ${record.title}`, record.body, record.conclusion, ''])
      : ['확인된 작업·검증 기록이 없습니다. 원문을 검토해 보완해 주세요.', '']),
    '## 방향 및 미검증 판단',
    ...directions.slice(-6).flatMap((record) => [`### ${recordLabel(record.kind)} · ${record.title}`, record.body, record.conclusion, '']),
    '', '## 산출물', ...snapshot.files.map((file) => `- ${file.path}`),
    '', '## 다음 작업', (() => {
      const next = snapshot.records.findLast((record) => record.kind === 'next' || record.next);
      return (next?.kind === 'next' ? next.body : next?.next) || '다음 작업이 기록되지 않았습니다.';
    })(),
  ].filter((value) => value !== undefined).join('\n');
}
