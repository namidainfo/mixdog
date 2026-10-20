import assert from 'node:assert/strict';
import test from 'node:test';
import { recordApprovedJob } from './approved-job-record.mjs';

const jobId = '550e8400-e29b-41d4-a716-446655440000';
const input = { jobId, requester: 'T1:U1', approvedBy: 'T1:UA', status: 'completed',
  goal: '계산 코드 작성', checks: '독립 factorial 비교', summary: '계산과 검증을 완료했다.' };
function fixture() {
  const session = { id: 'execution-session', cwd: 'C:\\Projects\\internal' }, calls = [], saves = [];
  let opened = false;
  const execute = async (name, args, options) => {
    calls.push({ name, args, options });
    if (name === 'mcp__worktrail__list_threads') return JSON.stringify({
      repo: 'internal/repo', worktree: '/mnt/c/Projects/internal',
      threads: opened ? [{ case_id: 99, title: `SOFTON 관리자 작업 ${jobId}` }] : [],
    });
    if (name === 'mcp__worktrail__open_thread') opened = true;
    return 'stored';
  };
  return { session, calls, saves, options: { session, input, scopeId: 'scope', execute, save: async (value) => saves.push(structuredClone(value)) } };
}
test('runtime owns recording context and confirms the scoped thread without agent shell/WSL calls', async () => {
  const h = fixture(), result = await recordApprovedJob(h.options);
  assert.deepEqual(result, { recorded: true, caseId: 99 });
  assert.equal(h.saves[0].approvedJobAudit.status, 'writing');
  assert.equal(h.session.approvedJobAudit.status, 'saved');
  assert.ok(h.calls.every(({ name }) => name.startsWith('mcp__worktrail__')));
  assert.ok(h.calls.every(({ options }) => options.scopeId === 'scope' && options.ownerKey === 'execution-session'));
  assert.equal(h.calls[0].args.worktree, 'C:\\Projects\\internal');
  assert.match(h.calls.find(({ name }) => name.endsWith('__note_turn')).args.observed, /요청: 계산 코드 작성/);
  const count = h.calls.length;
  assert.deepEqual(await recordApprovedJob(h.options), result);
  assert.equal(h.calls.length, count);
});
test('ordinary Slack sessions and unconfirmed MCP results never claim record success', async () => {
  const denied = fixture();
  denied.session.slackExecutionPolicy = { admin: false };
  await assert.rejects(recordApprovedJob(denied.options), /관리자 실행 세션/);
  assert.equal(denied.calls.length, 0);
  const failed = fixture();
  failed.options.execute = async () => { throw new Error('server unavailable with private details'); };
  await assert.rejects(recordApprovedJob(failed.options), /작업 이력 저장/);
  assert.equal(failed.session.approvedJobAudit.status, 'uncertain');
  await assert.rejects(recordApprovedJob(failed.options), /자동 재전송하지/);
});
test('backend identity changes and explicit error text block success without leaking repository lists', async () => {
  const h = fixture(), original = h.options.execute;
  let lists = 0;
  h.options.execute = async (name, args, options) => {
    const result = await original(name, args, options);
    if (name.endsWith('__list_threads') && ++lists === 2) return JSON.stringify({ repo: 'different', worktree: '/other', threads: [] });
    return result;
  };
  await assert.rejects(recordApprovedJob(h.options), (error) => /작업 이력 저장/u.test(error.message) && !error.message.includes('/other'));
  const errored = fixture();
  errored.options.execute = async () => 'casebook error: denied';
  await assert.rejects(recordApprovedJob(errored.options), /작업 이력 저장/);
});
