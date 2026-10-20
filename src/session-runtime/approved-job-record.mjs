import { normalizeToolEnvelope } from '../runtime/agent/orchestrator/session/tool-envelope.mjs';
import { redactToolCallArgumentsValue } from '../runtime/agent/orchestrator/session/compact/text-utils.mjs';

// A deliberately narrow local-runtime API, not an arbitrary MCP proxy. Slack
// sessions cannot use it, and no repository lists or backend errors escape it.
export async function recordApprovedJob({ session, scopeId, input, execute, save }) {
  if (!session?.id || session.slackExecutionPolicy) throw new Error('관리자 실행 세션에서만 작업 이력을 기록할 수 있습니다.');
  if (!input || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.jobId || '')
    || !['completed', 'failed', 'cancelled'].includes(input.status)) {
    throw new Error('관리자 작업 기록의 식별자와 결과를 확인해 주세요.');
  }
  const clean = (value, maximum) => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
      throw new Error('관리자 작업 기록의 내용을 확인해 주세요.');
    }
    return redactToolCallArgumentsValue(value.trim());
  };
  const goal = clean(input.goal, 20_000), checks = clean(input.checks, 10_000);
  const summary = clean(input.summary || '실행이 성공적으로 완료되지 않았습니다.', 20_000);
  const requester = clean(input.requester, 100), approvedBy = clean(input.approvedBy, 100);
  const previous = session.approvedJobAudit;
  if (previous) {
    if (previous.jobId === input.jobId && previous.status === 'saved') return { recorded: true, caseId: previous.caseId };
    throw new Error('작업 기록의 이전 전송 상태를 확인해야 합니다. 자동 재전송하지 않습니다.');
  }
  session.approvedJobAudit = { jobId: input.jobId, status: 'writing' };
  await save(session);
  const call = async (name, args) => {
    const envelope = normalizeToolEnvelope(await execute(`mcp__worktrail__${name}`, args, {
      scopeId, ownerKey: session.id,
    }));
    if (envelope.explicitFailure || envelope.result?.isError === true || envelope.result?.ok === false || envelope.result?.error
      || /^(?:casebook error:|Error:)/imu.test(String(envelope.result))) {
      throw new Error('Worktrail 저장 결과를 확인하지 못했습니다.');
    }
    return envelope.result;
  };
  try {
    const title = `SOFTON 관리자 작업 ${input.jobId}`;
    const context = JSON.parse(await call('list_threads', { worktree: session.cwd, facts: { client: 'Mixdog Personal' } }));
    if (!context.repo || !context.worktree || !Array.isArray(context.threads)) throw new Error('Invalid worktree context');
    let matches = context.threads.filter((thread) => thread.title === title);
    if (!matches.length) {
      await call('open_thread', { worktree: session.cwd, topic: 'Mixdog Personal', title,
        focus: `${title}\n\n관리자가 인수한 요청을 실행하고 검증 결과를 기록한다.`,
        facts: { client: 'Mixdog Personal', jobId: input.jobId } });
      const opened = JSON.parse(await call('list_threads', { worktree: session.cwd }));
      if (opened.repo !== context.repo || opened.worktree !== context.worktree || !Array.isArray(opened.threads)) {
        throw new Error('Worktree context changed');
      }
      matches = opened.threads.filter((thread) => thread.title === title);
    }
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].case_id) || matches[0].case_id <= 0) {
      throw new Error('Unique job thread required');
    }
    const caseId = matches[0].case_id;
    await call('note_turn', {
      case_id: caseId, kind: input.status === 'completed' ? 'verified' : 'finding',
      observed: `관리자 작업의 요청과 실제 결과\n\n요청자: ${requester}\n���인자: ${approvedBy}\n요청: ${goal}\n검증 기준: ${checks}\n실제 상태: ${input.status}\n관리자가 검토한 결과: ${summary}`,
      conclusion: `관리자 작업 결과\n\n${input.status === 'completed' ? '관리자가 실행과 검증 결과를 확인했다.' : '요청과 실행 결과를 구분하며 성공으로 처리하지 않았다.'}`,
      next: '관리자가 후속 작업 필요 여부를 판단한다\n\n추가 변경·배포는 별도 승인 없이 수행하지 않는다.',
      owner: 'user', client: 'Mixdog Personal',
    });
    if (input.status === 'completed') await call('close_thread', { case_id: caseId, result: `관리자 작업 검증 완료\n\n${summary}` });
    session.approvedJobAudit = { jobId: input.jobId, status: 'saved', caseId };
    await save(session);
    return { recorded: true, caseId };
  } catch {
    session.approvedJobAudit = { jobId: input.jobId, status: 'uncertain' };
    await save(session);
    throw new Error('작업 이력 저장을 확인하지 못했습니다. 작업 실행 결과와 별도로 확인해야 합니다.');
  }
}
