import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const previous = process.env.MIXDOG_DATA_DIR;
const directory = mkdtempSync(join(tmpdir(), 'mixdog-account-dashboard-'));
process.env.MIXDOG_DATA_DIR = directory;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Live provider requests are forbidden in this test.'); };
const { createUsageDashboard } = await import('./usage-dashboard.mjs');
const { normaliseWindows } = await import('./usage-dashboard-model.mjs');
const { registerProviderAccount, readProviderAccountPool, recordProviderAccountUsage } = await import('../../runtime/shared/provider-accounts.mjs');
const { normalizeAnthropicUsage, fetchOAuthUsageSnapshot } = await import('../../runtime/agent/orchestrator/providers/oauth-usage.mjs');
after(async () => {
  // oauth-usage coalesces its disk writes for 250ms; keep the isolated data
  // directory active until those writes have completed.
  await new Promise((resolve) => setTimeout(resolve, 300));
  globalThis.fetch = originalFetch;
  if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

const windows = (usedPct) => [
  { label: '5H', usedPct, resetAt: Date.now() + 3_600_000, windowSeconds: 18_000 },
  { label: 'Spend', limitUsd: 20, usedUsd: 5, remainingUsd: 15 },
  { label: 'Unknown', resetAt: Date.now() + 7_200_000 },
];
const roster = {
  selectedId: 'b',
  accounts: [
    { id: 'a', label: 'first', authenticated: true },
    { id: 'b', label: 'namidainfo.n', authenticated: true },
    { id: 'gone', label: 'gone', authenticated: false },
    { id: 'expired', label: 'expired', authenticated: true, reauthRequired: true },
  ],
};

test('dashboard exposes inactive connected accounts with their own quota, alias and selection', async () => {
  const probes = [];
  const updates = [];
  const options = {
    refresh: true,
    setup: { api: [], oauth: [{ id: 'cursor-oauth', name: 'Cursor', authenticated: false }] },
    listAccounts: (id) => id === 'cursor-oauth' ? roster : { accounts: [] },
    getProvider: () => ({
      forAccount: (id) => ({
        providerAccountId: id,
        async getUsageSnapshot() {
          probes.push(id);
          return { source: 'mock-provider', quotaWindows: windows(id === 'a' ? 12 : 74) };
        },
      }),
    }),
    onUpdate(snapshot) {
      updates.push({ rows: structuredClone(snapshot.rows) });
      if (snapshot.rows[0]?.accounts) snapshot.rows[0].accounts[0].windows.push({ label: 'observer-only' });
    },
  };
  const dashboard = await createUsageDashboard({}, options);
  const row = dashboard.rows[0];
  assert.deepEqual(probes, ['a', 'b']);
  assert.deepEqual(row.accounts.map((account) => [account.accountId, account.alias, account.selected]), [
    ['a', 'first', false], ['b', 'namidainfo.n', true],
  ]);
  assert.equal(row.windows[0].usedPct, 74, 'legacy provider summary stays on the selected account');
  assert.equal(row.accounts[0].windows[0].usedPct, 12);
  assert.equal(row.accounts[1].windows[0].usedPct, 74);
  assert.equal(row.accounts[0].windows[1].remainingUsd, 15);
  assert.equal(row.accounts[0].windows[2].usedPct, undefined);
  assert.equal(row.accounts[0].minimalRequestSupported, true);
  assert.ok(row.accounts.every((account) => !account.stale && account.windows.length === 3));
  assert.ok(updates[0].rows[0].accounts.every((account) => account.status === 'checking'));
  assert.ok(updates.at(-1).rows[0].accounts.every((account) => account.windows.length === 3));

  const unavailable = await createUsageDashboard({}, {
    ...options,
    onUpdate: undefined,
    getProvider: () => ({ forAccount: () => ({ async getUsageSnapshot() { throw new Error('Provider offline'); } }) }),
  });
  assert.deepEqual(unavailable.rows[0].accounts.map((account) => [account.accountId, account.windows[0].usedPct, account.stale]), [
    ['a', 12, true], ['b', 74, true],
  ], 'failed refreshes keep distinct last-known data, never another account quota');
  assert.ok(unavailable.rows[0].accounts.every((account) => account.refreshState === 'failed' && account.refreshError === 'Provider offline'));
});

test('unavailable quota stays unavailable and unsupported routing never probes a global account', async () => {
  let probes = 0;
  const dashboard = await createUsageDashboard({}, {
    refresh: true,
    setup: { oauth: [{ id: 'antigravity-oauth', name: 'Antigravity', authenticated: true }] },
    listAccounts: (id) => id === 'antigravity-oauth' ? { selectedId: 'unseen', accounts: [
      { id: 'unseen', label: 'private', authenticated: true },
      { id: 'stored', label: 'stored', authenticated: true, usage: { windows: [{ label: 'Spend', remainingUsd: 15, limitUsd: 20 }] } },
    ] } : { accounts: [] },
    getProvider: () => ({ async getUsageSnapshot() { probes++; assert.fail('Unsafe global quota probe'); } }),
  });
  const account = dashboard.rows[0].accounts[0];
  assert.equal(probes, 0);
  assert.equal(account.minimalRequestSupported, false);
  assert.deepEqual(account.windows, []);
  assert.equal(account.status, 'hidden');
  const stored = dashboard.rows[0].accounts[1];
  assert.equal(stored.windows[0].remainingUsd, 15);
  assert.equal(stored.stale, true);
  assert.equal(stored.refreshError, 'Account-scoped quota reads are unavailable.');
});

test('quota failure evidence keeps nested TLS codes and never timestamps stale readings as fresh', async () => {
  const options = {
    refresh: true,
    setup: { oauth: [{ id: 'cursor-oauth', authenticated: true }] },
    listAccounts: (id) => id === 'cursor-oauth' ? { selectedId: 'tls', accounts: [{
      id: 'tls', label: 'TLS', authenticated: true,
      usage: { checkedAt: 1_700_000_000_000, windows: [{ label: '5H', usedPct: 42 }] },
    }] } : { accounts: [] },
    getProvider: () => ({ forAccount: () => ({ async getUsageSnapshot() {
      throw new Error('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
    } }) }),
  };
  const row = (await createUsageDashboard({}, options)).rows[0].accounts[0];
  assert.equal(row.refreshState, 'failed');
  assert.match(row.refreshError, /fetch failed.*unable to verify the first certificate.*UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.equal(row.windows[0].usedPct, 42);
  assert.equal(row.updatedAt, 1_700_000_000_000);
  assert.equal(row.stale, true);
  const unknown = (await createUsageDashboard({}, {
    ...options, getProvider: () => ({ forAccount: () => ({ getUsageSnapshot: async () => null }) }),
  })).rows[0].accounts[0];
  assert.equal(unknown.refreshState, 'unavailable');
  assert.equal(unknown.refreshError, undefined);
});

test('dashboard and every caller joining a quota fetch receive the same TLS failure without a second probe', async () => {
  const accountId = 'joining-tls';
  const failure = new Error('fetch failed', {
    cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
  });
  let rejectProbe;
  let probes = 0;
  const probe = new Promise((_, reject) => { rejectProbe = reject; });
  const provider = { forAccount: () => ({ getUsageSnapshot() { probes++; return probe; } }) };
  const route = { provider: 'cursor-oauth', accountId, model: '' };
  // The original caller has no observer, as in a background usage fetch.
  const original = fetchOAuthUsageSnapshot(route, provider, undefined, { force: true });
  const failures = [];
  const joined = [0, 1].map((index) => fetchOAuthUsageSnapshot(route, provider, undefined, {
    force: true, onFailure: (error) => { failures[index] = error; },
  }));
  const dashboard = createUsageDashboard({}, {
    refresh: true,
    setup: { oauth: [{ id: 'cursor-oauth', authenticated: true }] },
    listAccounts: (id) => id === 'cursor-oauth' ? { selectedId: accountId, accounts: [{
      id: accountId, authenticated: true,
      usage: { checkedAt: 1_700_000_000_000, windows: [{ label: '5H', usedPct: 42 }] },
    }] } : { accounts: [] },
    getProvider: () => provider,
  });
  assert.equal(probes, 1);
  rejectProbe(failure);
  const [first, results, value] = await Promise.all([original, Promise.all(joined), dashboard]);
  assert.equal(first, null);
  assert.deepEqual(results, [null, null]);
  assert.equal(failures[0], failure);
  assert.equal(failures[1], failure);
  const account = value.rows[0].accounts[0];
  assert.equal(account.refreshState, 'failed');
  assert.match(account.refreshError, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.equal(account.updatedAt, 1_700_000_000_000);
  assert.equal(account.windows[0].usedPct, 42);
  assert.equal(account.stale, true);
  assert.equal(probes, 1);
  // The established negative-cache behavior is unchanged after settlement.
  assert.equal(await fetchOAuthUsageSnapshot(route, provider), null);
  assert.equal(probes, 1);
});

test('quota normalization and persisted account readings retain every window and reported limit', async () => {
  const source = Array.from({ length: 18 }, (_, index) => ({
    id: `quota-${index}`,
    label: `Window ${index}`,
    usedPct: index,
    resetAt: 1_900_000_000_000 + index,
    windowSeconds: 18_000,
    limitUsd: 20,
    usedUsd: 5,
    remainingUsd: 15,
    limitCredits: 100,
    usedCredits: 25,
    remainingCredits: 75,
  }));
  const normalized = normaliseWindows(source);
  assert.equal(normalized.length, 18);
  assert.deepEqual(normalized[0], { ...source[0], source: 'config' });
  const id = '00000000-0000-4000-8000-000000000003';
  await registerProviderAccount('cursor-oauth', id, { label: 'persist' });
  await recordProviderAccountUsage('cursor-oauth', id, { quotaWindows: normalized });
  const persisted = readProviderAccountPool('cursor-oauth').accounts.find((account) => account.id === id).usage.windows;
  assert.equal(persisted.length, 18);
  assert.deepEqual(persisted[0], normalized[0]);
  assert.deepEqual(normaliseWindows([{ label: 'Unknown' }]), [{ label: 'Unknown', source: 'config' }]);
  assert.equal(normaliseWindows([{ label: 'Remaining', remainingPct: 75 }])[0].usedPct, 25);
});

test('Anthropic retains additional reported windows alongside legacy windows without invented extra balances', () => {
  const snapshot = normalizeAnthropicUsage({
    five_hour: { utilization: 10, limit_window_seconds: 18_000 },
    seven_day: { utilization: 20 },
    limits: [
      { kind: 'session', percent: 10, limit_window_seconds: 18_000 },
      { kind: 'custom', percent: 30, limit_dollars: 10, used_dollars: 3, remaining_dollars: 7 },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 50 },
  });
  assert.deepEqual(snapshot.quotaWindows.map((window) => window.label), ['5H', '7D', 'CUSTOM', 'EXTRA']);
  assert.equal(snapshot.quotaWindows[0].windowSeconds, 18_000);
  assert.equal(snapshot.quotaWindows[2].remainingUsd, 7);
  assert.equal(snapshot.quotaWindows[3].remainingUsd, undefined);
});

test('Anthropic cents become dollars while missing spend remains unknown', () => {
  const known = normalizeAnthropicUsage({
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200 },
  });
  const extra = known.quotaWindows.find((window) => window.label === 'EXTRA');
  assert.equal(extra.limitUsd, 50);
  assert.equal(extra.usedUsd, 12);
  assert.equal(extra.remainingUsd, 38);
  assert.equal(known.balance.remainingUsd, 38);
  const unknown = normalizeAnthropicUsage({
    extra_usage: { is_enabled: true, monthly_limit: 5000 },
  });
  assert.equal(unknown.quotaWindows[0].limitUsd, 50);
  assert.equal(unknown.quotaWindows[0].usedUsd, undefined);
  assert.equal(unknown.quotaWindows[0].remainingUsd, undefined);
  assert.equal(unknown.balance.spentUsd, null);
  assert.equal(unknown.balance.remainingUsd, null);
});

test('each connected account retains its own credit balance and the provider credit setting', async (t) => {
  const probes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.anthropic.com/api/oauth/usage');
    const authorization = new Headers(options.headers).get('authorization');
    probes.push(authorization);
    return new Response(JSON.stringify({
      five_hour: { utilization: 25 },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: authorization === 'Bearer credit-a' ? 1200 : 2300,
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const dashboard = await createUsageDashboard({}, {
    refresh: true,
    setup: { oauth: [{ id: 'anthropic-oauth', authenticated: true }] },
    listAccounts: (provider) => provider === 'anthropic-oauth' ? {
      useCredits: true,
      selectedId: 'credit-a',
      accounts: [
        { id: 'credit-a', authenticated: true },
        { id: 'credit-b', authenticated: true },
      ],
    } : { accounts: [] },
    getProvider: () => ({
      forAccount: (id) => ({ ensureAuth: async () => ({ access_token: id }) }),
    }),
  });
  const row = dashboard.rows[0];
  assert.deepEqual(probes.sort(), ['Bearer credit-a', 'Bearer credit-b']);
  assert.deepEqual(row.accounts.map((account) => [account.accountId, account.credits.balance, account.useCredits]), [
    ['credit-a', 38, true],
    ['credit-b', 27, true],
  ]);
  assert.equal(row.credits.balance, 38);
  assert.equal(row.useCredits, true);
});
