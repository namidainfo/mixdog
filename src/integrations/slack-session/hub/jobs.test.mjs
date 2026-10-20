import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHubJobs, jobHandoff } from './jobs.mjs';

const user = { teamId: 'T1', userId: 'U1' }, other = { teamId: 'T1', userId: 'U2' };
const administrator = { teamId: 'T1', userId: 'UA' };
const input = { goal: '1부터 50까지 곱하는 Python 코드를 작성하고 실행', checks: '독립적인 factorial 계산과 결과를 비교' };
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-approved-jobs-'));
  // Windows can briefly retain a renamed directory entry after the last write.
  // Retry cleanup once; a persistent error still fails the test.
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 }));
  const calls = [], approved = new Set(['T1:U1', 'T1:U2', 'T1:UA', 'T2:U1']);
  let execution = { status: 'running' };
  const runner = {
    prepare: async (job) => { calls.push(['prepare', job]); return { sessionId: 'execution-1' }; },
    submit: async (job) => { calls.push(['submit', job]); return { accepted: true }; },
    inspect: async () => execution,
    abort: async () => { calls.push(['abort']); return { aborted: true }; },
    approve: async (_job, actor, decision) => { calls.push(['approve', actor, decision]); return { accepted: true }; },
    record: async () => ({ recorded: true, caseId: 42 }),
    file: async () => ({ data: Buffer.from('result').toString('base64') }),
    ...overrides.runner,
  };
  const options = {
    file: path.join(directory, 'jobs.json'), runner,
    authorize: async (person) => approved.has(`${person.teamId}:${person.userId}`),
    admin: (person) => person.teamId === 'T1' && person.userId === 'UA',
    notify: async (job, event) => { calls.push(['notice', job.id, event]); return { sent: true }; },
    ...overrides, runner,
  };
  const jobs = await createHubJobs(options);
  const create = () => jobs.create(user, { ...user, id: 'source-1', userName: '요청자', channelId: 'C1', threadTs: '1' }, input);
  const accept = (job) => jobs.approve(administrator, job.id, { revision: job.revision, projectPath: directory, confirm: true });
  return { jobs, create, accept, calls, directory, options, approved, execution: (value) => { execution = value; } };
}

test('requests cannot self-approve, forge identity or cross user/team boundaries', async (t) => {
  const h = await fixture(t), job = await h.create();
  assert.equal(job.status, 'pending');
  assert.equal(h.calls.some(([kind]) => kind === 'prepare'), false);
  await assert.rejects(h.jobs.approve({ ...user, admin: true }, job.id, { revision: job.revision, confirm: true, projectPath: h.directory }), /관리자/);
  for (const actor of [other, { teamId: 'T2', userId: 'U1' }]) {
    assert.deepEqual(await h.jobs.list(actor), []);
    await assert.rejects(h.jobs.get(actor, job.id), /조회/);
  }
  await assert.rejects(h.jobs.create(user, { ...other, id: 'another' }, input), /조회/);
  h.approved.delete('T1:U1');
  await assert.rejects(h.jobs.get(administrator, job.id), /조회/);
});

test('revision-bound approval starts a separate session once and survives restart without replay', async (t) => {
  const h = await fixture(t), original = await h.create();
  const revised = await h.jobs.revise(user, original.id, { ...input, goal: '수정된 목표', revision: original.revision });
  await assert.rejects(h.accept(original), /변경/);
  await assert.rejects(h.jobs.approve(administrator, revised.id, { revision: revised.revision, projectPath: h.directory }), /명시적/);
  const running = await h.accept(revised);
  assert.equal(running.status, 'running');
  assert.equal(running.executionSessionId, 'execution-1');
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 1);
  await assert.rejects(h.accept(running), /이미/);
  const reopened = await createHubJobs(h.options);
  await reopened.refresh();
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 1);
  assert.equal((await reopened.get(user, running.id)).executionSessionId, undefined);
  assert.match(jobHandoff(h.calls.find(([kind]) => kind === 'submit')[1]), /기록 때문에 shell\/WSL을 호출하지 않습니다/);
});

test('unavailable execution and ambiguous dispatch never fall back or submit twice', async (t) => {
  const failed = await fixture(t, { runner: { prepare: async () => { throw new Error('unavailable'); } } });
  assert.equal((await failed.accept(await failed.create())).status, 'failed');
  assert.equal(failed.calls.some(([kind]) => kind === 'submit'), false);
  const uncertain = await fixture(t, { runner: { submit: async () => { throw new Error('lost receipt'); } } });
  const job = await uncertain.accept(await uncertain.create());
  assert.equal(job.status, 'uncertain');
  await assert.rejects(uncertain.accept(job), /이미/);
  const reopened = await createHubJobs(uncertain.options);
  await reopened.refresh();
  assert.equal(uncertain.calls.filter(([kind]) => kind === 'prepare').length, 1);
});

test('turn completion needs administrator review and publishes only chosen receipts', async (t) => {
  const h = await fixture(t), running = await h.accept(await h.create());
  const file = { id: 'a'.repeat(64), path: 'result.py', sha256: 'b'.repeat(64), size: 15 };
  h.execution({ status: 'review', result: { summary: '관리자 전용 결과', files: [file] } });
  await h.jobs.refresh();
  const pending = await h.jobs.get(administrator, running.id), publicPending = await h.jobs.get(user, running.id);
  assert.equal(publicPending.status, 'review');
  assert.equal(publicPending.result, undefined);
  assert.deepEqual(publicPending.files, []);
  await assert.rejects(h.jobs.complete(user, running.id, { revision: pending.revision, confirm: true, summary: '완료' }), /관리자/);
  await assert.rejects(h.jobs.complete(administrator, running.id, { revision: pending.revision, confirm: true, summary: '완료', fileIds: ['not-a-receipt'] }), /산출물/);
  const done = await h.jobs.complete(administrator, running.id, { revision: pending.revision, confirm: true, summary: '검증한 공개 결과', fileIds: [file.id] });
  assert.equal(done.status, 'completed');
  assert.equal(done.recording.status, 'saved');
  assert.equal(done.notification.status, 'sent');
  assert.deepEqual((await h.jobs.get(user, running.id)).files, [file]);
  assert.equal((await h.jobs.get(user, running.id)).projectPath, undefined);
  await assert.rejects(h.jobs.file(other, running.id, file.id, file.sha256), /조회/);
  await assert.rejects(h.jobs.file(user, running.id, file.id, 'wrong-version'), /공개/);
});

test('recording/notification failures remain distinct from successful execution', async (t) => {
  const h = await fixture(t, { runner: { record: async () => { throw new Error('storage down'); } },
    notify: async () => { throw new Error('delivery unknown'); } });
  const running = await h.accept(await h.create());
  h.execution({ status: 'review', result: { summary: '비공개', files: [] } });
  await h.jobs.refresh();
  const review = await h.jobs.get(administrator, running.id);
  const done = await h.jobs.complete(administrator, running.id, { revision: review.revision, confirm: true, summary: '검증 완료' });
  assert.equal(done.status, 'completed');
  assert.equal(done.recording.status, 'failed');
  assert.equal(done.notification.status, 'uncertain');
});

test('tool approval is current, explicit and admin-only; revocation stops execution', async (t) => {
  const h = await fixture(t), running = await h.accept(await h.create());
  h.execution({ status: 'waiting', pendingApproval: { id: 'approval-1', name: 'shell', args: { command: 'py result.py' } } });
  await h.jobs.refresh();
  const waiting = await h.jobs.get(administrator, running.id);
  assert.equal((await h.jobs.get(user, running.id)).pendingApproval, undefined);
  await assert.rejects(h.jobs.toolDecision(user, running.id, { revision: waiting.revision, approvalId: 'approval-1', approved: true }), /관리자/);
  await assert.rejects(h.jobs.toolDecision(administrator, running.id, { revision: waiting.revision, approvalId: 'stale', approved: true }), /정확한/);
  await h.jobs.toolDecision(administrator, running.id, { revision: waiting.revision, approvalId: 'approval-1', approved: true });
  assert.equal(h.calls.filter(([kind]) => kind === 'approve').length, 1);
  h.approved.delete('T1:UA');
  await h.jobs.refresh();
  assert.equal((await h.jobs.get(user, running.id)).status, 'cancelling');
  h.execution({ status: 'cancelled' });
  await h.jobs.refresh();
  assert.equal((await h.jobs.get(user, running.id)).status, 'cancelled');
  assert.equal(h.calls.filter(([kind]) => kind === 'abort').length, 1);
});

test('an unconfirmed cancellation stays pending and malformed storage is preserved', async (t) => {
  const h = await fixture(t, { runner: { abort: async () => { throw new Error('offline'); } } });
  const running = await h.accept(await h.create());
  const stopping = await h.jobs.cancel(user, running.id, { revision: running.revision });
  assert.equal(stopping.status, 'cancelling');
  await h.jobs.refresh();
  assert.equal((await h.jobs.get(user, running.id)).status, 'cancelling');
  await fs.writeFile(h.options.file, '{"bad":"data"}');
  await assert.rejects(createHubJobs(h.options), /형식/);
  assert.equal(await fs.readFile(h.options.file, 'utf8'), '{"bad":"data"}');
});

test('queued notifications reconcile by inspection without dispatching another message', async (t) => {
  let delivered = false, sends = 0, inspections = 0;
  const h = await fixture(t, { notify: async (_job, _event, inspect) => {
    if (inspect) inspections++; else sends++;
    return delivered ? { sent: true } : { queued: true };
  } });
  const job = await h.create();
  assert.equal(job.notification.status, 'queued');
  delivered = true;
  await h.jobs.refresh();
  assert.equal((await h.jobs.get(user, job.id)).notification.status, 'sent');
  assert.equal(sends, 1); assert.equal(inspections, 1);
});
