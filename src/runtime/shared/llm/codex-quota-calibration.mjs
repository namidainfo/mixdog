// Read-only Codex source, separate numeric cache. Nothing here writes usage
// records to Mixdog's ledger. Missing identity/price is not inferred as zero.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { priceUsage } from './cost.mjs';
import { QUOTA_SCHEMA, readQuotaCalibration, recordQuotaSamples } from './usage-ledger-quota.mjs';

const TOKEN_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
const inflight = new Map();
const text = (value) => typeof value === 'string' ? value : '';

function tokens(value) {
  if (!value) return null;
  const result = TOKEN_KEYS.map((key) => key === 'cache_write_input_tokens' ? value[key] ?? 0 : value[key]);
  return result.every((number) => Number.isSafeInteger(number) && number >= 0) ? result : null;
}

/** Extract only account/model/time/counters/meter readings; never retain text. */
export async function readCodexCalibrationFile(path, size) {
  if (size === 0) return { accountId: '', sessionId: '', entries: [] };
  const lines = createInterface({ input: createReadStream(path, { end: size - 1 }), crlfDelay: Infinity });
  const document = { accountId: '', sessionId: '', entries: [] };
  let model = '';
  let tier = '';
  let previous = null;
  let pending = null;
  let lineNumber = 0;
  const accept = (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); }
    catch { throw new Error(`Invalid Codex calibration source: ${path}:${lineNumber}`); }
    const payload = row.payload;
    if (row.type === 'session_meta') {
      document.accountId = text(payload?.creator_account_id);
      document.sessionId = text(payload?.session_id || payload?.id);
    } else if (row.type === 'turn_context') {
      model = text(payload?.model);
      tier = text(payload?.service_tier);
    } else if (row.type === 'event_msg' && payload?.type === 'token_count') {
      const ts = Date.parse(row.timestamp);
      if (!Number.isSafeInteger(ts) || ts <= 0) return;
      const total = tokens(payload.info?.total_token_usage);
      const last = tokens(payload.info?.last_token_usage);
      let usage = null;
      let usageId = '';
      if (total && (!previous || total.some((value, index) => value !== previous[index]))) {
        usageId = total.join(':');
        // A gap or counter reset cannot establish request/model boundaries.
        // Mark it unpriced rather than price a cumulative sum as one prompt.
        if (last && total.every((value, index) => value - (previous?.[index] ?? 0) === last[index])) usage = last;
      }
      if (total) previous = total;
      const limits = payload.rate_limits;
      const readings = [];
      if (limits && (!limits.limit_id || limits.limit_id === 'codex')) {
        for (const window of [limits.primary, limits.secondary]) {
          const label = window?.window_minutes === 300 ? '5H' : window?.window_minutes === 10080 ? '7D' : '';
          const usedPct = window?.used_percent;
          const resetAt = window?.resets_at * 1000;
          if (label && Number.isFinite(usedPct) && usedPct >= 0 && usedPct <= 100 &&
              Number.isSafeInteger(resetAt) && resetAt > ts) readings.push({ label, usedPct, resetAt });
        }
      }
      document.entries.push({ ts, model, tier, usageId, usage, readings });
    }
  };
  try {
    // Delay the last line: an actively appended JSONL may end mid-record.
    // Invalid completed records remain errors, not silently missing evidence.
    for await (const line of lines) {
      if (pending !== null) accept(pending);
      pending = line;
    }
    if (pending !== null) {
      try { JSON.parse(pending); }
      catch {
        // A newline-terminated invalid record is not a torn append.
        const tail = createReadStream(path, { start: size - 1, end: size - 1 });
        let lastByte;
        for await (const chunk of tail) lastByte = chunk[0];
        if (lastByte === 10 || lastByte === 13) accept(pending);
        return document;
      }
      accept(pending);
    }
    return document;
  } finally {
    lines.close();
  }
}

async function sourceFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function loadPrior({ accountId, label, cachePath = ':memory:',
  directory = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), price = priceUsage }) {
  if (!accountId || !['5H', '7D'].includes(label)) return [];
  const files = await sourceFiles(directory);
  if (!files.length) return [];
  const cache = new DatabaseSync(cachePath);
  const meters = new DatabaseSync(':memory:');
  try {
    cache.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codex_files (
        path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, document TEXT NOT NULL
      );`);
    meters.exec(QUOTA_SCHEMA);
    const find = cache.prepare('SELECT size,mtime,document FROM codex_files WHERE path=?');
    const save = cache.prepare('INSERT OR REPLACE INTO codex_files VALUES (?,?,?,?)');
    const frames = [];
    for (const path of files) {
      const identity = await stat(path);
      const stored = find.get(path);
      let document;
      if (stored && stored.size === identity.size && stored.mtime === identity.mtimeMs) {
        document = JSON.parse(stored.document);
      } else {
        document = await readCodexCalibrationFile(path, identity.size);
        save.run(path, identity.size, identity.mtimeMs, JSON.stringify(document));
      }
      if (document.accountId === accountId && document.sessionId) {
        for (const entry of document.entries) frames.push({ ...entry, sessionId: document.sessionId });
      }
    }
    frames.sort((a, b) => a.ts - b.ts);
    const seen = new Set();
    const events = [];
    const samples = [];
    for (const frame of frames) {
      for (const reading of frame.readings) {
        samples.push({ provider: 'openai-oauth', account: accountId, ts: frame.ts, ...reading });
      }
      if (!frame.usageId) continue;
      const key = `${frame.sessionId}:${frame.usageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens] = frame.usage || [0, 0, 0, 0];
      const priced = frame.usage && frame.model ? price({
        provider: 'openai-oauth', kind: 'oauth', model: frame.model, ts: frame.ts,
        inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens,
        requestServiceTier: frame.tier,
      }) : { costUsd: null };
      events.push({
        ts: frame.ts, tokens: inputTokens + outputTokens, turns: 1,
        costUsd: priced.costUsd ?? 0, costKnownTurns: priced.costUsd === null ? 0 : 1,
      });
    }
    recordQuotaSamples(meters, samples);
    return readQuotaCalibration(meters, { provider: 'openai-oauth', account: accountId, label }, events);
  } finally {
    meters.close();
    cache.close();
  }
}

export function readCodexQuotaPrior(options) {
  const key = JSON.stringify([options.directory, options.cachePath, options.accountId, options.label]);
  if (inflight.has(key)) return inflight.get(key);
  const task = loadPrior(options).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
