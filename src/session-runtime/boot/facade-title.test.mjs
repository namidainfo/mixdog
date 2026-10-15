import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-title-reservation-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
const { buildFacade } = await import('./facade.mjs');
const { sessionOptions } = await import('../session-create/session-options.mjs');
const { createSession } = await import('../../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs');
const { getSession, updateSessionGeneratedTitle, updateSessionManualTitle } =
  await import('../../runtime/agent/orchestrator/session/manager/session-crud.mjs');
const { deleteSession, drainSessionStore, evictLiveSession } =
  await import('../../runtime/agent/orchestrator/session/store.mjs');
const { settleSessionSummaryIndex } = await import('../../runtime/agent/orchestrator/session/store/listing.mjs');
const { _withRegisteredProviderForTest } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

function reservedRuntime(id, sessionProfile = null) {
  const cwd = join(root, id);
  mkdirSync(cwd);
  const rt = {
    route: { provider: 'title-test', model: 'gpt-5.6-sol' },
    currentCwd: cwd,
    mode: 'full',
    config: {},
    sessionProfile,
    reservedSessionId: null,
  };
  const facade = buildFacade({
    rt,
    setupTool: {},
    workspaceApi: {},
    bindRuntimeNotificationSession: () => {},
    createCurrentSession: async () => {},
  });
  facade.reserveSessionId(id);
  return { rt, facade };
}

function materialize(rt) {
  return _withRegisteredProviderForTest(
    'title-test',
    { name: 'title-test', contextWindow: 128000 },
    () => createSession(sessionOptions({
      rt,
      cfgMod: { getPluginData: () => root },
      activeWorkflowContext: () => ({
        summary: null, context: '', packContext: '', orchestrationMode: 'none',
      }),
      schemaAllowedTools: [],
      featureDisallowedTools: () => [],
    }, ''))
  );
}

test('reservation fixes creation order and date before delayed materialization or title generation', async (t) => {
  let now = new Date(2026, 0, 2, 23, 59).getTime();
  t.mock.method(Date, 'now', () => now);
  const first = reservedRuntime('sess_reserved_first');
  const second = reservedRuntime('sess_reserved_second');
  first.facade.reserveSessionId('sess_reserved_first');
  assert.equal(first.rt.reservedSessionTitle.prefix, '260102-000 | ');
  assert.equal(second.rt.reservedSessionTitle.prefix, '260102-001 | ');

  const originalCreatedAt = now;
  now = new Date(2026, 0, 3, 0, 1).getTime();
  const secondSession = materialize(second.rt);
  const firstSession = materialize(first.rt);
  assert.equal(firstSession.createdAt, originalCreatedAt);
  assert.equal(secondSession.createdAt, originalCreatedAt);
  assert.equal(await updateSessionGeneratedTitle(secondSession.id, 'Second work', 'first'), true);
  assert.equal(await updateSessionGeneratedTitle(firstSession.id, '가'.repeat(32), 'first'), true);
  assert.equal(getSession(firstSession.id).title, `260102-000 | ${'가'.repeat(32)}`);
  assert.equal(getSession(firstSession.id).title.length, 45);
  assert.equal(getSession(secondSession.id).title, '260102-001 | Second work');
  assert.equal(await updateSessionGeneratedTitle(firstSession.id, '991231-999 | [000101] Updated work', 'third'), true);
  assert.equal(getSession(firstSession.id).title, '260102-000 | Updated work');
  assert.equal(getSession(firstSession.id).createdAt, originalCreatedAt);

  const stored = JSON.parse(readFileSync(join(root, 'sessions', `${firstSession.id}.json`), 'utf8'));
  assert.equal(stored.generatedTitlePrefix, '260102-000 | ');
  assert.equal(stored.createdAt, originalCreatedAt);
  evictLiveSession(firstSession.id);
  assert.equal(getSession(firstSession.id).title, '260102-000 | Updated work');
  assert.equal(await updateSessionManualTitle(secondSession.id, 'Custom title'), true);
  assert.equal(await updateSessionGeneratedTitle(secondSession.id, 'Do not replace', 'third'), false);
  assert.equal(getSession(secondSession.id).title, 'Custom title');

  assert.equal(deleteSession(firstSession.id, { deferSummaryUpdate: true }), true);
  now = new Date(2026, 0, 2, 23, 59, 30).getTime();
  const third = reservedRuntime('sess_reserved_third');
  assert.equal(third.rt.reservedSessionTitle.prefix, '260102-002 | ');
  assert.equal(materialize(third.rt).generatedTitlePrefix, '260102-002 | ');
  now = new Date(2026, 0, 3, 0, 2).getTime();
  assert.equal(reservedRuntime('sess_next_day').rt.reservedSessionTitle.prefix, '260103-000 | ');
});

test('agent-owned reservations are excluded and direct ordinary creation still receives a number', (t) => {
  t.mock.method(Date, 'now', () => new Date(2026, 0, 4).getTime());
  const hidden = reservedRuntime('sess_reserved_hidden', { owner: 'agent', agent: 'cycle1-agent' });
  assert.equal(hidden.rt.reservedSessionTitle, null);
  const hiddenSession = materialize(hidden.rt);
  assert.equal(hiddenSession.generatedTitlePrefix, undefined);
  const direct = _withRegisteredProviderForTest(
    'title-test',
    { name: 'title-test', contextWindow: 128000 },
    () => createSession({
      provider: 'title-test', model: 'gpt-5.6-sol', cwd: root, skipSkills: true, schemaAllowedTools: [],
    })
  );
  assert.equal(direct.generatedTitlePrefix, '260104-000 | ');
});

test('title reservations retain the durable address and refuse re-keying or closed admission', (t) => {
  t.mock.method(Date, 'now', () => new Date(2026, 0, 5).getTime());
  const { rt, facade } = reservedRuntime('sess_addressed_title');
  assert.equal(rt.addressedSessionId, 'sess_addressed_title');
  assert.equal(rt.reservedSessionTitle.prefix, '260105-000 | ');
  assert.throws(() => facade.reserveSessionId('sess_another_title'), /cannot be re-keyed/);
  assert.equal(rt.reservedSessionTitle.prefix, '260105-000 | ');
  rt.admission = 'terminal';
  assert.throws(() => facade.reserveSessionId('sess_addressed_title'), /closed to new work/);
  assert.equal(rt.reservedSessionTitle.prefix, '260105-000 | ');
  assert.equal(reservedRuntime('sess_after_closed_title').rt.reservedSessionTitle.prefix, '260105-001 | ');
});
