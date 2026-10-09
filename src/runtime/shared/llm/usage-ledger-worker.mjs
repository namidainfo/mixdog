// Worker-thread body for UsageLedger.workerRequest. Every operation opens its
// own connection for the request and closes it afterwards, so an idle ledger
// file is never held open by this thread. Reads run inside one transaction so
// multi-query answers see a single committed snapshot; writes use the same
// UsageLedger code (BEGIN IMMEDIATE, busy timeout, insert-or-ignore ids) as
// an in-thread write.
import { DatabaseSync } from 'node:sqlite';
import { serveWorkerRequests } from '../worker-requests.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import { readSessionUsage, rollupUsage } from './usage-ledger-rollup.mjs';
import { readQuotaHistory, readQuotaWindows, selectQuotaSeries } from './usage-ledger-quota.mjs';
import { readCodexQuotaPrior } from './codex-quota-calibration.mjs';
import { withProviderAccount } from '../provider-auth-binding.mjs';
import { loadTokens } from '../../agent/orchestrator/providers/openai-oauth-tokens.mjs';
import { applyUsageRepairIfUnchanged, selectUsageRepairCandidates } from './usage-ledger-repair.mjs';
import { unpricedCountAfter, unpricedPendingCounts } from './usage-pricing-refresh.mjs';

function read(path, query) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    try {
      return query(db);
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

function write(path, update) {
  const ledger = new UsageLedger(path, { existing: true });
  try {
    return update(ledger);
  } finally {
    ledger.close();
  }
}

async function readQuota(path, options, query) {
  const selection = read(path, (db) => selectQuotaSeries(db, options));
  let calibration = null;
  if (process.env.MIXDOG_PERSONAL === '1' && selection?.provider === 'openai-oauth') {
    const accountId = withProviderAccount('openai-oauth', selection.account, () => loadTokens()?.account_id);
    const intervals = await readCodexQuotaPrior({
      accountId, label: selection.label, cachePath: `${path}.codex-calibration.sqlite`,
    });
    calibration = { ...selection, intervals };
  }
  return read(path, (db) => query(db, { ...options, calibration }));
}

function errorOutcome(error) {
  return { error: { message: String(error?.message || error), code: error?.code ?? null } };
}

// One transaction for the whole batch; if it fails, each row gets its own
// transaction so a failure is reported only for the rows it belongs to.
function recordBatch(ledger, rows) {
  try {
    ledger.record(rows);
    return rows.map(() => ({}));
  } catch {
    return rows.map((row) => {
      try {
        ledger.record([row]);
        return {};
      } catch (error) {
        return errorOutcome(error);
      }
    });
  }
}

const operations = {
  rollup: ({ path, options }) => read(path, (db) => rollupUsage(db, options)),
  sessionUsage: ({ path, sessionIds }) => read(path, (db) => readSessionUsage(db, sessionIds)),
  record: ({ path, rows }) => write(path, (ledger) => recordBatch(ledger, rows)),
  recordQuota: ({ path, samples }) => write(path, (ledger) => ledger.recordQuota(samples)),
  quotaHistory: ({ path, options }) => readQuota(path, options, readQuotaHistory),
  quotaWindows: ({ path, options }) => readQuota(path, options, readQuotaWindows),
  unpricedPending: ({ path, now }) => read(path, (db) => unpricedPendingCounts(db, now)),
  unpricedAfter: ({ path, now, latest }) => read(path, (db) => unpricedCountAfter(db, now, latest)),
  repairCandidates: ({ path, ...options }) => read(path, (db) => selectUsageRepairCandidates(db, options)),
  applyRepair: ({ path, ...plan }) => write(path, (ledger) => applyUsageRepairIfUnchanged(ledger, plan)),
};

serveWorkerRequests(({ op, ...payload }) => operations[op](payload));
