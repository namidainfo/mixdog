import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const directory = mkdtempSync(join(tmpdir(), 'mixdog-account-requests-'));
process.env.MIXDOG_DATA_DIR = directory;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Live provider requests are forbidden in this test.'); };
const { createQuotaAccountRequests, QUOTA_ACCOUNT_REQUEST_CONTENT } = await import('./quota-account-requests.mjs');
const { createAccountPoolProvider } = await import('../../runtime/agent/orchestrator/providers/account-pool.mjs');
const { ACCOUNT_PROVIDERS, readProviderAccountPool, registerProviderAccount } = await import('../../runtime/shared/provider-accounts.mjs');
const { currentProviderAccountId } = await import('../../runtime/shared/provider-auth-binding.mjs');
const { createSetupApi } = await import('../provider-auth/setup.mjs');
const { createSessionIntegrationsApi } = await import('../../tui/session/session-api/integrations.mjs');
after(() => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
});

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const emptyPool = { accounts: [] };
const connected = (id, label = id) => ({ id, label, authenticated: true, reauthRequired: false });
const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';

test('every connected OAuth account gets one isolated minimal send, including non-selected accounts', async () => {
  const providers = new Map();
  const sends = [];
  const before = new Map();
  const expectedRequests = ACCOUNT_PROVIDERS.length * 2;
  for (const provider of ACCOUNT_PROVIDERS) {
    await registerProviderAccount(provider, FIRST, { label: 'first' });
    await registerProviderAccount(provider, SECOND, { label: 'namidainfo.n' });
    before.set(provider, readProviderAccountPool(provider));
    providers.set(provider, createAccountPoolProvider(provider, () => ({
      async listModels() { return [{ id: `${provider}-catalog-model`, reasoningLevels: ['low', 'high'] }]; },
      async send(messages, model, tools, options) {
        const accountId = currentProviderAccountId(provider);
        sends.push({ provider, accountId, messages, model, tools, options });
        await Promise.resolve();
        assert.equal(currentProviderAccountId(provider), accountId, 'account binding must survive asynchronous work');
        return { content: 'OK' };
      },
    })));
  }
  let refreshes = 0;
  const dashboard = { rows: [] };
  const request = createQuotaAccountRequests({
    getProvider: (id) => providers.get(id),
    listAccounts: (id) => ({
      ...before.get(id),
      accounts: [connected(FIRST, 'first'), connected(SECOND, 'namidainfo.n'), { id: 'gone', authenticated: false }, { ...connected('reauth'), reauthRequired: true }],
    }),
    refreshQuota: async () => { refreshes++; assert.equal(sends.length, expectedRequests); return dashboard; },
  });
  const result = await request();
  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, expectedRequests);
  assert.ok(result.results.every((row) => row.status === 'sent'));
  assert.equal(result.dashboard, dashboard);
  assert.equal(refreshes, 1);
  assert.equal(new Set(sends.map(({ options }) => options.sessionId)).size, expectedRequests);
  for (const provider of ACCOUNT_PROVIDERS) {
    assert.deepEqual(sends.filter((row) => row.provider === provider).map((row) => row.accountId), [FIRST, SECOND]);
    assert.deepEqual(readProviderAccountPool(provider), before.get(provider), 'selected account and account pool must not change');
    assert.equal(currentProviderAccountId(provider), FIRST);
  }
  for (const send of sends) {
    assert.deepEqual(send.messages, [{ role: 'user', content: QUOTA_ACCOUNT_REQUEST_CONTENT }]);
    assert.deepEqual(send.tools, []);
    assert.equal(send.model, `${send.provider}-catalog-model`);
    assert.equal(send.options.effort, 'low');
    assert.equal(send.options.serverFallback, false);
    assert.match(send.options.sessionId, /^quota-window:/);
    assert.equal(send.options.signal.aborted, false);
  }
});

test('unsupported routing and per-account errors do not stop other accounts, and refresh still runs', async () => {
  const sent = [];
  let refreshes = 0;
  const request = createQuotaAccountRequests({
    listAccounts: (id) => id === 'openai-oauth' ? { accounts: [connected('catalog-fail'), connected('send-fail'), connected('ok')] }
      : id === 'cursor-oauth' ? { accounts: [connected('unsupported')] } : emptyPool,
    getProvider: (provider) => provider === 'cursor-oauth' ? { send() { assert.fail('Must not use a global sender'); } } : {
      forAccount: (id) => ({
        providerAccountId: id,
        async listModels() {
          if (id === 'catalog-fail') throw new Error('Catalog denied');
          return [{ id: 'mock-model' }];
        },
        async send() {
          sent.push(id);
          if (id === 'send-fail') throw new Error('Quota exhausted');
          return { content: 'OK' };
        },
      }),
    },
    refreshQuota: async () => { refreshes++; throw new Error('Refresh unavailable'); },
  });
  const result = await request();
  assert.deepEqual(result.results.map((row) => [row.accountId, row.status]), [
    ['catalog-fail', 'failed'], ['send-fail', 'failed'], ['ok', 'sent'], ['unsupported', 'unsupported'],
  ]);
  assert.deepEqual(sent, ['send-fail', 'ok']);
  assert.equal(result.refreshError, 'Refresh unavailable');
  assert.equal(refreshes, 1);
});

test('bulk busy protection spans callers and the quota refresh; it does not queue another spend', async () => {
  const started = deferred();
  const sendGate = deferred();
  const refreshStarted = deferred();
  const refreshGate = deferred();
  let sends = 0;
  const options = {
    listAccounts: (id) => id === 'openai-oauth' ? { accounts: [connected('a')] } : emptyPool,
    getProvider: () => ({ forAccount: (id) => ({
      providerAccountId: id,
      async listModels() { return [{ id: 'mock-model' }]; },
      async send() { sends++; started.resolve(); await sendGate.promise; return { content: 'OK' }; },
    }) }),
    refreshQuota: async () => { refreshStarted.resolve(); await refreshGate.promise; return { rows: [] }; },
  };
  const first = createQuotaAccountRequests(options)();
  await started.promise;
  await assert.rejects(createQuotaAccountRequests(options), /already running/);
  sendGate.resolve();
  await refreshStarted.promise;
  await assert.rejects(createQuotaAccountRequests(options), /already running/);
  refreshGate.resolve();
  await first;
  assert.equal(sends, 1);
});

test('a timed-out catalog never sends later, and an in-flight timeout aborts the account request', async () => {
  const catalog = deferred();
  let sends = 0;
  let observedSignal;
  const request = createQuotaAccountRequests({
    timeoutMs: 15,
    listAccounts: (id) => id === 'openai-oauth' ? { accounts: [connected('catalog'), connected('send')] } : emptyPool,
    getProvider: () => ({ forAccount: (id) => ({
      providerAccountId: id,
      async listModels() { return id === 'catalog' ? catalog.promise : [{ id: 'mock-model' }]; },
      async send(_messages, _model, _tools, options) {
        sends++;
        observedSignal = options.signal;
        return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      },
    }) }),
    refreshQuota: async () => ({ rows: [] }),
  });
  const result = await request();
  assert.ok(result.results.every((row) => row.status === 'failed' && /may have consumed quota/.test(row.message)));
  assert.equal(observedSignal.aborted, true);
  catalog.resolve([{ id: 'mock-model' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
});

test('a mismatched account binding is unsupported rather than simulated success', async () => {
  const result = await createQuotaAccountRequests({
    listAccounts: (id) => id === 'openai-oauth' ? { accounts: [connected('b')] } : emptyPool,
    getProvider: () => ({ forAccount: () => ({
      providerAccountId: 'a',
      send() { assert.fail('Wrong account must never send'); },
      listModels() { assert.fail('Wrong account must never discover'); },
    }) }),
    refreshQuota: async () => ({ rows: [] }),
  })();
  assert.equal(result.results[0].status, 'unsupported');
});

test('provider-auth and session capability wrappers delegate without changing session state', async () => {
  const calls = [];
  const result = { status: 'completed', results: [] };
  const runtime = createSetupApi({
    awaitKeychainPrewarm: async () => { calls.push('keychain'); },
    requestConnectedAccountQuotaWindows: async () => { calls.push('bulk'); return result; },
  });
  const sessionApi = createSessionIntegrationsApi({
    runtime,
    getState: () => ({ session: 'existing' }),
    set() { assert.fail('Must not mutate session state'); },
    pushNotice() { assert.fail('Must not append a session notice'); },
    routeState() { assert.fail('Must not change session routes'); },
    resetStatsAndSyncContext() { assert.fail('Must not change session usage'); },
  }, { oauthFlows: new Map() });
  assert.equal(await sessionApi.requestConnectedAccountQuotaWindows(), result);
  assert.deepEqual(calls, ['keychain', 'bulk']);
  const unavailable = createSetupApi({ awaitKeychainPrewarm: async () => {} });
  await assert.rejects(unavailable.requestConnectedAccountQuotaWindows, /unavailable/);
});
