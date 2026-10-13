import {
  fetchOAuthUsageSnapshot,
  readCachedOAuthUsageSnapshot,
} from '../../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import {
  fetchOpenCodeGoUsageSnapshot,
  openCodeGoUsageConfigStatus,
  readCachedOpenCodeGoUsageSnapshot,
} from '../../runtime/agent/orchestrator/providers/opencode-go-usage.mjs';
import {
  fetchApiUsageSnapshot,
  readCachedApiUsageSnapshot,
} from '../../runtime/agent/orchestrator/providers/api-usage.mjs';
import { num } from '../../runtime/agent/orchestrator/providers/lib/usage-primitives.mjs';
import { ACCOUNT_PROVIDERS } from '../../runtime/shared/provider-accounts.mjs';
import { listProviderAccounts } from './provider-admin.mjs';
import { usageErrorDetails } from './usage-error.mjs';
import {
  creditsFromSnapshot,
  applyApiUnavailable,
  applyKnownRemaining,
  applyKnownUsage,
  applyTokenUsage,
  applyWindowQuota,
  baseRow,
  clean,
  displayWindow,
  localBudget,
  normaliseResetCredits,
  normaliseWindows,
  rowTone,
  snapshotRemaining,
  snapshotTokenUsage,
  snapshotUsage,
  usageDashboardSnapshot,
} from './usage-dashboard-model.mjs';

const CREDIT_PROVIDERS = new Set(['openai-oauth', 'anthropic-oauth']);

async function oauthSnapshot(providerId, { refresh, getProvider, log }, accountId) {
  const route = { provider: providerId, model: '', ...(accountId ? { accountId } : {}) };
  const cached = readCachedOAuthUsageSnapshot(route);
  if (!refresh && cached) return { snapshot: cached };
  // A rate-limited or failed forced refresh (Anthropic /oauth/usage 429s
  // aggressively) must not blank a known quota row: fall back to the last
  // contentful snapshot — a stale meter with its updatedAt beats an empty row.
  let refreshError = '';
  const staleFallback = () => {
    const snapshot = cached || readCachedOAuthUsageSnapshot(route, { allowStale: true });
    return {
      snapshot: snapshot ? { ...snapshot, stale: true } : null,
      refreshState: refreshError ? 'failed' : 'unavailable',
      ...(refreshError ? { refreshError } : {}),
    };
  };
  if (typeof getProvider === 'function') {
    try {
      const providerObj = getProvider(providerId);
      if (providerObj) {
        if (accountId && typeof providerObj.forAccount !== 'function') {
          refreshError = 'Account-scoped quota reads are unavailable.';
          return staleFallback();
        }
        const fresh = await fetchOAuthUsageSnapshot(route, providerObj, log, {
          force: refresh === true,
          onFailure: (error) => { refreshError = usageErrorDetails(error); },
        });
        // Some providers return a fallback reading after a failed measurement.
        // It must not be presented as freshly verified quota.
        return fresh && !refreshError ? { snapshot: fresh } : staleFallback();
      }
    } catch (error) {
      refreshError = usageErrorDetails(error);
      return staleFallback();
    }
  }
  return staleFallback();
}

async function apiSnapshot(providerId, { refresh } = {}) {
  const cached = readCachedApiUsageSnapshot(providerId);
  if (!refresh && cached) return cached;
  try {
    return await fetchApiUsageSnapshot(providerId, { force: refresh === true });
  } catch {
    return cached;
  }
}

function emitUsageDashboard(options, dashboard) {
  if (typeof options?.onUpdate !== 'function') return;
  try {
    options.onUpdate(usageDashboardSnapshot(dashboard.rows, dashboard));
  } catch {
    // UI progress callbacks should never break the usage refresh itself.
  }
}

// An account switch invalidates ONE provider's quota, but a plain refresh
// forces a live call for every connected provider and the surface only paints
// when the slowest of them answers. `refreshProviders` keeps the live sweep on
// the providers that actually changed; the rest serve their existing snapshots,
// exactly as an unforced read would.
function refreshScope(options) {
  const requested = options?.refreshProviders;
  if (!Array.isArray(requested) || !requested.length) return null;
  const ids = requested
    .slice(0, 16)
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

/** One API-key provider row. Two stages: paint what auth alone already says,
 *  then resolve whatever usage the provider — or a local budget fallback — can
 *  supply. The row is appended to `rows` before the first emit so every paint
 *  from here on includes it. */
async function apiProviderRow(item, { config, providers, preview, refreshFor, snapshotOptions, rows, emit }) {
  const providerCfg = providers[item.id] || {};
  const row = baseRow(item, 'api', providerCfg);
  row.status = row.authenticated ? 'checking' : 'missing';
  row.source = row.authenticated ? 'checking' : 'not-configured';
  row.sourceLabel = row.authenticated ? 'checking' : 'no key';
  row.primary = row.authenticated ? '' : 'not configured';
  row.detail = row.authenticated ? 'Checking provider usage' : 'Configure auth';
  row.tone = rowTone(row);
  rows.push(row);
  emit(true);

  if (preview) {
    return row;
  }

  // The unauthenticated presentation is already on the row from the initial
  // paint above; only a configured provider still has usage to resolve.
  if (row.authenticated) {
    let hasQuota = false;
    let apiUsageSnapshot = null;
    if (item.id === 'opencode-go') {
      const usageStatus = openCodeGoUsageConfigStatus(config);
      try {
        let snapshot = null;
        if (refreshFor(item.id)) snapshot = await fetchOpenCodeGoUsageSnapshot(config, { force: true });
        else snapshot = readCachedOpenCodeGoUsageSnapshot();
        if (!snapshot && !refreshFor(item.id) && usageStatus.ready) {
          snapshot = await fetchOpenCodeGoUsageSnapshot(config);
        }
        if (snapshot) {
          hasQuota = applyWindowQuota(row, snapshot?.quotaWindows, {
            source: 'opencode-go-console',
            detail: 'subscription quota',
          });
          row.updatedAt = num(snapshot?.cachedAt, null);
        } else {
          row.status = 'missing';
          row.source = 'usage-auth-missing';
          row.sourceLabel = 'usage auth';
          row.primary = '';
          row.detail = usageStatus.ready
            ? 'OpenCode Go usage not found'
            : 'Set an OpenCode console API key (all permissions) for usage';
        }
      } catch (err) {
        if (String(err?.code || '').startsWith('OPENCODE_GO_USAGE_')) {
          row.status = 'missing';
          row.source = 'usage-auth-missing';
          row.sourceLabel = 'usage auth';
          row.primary = '';
          row.detail = usageStatus.ready
            ? 'OpenCode Go usage not found'
            : 'Set an OpenCode console API key (all permissions) for usage';
        }
      }
    } else {
      const snapshot = await apiSnapshot(item.id, snapshotOptions(item.id));
      apiUsageSnapshot = snapshot;
      const known = snapshotRemaining(snapshot);
      const usage = snapshotUsage(snapshot);
      const tokenUsage = snapshotTokenUsage(snapshot);
      const windows = normaliseWindows(snapshot?.quotaWindows, clean(snapshot?.source) || 'provider-api');
      const estimated = localBudget(providerCfg);
      row.updatedAt = num(snapshot?.cachedAt, null);
      if (known) {
        applyKnownRemaining(row, known, { estimated: false });
        row.sourceLabel = 'API';
        hasQuota = true;
      } else if (windows.length) {
        hasQuota = applyWindowQuota(row, windows, {
          source: clean(snapshot?.source) || 'provider-api',
          detail: 'provider quota',
        });
      } else if (estimated) {
        applyKnownRemaining(row, estimated, { estimated: true });
        hasQuota = true;
      } else if (usage) {
        applyKnownUsage(row, usage);
        hasQuota = true;
      } else if (tokenUsage) {
        applyTokenUsage(row, tokenUsage);
        hasQuota = true;
      }
    }
    if (!row.includeInTotal && !hasQuota) {
      const estimated = localBudget(providerCfg);
      if (estimated) {
        applyKnownRemaining(row, estimated, { estimated: true });
        hasQuota = true;
      }
    }
    if (item.id !== 'opencode-go' && !row.includeInTotal && !hasQuota) {
      applyApiUnavailable(row, item.id, apiUsageSnapshot);
    }
  }
  row.tone = rowTone(row);
  emit(true);
  return row;
}

/** One OAuth provider row. Same two-stage paint as the API lane, but the usage
 *  comes from the subscription quota windows its snapshot exposes rather than
 *  from a key balance. */
async function readOAuthRow(row, providerId, options, accountId) {
  if (!row.authenticated) return;
  try {
    const result = await oauthSnapshot(providerId, options, accountId);
    const snapshot = result.snapshot;
    row.refreshState = result.refreshState || 'available';
    if (result.refreshError) row.refreshError = result.refreshError;
    else delete row.refreshError;
    const known = snapshotRemaining(snapshot);
    const windows = snapshot
      ? normaliseWindows(snapshot.quotaWindows, clean(snapshot.source) || 'provider-api')
      : row.windows;
    const resetCredits = normaliseResetCredits(snapshot?.resetCredits);
    row.windows = windows;
    if (resetCredits) row.resetCredits = resetCredits;
    const credits = creditsFromSnapshot(providerId, snapshot);
    if (credits) row.credits = credits;
    else if (snapshot) delete row.credits;
    row.updatedAt = snapshot ? num(snapshot.cachedAt, null) : row.updatedAt;
    row.stale = snapshot?.stale === true || (!snapshot && windows.length > 0);
    if (known) {
      applyKnownRemaining(row, known, { estimated: false });
      row.sourceLabel = 'API';
      if (windows.length) row.detail = 'subscription quota';
    } else if (windows.length) {
      row.status = 'partial';
      row.source = clean(snapshot?.source) || 'provider-api';
      row.sourceLabel = 'API window';
      row.primary = windows.map(displayWindow).slice(0, 2).join(' · ');
      row.detail = 'subscription quota';
    } else {
      row.status = 'hidden';
      row.source = 'usage-disabled';
      row.sourceLabel = 'unavailable';
      row.primary = '';
      row.detail = 'Quota unavailable from provider';
    }
  } catch (err) {
    row.status = 'error';
    row.source = 'error';
    row.sourceLabel = 'error';
    row.primary = 'fetch failed';
    row.detail = usageErrorDetails(err);
    row.refreshState = 'failed';
    row.refreshError = row.detail;
  }
  row.tone = rowTone(row);
}

async function oauthProviderRow(item, { providers, preview, snapshotOptions, rows, emit }) {
  const providerCfg = providers[item.id] || {};
  const row = baseRow(item, 'oauth', providerCfg);
  row.status = row.authenticated ? 'checking' : 'missing';
  row.source = row.authenticated ? 'checking' : 'not-configured';
  row.sourceLabel = row.authenticated ? 'checking' : 'not signed in';
  row.primary = row.authenticated ? '' : 'not signed in';
  row.detail = row.authenticated ? 'Checking provider usage' : item.detail || 'OAuth credentials missing';
  row.tone = rowTone(row);
  const options = snapshotOptions(item.id);
  if (CREDIT_PROVIDERS.has(item.id)) row.useCredits = options.accountPool?.useCredits === true;
  if (ACCOUNT_PROVIDERS.includes(item.id)) {
    const pool = options.accountPool;
    const provider = options.getProvider?.(item.id);
    row.accounts = pool.accounts
      .filter((account) => account.authenticated === true && account.reauthRequired !== true)
      .map((account) => ({
        ...baseRow({ ...item, authenticated: true }, 'oauth'),
        accountId: account.id,
        alias: account.label,
        identity: account.identity || '',
        selected: pool.selectedId === account.id,
        ...(CREDIT_PROVIDERS.has(item.id) ? { useCredits: row.useCredits } : {}),
        minimalRequestSupported: typeof provider?.forAccount === 'function',
        status: 'checking',
        windows: normaliseWindows(account.usage?.windows, 'account-cache'),
        updatedAt: num(account.usage?.checkedAt, null),
        stale: true,
      }));
  }
  rows.push(row);
  emit(true);

  if (preview) {
    return row;
  }

  if (row.accounts?.length) {
    await Promise.all(row.accounts.map(async (account) => {
      await readOAuthRow(account, item.id, options, account.accountId);
      emit(true);
    }));
    // Preserve the selected-provider row for existing usage/history consumers.
    const selected = row.accounts.find((account) => account.selected);
    if (selected) Object.assign(row, { ...selected, accounts: row.accounts, label: row.label });
  } else {
    await readOAuthRow(row, item.id, options);
  }
  row.tone = rowTone(row);
  emit(true);
  return row;
}

export async function createUsageDashboard(config = {}, options = {}) {
  const setup = options.setup || { api: [], oauth: [], local: [] };
  const oauthItems = [...(setup.oauth || [])];
  const accountPools = new Map();
  for (const provider of ACCOUNT_PROVIDERS) {
    const pool = (options.listAccounts || listProviderAccounts)(provider);
    accountPools.set(provider, pool);
    if (!oauthItems.some((item) => item.id === provider) && pool.accounts.some((account) => account.authenticated === true && account.reauthRequired !== true)) {
      oauthItems.push({ id: provider, name: provider, authenticated: true });
    }
  }
  const providers = config.providers || {};
  const rows = [];
  const checkedAt = Date.now();
  const refresh = options.refresh === true;
  const scope = refresh ? refreshScope(options) : null;
  const refreshFor = (id) => refresh && (!scope || scope.has(String(id || '').toLowerCase()));
  const snapshotOptions = (id) => ({ ...options, refresh: refreshFor(id), accountPool: accountPools.get(id) });
  const preview = options.preview === true;
  const emit = (checking = true) =>
    emitUsageDashboard(options, usageDashboardSnapshot(rows, { checkedAt, refresh, checking }));

  const lane = { config, providers, preview, refreshFor, snapshotOptions, rows, emit };
  const apiTasks = (setup.api || []).map((item) => apiProviderRow(item, lane));
  const oauthTasks = oauthItems.map((item) => oauthProviderRow(item, lane));

  await Promise.all([...apiTasks, ...oauthTasks]);

  const dashboard = usageDashboardSnapshot(rows, { checkedAt, refresh, checking: preview });
  emitUsageDashboard(options, dashboard);
  return dashboard;
}
