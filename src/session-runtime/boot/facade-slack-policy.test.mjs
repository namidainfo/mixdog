import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(tmpdir(), 'facade-slack-policy-'));
const previous = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = directory;
const { buildFacade } = await import('./facade.mjs');
const { createSession } = await import('../../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
const { getSession } = await import('../../runtime/agent/orchestrator/session/manager/session-crud.mjs');
const { drainSessionStore, evictLiveSession } = await import('../../runtime/agent/orchestrator/session/store.mjs');
const { settleSessionSummaryIndex } = await import('../../runtime/agent/orchestrator/session/store/listing.mjs');
const { _withRegisteredProviderForTest } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');
test.after(async () => {
  drainSessionStore(); await settleSessionSummaryIndex();
  if (previous === undefined) delete process.env.MIXDOG_DATA_DIR; else process.env.MIXDOG_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

test('a previously unrestricted session keeps its owner policy through disk save and reload', async () => {
  const session = _withRegisteredProviderForTest('slack-policy-test',
    { name: 'slack-policy-test', contextWindow: 128000 },
    () => createSession({ provider: 'slack-policy-test', model: 'test', cwd: directory, schemaAllowedTools: [] }));
  const rt = { session, config: {}, currentCwd: directory };
  const facade = buildFacade({ rt, mgr: {}, setupTool: {}, workspaceApi: {} });
  const policy = { version: 1, teamId: 'T1', userId: 'U1', active: true, admin: false, root: directory };
  assert.deepEqual(await facade.setSlackExecutionPolicy(policy), policy);
  const stored = JSON.parse(readFileSync(path.join(directory, 'sessions', `${session.id}.json`), 'utf8'));
  assert.deepEqual(stored.slackExecutionPolicy, policy);
  evictLiveSession(session.id);
  assert.deepEqual(getSession(session.id).slackExecutionPolicy, policy);
  await assert.rejects(facade.setSlackExecutionPolicy({ ...policy, userId: 'U2' }), /소유자를 변경/u);
  await assert.rejects(facade.setSlackExecutionPolicy({ ...policy, root: path.dirname(directory) }), /현재 SOFTON/u);
  await assert.rejects(facade.setSlackExecutionPolicy(null), /유효한/u);
  await assert.rejects(facade.recordApprovedJob({}), /관리자 실행 세션/u);
});
