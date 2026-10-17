import { Info, Plus } from 'lucide-react';
import { SidebarUsageMenu } from './SidebarUsageMenu';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

import { PaneSurfaceGate } from './PaneSurfaceGate';
import { InitialSurface } from './InitialSurface';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { ProviderIcon } from './provider-display';
import { record } from './record-utils';
import {
  getUsageDashboardSnapshot,
  holdUsageDashboardCadence,
  publishUsageDashboard,
  refreshUsageDashboard,
  subscribeUsageDashboard,
  withUsageTimeout,
  type UsageApi,
  type UsageRecord,
} from './usage-dashboard-store';
import { displayUsagePercent, usageToneClass } from './usage-percent';
import { usageResetPresentation } from './usage-reset-time';
import {
  usageResetSchedule as resetSchedule,
  usageResetShortText as resetShortText,
  usageResetText as resetText,
  usageTimestamp as timestamp,
  usageWindowLabel as windowLabel,
} from './usage-window-text';
import { useUsageResetVerification } from './use-usage-reset-verification';
import { ProviderAccountPicker } from './ProviderAccountPicker';
import { focusQuotaUsage } from './usage-surface-mode';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { SUBSCRIPTIONS, type Subscription } from './subscription-providers';
import { usageAccountNote, usageFailureReason } from './usage-status';

const SIDEBAR_CODEX_RESET_ATTEMPT_KEY = 'mixdog.desktop.codex-reset-attempt.v1';
const SIDEBAR_CODEX_RESET_TIMEOUT_MS = 90_000;

function rows(value: unknown): UsageRecord[] {
  const dashboard = record(value);
  return Array.isArray(dashboard.rows) ? dashboard.rows.map(record) : [];
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed;
}

/** Subscriptions matched by row id or label whatever the row's group. */
const ROW_MATCHERS: Record<string, (id: string, label: string) => boolean> = {
  'opencode-go': (id, label) => id === 'opencode-go' || label.includes('opencode go'),
  cursor: (id, label) => id === 'cursor-oauth' || label.includes('cursor oauth'),
  antigravity: (id, label) => id === 'antigravity-oauth' || label.includes('antigravity'),
};

/** Subscriptions matched inside the `oauth` group by id/label text. */
const OAUTH_ROW_PATTERNS: Record<string, RegExp> = {
  codex: /openai|codex/,
  claude: /anthropic|claude/,
  grok: /grok|xai/,
};

function subscriptionRow(dashboard: unknown, subscription: Subscription): UsageRecord {
  return (
    rows(dashboard).find((row) => {
      const id = String(row.id || '').toLowerCase();
      const label = String(row.label || '').toLowerCase();
      const matcher = ROW_MATCHERS[subscription.key];
      if (matcher) return matcher(id, label);
      if (String(row.group || '').toLowerCase() !== 'oauth') return false;
      const pattern = OAUTH_ROW_PATTERNS[subscription.key];
      return pattern ? pattern.test(`${id} ${label}`) : id === subscription.provider;
    }) || {}
  );
}

function quotaWindows(row: UsageRecord): UsageRecord[] {
  return Array.isArray(row.windows) ? row.windows.map(record) : [];
}

function quotaWindowKey(window: UsageRecord, index: number): string {
  return `${window.id || window.window || window.period || window.label || 'window'}:${index}`;
}

function resetCreditKey(credit: UsageRecord, index: number): string {
  return String(
    credit.id ||
      credit.creditId ||
      (timestamp(credit.expiresAt) ? `expires:${timestamp(credit.expiresAt)}` : `credit:${index}`)
  );
}

function subscriptionConnected(row: UsageRecord): boolean {
  return row.authenticated === true && row.reauthRequired !== true;
}

/** An authoritative account roster is never collapsed to the selected account.
 * Older cached dashboards can still paint their authenticated provider row. */
export function connectedUsageAccounts(dashboard: unknown): UsageRecord[] {
  return rows(dashboard).flatMap((row) => {
    const subscription = SUBSCRIPTIONS.find((entry) => entry.provider === row.id);
    if (row.group !== 'oauth' && subscription?.key !== 'opencode-go') return [];
    const accounts = Array.isArray(row.accounts) ? row.accounts.map(record) : [row];
    return accounts.filter(subscriptionConnected).map((account) => {
      const provider = String(row.id || '');
      const brand = subscription?.label || String(row.label || provider);
      const alias = String(account.alias || '').trim();
      return {
        ...account,
        provider,
        providerKey: subscription?.key || provider,
        key: `${provider}:${account.accountId || 'provider'}`,
        displayLabel: alias ? `${brand} (${alias})` : brand,
        minimalRequestSupported: account.minimalRequestSupported === true,
      };
    });
  });
}

function quotaAmountDetails(window: UsageRecord): string {
  const parts: string[] = [];
  for (const [suffix, unit] of [['Usd', '$'], ['Credits', ' credits']] as const) {
    for (const [field, label] of [['remaining', 'Remaining'], ['limit', 'Limit'], ['used', 'Used']] as const) {
      const value = number(window[`${field}${suffix}`]);
      if (value !== null) parts.push(`${t(label)} ${suffix === 'Usd' ? unit : ''}${value}${suffix === 'Credits' ? unit : ''}`);
    }
  }
  return parts.join(' · ');
}

function usedPercent(window: UsageRecord): number | null {
  const value = number(window.usedPct);
  return value === null ? null : Math.max(0, Math.min(100, value));
}

/** Which quota bars a pinned brand draws on the rail. */
export type UsageRailBars = 'long' | 'short-long';

interface UsagePinWindow {
  label: string;
  percent: number;
  resetAt: number | null;
}

interface UsagePinEntry {
  key: string;
  label: string;
  provider: string;
  /** The figure shown under the bars: the higher of the drawn bars. */
  percent: number;
  /** Drawn bars, short window first. */
  bars: UsagePinWindow[];
  /** Every window the tooltip names (short window first when there is one). */
  windows: UsagePinWindow[];
  /** Index in `bars` of the bar that drives the figure and the tone. */
  hot: number;
  /** Rail hover text naming the provider and every window. */
  tooltip: string;
}

const PIN_WINDOW_PRIORITY = [
  /^(?:M|MO|MON|MONTH|MONTHLY)$/i,
  /^(?:7D|W|WK|WEEK|WEEKLY)$/i,
  /^(?:\d+H|\d+D|D|DAY|DAILY)$/i,
];

/** Window length in hours from its label; null for non-duration labels. */
function windowHours(label: string): number | null {
  const text = label.trim();
  const hours = /^(\d+)H$/i.exec(text);
  if (hours) return Number(hours[1]);
  const days = /^(\d+)D$/i.exec(text);
  if (days) return Number(days[1]) * 24;
  if (/^(?:D|DAY|DAILY)$/i.test(text)) return 24;
  if (/^(?:W|WK|WEEK|WEEKLY)$/i.test(text)) return 168;
  if (/^(?:M|MO|MON|MONTH|MONTHLY)$/i.test(text)) return 720;
  return null;
}

function pinWindows(
  windows: UsageRecord[],
  provider: string
): { long: UsagePinWindow; short: UsagePinWindow | null } | null {
  const candidates = windows.flatMap((window): UsagePinWindow[] => {
    const percent = usedPercent(window);
    return percent === null
      ? []
      : [{ label: String(window.label || '').trim(), percent, resetAt: timestamp(window.resetAt) }];
  });
  if (!candidates.length) return null;
  let long: UsagePinWindow | undefined;
  const preferredLabel = provider === 'cursor-oauth' ? 'Basic' : '';
  if (preferredLabel) {
    long = candidates.find((candidate) => candidate.label.toLowerCase() === preferredLabel.toLowerCase());
  }
  for (const pattern of PIN_WINDOW_PRIORITY) {
    if (long) break;
    long = candidates.find((candidate) => pattern.test(candidate.label));
  }
  long ||= candidates[candidates.length - 1];
  const longHours = windowHours(long.label);
  let short: UsagePinWindow | null = null;
  let shortHours = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const hours = windowHours(candidate.label);
    if (candidate === long || hours === null || (longHours !== null && hours >= longHours)) continue;
    if (hours < shortHours) {
      short = candidate;
      shortHours = hours;
    }
  }
  return { long, short };
}

/** Rail pin mode: one entry per brand that has quota data —
 *  its icon plus the final quota window's usage, picked by longest period:
 *  monthly (M) → weekly (7D/W) → daily/hourly. Unknown windows fall back to
 *  the provider's final entry. In `short-long` mode the shortest-duration
 *  window joins as a second bar (none for a provider without one) and the
 *  figure/tone follow the higher of the two. */
export function usagePinEntries(dashboard: unknown, mode: UsageRailBars = 'long'): UsagePinEntry[] {
  const sources = rows(dashboard).some((row) => Array.isArray(row.accounts))
    ? connectedUsageAccounts(dashboard).map((account) => ({
        key: String(account.key),
        label: `${account.displayLabel}${account.selected ? ` — ${t('In use')}` : ''}`,
        provider: String(account.provider),
        windows: quotaWindows(account),
      }))
    : SUBSCRIPTIONS.map((subscription) => ({
        ...subscription,
        windows: quotaWindows(subscriptionRow(dashboard, subscription)),
      }));
  return sources.flatMap((source) => {
    const picked = pinWindows(source.windows, source.provider);
    if (!picked) return [];
    const windows = picked.short ? [picked.short, picked.long] : [picked.long];
    const bars = mode === 'short-long' ? windows : [picked.long];
    let hot = 0;
    bars.forEach((bar, index) => {
      if (bar.percent >= bars[hot].percent) hot = index;
    });
    return [
      {
        key: source.key,
        label: source.label,
        provider: source.provider,
        percent: bars[hot].percent,
        bars,
        windows,
        hot,
        tooltip: usagePinTooltip(source.label, windows),
      },
    ];
  });
}

function pinWindowName(label: string): string {
  const hours = windowHours(label);
  if (hours === 168) return t('weekly');
  if (hours === 720) return t('monthly');
  if (hours === 24) return t('daily');
  const count = /^(\d+)([HD])$/i.exec(label.trim());
  if (count) return t(count[2].toUpperCase() === 'H' ? '{{n}}-hour' : '{{n}}-day', { n: count[1] });
  return label;
}

/** Rail hover text: the provider plus every window's usage and reset time. */
function usagePinTooltip(label: string, windows: UsagePinWindow[]): string {
  const parts = windows.map((window) => {
    const schedule = resetSchedule(window.resetAt);
    const reset = schedule.state === 'in' ? ` (${t('resets in {{time}}', { time: schedule.time })})` : '';
    return `${pinWindowName(window.label)} ${displayUsagePercent(window.percent)}%${reset}`;
  });
  return [label, ...parts].join(' · ');
}

function resetExpiryText(value: unknown): string {
  const schedule = resetSchedule(value);
  if (schedule.state === 'due') return t('Expiry due');
  if (schedule.state === 'in') return t('Expires in {{time}}', { time: schedule.time });
  return schedule.state === 'soon' ? t('Expires soon') : '';
}

function resetCredits(row: UsageRecord): UsageRecord {
  return record(row.resetCredits);
}

function availableResetCount(value: UsageRecord): number {
  return Math.max(0, Math.floor(number(value.availableCount) || 0));
}

function availableResetCredits(value: UsageRecord): UsageRecord[] {
  const availableCount = availableResetCount(value);
  const credits = (Array.isArray(value.availableCredits) ? value.availableCredits : [])
    .map(record)
    .sort(
      (left, right) =>
        (timestamp(left.expiresAt) ?? Number.POSITIVE_INFINITY) -
        (timestamp(right.expiresAt) ?? Number.POSITIVE_INFINITY)
    );
  while (credits.length < availableCount) credits.push({});
  return credits.slice(0, availableCount);
}

function createResetAttemptId(): string {
  const bytes = new Uint8Array(16);
  if (typeof window.crypto?.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codexResetAttempt(offerRevision: string): string {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || 'null'));
    if (stored.offerRevision === offerRevision && typeof stored.idempotencyKey === 'string') {
      return stored.idempotencyKey;
    }
  } catch {
    // A corrupt retry record is replaced with a fresh scoped attempt below.
  }
  const idempotencyKey = createResetAttemptId();
  try {
    window.localStorage.setItem(
      SIDEBAR_CODEX_RESET_ATTEMPT_KEY,
      JSON.stringify({
        offerRevision,
        idempotencyKey,
      })
    );
  } catch {
    // In-memory completion remains safe for this window when storage is unavailable.
  }
  return idempotencyKey;
}

function resetOutcomeNotice(status: unknown, outcome: unknown): string {
  if (status === 'offerChanged') return t('Reset availability changed. Review the latest Codex usage.');
  if (outcome === 'reset') return '';
  if (outcome === 'alreadyRedeemed') return t('Reset already applied.');
  if (outcome === 'nothingToReset') return t('No eligible rate-limit window is exhausted.');
  return t('No reset credit is available.');
}

function clearCodexResetAttempt(offerRevision: string): void {
  try {
    const stored = record(JSON.parse(window.localStorage.getItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY) || 'null'));
    if (stored.offerRevision === offerRevision) {
      window.localStorage.removeItem(SIDEBAR_CODEX_RESET_ATTEMPT_KEY);
    }
  } catch {
    // The next attempt replaces an unreadable record.
  }
}

function creditsOf(row: UsageRecord): UsageRecord | null {
  return row.credits && typeof row.credits === 'object' ? record(row.credits) : null;
}

const MONEY = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

function CreditLine({
  credits,
  on,
  exhausted,
  onToggle,
}: {
  credits: UsageRecord;
  on: boolean;
  exhausted: boolean;
  onToggle(next: boolean): void;
}) {
  const usd = credits.unit === 'usd';
  const balance = number(credits.balance);
  const limit = number(credits.monthlyLimit);
  let value: string;
  if (credits.unlimited === true) value = t('Unlimited');
  else if (balance === null) value = '—';
  else if (usd) value = `$${balance.toLocaleString('en-US', MONEY)}`;
  else value = Math.round(balance).toLocaleString('en-US');
  const inUse = on && exhausted;
  return (
    <div className="sidebar-usage-credit">
      <small>{t('Credits')}</small>
      <span className="sidebar-usage-credit-value">
        <b className={inUse ? 'is-in-use' : undefined}>{value}</b>
        {usd && limit !== null && (
          <small className="sidebar-usage-credit-limit">
            {' · '}
            {t('Monthly limit')} ${limit.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </small>
        )}
        {inUse && <em className="sidebar-usage-credit-badge">{t('In use')}</em>}
      </span>
      <button
        type="button"
        role="switch"
        className="sidebar-usage-credit-switch"
        aria-checked={on}
        aria-label={t('Use credits')}
        onClick={() => onToggle(!on)}
      />
    </div>
  );
}

export function SidebarUsage({
  api = window.mixdogDesktop,
  sidebarOpen = true,
  pinned = false,
  onTogglePin,
  railBars = 'long',
  onRailBarsChange,
  onOpenStats,
  onAddProviders,
}: {
  api?: UsageApi;
  sidebarOpen?: boolean;
  /** Rail pin mode: the header toggle swaps the rail's pie glyph for the
   *  per-brand icon + % stack. */
  pinned?: boolean;
  onTogglePin?(): void;
  /** Which bars the pinned rail draws per brand. */
  railBars?: UsageRailBars;
  onRailBarsChange?(next: UsageRailBars): void;
  /** Opens the usage surface: this panel answers what is LEFT, that one how
   *  it was spent — in tokens, or on a subscription's own meter. */
  onOpenStats?(): void;
  onAddProviders?(): void;
}) {
  // The popup mounts and unmounts with the flyout; the snapshot, the in-flight
  // request and the refresh cadence all live in the shared store, so opening
  // paints the last known rows immediately and only revalidates.
  const snapshot = useSyncExternalStore(subscribeUsageDashboard, getUsageDashboardSnapshot);
  const dashboard = snapshot.dashboard;
  const rowsPresent = rows(dashboard).length > 0;
  const connectedAccounts = connectedUsageAccounts(dashboard);
  const anyConnected = connectedAccounts.length > 0;
  const resetAts = connectedAccounts
    .flatMap((row) => quotaWindows(row))
    .map((window) => timestamp(window.resetAt))
    .filter((value): value is number => value !== null);
  const failedResetAts = useUsageResetVerification({
    api,
    resetAts,
    refreshedAt: snapshot.refreshedAt,
  });
  // A seedless first paint announces LOADING until the store reports a live
  // result or a final unavailable state. Painting "Not connected" while the
  // very first request is still outstanding claimed an answer nobody has yet.
  // Cached rows always win: revalidation never downgrades them to Loading.
  const awaitingFirstUsage = !rowsPresent && (snapshot.status === 'idle' || snapshot.status === 'loading');
  const [resetConfirming, setResetConfirming] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState('');
  const bulkPending = useRef(false);
  const [requestingAccounts, setRequestingAccounts] = useState(false);
  const [accountRequestResults, setAccountRequestResults] = useState<UsageRecord[]>([]);
  const [accountRequestNotice, setAccountRequestNotice] = useState('');
  const requestAllAccounts = async () => {
    if (bulkPending.current || !anyConnected || !api?.invokeCapability) return;
    bulkPending.current = true;
    setRequestingAccounts(true);
    setAccountRequestResults([]);
    setAccountRequestNotice('');
    try {
      const response = await api.invokeCapability({ capability: 'requestConnectedAccountQuotaWindows', args: [] });
      const result = record(response?.value);
      if (result.status !== 'completed' || !Array.isArray(result.results)) {
        throw new Error(t('The account requests could not be confirmed.'));
      }
      setAccountRequestResults(result.results.map(record));
      if (result.results.length === 0) setAccountRequestNotice(t('No connected supported OAuth accounts are available.'));
      if (result.refreshError) setAccountRequestNotice(t('Quota refresh failed: {{reason}}', { reason: usageFailureReason(result.refreshError) }));
      if (!publishUsageDashboard(result.dashboard)) await refreshUsageDashboard(api, { force: true });
    } catch (cause) {
      setAccountRequestNotice(usageFailureReason(cause instanceof Error ? cause.message : cause));
      await refreshUsageDashboard(api, { force: true });
    } finally {
      bulkPending.current = false;
      setRequestingAccounts(false);
    }
  };

  // One cadence for the renderer: the rail holds it too, so a popup remount
  // never restarts the five-minute timer and never re-requests.
  useEffect(() => holdUsageDashboardCadence(api), [api]);

  // A provider name or meter opens its own subscription usage: the name with
  // that provider's first window, a meter with its window selected.
  const quotaTrigger = (provider: string, window = '', account = '') => {
    if (!onOpenStats) return {};
    const open = () => {
      focusQuotaUsage({ provider, window, account });
      onOpenStats();
    };
    // What the click opens is read while the pointer is still on its way.
    const readAhead = () => prefetchQuotaUsage(api, { provider, window, account });
    return {
      role: 'button',
      tabIndex: 0,
      onMouseEnter: readAhead,
      onFocus: readAhead,
      onClick: open,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      },
    };
  };

  // Opening revalidates a stale snapshot only (fresh data inside the TTL paints
  // as-is, an in-flight request is shared) and reads ahead the subscription
  // usage ℹ️ opens on; closing clears reset confirmation.
  const statsAvailable = Boolean(onOpenStats);
  useEffect(() => {
    if (sidebarOpen) {
      void refreshUsageDashboard(api);
      if (statsAvailable) prefetchQuotaUsage(api);
    } else {
      setResetConfirming(null);
      setResetNotice('');
    }
  }, [api, sidebarOpen, statsAvailable]);

  // Preserve the provider's individual expiry rows. The consume endpoint does
  // not accept a credit id, so every Use action safely means "consume one
  // currently available credit"; the refreshed provider list decides which
  // concrete row remains afterward.
  const codexRow = subscriptionRow(dashboard, SUBSCRIPTIONS[0]);
  const codexResetCredits = resetCredits(codexRow);
  const codexResetCount = availableResetCount(codexResetCredits);
  const codexResetRows = availableResetCredits(codexResetCredits);
  const codexResetKeys = codexResetRows.map(resetCreditKey);
  const codexResetKeySignature = codexResetKeys.join('\u0000');
  const codexResetOffer = String(codexResetCredits.offerRevision || '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: codexResetKeySignature is the stable string form of codexResetKeys, so the effect re-runs only when the key set changes
  useEffect(() => {
    if (resetConfirming && !codexResetKeys.includes(resetConfirming)) {
      setResetConfirming(null);
    }
  }, [codexResetKeySignature, resetConfirming]);
  const [resetInfoOpen, setResetInfoOpen] = useState(false);
  const resetRef = useRef<HTMLDivElement | null>(null);
  useMobileBack(resetConfirming !== null, () => {
    if (!resetting) setResetConfirming(null);
  });
  useMobileBack(resetInfoOpen, () => setResetInfoOpen(false));
  useEffect(() => {
    if (!sidebarOpen) setResetInfoOpen(false);
  }, [sidebarOpen]);
  useEffect(() => {
    if (!resetInfoOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!resetRef.current?.contains(event.target as Node)) setResetInfoOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setResetInfoOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [resetInfoOpen]);
  const [creditSwitch, setCreditSwitch] = useState<Record<string, boolean>>({});
  const toggleCredits = async (provider: string, next: boolean) => {
    if (typeof api?.invokeCapability !== 'function') return;
    setCreditSwitch((current) => ({ ...current, [provider]: next }));
    const settle = () =>
      setCreditSwitch((current) => {
        const { [provider]: _settled, ...rest } = current;
        return rest;
      });
    try {
      await api.invokeCapability({
        capability: 'updateProviderAccounts',
        args: [provider, { useCredits: next }],
      });
      invalidateSidebarReferenceForMutation('updateProviderAccounts');
      await refreshUsageDashboard(api, { force: true });
    } catch (cause) {
      console.error('Provider credits toggle failed:', cause);
    }
    settle();
  };
  const consumeCodexReset = async () => {
    if (!codexResetOffer || codexResetCount < 1 || resetting || typeof api?.invokeCapability !== 'function') return;
    const idempotencyKey = codexResetAttempt(codexResetOffer);
    setResetting(true);
    setResetNotice('');
    try {
      const response = await withUsageTimeout(
        api.invokeCapability({
          capability: 'consumeCodexRateLimitResetCredit',
          args: [
            {
              expectedOfferRevision: codexResetOffer,
              idempotencyKey,
            },
          ],
        }),
        SIDEBAR_CODEX_RESET_TIMEOUT_MS,
        window
      );
      const result = record(response?.value);
      // Authoritative provider vocabulary (oauth-usage.mjs): every consume that
      // the runtime recognises carries one of these, plus a rebuilt dashboard.
      const outcome = String(result.outcome || '');
      const authoritative =
        result.status === 'offerChanged' ||
        outcome === 'reset' ||
        outcome === 'alreadyRedeemed' ||
        outcome === 'nothingToReset' ||
        outcome === 'noCredit';
      if (!authoritative) {
        // Unrecognised outcome: the durable idempotency key SURVIVES so a retry
        // reuses this operation instead of spending a second credit, and the
        // surface says so.
        setResetNotice(t('Reset could not be confirmed. Retrying is safe.'));
        return;
      }
      // The OUTCOME settles the redeem; the rebuilt dashboard is a courtesy
      // payload. When it arrives it lands in the shared snapshot and its cache
      // (not popup-local state); when the runtime's refresh budget expired,
      // the store revalidates instead of calling a spent credit unconfirmed.
      if (!publishUsageDashboard(result.dashboard)) {
        void refreshUsageDashboard(api, { force: true });
      }
      clearCodexResetAttempt(codexResetOffer);
      setResetConfirming(null);
      setResetNotice(resetOutcomeNotice(result.status, outcome));
    } catch (cause) {
      // Keep the durable idempotency key: retrying an unknown provider outcome
      // must reuse the same operation rather than spend a second credit.
      console.error('Codex reset-credit consume failed:', cause);
      const reason = cause instanceof Error && cause.message ? cause.message.trim() : '';
      setResetNotice(
        reason
          ? t('Reset could not be confirmed ({{reason}}). Retrying is safe.', { reason: usageFailureReason(reason) })
          : t('Reset could not be confirmed. Retrying is safe.')
      );
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="sidebar-usage" aria-label={t('Providers')}>
      {/* Same title-row grammar as the rail panels (Sessions/Projects…):
          36px header, 28px action boxes, 16px glyphs. */}
      <header className="sidebar-usage-heading session-panel-header">
        <span className="session-panel-title">{t('Providers')}</span>
        <div className="session-panel-header-actions">
          {onOpenStats && (
            <button
              type="button"
              className="session-panel-action sidebar-usage-stats"
              aria-label={t('Show usage')}
              data-tooltip={t('Show usage')}
              onClick={onOpenStats}
            >
              <Info size={16} aria-hidden="true" />
            </button>
          )}
          {/* Nothing to pin without a connected subscription. */}
          {onTogglePin && anyConnected && (
            <SidebarUsageMenu
              pinned={pinned}
              onTogglePin={onTogglePin}
              railBars={railBars}
              onRailBarsChange={onRailBarsChange}
            />
          )}
          <button
            type="button"
            className="session-panel-action sidebar-provider-add"
            aria-label={t('Connect provider')}
            data-tooltip={t('Connect provider')}
            disabled={!onAddProviders}
            onClick={onAddProviders}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <PaneSurfaceGate ready={!awaitingFirstUsage} label={t('Loading usage…')} fallback={<InitialSurface />}>
        <div className="sidebar-usage-content">
          <div className="sidebar-usage-bulk">
            <button
              type="button"
              className="sidebar-usage-request-all"
              disabled={requestingAccounts || !anyConnected || !api?.invokeCapability}
              aria-busy={requestingAccounts}
              onClick={() => void requestAllAccounts()}
            >
              {requestingAccounts ? t('Requesting…') : t('Send minimal requests to all accounts')}
            </button>
            {accountRequestNotice && <p role="status">{accountRequestNotice}</p>}
            {accountRequestResults.length > 0 && (
              <ul className="sidebar-usage-request-results" role="status">
                {accountRequestResults.map((result, index) => (
                  <li key={`${result.provider}:${result.accountId || index}`}>
                    {SUBSCRIPTIONS.find((entry) => entry.provider === result.provider)?.label || String(result.provider)}
                    {result.label ? ` (${result.label})` : ''}: {result.status === 'sent'
                      ? t('Request sent; check refreshed quota')
                      : result.status === 'unsupported' ? t('Unsupported') : t('Failed')}
                    {result.message ? ` — ${usageFailureReason(result.message)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div id="sidebar-usage-list" className="sidebar-usage-list">
            {/* Flat roster: header (icon · name · soonest reset) with
            EVERY quota window inline beneath — nothing left to drill into. */}
            {connectedAccounts.map((row) => {
              const provider = String(row.provider);
              const windows = quotaWindows(row);
              const credits = creditsOf(row);
              const checking = row.status === 'checking';
              const accountNote = usageAccountNote(row);
              // Only connected providers are listed, so a row here always
              // reads as connected and never as a first-load placeholder.
              if (!subscriptionConnected(row)) return null;
              return (
                <div
                  className={`sidebar-usage-row${row.stale ? ' is-stale' : ''}`}
                  key={String(row.key)}
                  data-usage-provider={String(row.providerKey)}
                  data-usage-account={String(row.accountId || '')}
                  data-account-selected={row.selected === true}
                  aria-busy={checking}
                >
                  <span className="sidebar-usage-line">
                    <span className="sidebar-usage-provider-icon">
                      <ProviderIcon provider={provider} />
                    </span>
                    <b title={String(row.displayLabel)} {...quotaTrigger(provider, '', String(row.accountId || ''))}>{String(row.displayLabel)}</b>
                    {row.selected === true && <small className="sidebar-usage-selected">{t('In use')}</small>}
                    {provider.endsWith('-oauth') && (row.selected === true || !row.accountId) && (
                      <ProviderAccountPicker api={api} provider={provider} />
                    )}
                    {windows.length === 0 && !checking && <small>{t('Connected')}</small>}
                  </span>
                  {row.minimalRequestSupported === false && <small className="sidebar-usage-account-note">{t('Minimal requests unsupported: account routing unavailable')}</small>}
                  {accountNote && <small className="sidebar-usage-account-note" role="status">{accountNote}</small>}
                  <span className="sidebar-usage-meters">
                    {windows.map((window, index) => {
                      const percent = usedPercent(window);
                      const resetAt = timestamp(window.resetAt);
                      const resetPresentation = usageResetPresentation({
                        percent,
                        resetAt,
                        refreshedAt: snapshot.refreshedAt,
                        verificationFailed: resetAt !== null && (resetAt <= Date.now() || failedResetAts.has(resetAt)),
                      });
                      const effectivePercent = resetPresentation.percent;
                      const remainingPercent = effectivePercent === null ? null : 100 - effectivePercent;
                      const displayedPercent = displayUsagePercent(remainingPercent);
                      const tone = usageToneClass(effectivePercent);
                      const details = quotaAmountDetails(window);
                      const resetTitle = resetAt === null ? t('Reset time unavailable') : `${resetText(window.resetAt)} · ${new Date(resetAt).toLocaleString()}`;
                      const remainingTitle = displayedPercent === null ? t('Remaining unavailable') : t('{{percent}}% remaining', { percent: displayedPercent });
                      return (
                        <span
                          className={`sidebar-usage-meter${tone}${remainingPercent !== null ? ' has-quota' : ''}${remainingPercent !== null && remainingPercent > 0 ? ' glowing' : ''}`}
                          style={{ '--quota-value': `${remainingPercent ?? 0}%` } as CSSProperties}
                          key={quotaWindowKey(window, index)}
                          title={`${remainingTitle} · ${resetTitle}${details ? ` · ${details}` : ''}`}
                          {...quotaTrigger(provider, String(window.label || ''), String(row.accountId || ''))}
                        >
                          <small title={windowLabel(window)}>{windowLabel(window)}</small>
                          <i aria-label={`${row.displayLabel} ${windowLabel(window)}: ${remainingTitle}`}
                            role={remainingPercent === null ? undefined : 'meter'}
                            aria-valuemin={remainingPercent === null ? undefined : 0}
                            aria-valuemax={remainingPercent === null ? undefined : 100}
                            aria-valuenow={remainingPercent ?? undefined}
                            aria-valuetext={remainingTitle}>
                            <i style={{ width: `${remainingPercent ?? 0}%` }} />
                          </i>
                          <b>{displayedPercent === null ? '—' : `${displayedPercent}%`}</b>
                          <em title={resetTitle}>
                            {resetPresentation.resetTextOverride ?? resetShortText(window.resetAt)}
                          </em>
                          {details && <span className="sidebar-usage-quota-details">{details}</span>}
                        </span>
                      );
                    })}
                    {windows.length === 0 && (
                      <span className="sidebar-usage-meter sidebar-usage-meter-empty">
                        <small>{checking ? t('Loading usage…') : t('Quota unavailable from provider')}</small>
                      </span>
                    )}
                  </span>
                  {credits && (
                    <CreditLine
                      credits={credits}
                      on={creditSwitch[provider] ?? row.useCredits === true}
                      exhausted={windows.some((window) => (usedPercent(window) ?? 0) >= 100)}
                      onToggle={(next) => void toggleCredits(provider, next)}
                    />
                  )}
                  {row.providerKey === 'codex' && (row.selected === true || !row.accountId) && codexResetOffer && codexResetCount > 0 && (
                    <div className="sidebar-usage-reset-credit" ref={resetRef}>
                      <div className="sidebar-usage-reset-line">
                        <small>{t('Reset credits')}</small>
                        <span className="sidebar-usage-credit-value">
                          <b>{t('{{count}} left', { count: codexResetCount })}</b>
                          <button
                            type="button"
                            className="sidebar-usage-reset-info"
                            aria-label={t('Reset credit details')}
                            aria-expanded={resetInfoOpen}
                            onClick={() => setResetInfoOpen((open) => !open)}
                          >
                            <Info size={14} aria-hidden="true" />
                          </button>
                        </span>
                        <button
                          type="button"
                          className="sidebar-usage-reset-use"
                          disabled={resetting}
                          onClick={() => setResetConfirming(codexResetKeys[0] ?? null)}
                        >
                          {t('Use')}
                        </button>
                      </div>
                      {timestamp(codexResetCredits.nextExpiresAt) !== null && (
                        <p className="sidebar-usage-account-note">
                          {t('Next reset credit expiry: {{expiry}}', { expiry: resetExpiryText(codexResetCredits.nextExpiresAt) })}
                        </p>
                      )}
                      {resetInfoOpen && (
                        <ul className="sidebar-usage-reset-popover" role="dialog" aria-label={t('Reset credits')}>
                          {codexResetRows.map((credit, index) => {
                            const expiresAt = timestamp(credit.expiresAt);
                            const soon = expiresAt !== null && expiresAt - Date.now() <= 7 * 24 * 3_600_000;
                            return (
                              <li key={codexResetKeys[index]}>
                                <span>{t('Reset credit {{index}}', { index: index + 1 })}</span>
                                <small className={soon ? 'is-soon' : undefined}>
                                  {resetExpiryText(credit.expiresAt) || t('Expiry unavailable')}
                                </small>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {resetConfirming !== null && (
                        <div className="sidebar-usage-reset-confirmation">
                          <p>
                            {t(
                              'This uses one available reset credit and immediately resets eligible Codex rate-limit windows.'
                            )}
                          </p>
                          <div className="sidebar-usage-reset-actions">
                            <button type="button" disabled={resetting} onClick={() => setResetConfirming(null)}>
                              {t('Cancel')}
                            </button>
                            <button type="button" disabled={resetting} onClick={() => void consumeCodexReset()}>
                              {resetting ? t('Using…') : t('Confirm')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {resetNotice && (
            <p className="sidebar-usage-reset-notice" role="status">
              {resetNotice}
            </p>
          )}
        </div>
      </PaneSurfaceGate>
    </section>
  );
}
