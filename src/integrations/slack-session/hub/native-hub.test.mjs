import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeSlackClient } from '../native-client.mjs';
import { SLACK_PROJECT_CWD } from '../project.mjs';
import { spawnSync } from 'node:child_process';

function harness(cwd) {
  const calls = [];
  const client = new NativeSlackClient({
    provider: 'openai-oauth', model: 'gpt-6.1-sol', effort: 'ultra', contextTokens: 500000, onState() {},
    hubBridge: { call: async () => ({ version: 1, teamId: 'T1', userId: 'U1',
      active: true, admin: false, root: SLACK_PROJECT_CWD }) },
  });
  const state = { sessionId: 'nonexistent-hub-test', provider: 'openai-oauth', model: 'gpt-6.1-sol', cwd,
    items: [{ kind: 'user', id: 'u', text: '공개 요청' }, { kind: 'assistant', id: 'a', text: '비공개 추론', channel: 'analysis' }] };
  client.createSession = async () => ({ getState: () => state, subscribe() {}, resume: async () => {}, dispose: async () => {},
    setSlackExecutionPolicy: async (policy) => policy,
    listSessions: async () => [{ id: 'another-user', title: '공개하면 안 되는 제목' },
      { id: state.sessionId, title: '261016-001 | softon_박수한 | 작업' }] });
  client.hubFiles = { manifests: new Map(),
    snapshot: async (id, paths) => { calls.push({ id, paths }); return []; },
    file: async (...args) => { calls.push(args); return { data: '' }; },
  };
  return { client, calls };
}
test('the Windows worker projects only public SOFTON state and forwards version-bound file IDs', async () => {
  const h = harness(SLACK_PROJECT_CWD);
  const snapshot = await h.client.hubSnapshot({ sessionId: 'nonexistent-hub-test' });
  assert.equal(snapshot.title, '261016-001 | softon_박수한 | 작업');
  assert.deepEqual(snapshot.messages.map((item) => item.text), ['공개 요청']);
  assert.deepEqual(h.calls[0], { id: 'nonexistent-hub-test', paths: [] });
  await h.client.hubFile({ sessionId: snapshot.id, fileId: 'file-id', sha256: 'version' });
  assert.deepEqual(h.calls[1], ['nonexistent-hub-test', 'file-id', 'version']);
  await h.client.close();
});
test('worker snapshots reject sessions outside SOFTON before reading artifacts', async () => {
  const h = harness('C:\\another-project');
  await assert.rejects(h.client.hubSnapshot({ sessionId: 'nonexistent-hub-test' }), /SOFTON 외부/u);
  assert.equal(h.calls.length, 0);
  await h.client.close();
});
test('the worker hosts the hub, requires live approval, and exits cleanly without a separate WSL listener', () => {
  // Windows Node 24.15 crashes when --test-force-exit interrupts this HTTP
  // integration process. Verify its real, graceful process exit instead.
  const source = `
    import assert from 'node:assert/strict';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const { NativeSlackClient } = await import(${JSON.stringify(new URL('../native-client.mjs', import.meta.url).href)});
    const directory = await mkdtemp(path.join(tmpdir(), 'softon-native-hub-'));
    const calls = [];
    const client = new NativeSlackClient({
      provider: 'openai-oauth', model: 'gpt-6.1-sol', onState() {},
      hubBridge: { call: async method => { calls.push(method); return method === 'conversations' ? [] : false; } },
    });
    try {
      const receipt = await client.startHub({ origin: 'http://127.0.0.1:0', adminUsers: ['T1:UA'], documentsFile: path.join(directory, 'docs.json') });
      const response = await fetch(receipt.origin + '/api/me');
      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /로그인/u);
      const challenge = await fetch(receipt.origin + '/api/auth/challenge', { method: 'POST',
        headers: { origin: receipt.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: 'T1', userId: 'U1' }) });
      assert.equal(challenge.status, 200);
      assert.ok((await challenge.json()).challengeId);
      assert.ok(calls.includes('authorize'));
      assert.equal(calls.includes('conversations'), false);
      assert.equal(calls.includes('sendCode'), false);
      await assert.rejects(client.startHub({}), /이미 실행/u);
    } finally {
      await client.close();
      assert.equal(client.hub, null);
      await rm(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
