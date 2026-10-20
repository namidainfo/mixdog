import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApprovedJobRunner } from './approved-jobs.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-job-runner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], actor = { teamId: 'T1', userId: 'UA' };
  const state = { sessionId: 'execution', cwd: directory, items: [] };
  let policy = { ...actor, active: true, admin: true };
  const view = {
    getState: () => state, renameSessionTitle: async () => true, dispose: async () => {},
    submitAsync: async (prompt, options) => { calls.push(['submit', prompt, options]); return true; },
    resume: async () => {}, abortAsync: async () => ({ aborted: true }),
    approveAsync: async (...args) => { calls.push(['approve', ...args]); return true; },
    recordApprovedJob: async (input) => { calls.push(['record', input]); return { recorded: true, caseId: 1 }; },
  };
  const runner = new ApprovedJobRunner({
    options: { provider: 'test', model: 'model', cwd: 'ignored', toolMode: 'full' },
    createSession: async (options) => { calls.push(['create', options]); return view; },
    access: async () => policy,
  });
  const job = { id: 'job-1', teamId: 'T1', userId: 'U1', sessionId: 'requester', approvedBy: actor,
    projectPath: directory, goal: '파일 생성', checks: '출력 검증', constraints: '별도 승인 없는 배포 금지', approvedRevision: 1 };
  return { runner, job, state, calls, directory, actor, policy: (value) => { policy = value; } };
}

test('runner rechecks administrator and creates a separate local session without upgrading Slack', async (t) => {
  const h = await fixture(t);
  h.policy({ ...h.actor, active: true, admin: false });
  await assert.rejects(h.runner.prepare(h.job), /관리자/);
  assert.equal(h.calls.length, 0);
  h.policy({ ...h.actor, active: true, admin: true });
  const prepared = await h.runner.prepare(h.job);
  h.job.executionSessionId = prepared.sessionId;
  assert.equal(prepared.sessionId, 'execution');
  assert.equal(h.calls[0][1].cwd, h.directory);
  assert.equal(h.calls[0][1].toolMode, undefined);
  await h.runner.submit(h.job);
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 1);
  assert.deepEqual(h.calls.find(([kind]) => kind === 'submit')[2], { id: 'job-1' });
  h.policy({ ...h.actor, active: false, admin: true });
  await assert.rejects(h.runner.submit(h.job), /관리자/);
});

test('runner keeps reasoning private and offers only successful in-project authored files for review', async (t) => {
  const h = await fixture(t);
  h.job.executionSessionId = (await h.runner.prepare(h.job)).sessionId;
  await fs.writeFile(path.join(h.directory, 'result.py'), 'print(1)\n');
  h.state.items = [
    { kind: 'user', id: 'u', messageId: h.job.id },
    { kind: 'assistant', channel: 'analysis', text: 'private reasoning' },
    { kind: 'tool', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: result.py\n+print(1)\n*** End Patch' },
      result: 'ok', completedAt: 1, success: true },
    { kind: 'assistant', text: '공개 전 관리자 검토가 필요한 결과' },
    { kind: 'turndone', checkpointId: 'u', status: 'done' },
  ];
  const result = await h.runner.inspect(h.job);
  assert.equal(result.status, 'review');
  assert.doesNotMatch(result.result.summary, /private reasoning/);
  assert.equal(result.result.summary, '공개 전 관리자 검토가 필요한 결과');
  assert.deepEqual(result.result.files.map((file) => file.path), ['result.py']);
  // Publishing is a separate administrator action, not a model-turn status.
  assert.equal(h.job.files, undefined);
  h.state.cwd = path.dirname(h.directory);
  await assert.rejects(h.runner.inspect(h.job), /세션/);
});

test('runner only approves the exact live pending call and reattaches without resubmission', async (t) => {
  const h = await fixture(t);
  h.job.executionSessionId = 'execution';
  h.state.toolApproval = { id: 'current', name: 'shell', args: { command: 'py result.py' } };
  await assert.rejects(h.runner.approve(h.job, h.actor, { approvalId: 'stale', approved: true }), /현재/);
  assert.equal((await h.runner.approve(h.job, h.actor, { approvalId: 'current', approved: true })).accepted, true);
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'submit').length, 0);
  assert.equal((await h.runner.inspect(h.job)).status, 'waiting');
});

test('output receipts cannot expose absolute paths, traversal, protected files or junction targets', async (t) => {
  const h = await fixture(t), project = path.join(h.directory, 'project'), external = path.join(h.directory, 'other-user');
  await fs.mkdir(project); await fs.mkdir(external);
  await fs.writeFile(path.join(project, 'result.txt'), 'allowed');
  await fs.writeFile(path.join(project, '.env'), 'NOT_FOR_REQUESTER=secret');
  await fs.writeFile(path.join(external, 'secret.txt'), 'other user data');
  await fs.symlink(external, path.join(project, 'link'), 'junction');
  h.job.projectPath = project; h.state.cwd = project;
  h.job.executionSessionId = (await h.runner.prepare(h.job)).sessionId;
  const authored = ['result.txt', '.env', '../other-user/secret.txt', path.join(external, 'secret.txt'), 'link/secret.txt'];
  h.state.items = [
    { kind: 'user', id: 'u', messageId: h.job.id },
    ...authored.map((target, index) => ({ kind: 'tool', id: `file-${index}`, name: 'edit', args: { file_path: target }, result: 'ok', completedAt: 1 })),
    { kind: 'assistant', text: '결과 검토' },
    { kind: 'turndone', checkpointId: 'u', status: 'done' },
  ];
  const inspected = await h.runner.inspect(h.job);
  assert.deepEqual(inspected.result.files.map((file) => file.path), ['result.txt']);
  h.job.files = inspected.result.files;
  const file = h.job.files[0];
  assert.equal(Buffer.from((await h.runner.file(h.job, file.id, file.sha256)).data, 'base64').toString(), 'allowed');
  await fs.writeFile(path.join(project, 'result.txt'), 'changed');
  await assert.rejects(h.runner.file(h.job, file.id, file.sha256), /변경/);
});

test('a cancelled terminal turn is distinct from an unfinished abort request', async (t) => {
  const h = await fixture(t);
  h.job.executionSessionId = (await h.runner.prepare(h.job)).sessionId;
  assert.equal((await h.runner.abort(h.job)).aborted, true);
  assert.equal((await h.runner.inspect(h.job)).status, 'running');
  h.state.items = [
    { kind: 'user', id: 'turn', messageId: h.job.id },
    { kind: 'turndone', checkpointId: 'turn', status: 'cancelled' },
  ];
  assert.equal((await h.runner.inspect(h.job)).status, 'cancelled');
});
