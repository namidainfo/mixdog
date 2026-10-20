import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ApprovedJobRunner } from './approved-jobs.mjs';
import { createSessionHub } from './hub/server.mjs';

// The model/session endpoint is a deterministic fixture, not the installed
// daemon. HTTP authorization, the job controller/runner, files and Python are
// real. This live lane requires py on Windows or python3 on other platforms.
test('HTTP approval controls a real Python run and releases only administrator-reviewed output', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-job-python-'));
  const project = path.join(directory, 'project');
  await fs.mkdir(project);
  const python = process.platform === 'win32' ? 'py' : 'python3';
  const script = 'import math\nvalue = 1\nfor n in range(1, 51):\n    value *= n\nassert value == math.factorial(50)\nprint(value)\n';
  const state = { sessionId: 'fixture-admin-execution', cwd: project, items: [] };
  const notices = [], codes = new Map();
  let executions = 0, executionError;
  const view = {
    getState: () => state, renameSessionTitle: async () => true, resume: async () => {}, dispose: async () => {},
    abortAsync: async () => ({ aborted: true }), recordApprovedJob: async () => ({ recorded: true, caseId: 7 }),
    submitAsync: async (prompt, { id }) => {
      executions++;
      await fs.writeFile(path.join(project, 'result.py'), script, { flag: 'wx' });
      let stdout;
      try {
        ({ stdout } = await promisify(execFile)(python, ['result.py'], {
          cwd: project, windowsHide: true, timeout: 15_000,
          env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
        }));
      } catch (error) { executionError = error; throw error; }
      state.items = [
        { kind: 'user', id: 'turn-1', messageId: id, text: prompt },
        { kind: 'tool', name: 'edit', args: { file_path: 'result.py' }, result: 'created', completedAt: Date.now() },
        { kind: 'tool', name: 'shell', args: { command: `${python} result.py` }, result: stdout, completedAt: Date.now() },
        { kind: 'assistant', text: stdout.trim() },
        { kind: 'turndone', checkpointId: 'turn-1', status: 'done' },
      ];
      return true;
    },
  };
  const authorize = async (message) => message.team === 'T1' && ['U1', 'UA'].includes(message.user);
  const runner = new ApprovedJobRunner({
    options: { provider: 'fixture', model: 'fixture' }, createSession: async () => view,
    access: async (person) => ({ ...person, active: await authorize({ team: person.teamId, user: person.userId }), admin: person.userId === 'UA' }),
  });
  const hub = await createSessionHub({
    origin: 'http://127.0.0.1:0', adminUsers: ['T1:UA'], documentsFile: path.join(directory, 'documents.json'),
    authorize, sendCode: async (person, code) => codes.set(person.userId, code),
    store: { listConversations: async () => [['source', {
      teamId: 'T1', actorId: 'U1', userName: '요청자', channelId: 'C1', threadTs: '1', nativeSessionId: 'source', requests: {},
    }]] },
    transport: { request: async () => { throw new Error('No snapshot transport is needed by job execution'); } },
    jobRunner: runner, jobNotify: async (job, event) => { notices.push({ id: job.id, event }); return { sent: true }; },
  });
  t.after(async () => {
    await hub.close(); await runner.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 1, retryDelay: 50 });
  });
  const origin = await hub.start();
  const request = (url, input, actor) => fetch(origin + url, {
    headers: { ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }),
      ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}) },
    ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
  });
  const login = async (userId) => {
    const challenge = await (await request('/api/auth/challenge', { teamId: 'T1', userId })).json();
    const verified = await request('/api/auth/verify', { ...challenge, code: codes.get(userId) });
    assert.equal(verified.status, 200);
    const actor = { cookie: verified.headers.get('set-cookie').split(';')[0], csrf: '' };
    actor.csrf = (await (await request('/api/me', undefined, actor)).json()).csrf;
    return actor;
  };
  const user = await login('U1'), admin = await login('UA');
  const createdResponse = await request('/api/sessions/source/jobs',
    { goal: '1부터 50까지 곱하는 Python 코드 작성·실행', checks: 'math.factorial(50) 및 별도 BigInt 계산과 비교' }, user);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(executions, 0);
  assert.equal((await request(`/api/jobs/${created.id}/approve`,
    { revision: created.revision, projectPath: project, confirm: true }, user)).status, 403);
  assert.equal(executions, 0);
  const started = await request(`/api/jobs/${created.id}/approve`,
    { revision: created.revision, projectPath: project, confirm: true }, admin);
  assert.equal(started.status, 200);
  assert.equal((await started.json()).status, 'running', executionError?.message);
  assert.equal(executions, 1);
  const review = (await (await request('/api/jobs', undefined, admin)).json()).jobs[0];
  assert.equal(review.status, 'review');
  const factorial = Array.from({ length: 50 }, (_, index) => BigInt(index + 1)).reduce((value, factor) => value * factor, 1n);
  assert.equal(BigInt(review.result.summary), factorial);
  assert.deepEqual(review.result.files.map((file) => file.path), ['result.py']);
  const beforeRelease = await (await request(`/api/jobs/${created.id}`, undefined, user)).json();
  assert.equal(beforeRelease.result, undefined); assert.deepEqual(beforeRelease.files, []);
  const completed = await request(`/api/jobs/${created.id}/complete`, {
    revision: review.revision, confirm: true, summary: `검증 결과: ${factorial}`,
    fileIds: review.result.files.map((file) => file.id),
  }, admin);
  assert.equal(completed.status, 200);
  const publicResult = await (await request(`/api/jobs/${created.id}`, undefined, user)).json();
  assert.equal(publicResult.status, 'completed');
  assert.equal(publicResult.projectPath, undefined);
  const file = publicResult.files[0];
  const download = await request(`/api/jobs/${created.id}/files/${file.id}?version=${file.sha256}`, undefined, user);
  assert.equal(download.status, 200); assert.equal(await download.text(), script);
  assert.ok(notices.some(({ event }) => event === 'completed'));
  assert.equal(executions, 1);
});
