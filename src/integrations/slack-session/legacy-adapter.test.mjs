import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLegacySlackAdapter } from './legacy-adapter.mjs';

async function harness(t, { admin = 'T1:U1' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'softon-legacy-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = {
    MIXDOG_SLACK_NODE: process.execPath, MIXDOG_SLACK_WORKER: 'worker.mjs',
    MIXDOG_SLACK_RUNTIME_ROOT: directory, MIXDOG_SLACK_STATE_FILE: path.join(directory, 'native.json'),
    MIXDOG_HUB_ORIGIN: 'http://127.0.0.1:0', MIXDOG_HUB_ADMINS: admin,
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const allowed = new Set(['U1', 'U2']), authorization = [], authCalls = [];
  const config = { stateFile: path.join(directory, 'jaw.json'), slackBotToken: 'test-token',
    jawAllowedUserIds: allowed, jawAllowedChannelIds: new Set(['C1']), jawRelayEnabled: true };
  class StateStore {
    constructor(file) { this.file = file; this.rows = []; }
    listConversations() { return this.rows; }
  }
  const deps = {
    config, StateStore, legacyStore: {}, api: {}, resolveIdentity: async (id) => id,
    client: { auth: { test: async (input) => { authCalls.push(input); return { ok: true, team_id: 'T1' }; } } },
    helpers: { isJawRequestAuthorized(message) {
      authorization.push(message);
      return config.jawRelayEnabled && !message.bot_id && allowed.has(message.user)
        && config.jawAllowedChannelIds.has(message.channel);
    } },
  };
  return { deps, allowed, authorization, authCalls };
}
test('the existing approval policy authenticates empty-session users and rechecks revocation and workspace', async (t) => {
  const h = await harness(t), relay = await createLegacySlackAdapter(h.deps);
  t.after(() => relay.close());
  assert.equal(await relay.transport.hubRequest('authorize', { team: 'T1', user: 'U2' }), true);
  assert.equal(h.authorization[0].channel, 'C1');
  assert.equal(await relay.transport.hubRequest('authorize', { team: 'T2', user: 'U2' }), false);
  assert.equal(await relay.transport.hubRequest('authorize', { team: 'T1', user: 'U0' }), false);
  h.allowed.delete('U2');
  assert.equal(await relay.transport.hubRequest('authorize', { team: 'T1', user: 'U2' }), false);
  assert.equal(h.authCalls.length, 1);
  assert.deepEqual(relay.store.listConversations(), []);
});
test('an administrator outside the authenticated workspace cannot be configured', async (t) => {
  const h = await harness(t, { admin: 'T2:U1' });
  await assert.rejects(createLegacySlackAdapter(h.deps), /같은 Slack 워크스페이스/u);
});

test('execution roles come only from the approved workspace and stored owner, not request claims', async (t) => {
  const h = await harness(t), relay = await createLegacySlackAdapter(h.deps);
  t.after(() => relay.close());
  const access = (input) => relay.transport.hubRequest('executionAccess', input);
  const member = await access({ principal: { teamId: 'T1', userId: 'U2', admin: true, root: 'outside' } });
  assert.equal(member.active, true); assert.equal(member.admin, false);
  assert.equal((await access({ principal: { teamId: 'T1', userId: 'U1' } })).admin, true);
  await assert.rejects(access({ principal: { teamId: 'T2', userId: 'U1' } }), /소유자/u);
  relay.store.rows.push(['member', { teamId: 'T1', actorId: 'U2',
    nativeSessionId: 'existing', nativeSessionHistory: ['rotated'], requests: {} }]);
  const stored = await access({ sessionId: 'rotated', principal: { teamId: 'T1', userId: 'U1' } });
  assert.equal(stored.userId, 'U2'); assert.equal(stored.admin, false);
  h.allowed.delete('U2');
  assert.equal((await access({ sessionId: 'existing' })).active, false);
  relay.store.rows.push(['collision', { teamId: 'T1', actorId: 'U1', nativeSessionId: 'existing', requests: {} }]);
  await assert.rejects(access({ sessionId: 'existing' }), /소유자/u);
  await assert.rejects(access({ sessionId: 'unknown' }), /소유자/u);
});
test('an unapproved account cannot be configured as an administrator', async (t) => {
  const h = await harness(t, { admin: 'T1:U0' });
  await assert.rejects(createLegacySlackAdapter(h.deps), /기존 승인 사용자/u);
});
