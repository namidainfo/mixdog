import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { SidebarUsage, usagePinEntries } from './SidebarUsage.tsx';
import { applyAccountUsageWindows, getUsageDashboardSnapshot, publishUsageDashboard } from './usage-dashboard-store.ts';
import { clearQuotaFocus, peekQuotaFocus } from './usage-surface-mode.ts';
import { initUiLanguage, setUiLanguagePreference } from './i18n.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const RESET = Date.now() + 86_400_000;
const account = (accountId, alias, selected, windows, extra = {}) => ({
  accountId, alias, selected, authenticated: true, windows, status: 'partial', minimalRequestSupported: true, ...extra,
});
const dashboard = () => ({
  rows: [
    {
      id: 'openai-oauth', group: 'oauth', label: 'OpenAI OAuth', authenticated: true,
      accounts: [
        account('a', 'first', true, [{ label: '5H', usedPct: 0, resetAt: RESET }]),
        account('b', 'namidainfo.n', false, [
          { label: '5H', usedPct: 70, resetAt: RESET, windowSeconds: 18_000 },
          { label: '7D', usedPct: 90, resetAt: RESET, windowSeconds: 604_800 },
          { label: 'Spend', limitUsd: 20, usedUsd: 5, remainingUsd: 15 },
          { label: 'Credits', limitCredits: 100, usedCredits: 25, remainingCredits: 75 },
          { label: 'Unknown', resetAt: RESET },
        ]),
        account('gone', 'disconnected', false, [{ label: 'old', usedPct: 0 }], { authenticated: false }),
        account('expired', 'expired', false, [], { reauthRequired: true }),
      ],
      windows: [{ label: '5H', usedPct: 0, resetAt: RESET }],
    },
    {
      id: 'future-oauth', group: 'oauth', label: 'Future', accounts: [
        account('c', 'future alias', true, [], { minimalRequestSupported: false, status: 'hidden' }),
      ],
      windows: [],
    },
  ],
});

async function renderUsage(t, api = {}, value = dashboard(), props = {}) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement'],
    actEnvironment: false,
  });
  const root = createRoot(document.querySelector('main'));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  publishUsageDashboard(value);
  await act(async () => root.render(React.createElement(SidebarUsage, { api, ...props })));
  return { root };
}

test('sidebar shows all actually connected account aliases and selected markers, including unknown providers', async (t) => {
  await renderUsage(t);
  const rows = [...document.querySelectorAll('.sidebar-usage-row')];
  assert.deepEqual(rows.map((row) => row.querySelector('.sidebar-usage-line b').textContent), [
    'Codex (first)', 'Codex (namidainfo.n)', 'Future (future alias)',
  ]);
  assert.deepEqual(rows.map((row) => [row.dataset.usageAccount, row.dataset.accountSelected]), [['a', 'true'], ['b', 'false'], ['c', 'true']]);
  assert.equal(rows[0].querySelector('.sidebar-usage-selected').textContent, 'In use');
  assert.equal(rows[1].querySelector('.sidebar-usage-selected'), null);
  assert.match(rows[2].textContent, /unsupported.*routing unavailable/i);
  assert.match(rows[2].textContent, /Quota unavailable from provider/);
  assert.equal(document.querySelectorAll('.sidebar-usage-request-all').length, 1);
});

test('every window exposes measured remaining quota, exact limit details, reset time and reference tone thresholds', async (t) => {
  await renderUsage(t);
  const meters = [...document.querySelectorAll('[data-usage-account="b"] .sidebar-usage-meter')];
  assert.deepEqual(meters.map((row) => row.querySelector('b').textContent), ['30%', '10%', '—', '—', '—']);
  assert.equal(meters.length, 5);
  assert.ok(meters[0].classList.contains('tone-warning'));
  assert.ok(meters[1].classList.contains('tone-danger'));
  assert.ok(meters[0].classList.contains('glowing'));
  assert.equal(meters[0].querySelector('[role="meter"]').getAttribute('aria-valuenow'), '30');
  assert.equal(meters[0].querySelector('i > i').style.width, '30%');
  assert.equal(meters[0].querySelector('.sidebar-usage-quota-details'), null);
  assert.equal(meters[1].querySelector('.sidebar-usage-quota-details'), null);
  assert.doesNotMatch(meters[0].title + meters[1].title, /18000|604800/);
  assert.match(meters[2].textContent, /Remaining \$15.*Limit \$20.*Used \$5/);
  assert.match(meters[3].textContent, /Remaining 75 credits.*Limit 100 credits.*Used 25 credits/);
  assert.equal(meters[4].querySelector('[role="meter"]'), null);
  assert.match(meters[4].title, /Remaining unavailable/);
  assert.ok(meters[0].querySelector('em').title.includes(new Date(RESET).toLocaleString()));
  const full = document.querySelector('[data-usage-account="a"] .sidebar-usage-meter');
  assert.equal(full.querySelector('b').textContent, '100%');
  assert.ok(!full.classList.contains('tone-warning') && !full.classList.contains('tone-danger'));
  assert.equal(full.querySelector('[role="meter"]').getAttribute('aria-valuetext'), '100% remaining');
});

test('cached account windows are retained completely and pins no longer collapse multiple accounts', async (t) => {
  const value = dashboard();
  value.rows[0].accounts[1].windows = Array.from({ length: 18 }, (_, index) => ({ label: `Quota ${index}`, usedPct: index }));
  await renderUsage(t, {}, value);
  assert.equal(document.querySelectorAll('[data-usage-account="b"] .sidebar-usage-meter').length, 18);
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].accounts[1].windows.length, 18);
  const entries = usagePinEntries(value);
  assert.deepEqual(entries.map((entry) => entry.key), ['openai-oauth:a', 'openai-oauth:b']);
  assert.match(entries[0].label, /Codex \(first\).*In use/);
  assert.equal(entries[1].label, 'Codex (namidainfo.n)');
  assert.equal(entries[1].percent, 17);
});

test('selection updates keep other accounts and their quota instead of replacing the roster', async (t) => {
  await renderUsage(t);
  await act(async () => applyAccountUsageWindows('openai-oauth', [{ label: '7D', usedPct: 50 }], 'b'));
  const rows = [...document.querySelectorAll('[data-usage-provider="codex"]')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.accountSelected, 'false');
  assert.equal(rows[1].dataset.accountSelected, 'true');
  assert.equal(rows[0].querySelector('.sidebar-usage-meter b').textContent, '100%');
  assert.equal(rows[1].querySelector('.sidebar-usage-meter b').textContent, '50%');
});

test('one explicit bulk click invokes once, blocks double clicks, publishes refreshed quota and shows partial failures', async (t) => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const calls = [];
  const api = {
    async invokeCapability(request) {
      calls.push(request);
      assert.equal(request.capability, 'requestConnectedAccountQuotaWindows');
      return pending;
    },
  };
  await renderUsage(t, api);
  assert.deepEqual(calls, [], 'mounting and cadence must never consume quota');
  const button = document.querySelector('.sidebar-usage-request-all');
  await act(async () => { button.click(); button.click(); });
  assert.deepEqual(calls, [{ capability: 'requestConnectedAccountQuotaWindows', args: [] }]);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const refreshed = dashboard();
  refreshed.rows[0].accounts[1].windows[0].usedPct = 71;
  await act(async () => resolve({ value: {
    status: 'completed',
    results: [
      { provider: 'openai-oauth', accountId: 'a', label: 'first', status: 'sent' },
      { provider: 'openai-oauth', accountId: 'b', label: 'namidainfo.n', status: 'failed', message: 'Quota exhausted' },
      { provider: 'future-oauth', accountId: 'c', label: 'future alias', status: 'unsupported', message: 'Account routing unavailable' },
    ],
    dashboard: refreshed,
  } }));
  assert.equal(button.disabled, false);
  assert.equal(document.querySelector('[data-usage-account="b"] .sidebar-usage-meter b').textContent, '29%');
  const notices = document.querySelector('.sidebar-usage-request-results').textContent;
  assert.match(notices, /Request sent; check refreshed quota/);
  assert.match(notices, /namidainfo.n.*Failed.*Quota exhausted/);
  assert.match(notices, /Unsupported.*routing unavailable/);
  assert.equal(document.querySelector('.sidebar-usage-bulk > small'), null);
  assert.doesNotMatch(document.querySelector('.sidebar-usage-request-all').textContent, /reset/i);
});

test('a failed bulk capability reports the error and explicitly refreshes quota without retrying the spend', async (t) => {
  const calls = [];
  const api = {
    async invokeCapability(request) {
      calls.push(request.capability);
      if (request.capability === 'requestConnectedAccountQuotaWindows') throw new Error('Backend busy');
      assert.equal(request.capability, 'getUsageDashboard');
      return { value: dashboard() };
    },
  };
  await renderUsage(t, api);
  await act(async () => document.querySelector('.sidebar-usage-request-all').click());
  assert.deepEqual(calls, ['requestConnectedAccountQuotaWindows', 'getUsageDashboard']);
  assert.match(document.querySelector('.sidebar-usage-bulk').textContent, /Backend busy/);
  assert.equal(document.querySelector('.sidebar-usage-request-all').disabled, false);
});

test('an elapsed reset never fabricates full remaining quota', async (t) => {
  const value = dashboard();
  value.rows[0].accounts[0].windows[0].resetAt = Date.now() - 1_000;
  await renderUsage(t, {}, value);
  const meter = document.querySelector('[data-usage-account="a"] .sidebar-usage-meter');
  assert.equal(meter.querySelector('b').textContent, '—');
  assert.equal(meter.querySelector('[role="meter"]'), null);
  assert.match(meter.querySelector('em').title, /Reset due/);
});

test('account names, window clicks and read-ahead all focus the clicked account, not the selected one', async (t) => {
  const calls = [];
  let opened = 0;
  const api = { async invokeCapability(request) {
    assert.equal(request.capability, 'getQuotaHistory');
    calls.push(request.args[0]);
    return { value: {} };
  } };
  t.after(clearQuotaFocus);
  await renderUsage(t, api, dashboard(), { onOpenStats() { opened++; } });
  const name = document.querySelector('[data-usage-account="b"] .sidebar-usage-line b');
  await act(async () => { name.focus(); name.click(); });
  assert.deepEqual(peekQuotaFocus(), { provider: 'openai-oauth', account: 'b', window: '' });
  assert.deepEqual(calls.at(-1), { provider: 'openai-oauth', account: 'b', window: '', view: 'window' });
  const weekly = document.querySelectorAll('[data-usage-account="b"] .sidebar-usage-meter')[1];
  await act(async () => { weekly.focus(); weekly.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  assert.deepEqual(peekQuotaFocus(), { provider: 'openai-oauth', account: 'b', window: '7D' });
  assert.deepEqual(calls.at(-1), { provider: 'openai-oauth', account: 'b', window: '7D', view: 'window' });
  assert.equal(opened, 2);
});

test('Korean control and quota status distinguish pending, unavailable and evidenced certificate failure', async (t) => {
  const value = dashboard();
  Object.assign(value.rows[0].accounts[0], { stale: true, status: 'checking' });
  Object.assign(value.rows[0].accounts[1], { stale: true, refreshState: 'failed', refreshError: 'fetch failed · UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
  await renderUsage(t, {}, value);
  setUiLanguagePreference('ko');
  await initUiLanguage();
  t.after(async () => { setUiLanguagePreference('en'); await initUiLanguage(); });
  // Publish again to render with the catalog loaded.
  await act(async () => publishUsageDashboard(value));
  assert.equal(document.querySelector('.sidebar-usage-request-all').textContent, '모든 계정에 최소 요청 보내기');
  assert.equal(document.querySelector('.sidebar-usage-bulk > small'), null);
  const notes = () => [...document.querySelectorAll('[data-usage-provider="codex"] [role="status"]')].map((node) => node.textContent);
  assert.equal(notes()[0], '이전에 기록된 할당량 · 갱신 중');
  assert.match(notes()[1], /갱신 실패.*서버 인증서를 검증할 수 없어.*UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  Object.assign(value.rows[0].accounts[0], { status: 'partial', refreshState: 'unavailable' });
  await act(async () => publishUsageDashboard(value));
  assert.equal(notes()[0], '이전에 기록된 할당량 · 갱신 정보 없음');
  assert.doesNotMatch(notes()[0], /실패|인증서|갱신 중/);
});

test('provider-reported ticket expiries survive account caching; aggregate expiry never invents individual expiries', async (t) => {
  const value = dashboard();
  const credits = { availableCount: 2, offerRevision: 'offer', nextExpiresAt: RESET, availableCredits: [{ expiresAt: RESET }, {}] };
  value.rows[0].resetCredits = credits;
  value.rows[0].accounts[0].resetCredits = credits;
  await renderUsage(t, {}, value);
  assert.deepEqual(getUsageDashboardSnapshot().dashboard.rows[0].accounts[0].resetCredits, credits);
  await act(async () => document.querySelector('[aria-label="Reset credit details"]').click());
  const summaries = () => [...document.querySelectorAll('.sidebar-usage-reset-popover li small')].map((node) => node.textContent);
  assert.match(summaries()[0], /Expires/);
  assert.equal(summaries()[1], 'Expiry unavailable');
  assert.match(document.querySelector('.sidebar-usage-reset-credit').textContent, /Next reset credit expiry: Expires/);
  credits.availableCredits = [];
  await act(async () => publishUsageDashboard(value));
  assert.deepEqual(summaries(), ['Expiry unavailable', 'Expiry unavailable']);
  assert.match(document.querySelector('.sidebar-usage-reset-credit').textContent, /Next reset credit expiry: Expires/);
});
