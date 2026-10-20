import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactToolCallArgumentsValue } from '../../../runtime/agent/orchestrator/session/compact/text-utils.mjs';

const states = new Set(['pending', 'starting', 'running', 'waiting', 'review', 'completed', 'rejected', 'cancelled', 'cancelling', 'failed', 'uncertain']);
const live = new Set(['starting', 'running', 'waiting', 'cancelling', 'uncertain']);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export { jobHandoff } from './job-contract.mjs';
function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) fail(400, `${label}을 확인해 주세요.`);
  return redactToolCallArgumentsValue(value.trim());
}
function request(input) {
  return { goal: text(input.goal, 20_000, '작업 목표'), checks: text(input.checks, 10_000, '완료 검증 방법'),
    constraints: text(input.constraints || '승인 범위 밖 작업·커밋·배포·설치·권한 변경은 별도 승인 없이 수행하지 않습니다.', 10_000, '작업 제한') };
}
import { jobHandoff } from './job-contract.mjs';

export async function createHubJobs({ file, runner, authorize, admin, notify, now = Date.now }) {
  let rows = [];
  try {
    rows = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(rows) || rows.some((row) => !row.id || !row.teamId || !row.userId || !row.sessionId
      || !Number.isSafeInteger(row.revision) || !states.has(row.status) || !Array.isArray(row.history))) {
      throw new Error('공유실 작업 저장 형식이 다릅니다. 원본 파일은 보존됩니다.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let chain = Promise.resolve();
  const locked = (operation) => { const result = chain.then(operation); chain = result.catch(() => {}); return result; };
  const put = async (row) => {
    const next = rows.filter((value) => value.id !== row.id).concat(row);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      rows = next;
    } finally { await fs.rm(temporary, { force: true }); }
    return row;
  };
  const change = (row, patch) => put({ ...row, ...patch, revision: row.revision + 1, updatedAt: now(),
    history: patch.status && patch.status !== row.status
      ? [...row.history, { status: patch.status, at: now() }] : row.history });
  const signedIn = async (person) => {
    if (!person || !await authorize(person)) fail(403, '현재 승인된 계정으로 로그인해 주세요.');
  };
  const get = async (person, id, administrator = false) => {
    await signedIn(person);
    if (administrator && !admin(person)) fail(403, '관리자 승인이 필요한 작업입니다.');
    const row = rows.find((value) => value.id === id && value.teamId === person.teamId
      && (admin(person) || value.userId === person.userId));
    if (!row || !await authorize({ teamId: row.teamId, userId: row.userId })) fail(404, '조회할 수 있는 작업이 아닙니다.');
    return row;
  };
  const version = (row, input) => {
    if (input.revision !== row.revision) fail(409, '작업이 변경됐습니다. 다시 불러와 검토해 주세요.');
  };
  const view = (row, administrator) => {
    const value = {
      id: row.id, sessionId: row.sessionId, teamId: row.teamId, userId: row.userId, userName: row.userName,
      goal: row.goal, checks: row.checks, constraints: row.constraints, status: row.status, revision: row.revision,
      createdAt: row.createdAt, updatedAt: row.updatedAt, history: row.history,
      summary: row.summary || '', files: row.files || [],
      notification: row.notification, recording: row.recording,
    };
    if (administrator) Object.assign(value, {
      projectPath: row.projectPath || '', approvedBy: row.approvedBy, approvedRevision: row.approvedRevision,
      executionSessionId: row.executionSessionId, result: row.result, pendingApproval: row.pendingApproval,
      handoff: row.approvedBy ? jobHandoff(row) : null,
    });
    return structuredClone(value);
  };
  const deliver = async (row, event) => {
    row = await change(row, { notification: { status: 'sending', event } });
    let status = 'unavailable';
    if (notify) {
      try {
        const receipt = await notify(structuredClone(row), event);
        status = receipt?.sent === true ? 'sent' : receipt?.queued === true ? 'queued' : 'uncertain';
      } catch { status = 'uncertain'; }
    }
    return change(row, { notification: { status, event } });
  };
  const audit = async (row) => {
    if (!row.executionSessionId) return change(row, { recording: { status: 'local_only' } });
    row = await change(row, { recording: { status: 'writing' } });
    let recording;
    try {
      const receipt = await runner.record(structuredClone(row));
      if (receipt?.recorded !== true || !Number.isSafeInteger(receipt.caseId) || receipt.caseId <= 0) throw new Error('Unconfirmed record');
      recording = { status: 'saved', caseId: receipt.caseId };
    } catch { recording = { status: 'failed' }; }
    return change(row, { recording });
  };
  const stop = async (row) => {
    if (!live.has(row.status)) return change(row, { status: 'cancelled', pendingApproval: null });
    row = await change(row, { status: 'cancelling', pendingApproval: null });
    try {
      if (row.executionSessionId) await runner.abort(structuredClone(row));
    } catch { /* A failed stop is not evidence of termination. */ }
    // An abort receipt acknowledges the request, not the terminal turn state.
    return row;
  };
  // A crash during a dispatch or write must never cause an automatic replay.
  for (const row of [...rows]) {
    const patch = {};
    if (row.status === 'starting') patch.status = 'uncertain';
    if (row.notification?.status === 'sending') patch.notification = { ...row.notification, status: 'uncertain' };
    if (row.recording?.status === 'writing') patch.recording = { status: 'uncertain' };
    if (Object.keys(patch).length) await change(row, patch);
  }
  return {
    idle: () => chain,
    list: async (person) => {
      await signedIn(person);
      const result = [];
      for (const row of rows) {
        if (row.teamId === person.teamId && (admin(person) || row.userId === person.userId)
          && await authorize({ teamId: row.teamId, userId: row.userId })) result.push(view(row, admin(person)));
      }
      return result;
    },
    get: async (person, id) => view(await get(person, id), admin(person)),
    create: (person, owner, input) => locked(async () => {
      await signedIn(person);
      if (owner.teamId !== person.teamId || (owner.userId !== person.userId && !admin(person))
        || !await authorize(owner)) fail(404, '조회할 수 있는 세션이 아닙니다.');
      const row = await put({
        id: randomUUID(), sessionId: owner.id, teamId: owner.teamId, userId: owner.userId, userName: owner.userName,
        channelId: owner.channelId, threadTs: owner.threadTs, ...request(input),
        status: 'pending', revision: 1, createdAt: now(), updatedAt: now(),
        history: [{ status: 'pending', at: now() }],
        notification: { status: 'not_started' }, recording: { status: 'local_only' },
      });
      return view(await deliver(row, 'requested'), admin(person));
    }),
    revise: (person, id, input) => locked(async () => {
      const row = await get(person, id);
      version(row, input);
      if (row.userId !== person.userId || row.status !== 'pending') fail(409, '본인의 승인 대기 요청만 수정할 수 있습니다.');
      return view(await change(row, request(input)), admin(person));
    }),
    approve: (person, id, input) => locked(async () => {
      let row = await get(person, id, true);
      version(row, input);
      if (row.status !== 'pending') fail(409, '이미 처리된 요청입니다. 자동 재실행하지 않습니다.');
      if (input.confirm !== true) fail(400, '작업 범위와 실행 프로젝트를 검토하고 명시적으로 승인해 주세요.');
      let projectPath;
      try {
        if (typeof input.projectPath !== 'string' || !path.isAbsolute(input.projectPath)) throw new Error('Absolute path required');
        projectPath = await fs.realpath(input.projectPath);
        if (projectPath === path.parse(projectPath).root || !(await fs.stat(projectPath)).isDirectory()) throw new Error('Project directory required');
      } catch { fail(400, '실행 PC의 실제 프로젝트 디렉터리 절대 경로가 필요합니다.'); }
      row = await change(row, { status: 'starting', projectPath, approvedBy: { teamId: person.teamId, userId: person.userId },
        approvedRevision: row.revision, approvedAt: now() });
      try {
        const prepared = await runner.prepare(structuredClone(row));
        if (!prepared?.sessionId || prepared.sessionId === row.sessionId) throw new Error('Separate execution session required');
        row = await change(row, { executionSessionId: prepared.sessionId });
      } catch {
        row = await change(row, { status: 'failed', summary: '관리자 실행 환경을 시작하지 못했습니다. 다른 실행 경로로 대체하지 않았습니다.' });
        return view(await deliver(await audit(row), 'failed'), true);
      }
      try {
        const receipt = await runner.submit(structuredClone(row));
        row = await change(row, { status: receipt?.accepted === true ? 'running' : 'failed',
          ...(receipt?.accepted === true ? {} : { summary: '실행 세션이 작업을 접수하지 않았습니다.' }) });
      } catch {
        row = await change(row, { status: 'uncertain', summary: '접수 상태가 불확실합니다. 자동으로 다시 실행하지 않습니다.' });
      }
      if (row.status === 'failed') row = await audit(row);
      return view(await deliver(row, row.status), true);
    }),
    reject: (person, id, input) => locked(async () => {
      let row = await get(person, id, true);
      version(row, input);
      if (row.status !== 'pending') fail(409, '승인 대기 요청만 거절할 수 있습니다.');
      row = await change(row, { status: 'rejected', summary: text(input.summary, 5_000, '거절 사유') });
      return view(await deliver(row, 'rejected'), true);
    }),
    cancel: (person, id, input) => locked(async () => {
      let row = await get(person, id);
      version(row, input);
      if (!['pending', 'review', ...live].includes(row.status)) fail(409, '이미 종료된 작업입니다.');
      row = await stop(row);
      return view(await deliver(row, row.status), admin(person));
    }),
    toolDecision: (person, id, input) => locked(async () => {
      const row = await get(person, id, true);
      version(row, input);
      if (row.status !== 'waiting' || !row.pendingApproval || input.approvalId !== row.pendingApproval.id
        || typeof input.approved !== 'boolean') fail(409, '현재 작업의 정확한 승인 요청을 확인해 주세요.');
      if ((await runner.approve(structuredClone(row), person, input))?.accepted !== true) fail(409, '도구 승인이 적용되지 않았습니다.');
      return view(await change(row, { status: 'running', pendingApproval: null }), true);
    }),
    complete: (person, id, input) => locked(async () => {
      let row = await get(person, id, true);
      version(row, input);
      if (row.status !== 'review' || input.confirm !== true) fail(409, '실행 결과와 검증을 확인한 작업만 완료할 수 있습니다.');
      const ids = input.fileIds || [];
      if (!Array.isArray(ids) || ids.some((id) => !row.result.files.some((file) => file.id === id && file.downloadable !== false))) {
        fail(400, '확인된 산출물만 공개할 수 있습니다.');
      }
      row = await change(row, { status: 'completed', summary: text(input.summary, 20_000, '검토한 공개 결과'),
        files: row.result.files.filter((file) => ids.includes(file.id)), verifiedBy: { teamId: person.teamId, userId: person.userId } });
      return view(await deliver(await audit(row), 'completed'), true);
    }),
    file: async (person, id, fileId, sha256) => {
      const row = await get(person, id);
      if (row.status !== 'completed' || !row.files?.some((file) => file.id === fileId && file.sha256 === sha256)) {
        fail(404, '공개된 작업 산출물이 아닙니다.');
      }
      return runner.file(structuredClone(row), fileId, sha256);
    },
    refresh: () => locked(async () => {
      for (const row of [...rows].filter((value) => ['queued', 'uncertain'].includes(value.notification?.status))) {
        if (!notify || !await authorize({ teamId: row.teamId, userId: row.userId })) continue;
        try {
          const receipt = await notify(structuredClone(row), row.notification.event, true);
          const status = receipt?.sent === true ? 'sent' : receipt?.queued === true ? 'queued' : 'uncertain';
          if (status !== row.notification.status) await change(row, { notification: { ...row.notification, status } });
        } catch { /* Leave the unconfirmed delivery visible; do not resend. */ }
      }
      for (let row of [...rows].filter((value) => live.has(value.status))) {
        if (!await authorize({ teamId: row.teamId, userId: row.userId })
          || !row.approvedBy || !admin(row.approvedBy) || !await authorize(row.approvedBy)) {
          if (row.status !== 'cancelling') row = await deliver(await stop(row), 'access_revoked');
        }
        if (!row.executionSessionId) continue;
        try {
          const result = await runner.inspect(structuredClone(row));
          if (!['running', 'waiting', 'review', 'failed', 'cancelled', 'uncertain'].includes(result.status)) throw new Error('Invalid execution state');
          // Cancellation is not completed until the process reports termination.
          if (row.status === 'cancelling' && !['review', 'failed', 'cancelled'].includes(result.status)) continue;
          const status = row.status === 'cancelling' ? 'cancelled' : result.status;
          const patch = { status, pendingApproval: result.pendingApproval || null,
            summary: status === 'failed' ? '실행이 정상 완료되지 않았습니다. 관리자에게 결과 확인이 필요합니다.'
              : status === 'cancelled' ? '실행 턴의 종료를 확인하여 취소 처리했습니다.' : '',
            ...(result.result ? { result: result.result } : {}) };
          if (Object.entries(patch).every(([key, value]) => JSON.stringify(row[key] ?? null) === JSON.stringify(value))) continue;
          const previous = row.status;
          row = await change(row, patch);
          if (['review', 'failed', 'cancelled'].includes(status) && previous !== status) {
            if (status !== 'review') row = await audit(row);
            await deliver(row, status);
          }
        } catch {
          if (row.status !== 'uncertain' && row.status !== 'cancelling') await change(row, { status: 'uncertain' });
        }
      }
    }),
  };
}
