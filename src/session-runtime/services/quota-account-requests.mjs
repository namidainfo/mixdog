import { randomUUID } from 'node:crypto';
import { ACCOUNT_PROVIDERS } from '../../runtime/shared/provider-accounts.mjs';
import { listProviderAccounts } from './provider-admin.mjs';
import { usageErrorDetails } from './usage-error.mjs';

// Shared across runtime/session instances in this process. A second click must
// not spend quota again while the first operation (including its refresh) runs.
let busy = false;
export const QUOTA_ACCOUNT_REQUEST_TIMEOUT_MS = 45_000;
export const QUOTA_ACCOUNT_REQUEST_CONTENT = 'Reply only OK.';

async function requestAccount(provider, account, getProvider, timeoutMs) {
  const identity = { provider, accountId: account.id, label: account.label };
  const pooled = getProvider(provider);
  if (typeof pooled?.forAccount !== 'function') {
    return { ...identity, status: 'unsupported', message: 'Account-scoped model requests are unavailable.' };
  }
  const bound = pooled.forAccount(account.id);
  if (bound?.providerAccountId !== account.id || typeof bound.send !== 'function' || typeof bound.listModels !== 'function') {
    return { ...identity, status: 'unsupported', message: 'The provider cannot safely route a request to this account.' };
  }
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Request timed out; it may have consumed quota.');
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const request = (async () => {
      // Use the provider's own catalog order and advertised lowest effort,
      // never a session's model, conversation, tools, or global account route.
      const models = await bound.listModels();
      if (controller.signal.aborted) throw controller.signal.reason;
      const model = models?.[0];
      if (!model || typeof model.id !== 'string' || !model.id) throw new Error('No model is available for this account.');
      const sessionId = `quota-window:${randomUUID()}`;
      const response = await bound.send(
        [{ role: 'user', content: QUOTA_ACCOUNT_REQUEST_CONTENT }],
        model.id,
        [],
        {
          signal: controller.signal,
          sessionId,
          agent: 'quota-window',
          effort: model.reasoningLevels?.[0] || 'none',
          serverFallback: false,
        }
      );
      if (!response || typeof response !== 'object' || response.error) throw new Error('The provider did not confirm a response.');
      return { ...identity, status: 'sent', model: model.id };
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    return { ...identity, status: 'failed', message: usageErrorDetails(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function createQuotaAccountRequests({
  getProvider,
  listAccounts = listProviderAccounts,
  refreshQuota,
  timeoutMs = QUOTA_ACCOUNT_REQUEST_TIMEOUT_MS,
}) {
  return async function requestConnectedAccountQuotaWindows() {
    if (busy) throw new Error('A connected-account quota request is already running.');
    busy = true;
    const results = [];
    try {
      const accounts = [];
      for (const provider of ACCOUNT_PROVIDERS) {
        try {
          const pool = listAccounts(provider);
          for (const account of pool.accounts) {
            if (account.authenticated === true && account.reauthRequired !== true) accounts.push({ provider, account });
          }
        } catch (error) {
          results.push({ provider, status: 'failed', message: usageErrorDetails(error) });
        }
      }
      for (let offset = 0; offset < accounts.length; offset += 4) {
        results.push(...await Promise.all(accounts.slice(offset, offset + 4).map(async ({ provider, account }) => {
          try {
            return await requestAccount(provider, account, getProvider, timeoutMs);
          } catch (error) {
            return { provider, accountId: account.id, label: account.label, status: 'failed', message: usageErrorDetails(error) };
          }
        })));
      }
      // Refresh even after partial failures. A response is NOT a quota reset
      // and does not prove that an idle window has started.
      try {
        const dashboard = await refreshQuota();
        return { status: 'completed', results, dashboard };
      } catch (error) {
        return { status: 'completed', results, refreshError: usageErrorDetails(error) };
      }
    } finally {
      busy = false;
    }
  };
}
