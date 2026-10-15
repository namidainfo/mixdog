import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readCodexQuotaPrior } from './codex-quota-calibration.mjs';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';

const MINUTE = 60_000;
const start = Date.UTC(2026, 8, 1);
const stamp = (index) => start + index * MINUTE;
const usage = (input, cached = 0, output = 0) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output,
  reasoning_output_tokens: output, total_tokens: input + output,
});
const event = (index, total, last, five, week, reset = start + 5 * 60 * MINUTE) => ({
  timestamp: new Date(stamp(index)).toISOString(), type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last },
    rate_limits: { limit_id: 'codex', plan_type: 'team',
      primary: { used_percent: five, window_minutes: 300, resets_at: reset / 1000 },
      secondary: { used_percent: week, window_minutes: 10080, resets_at: (start + 7 * 24 * 60 * MINUTE) / 1000 },
    } },
});
const log = () => [
  { type: 'session_meta', payload: { id: 'codex-session', creator_account_id: 'account-a', instructions: 'SECRET_PROMPT' } },
  { type: 'turn_context', payload: { model: 'source-model', service_tier: 'priority' } },
  event(1, usage(100, 50, 10), usage(100, 50, 10), 10, 10),
  event(2, usage(200, 100, 20), usage(100, 50, 10), 11, 12),
  event(3, usage(200, 100, 20), usage(100, 50, 10), 11, 12),
  event(4, usage(300, 150, 30), usage(100, 50, 10), 12, 14),
];
const serialize = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-codex-prior-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout-source.jsonl');
  writeFileSync(path, serialize(log()));
  return { directory, path, cachePath: join(directory, 'cache.sqlite'), accountId: 'account-a' };
}
function price(args) {
  assert.equal(args.provider, 'openai-oauth');
  assert.equal(args.model, 'source-model');
  assert.equal(args.requestServiceTier, 'priority');
  // Inclusive input is 100, of which 50 is cached. Reasoning is already
  // included in the 10 output tokens; it is not charged twice.
  assert.equal(args.outputTokens, 10);
  return { costUsd: (args.inputTokens - args.cacheReadTokens) * 0.01 + args.cacheReadTokens * 0.001 + args.outputTokens * 0.02 };
}

test('Codex counters and copied logs calibrate once, with distinct 5H and 7D evidence', async (t) => {
  const options = fixture(t);
  writeFileSync(join(options.directory, 'rollout-copy.jsonl'), readFileSync(options.path));
  const original = readFileSync(options.path);
  const five = await readCodexQuotaPrior({ ...options, label: '5H', price });
  const week = await readCodexQuotaPrior({ ...options, label: '7D', price });
  assert.equal(five.length, 2);
  assert.deepEqual(five.map((row) => [row.points, row.costUsd]), [[1, 0.75], [1, 0.75]]);
  assert.deepEqual(week.map((row) => [row.points, row.costUsd]), [[2, 0.75], [2, 0.75]]);
  assert.deepEqual(readFileSync(options.path), original);
  assert.deepEqual(await readCodexQuotaPrior({ ...options, accountId: 'other-account', label: '5H', price }), []);
  assert.deepEqual(await readCodexQuotaPrior({ ...options, accountId: '', label: '5H', price }), []);
  const cache = new DatabaseSync(options.cachePath, { readOnly: true });
  try {
    for (const row of cache.prepare('SELECT document FROM codex_files').all()) {
      assert.equal(row.document.includes('SECRET_PROMPT'), false);
      assert.equal(row.document.includes('instructions'), false);
    }
  } finally { cache.close(); }
});

test('numeric cache refreshes changed logs and never prices unknown or missing request boundaries', async (t) => {
  const options = fixture(t);
  await readCodexQuotaPrior({ ...options, label: '5H', price });
  appendFileSync(options.path, serialize([event(5, usage(400, 200, 40), usage(100, 50, 10), 13, 16)]));
  assert.equal((await readCodexQuotaPrior({ ...options, label: '5H', price })).length, 3);
  assert.deepEqual(await readCodexQuotaPrior({ ...options, label: '5H', price: () => ({ costUsd: null }) }), []);
  const missing = log();
  missing[3] = event(2, usage(300, 150, 30), usage(100, 50, 10), 11, 12);
  writeFileSync(options.path, serialize(missing.slice(0, 4)));
  assert.deepEqual(await readCodexQuotaPrior({ ...options, label: '5H', price }), []);
});

test('torn append is deferred, while malformed completed source is an error', async (t) => {
  const options = fixture(t);
  appendFileSync(options.path, '{"timestamp":');
  assert.equal((await readCodexQuotaPrior({ ...options, label: '5H', price })).length, 2);
  appendFileSync(options.path, '\n');
  await assert.rejects(readCodexQuotaPrior({ ...options, label: '5H', price }), /Invalid Codex calibration source/);
});

test('a reset cannot train a percentage drop or an inferred first reading', async (t) => {
  const options = fixture(t);
  const rows = log().slice(0, 4);
  rows.push(event(4, usage(300, 150, 30), usage(100, 50, 10), 1, 14, start + 10 * 60 * MINUTE));
  rows.push(event(5, usage(400, 200, 40), usage(100, 50, 10), 2, 16, start + 10 * 60 * MINUTE));
  writeFileSync(options.path, serialize(rows));
  const prior = await readCodexQuotaPrior({ ...options, label: '5H', price });
  assert.deepEqual(prior.map((row) => row.points), [1, 1]);
});

test('external prior changes only inference, never ledger totals, source models or observed chart points', async (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const opened = start + 24 * 60 * MINUTE;
  const selection = { provider: 'openai-oauth', account: 'default', label: '5H' };
  const sample = (ts, usedPct) => ({ ...selection, ts, usedPct, resetAt: opened + 5 * 60 * MINUTE });
  ledger.recordQuota([sample(opened, 0), sample(opened + MINUTE, 1), sample(opened + 3 * MINUTE, 2)]);
  const request = makeUsageRecord({
    provider: 'openai-oauth', model: 'mixdog-only-model', account: 'default', sessionId: 'local-session',
    ts: opened + 2 * MINUTE, inputTokens: 100, outputTokens: 10,
  });
  ledger.record([{ ...request, costUsd: 1, costSource: 'subscription' }]);
  const options = { ...selection, now: opened + 4 * MINUTE };
  const before = await ledger.quotaHistoryAsync(options);
  const intervals = [{ fromMs: stamp(1), toMs: stamp(2), points: 1, costUsd: 1, priced: true, measured: true, resolution: 1 }];
  const calibration = { ...selection, intervals };
  const after = await ledger.quotaHistoryAsync({ ...options, calibration });
  assert.equal(before.summary.costPerPercent, null);
  assert.ok(Math.abs(after.summary.costPerPercent - 1) < 0.02);
  assert.equal(after.totals.costUsd, 1);
  assert.equal(after.totals.turns, 1);
  assert.equal(after.totals.tokens, before.totals.tokens);
  assert.deepEqual(after.models.map((row) => row.model), ['mixdog-only-model']);
  assert.deepEqual(after.points, before.points);
  assert.deepEqual(after.subscriptions, before.subscriptions);
  assert.equal(after.summary.consumed, before.summary.consumed);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM quota_samples').get().n, 3);
  const windows = await ledger.quotaWindowsAsync({ ...options, calibration });
  assert.ok(Math.abs(windows.windows[0].costPerPercent - 1) < 0.02);
  for (const extra of [{ account: 'other' }, { label: '7D' }, { provider: 'anthropic-oauth' },
    { intervals: [{ ...intervals[0], fromMs: opened + 10 * MINUTE, toMs: opened + 11 * MINUTE }] }]) {
    const ignored = await ledger.quotaHistoryAsync({ ...options, calibration: { ...calibration, ...extra } });
    assert.equal(ignored.summary.costPerPercent, null);
  }
});

test('the personal ledger worker applies only an authenticated matching Codex account', (t) => {
  const options = fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = process.env.MIXDOG_DATA_DIR;
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', 'rollout-source.jsonl'),
      readFileSync(join(dir, 'rollout-source.jsonl'), 'utf8').replace('"service_tier":"priority"', '"service_tier":"default"'));
    writeFileSync(join(dir, 'openai-oauth.json'), JSON.stringify({
      account_id: 'account-a', access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    }));
    writeFileSync(join(dir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {
      openai: { models: { 'source-model': { cost: { input: 10000, output: 20000, cache_read: 1000 } } } },
    } }));
    const { UsageLedger, makeUsageRecord } = await import('./src/runtime/shared/llm/usage-ledger.mjs');
    const ledger = new UsageLedger(join(dir, 'usage.sqlite'));
    const start = ${start + 24 * 60 * MINUTE};
    const sample = (ts, usedPct) => ({
      provider: 'openai-oauth', account: 'default', label: '5H', ts, usedPct, resetAt: start + 5 * 60 * 60000,
    });
    ledger.recordQuota([sample(start, 0), sample(start + 60000, 1), sample(start + 180000, 2)]);
    ledger.record([{ ...makeUsageRecord({
      provider: 'openai-oauth', model: 'local-only-model', account: 'default', sessionId: 'local-session',
      ts: start + 120000, inputTokens: 100, outputTokens: 10,
    }), costUsd: 0.75, costSource: 'subscription' }]);
    const query = { provider: 'openai-oauth', account: 'default', label: '5H', now: start + 240000 };
    const history = await ledger.quotaHistoryAsync(query);
    assert.ok(Math.abs(history.summary.costPerPercent - 0.75) < 0.02);
    assert.equal(history.totals.costUsd, 0.75);
    assert.deepEqual(history.models.map(row => row.model), ['local-only-model']);
    writeFileSync(join(dir, 'openai-oauth.json'), JSON.stringify({
      account_id: 'different-account', access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    }));
    const mismatch = await ledger.quotaHistoryAsync(query);
    assert.equal(mismatch.summary.costPerPercent, null);
    ledger.close();
  `], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, MIXDOG_DATA_DIR: options.directory, MIXDOG_PERSONAL: '1',
      CODEX_HOME: options.directory, MIXDOG_USAGE_LEDGER_WORKER_IDLE_MS: '100' },
    windowsHide: true,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
