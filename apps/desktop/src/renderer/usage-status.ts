import { t } from './i18n';
import type { UsageRecord } from './usage-dashboard-store';

/** Explain evidenced certificate failures without hiding the original diagnostic. */
export function usageFailureReason(value: unknown): string {
  const reason = String(value || '');
  if (/\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\b|unable to verify the first certificate|self[- ]signed certificate|certificate has expired/i.test(reason)) {
    return t('TLS certificate verification failed; the secure connection could not be established. ({{reason}})', { reason });
  }
  return t(reason);
}

/** A pending read is not a failure; an old reading is not a fresh answer. */
export function usageAccountNote(row: UsageRecord): string {
  const stale = row.stale === true && Array.isArray(row.windows) && row.windows.length > 0;
  if (row.status === 'checking') return t(stale ? 'Last recorded quota; refresh pending' : 'Quota refresh pending');
  const reason = row.refreshError || (row.status === 'error' ? row.detail : '');
  if (reason) return t(stale ? 'Last recorded quota; refresh failed: {{reason}}' : 'Quota refresh failed: {{reason}}', {
    reason: usageFailureReason(reason),
  });
  if (stale) return t('Last recorded quota; refresh unavailable');
  return '';
}
