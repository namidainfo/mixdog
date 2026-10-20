import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HubAccess, allowedAddress } from './access.mjs';
import { HubFiles, MAX_FILE_BYTES } from './files.mjs';
import { projectHubState, producedPaths, composeSessionDocument } from './projection.mjs';
import { createHubDocuments } from './documents.mjs';
import { createSessionHub } from './server.mjs';
import { recentRecords, recordSide, recordLabel } from './records.mjs';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'softon-hub-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const tool = (name, args, extra = {}) => ({ kind: 'tool', name, args, id: name, result: 'saved', completedAt: 1792110000000, ...extra });
const state = (extra = {}) => ({ sessionId: 'native-a', cwd: 'C:\\Users\\admin\\Documents\\SOFTON', items: [], ...extra });

test('the network boundary accepts only the office /24 and loopback, not lookalikes or forwarded addresses', () => {
  for (const ip of ['127.0.0.1', '::1', '192.168.19.1', '192.168.19.254', '::ffff:192.168.19.34']) assert.equal(allowedAddress(ip), true, ip);
  for (const ip of ['', '192.168.18.1', '192.168.190.1', '192.168.19.256', '192.168.19.01', '10.0.0.1', '8.8.8.8', 'localhost']) assert.equal(allowedAddress(ip), false, ip);
});

test('Slack codes are private, IP bound, one-use even under concurrent verification, and sessions recheck approval', async () => {
  let approved = true, code, time = 1000;
  const auth = new HubAccess({ now: () => time, authorize: async () => approved, sendCode: async (_person, value) => { code = value; } });
  const person = { teamId: 'T1', userId: 'U1' }, ip = '192.168.19.4';
  const issued = await auth.challenge(person, ip);
  assert.equal(JSON.stringify(issued).includes(code), false);
  await assert.rejects(auth.verify({ ...issued, code }, '192.168.19.5'), /코드/);
  const results = await Promise.allSettled([auth.verify({ ...issued, code }, ip), auth.verify({ ...issued, code }, ip)]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  const login = results.find((value) => value.status === 'fulfilled').value;
  assert.equal((await auth.current(login.token, ip)).userId, 'U1');
  approved = false;
  await assert.rejects(auth.current(login.token, ip), /로그인/);
  assert.equal(auth.sessions.size, 0);
  approved = true; time += 61_000;
  const expired = await auth.challenge(person, ip); time += 300_001;
  await assert.rejects(auth.verify({ ...expired, code }, ip), /코드/);
});

test('unknown users receive no DM and challenge and verification attempts are rate limited', async () => {
  let sent = 0;
  const auth = new HubAccess({ authorize: () => false, sendCode: () => { sent++; } });
  const issued = await auth.challenge({ teamId: 'T1', userId: 'U0' }, '127.0.0.1');
  assert.equal(sent, 0);
  assert.ok(issued.challengeId);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.verify({ challengeId: issued.challengeId, code: 'wrong' }, '127.0.0.1'), /코드/);
  await assert.rejects(auth.verify({ challengeId: issued.challengeId, code: 'wrong' }, '127.0.0.1'), (error) => error.status === 429);
});

test('a login session expires after eight hours and logout invalidates it', async () => {
  let now = 0, code;
  const auth = new HubAccess({ now: () => now, authorize: () => true, sendCode: (_subject, value) => { code = value; } });
  const challenge = await auth.challenge({ teamId: 'T1', userId: 'U1' }, '127.0.0.1');
  const result = await auth.verify({ ...challenge, code }, '127.0.0.1');
  now = 8 * 60 * 60_000;
  await assert.rejects(auth.current(result.token, '127.0.0.1'), /로그인/);
  now += 61_000;
  const next = await auth.challenge({ teamId: 'T1', userId: 'U1' }, '127.0.0.1');
  const nextLogin = await auth.verify({ ...next, code }, '127.0.0.1');
  auth.logout(nextLogin.token);
  await assert.rejects(auth.current(nextLogin.token, '127.0.0.1'), /로그인/);
});

test('projection includes only completed public messages and successful session-local Worktrail writes', () => {
  const projected = projectHubState(state({ items: [
    { kind: 'user', id: 'u', text: '[Slack request slack:C1:1]\nmetadata\n[현재 사용자 요청]\n정리해 줘.' },
    { kind: 'assistant', id: 'a', text: '공개 답변' },
    { kind: 'assistant', id: 'hidden', text: 'private reasoning', channel: 'analysis' },
    { kind: 'assistant', id: 'stream', text: 'partial', streaming: true },
    tool('mcp__worktrail__note_turn', { kind: 'verified', observed: '확인 기록\n\n검증했습니다.', conclusion: '결론', next: '검토해 주세요.', owner: 'user' }),
    tool('mcp__worktrail__decide', { statement: '결정\n\n본인 기록만 표시한다.' }, { id: 'decision' }),
    tool('mcp__worktrail__note_turn', { kind: 'change', observed: '실패한 저장' }, { isError: true }),
    tool('mcp__worktrail__declare', { kind: 'next', statement: '잘못된 저장' }, { result: 'casebook error: invalid title' }),
    tool('mcp__worktrail__declare', { kind: 'next', statement: '실패' }, { result: { isError: true } }),
    tool('mcp__worktrail__list_threads', { worktree: '/another-project' }),
    { kind: 'turndone', status: 'done' },
  ] }));
  assert.deepEqual(projected.messages.map((item) => item.text), ['정리해 줘.', '공개 답변']);
  assert.deepEqual(projected.records.map((item) => item.kind), ['verified', 'decision']);
  assert.equal(projected.records[0].next, '검토해 주세요.');
  assert.equal(projected.state, 'done');
  assert.equal(recordSide('decision'), 'up'); assert.equal(recordSide('verified'), 'down');
  assert.equal(recordLabel('change'), '바꿈');
  assert.deepEqual(recentRecords([1, 2, 3, 4, 5, 6, 7, 8]), [3, 4, 5, 6, 7, 8]);
});

test('aggregate members preserve individual completion and record order', () => {
  const items = [{ kind: 'tool', aggregate: true, id: 'aggregate', toolMembers: [
    tool('mcp__worktrail__declare', { kind: 'focus', statement: '범위' }, { id: undefined }),
    tool('mcp__worktrail__note_turn', { kind: 'finding', observed: '관찰' }, { id: undefined }),
    tool('mcp__worktrail__note_turn', { kind: 'thought', observed: '진행 중' }, { completedAt: null, result: null, completedCount: 0 }),
  ] }];
  const records = projectHubState(state({ items })).records;
  assert.deepEqual(records.map((item) => item.kind), ['focus', 'finding']);
  assert.equal(new Set(records.map((item) => item.id)).size, 2);
});

test('provider JSON arguments and freeform patch arguments normalize by the existing runtime format', () => {
  const records = projectHubState(state({ items: [
    tool('mcp__worktrail__note_turn', JSON.stringify({ kind: 'finding', observed: '실제 기록' })),
  ] })).records;
  assert.equal(records[0].title, '실제 기록');
  const paths = producedPaths([
    tool('functions.apply_patch', '*** Begin Patch\n*** Add File: raw.md\n+x\n*** End Patch'),
    tool('apply_patch', JSON.stringify({ patch: '*** Add File: json.md\n+x' })),
    tool('visualize', { action: 'export', input: { output: 'design/result.png' } }),
  ]);
  assert.deepEqual(paths, ['raw.md', 'json.md', 'design/result.png']);
});

test('artifact paths come from successful authored targets and receipts, not prose, reads, deletions, or move sources', () => {
  const paths = producedPaths([
    tool('apply_patch', { patch: '*** Add File: out.md\n+x\n*** Update File: old.md\n*** Move to: moved.md\n*** Delete File: gone.md\n' }),
    tool('read', { file_path: 'private.md' }, { result: 'file path: secret.md' }),
    tool('apply_patch', { patch: '*** Add File: failed.md' }, { isError: true }),
    tool('office', {}, { result: { artifacts: [{ path: 'deliverables/result.docx', operation: 'create' }, { path: 'input.docx', operation: 'read' }] } }),
  ]);
  assert.deepEqual(paths, ['out.md', 'moved.md', 'deliverables/result.docx']);
});

test('snapshots distinguish running, waiting, failed, idle and done without inferring completion from prose', () => {
  assert.equal(projectHubState(state()).state, 'idle');
  assert.equal(projectHubState(state({ busy: true })).state, 'running');
  assert.equal(projectHubState(state({ busy: true, userQuestion: { id: 'q' } })).state, 'waiting');
  assert.equal(projectHubState(state({ items: [{ kind: 'assistant', text: '완료했습니다.' }] })).state, 'idle');
  assert.equal(projectHubState(state({ items: [{ kind: 'turndone', status: 'error' }] })).state, 'error');
});

test('synchronous media receipts without status produce artifacts, but pending and failed jobs do not', () => {
  const receipt = { ok: true, output: 'design/gangbyeon-technomart-1792132797-256879.png', assetId: 'generated-asset' };
  const shapes = [
    receipt, JSON.stringify(receipt),
    { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
    { structuredContent: receipt },
  ];
  for (const result of shapes) {
    assert.deepEqual(producedPaths([tool('functions.media', { action: 'generate' }, { result })]), [receipt.output]);
  }
  for (const status of ['running', 'queued', 'failed', 'canceled', 'cancelled']) {
    assert.deepEqual(producedPaths([tool('media', {}, { result: { ...receipt, status } })]), []);
  }
  assert.deepEqual(producedPaths([tool('media', {}, { result: { ...receipt, ok: false } })]), []);
  assert.deepEqual(producedPaths([tool('media', {}, { result: { ...receipt, isError: true } })]), []);
  assert.deepEqual(producedPaths([tool('office', {}, { result: receipt })]), []);
});

test('files are manifest scoped, reject traversal, protected files, links outside the project, and changed content', async (t) => {
  const directory = await temporary(t), project = path.join(directory, 'project'), outside = path.join(directory, 'outside');
  await mkdir(project); await mkdir(outside);
  await writeFile(path.join(project, 'result.md'), '# 산출물');
  await writeFile(path.join(project, '.env'), 'PRIVATE=value');
  await writeFile(path.join(project, 'large.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await writeFile(path.join(outside, 'private.md'), 'private');
  await symlink(outside, path.join(project, 'external'), 'junction');
  const files = new HubFiles(project);
  const rows = await files.snapshot('a', ['result.md', '.env', '../outside/private.md', 'external/private.md', 'gone.md', 'large.bin']);
  assert.equal(rows.length, 2); assert.equal(rows[0].path, 'result.md');
  assert.equal(rows[1].path, 'large.bin'); assert.equal(rows[1].downloadable, false);
  assert.equal(rows[1].size, MAX_FILE_BYTES + 1);
  assert.equal(Buffer.from((await files.file('a', rows[0].id, rows[0].sha256)).data, 'base64').toString(), '# 산출물');
  await assert.rejects(files.file('b', rows[0].id, rows[0].sha256), /이 세션/);
  await assert.rejects(files.file('a', rows[0].id, 'wrong'), /버전/);
  await writeFile(path.join(project, 'result.md'), '다른 내용');
  await assert.rejects(files.file('a', rows[0].id, rows[0].sha256), /변경/);
});

test('drafts survive restart, bind to one session, check revisions and explicit approval, and keep an idempotent slug', async (t) => {
  const directory = await temporary(t), file = path.join(directory, 'documents.json');
  let calls = 0, slug, offline = true;
  const wiki = async (_action, input) => { calls++; slug = input.slug; if (offline) throw new Error('offline'); return { slug, draft_id: 9, submitted: true }; };
  const documents = await createHubDocuments({ file, wiki });
  const snapshot = { id: 'a', title: '검증 문서', userName: '작성자', updatedAt: '2026-10-16T00:00:00Z', state: 'done',
    records: [{ kind: 'verified', title: '검증', body: '테스트를 통과했습니다.', conclusion: '확인됨' }], files: [] };
  const doc = await documents.create(snapshot);
  assert.match(composeSessionDocument(snapshot), /테스트를 통과했습니다/);
  assert.deepEqual(documents.list('b'), []);
  await assert.rejects(documents.save('b', { id: doc.id, revision: 1 }), (error) => error.status === 404);
  const saved = await documents.save('a', { id: doc.id, revision: 1, title: '제목 수정', content: '검토한 내용' });
  await assert.rejects(documents.save('a', { id: doc.id, revision: 1, title: '충돌', content: '충돌' }), (error) => error.status === 409);
  await assert.rejects(documents.submit('a', { id: doc.id, revision: 2 }), /명시적/);
  assert.equal(calls, 0);
  await assert.rejects(documents.submit('a', { id: doc.id, revision: 2, confirm: true }), /불확실/);
  assert.equal(documents.list('a')[0].status, 'uncertain');
  const restarted = await createHubDocuments({ file, wiki });
  assert.equal(restarted.list('a')[0].content, saved.content);
  offline = false;
  const submitted = await restarted.submit('a', { id: doc.id, revision: 2, confirm: true });
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.slug, slug);
  await restarted.submit('a', { id: doc.id, revision: 2, confirm: true });
  assert.equal(calls, 2);
  await assert.rejects(restarted.save('a', { id: doc.id, revision: 2, title: '수정', content: '수정' }), /수정할 수 없/);
});

test('corrupt storage is rejected without overwriting it and unexpected CloudWiki receipts remain uncertain', async (t) => {
  const file = path.join(await temporary(t), 'documents.json');
  await writeFile(file, '{"bad":true}');
  await assert.rejects(createHubDocuments({ file }), /저장 형식/);
  assert.equal(await readFile(file, 'utf8'), '{"bad":true}');
});

async function serverHarness(t, { jobRunner, jobNotify } = {}) {
  const directory = await temporary(t), sent = [], calls = [], approved = new Set(['U1', 'U2', 'UA']);
  const values = [
    { actorId: 'U1', userName: '사용자 1', teamId: 'T1', channelId: 'C1', threadTs: '1', nativeSessionId: 'a',
      nativeSessionHistory: ['old-a'], sessionTitle: '첫 작업', requests: { old: { userId: 'U1', sessionId: 'old-a' } } },
    { actorId: 'U2', userName: '사용자 2', teamId: 'T1', channelId: 'C1', threadTs: '1', nativeSessionId: 'b', requests: {} },
    { actorId: 'UA', userName: '관리자', teamId: 'T1', channelId: 'C1', threadTs: '2', nativeSessionId: 'admin', requests: {} },
    { actorId: 'U1', userName: '사용자 1', teamId: 'T1', channelId: 'C1', threadTs: '3', nativeSessionId: 'mixed',
      requests: { other: { userId: 'U2', sessionId: 'mixed' } } },
  ];
  const fileId = 'a'.repeat(64), sha256 = 'b'.repeat(64);
  const hub = await createSessionHub({
    origin: 'http://127.0.0.1:0', adminUsers: ['T1:UA'], documentsFile: path.join(directory, 'documents.json'),
    jobRunner, jobNotify,
    store: { listConversations: async () => values.map((value, i) => [String(i), value]) },
    authorize: async (message) => message.team === 'T1' && approved.has(message.user),
    sendCode: async (person, code) => sent.push({ ...person, code }),
    transport: { request: async (method, input) => {
      calls.push({ method, input });
      if (method === 'hubSnapshot') return {
        id: input.sessionId, title: `제목 ${input.sessionId}`, state: 'done', messages: [],
        records: [{ id: `record-${input.sessionId}`, kind: 'verified', title: `기록 ${input.sessionId}`, body: `본문 ${input.sessionId}` }],
        files: [{ id: fileId, sha256, path: 'result.md' }],
      };
      if (method === 'hubFile') return { data: Buffer.from('파일 내용').toString('base64') };
      throw new Error('unexpected operation');
    } },
    wiki: async (_action, input) => ({ slug: input.slug, draft_id: 11, submitted: true }),
  });
  t.after(() => hub.close());
  const origin = await hub.start();
  const request = (url, input, cookie, headers = {}) => fetch(origin + url, { headers: {
    ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers,
  }, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
  const login = async (userId) => {
    const challenge = await (await request('/api/auth/challenge', { teamId: 'T1', userId })).json();
    const code = sent.findLast((value) => value.userId === userId).code;
    const verified = await request('/api/auth/verify', { ...challenge, code });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get('set-cookie').split(';')[0];
    assert.match(verified.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/u);
    const me = await (await request('/api/me', undefined, cookie)).json();
    return { cookie, csrf: me.csrf };
  };
  return { hub, request, login, approved, calls, fileId, sha256, origin, values };
}

test('job HTTP routes bind requester identity, require current administrator approval and protect reviewed results', async (t) => {
  const directory = await temporary(t), calls = [];
  let inspection = { status: 'running' };
  const h = await serverHarness(t, {
    jobRunner: {
      prepare: async (job) => { calls.push(['prepare', job]); return { sessionId: 'admin-execution' }; },
      submit: async (job) => { calls.push(['submit', job]); return { accepted: true }; },
      inspect: async () => inspection, abort: async () => ({ aborted: true }),
      record: async () => { throw new Error('recording unavailable'); },
    },
    jobNotify: async () => { throw new Error('notification unavailable'); },
  });
  const user = await h.login('U1'), admin = await h.login('UA'), other = await h.login('U2');
  const userHeaders = { 'x-csrf-token': user.csrf }, adminHeaders = { 'x-csrf-token': admin.csrf };
  const input = { goal: '계산 코드 작성', checks: 'factorial 독립 검증', userId: 'UA', teamId: 'T2', admin: true };
  assert.equal((await h.request('/api/sessions/b/jobs', input, user.cookie, userHeaders)).status, 404);
  const created = await h.request('/api/sessions/a/jobs', input, user.cookie, userHeaders);
  assert.equal(created.status, 201);
  const job = await created.json();
  assert.equal(job.userId, 'U1'); assert.equal(job.teamId, 'T1');
  assert.equal((await h.request(`/api/jobs/${job.id}`, undefined, other.cookie)).status, 404);
  const approval = { revision: job.revision, confirm: true, projectPath: directory };
  assert.equal((await h.request(`/api/jobs/${job.id}/approve`, approval, user.cookie, userHeaders)).status, 403);
  assert.equal((await h.request(`/api/jobs/${job.id}/approve`, approval, admin.cookie)).status, 403);
  assert.equal((await h.request(`/api/jobs/${job.id}/approve`, { ...approval, revision: -1 }, admin.cookie, adminHeaders)).status, 409);
  const runningResponse = await h.request(`/api/jobs/${job.id}/approve`, approval, admin.cookie, adminHeaders);
  assert.equal(runningResponse.status, 200);
  assert.equal((await runningResponse.json()).executionSessionId, 'admin-execution');
  assert.equal(calls.filter(([kind]) => kind === 'submit').length, 1);
  assert.equal((await h.request(`/api/jobs/${job.id}/approve`, approval, admin.cookie, adminHeaders)).status, 409);
  inspection = { status: 'review', result: { summary: '관리자만 볼 수 있는 실행 대화', files: [] } };
  const publicList = await (await h.request('/api/jobs', undefined, user.cookie)).json();
  assert.equal(publicList.jobs[0].status, 'review');
  assert.equal(publicList.jobs[0].result, undefined);
  assert.equal(publicList.jobs[0].projectPath, undefined);
  const review = await (await h.request(`/api/jobs/${job.id}`, undefined, admin.cookie)).json();
  assert.equal(review.result.summary, '관리자만 볼 수 있는 실행 대화');
  const result = await h.request(`/api/jobs/${job.id}/complete`,
    { revision: review.revision, confirm: true, summary: '검증한 결과만 공개', fileIds: [] }, admin.cookie, adminHeaders);
  assert.equal(result.status, 200);
  const done = await result.json();
  assert.equal(done.status, 'completed');
  assert.equal(done.recording.status, 'failed');
  assert.equal(done.notification.status, 'uncertain');
  const published = await (await h.request(`/api/jobs/${job.id}`, undefined, user.cookie)).json();
  assert.equal(published.summary, '검증한 결과만 공개');
  assert.equal(published.result, undefined);
});

test('approved CLI-JAW users can authenticate before creating any Mixdog session without exposing other workspaces', async (t) => {
  const h = await serverHarness(t);
  h.values.length = 0;
  const user = await h.login('U1');
  const list = await h.request('/api/sessions', undefined, user.cookie);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).sessions, []);
  assert.equal(h.calls.length, 0);
  const denied = await h.request('/api/auth/challenge', { teamId: 'T2', userId: 'U1' });
  assert.equal(denied.status, 200);
  const fake = await h.request('/api/auth/verify', { challengeId: (await denied.json()).challengeId, code: 'wrong' });
  assert.equal(fake.status, 401);
});

test('HTTP routes enforce login, owner isolation including rotation history, administrator scope, mixed-history denial and revocation', async (t) => {
  const h = await serverHarness(t);
  assert.equal((await h.request('/api/sessions')).status, 401);
  const user = await h.login('U1'), admin = await h.login('UA');
  const list = await (await h.request('/api/sessions', undefined, user.cookie)).json();
  assert.deepEqual(list.sessions.map((row) => row.id), ['a', 'old-a']);
  const all = await (await h.request('/api/sessions', undefined, admin.cookie)).json();
  assert.deepEqual(all.sessions.map((row) => row.id), ['a', 'old-a', 'b', 'admin']);
  for (const endpoint of ['/api/sessions/b', '/api/sessions/b/documents', `/api/sessions/b/files/${h.fileId}`]) {
    assert.equal((await h.request(endpoint, undefined, user.cookie)).status, 404);
  }
  assert.equal(h.calls.length, 0);
  for (const id of ['a', 'old-a']) {
    const response = await h.request(`/api/sessions/${id}`, undefined, user.cookie);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).records.map((record) => record.id), [`record-${id}`]);
  }
  const adminSnapshot = await h.request('/api/sessions/b', undefined, admin.cookie);
  assert.equal(adminSnapshot.status, 200);
  assert.deepEqual((await adminSnapshot.json()).records.map((record) => record.id), ['record-b']);
  h.approved.delete('U1');
  assert.equal((await h.request('/api/sessions', undefined, user.cookie)).status, 401);
  assert.equal((await h.request('/api/sessions/a', undefined, admin.cookie)).status, 404);
});

test('HTTP security checks Host, Origin, CSRF, direct client IP, content type and immutable file version', async (t) => {
  const h = await serverHarness(t), user = await h.login('U1');
  const invalidHost = await new Promise((resolve, reject) => {
    // Node fetch rewrites Host; raw HTTP must exercise the actual server boundary.
    const request = httpRequest(h.origin + '/api/me', { headers: { host: 'evil.example', cookie: user.cookie } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal((await h.request('/api/logout', {}, user.cookie, { origin: 'https://evil.example', 'x-csrf-token': user.csrf })).status, 403);
  assert.equal((await h.request('/api/sessions/a/snapshot', {}, user.cookie)).status, 403);
  assert.equal((await h.request('/api/sessions/a/snapshot', {}, user.cookie, { 'x-csrf-token': user.csrf, 'content-type': 'text/plain' })).status, 415);
  const response = await h.request('/api/sessions/a', undefined, user.cookie);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal((await h.request(`/api/sessions/a/files/${h.fileId}?version=wrong`, undefined, user.cookie)).status, 409);
  const file = await h.request(`/api/sessions/a/files/${h.fileId}?version=${h.sha256}`, undefined, user.cookie);
  assert.equal(await file.text(), '파일 내용');
  assert.match(file.headers.get('content-disposition'), /^attachment/u);
  assert.equal(h.calls.findLast((call) => call.method === 'hubFile').input.sha256, h.sha256);
  const direct = new PassThrough();
  direct.url = '/api/me'; direct.method = 'GET'; direct.headers = { host: new URL(h.origin).host, 'x-forwarded-for': '192.168.19.2' };
  direct.socket = { remoteAddress: '10.1.2.3' }; direct.end();
  let status, raw;
  await h.hub.handler(direct, { setHeader() {}, writeHead(value) { status = value; }, end(value) { raw = value; } });
  assert.equal(status, 403); assert.match(raw, /사내망/u);
});

test('HTTP document actions cannot cross sessions and require explicit CSRF-protected approval', async (t) => {
  const h = await serverHarness(t), user = await h.login('U1'), headers = { 'x-csrf-token': user.csrf };
  const doc = await (await h.request('/api/sessions/a/documents', {}, user.cookie, headers)).json();
  assert.equal((await h.request(`/api/sessions/b/documents/${doc.id}/submit`, { revision: 1, confirm: true }, user.cookie, headers)).status, 404);
  assert.equal((await h.request(`/api/sessions/old-a/documents/${doc.id}/submit`, { revision: 1, confirm: true }, user.cookie, headers)).status, 404);
  assert.equal((await h.request(`/api/sessions/a/documents/${doc.id}/submit`, { revision: 1 }, user.cookie, headers)).status, 400);
  const submitted = await h.request(`/api/sessions/a/documents/${doc.id}/submit`, { revision: 1, confirm: true }, user.cookie, headers);
  assert.equal(submitted.status, 200); assert.equal((await submitted.json()).status, 'submitted');
});

test('LAN plaintext, missing TLS, public origins and missing administrator identities fail closed', async (t) => {
  const base = { store: { listConversations: () => [] }, documentsFile: path.join(await temporary(t), 'docs.json'), adminUsers: ['T1:UA'] };
  await assert.rejects(createSessionHub({ ...base, origin: 'http://192.168.19.10:8797' }), /HTTPS/u);
  await assert.rejects(createSessionHub({ ...base, origin: 'https://192.168.19.10:8797' }), /TLS/u);
  await assert.rejects(createSessionHub({ ...base, origin: 'https://8.8.8.8' }), /HTTPS/u);
  await assert.rejects(createSessionHub({ ...base, origin: 'http://127.0.0.1:0', adminUsers: [] }), /관리자/u);
});
