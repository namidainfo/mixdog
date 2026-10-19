import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const { deleteSession, drainSessionStore, evictLiveSession, saveSessionAsync } =
  await import('../../runtime/agent/orchestrator/session/store.mjs');
const { assignSessionTitlePrefix } =
  await import('../../runtime/agent/orchestrator/session/store/title-sequence.mjs');
const { settleSessionSummaryIndex } = await import('../../runtime/agent/orchestrator/session/store/listing.mjs');
const { _withRegisteredProviderForTest } = await import('../../runtime/agent/orchestrator/providers/registry.mjs');
const sequencePath = join(root, 'session-title-sequences.json');
const counterState = () => existsSync(sequencePath) ? readFileSync(sequencePath, 'utf8') : null;

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
  const boot = {
    rt,
    mgr: { getSession, updateSessionManualTitle },
    setupTool: {},
    workspaceApi: {},
    bindRuntimeNotificationSession: () => {},
    createCurrentSession: async () => {},
  };
  const facade = buildFacade(boot);
  facade.reserveSessionId(id);
  return { rt, facade, boot };
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

test('reservations and materialization do not number conversations before their first real input', async () => {
  const first = reservedRuntime('sess_reserved_first');
  const second = reservedRuntime('sess_reserved_second');
  const reservedAt = first.rt.reservedSessionCreatedAt;
  first.facade.reserveSessionId('sess_reserved_first');
  assert.equal(first.rt.reservedSessionCreatedAt, reservedAt);
  assert.equal(counterState(), null);

  const originalCreatedAt = new Date(2026, 0, 2, 23, 59).getTime();
  first.rt.reservedSessionCreatedAt = originalCreatedAt;
  const secondSession = materialize(second.rt);
  const firstSession = materialize(first.rt);
  assert.equal(firstSession.createdAt, originalCreatedAt);
  assert.equal(secondSession.createdAt, second.rt.reservedSessionCreatedAt);
  assert.equal(firstSession.generatedTitlePrefix, undefined);
  assert.equal(secondSession.generatedTitlePrefix, undefined);
  assert.equal(counterState(), null);

  const firstInputAt = new Date(2026, 0, 3, 0, 1).getTime();
  assert.equal(assignSessionTitlePrefix(secondSession, firstInputAt), true);
  assert.equal(assignSessionTitlePrefix(firstSession, firstInputAt), true);
  assert.equal(await updateSessionGeneratedTitle(secondSession.id, 'Second work', 'first'), true);
  assert.equal(await updateSessionGeneratedTitle(firstSession.id, '가'.repeat(32), 'first'), true);
  assert.equal(getSession(firstSession.id).title, `260103-001 | ${'가'.repeat(32)}`);
  assert.equal(getSession(firstSession.id).title.length, 45);
  assert.equal(getSession(secondSession.id).title, '260103-000 | Second work');
  assert.equal(await updateSessionGeneratedTitle(firstSession.id, '991231-999 | [000101] Updated work', 'third'), true);
  assert.equal(getSession(firstSession.id).title, '260103-001 | Updated work');
  assert.equal(getSession(firstSession.id).createdAt, originalCreatedAt);

  const stored = JSON.parse(readFileSync(join(root, 'sessions', `${firstSession.id}.json`), 'utf8'));
  assert.equal(stored.generatedTitlePrefix, '260103-001 | ');
  assert.equal(stored.createdAt, originalCreatedAt);
  evictLiveSession(firstSession.id);
  assert.equal(getSession(firstSession.id).title, '260103-001 | Updated work');
  assert.equal(await updateSessionManualTitle(secondSession.id, 'Custom title'), true);
  assert.equal(await updateSessionGeneratedTitle(secondSession.id, 'Do not replace', 'third'), false);
  assert.equal(getSession(secondSession.id).title, 'Custom title');

  assert.equal(deleteSession(firstSession.id, { deferSummaryUpdate: true }), true);
  const third = reservedRuntime('sess_reserved_third');
  const thirdSession = materialize(third.rt);
  assert.equal(thirdSession.generatedTitlePrefix, undefined);
  assert.equal(assignSessionTitlePrefix(thirdSession, firstInputAt), true);
  assert.equal(thirdSession.generatedTitlePrefix, '260103-002 | ');
  const nextDay = materialize(reservedRuntime('sess_next_day').rt);
  assert.equal(assignSessionTitlePrefix(nextDay, new Date(2026, 0, 4).getTime()), true);
  assert.equal(nextDay.generatedTitlePrefix, '260104-000 | ');
});

test('prefix-preserving manual titles wait for real input and resist generated-title replacement', async () => {
  const { rt, facade, boot } = reservedRuntime('sess_slack_named');
  const countersBefore = counterState();
  let creations = 0;
  boot.createCurrentSession = async () => {
    creations += 1;
    rt.session = materialize(rt);
  };
  assert.equal(await facade.renameSessionTitle(
    rt.reservedSessionId, 'softon_박수한 | 연결 폴더의 최신 프로젝트', { preservePrefix: true },
  ), true);
  assert.equal(creations, 1);
  assert.equal(counterState(), countersBefore);
  assert.equal(getSession(rt.session.id).generatedTitlePrefix, undefined);
  assert.equal(getSession(rt.session.id).title, 'softon_박수한 | 연결 폴더의 최신 프로젝트');
  assert.equal(getSession(rt.session.id).titlePrefixPending, true);
  assert.equal(assignSessionTitlePrefix(rt.session, new Date(2026, 9, 16, 9).getTime()), true);
  await saveSessionAsync(rt.session, { expectedGeneration: rt.session.generation });
  assert.equal(getSession(rt.session.id).title, '261016-000 | softon_박수한 | 연결 폴더의 최신 프로젝트');
  assert.equal(getSession(rt.session.id).titleLocked, true);
  assert.equal(getSession(rt.session.id).titlePrefixPending, undefined);
  evictLiveSession(rt.session.id);
  assert.equal(getSession(rt.session.id).title, '261016-000 | softon_박수한 | 연결 폴더의 최신 프로젝트');
  assert.equal(await updateSessionGeneratedTitle(rt.session.id, 'Do not replace', 'first'), false);
  assert.equal(await facade.renameSessionTitle(rt.session.id, 'Custom title'), true);
  assert.equal(getSession(rt.session.id).title, 'Custom title');
  assert.equal(creations, 1);
});

test('agent-owned sessions stay excluded and direct ordinary creation waits for real input', () => {
  const countersBefore = counterState();
  const hidden = reservedRuntime('sess_reserved_hidden', { owner: 'agent', agent: 'cycle1-agent' });
  const hiddenSession = materialize(hidden.rt);
  assert.equal(hiddenSession.generatedTitlePrefix, undefined);
  const numberedAt = new Date(2026, 0, 6).getTime();
  assert.equal(assignSessionTitlePrefix(hiddenSession, numberedAt), false);
  const direct = _withRegisteredProviderForTest(
    'title-test',
    { name: 'title-test', contextWindow: 128000 },
    () => createSession({
      provider: 'title-test', model: 'gpt-5.6-sol', cwd: root, skipSkills: true, schemaAllowedTools: [],
    })
  );
  assert.equal(direct.generatedTitlePrefix, undefined);
  assert.equal(counterState(), countersBefore);
  assert.equal(assignSessionTitlePrefix(direct, numberedAt), true);
  assert.equal(direct.generatedTitlePrefix, '260106-000 | ');
});

test('reservations retain their durable address without consuming numbers on rejected admission', () => {
  const countersBefore = counterState();
  const { rt, facade } = reservedRuntime('sess_addressed_title');
  const reservedAt = rt.reservedSessionCreatedAt;
  assert.equal(rt.addressedSessionId, 'sess_addressed_title');
  assert.throws(() => facade.reserveSessionId('sess_another_title'), /cannot be re-keyed/);
  assert.equal(rt.reservedSessionCreatedAt, reservedAt);
  rt.admission = 'terminal';
  assert.throws(() => facade.reserveSessionId('sess_addressed_title'), /closed to new work/);
  assert.equal(rt.reservedSessionCreatedAt, reservedAt);
  reservedRuntime('sess_after_closed_title');
  assert.equal(counterState(), countersBefore);
});

test('an ordinary manual rename cancels pending prefix preservation before the first input', async () => {
  const { rt, facade, boot } = reservedRuntime('sess_renamed_before_input');
  const countersBefore = counterState();
  boot.createCurrentSession = async () => {
    rt.session = materialize(rt);
  };
  assert.equal(await facade.renameSessionTitle(
    rt.reservedSessionId, 'softon_user | Work', { preservePrefix: true },
  ), true);
  assert.equal(await facade.renameSessionTitle(rt.session.id, 'My custom title'), true);
  assert.equal(rt.session.titlePrefixPending, undefined);
  assert.equal(counterState(), countersBefore);
  assert.equal(assignSessionTitlePrefix(rt.session, new Date(2026, 0, 7).getTime()), true);
  assert.equal(rt.session.generatedTitlePrefix, '260107-000 | ');
  assert.equal(rt.session.title, 'My custom title');
});
