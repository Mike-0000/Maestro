import type {
  ClaudeAccount,
  ClaudeAccountUsage,
  ClaudeUsageErrorType,
  ClaudeUsageSnapshot,
  ClaudeUsageWindow,
} from '../api/types';
import { formatClaudePlan } from './account-model';

/** How loudly a usage figure is shown: quiet until it is high. */
export type UsageSeverity = 'calm' | 'warning' | 'critical';

export const USAGE_WARNING_PERCENT = 75;
export const USAGE_CRITICAL_PERCENT = 90;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** `45.6` -> `46%`. Anything above zero shows as at least 1%, so "some" never reads as none. */
export function formatUsagePercent(usedPercent: number): string {
  const clamped = clampPercent(usedPercent);
  const rounded = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
  return `${rounded}%`;
}

/**
 * Severity from the percentage, raised by what the service itself reports for the limit.
 * A reported severity never lowers it.
 */
export function usageSeverity(usedPercent: number, reported?: string | null): UsageSeverity {
  const percent = clampPercent(usedPercent);
  const fromPercent: UsageSeverity =
    percent >= USAGE_CRITICAL_PERCENT
      ? 'critical'
      : percent >= USAGE_WARNING_PERCENT
        ? 'warning'
        : 'calm';
  const word = reported?.toLowerCase() ?? '';
  if (/critical|exceeded|blocked/.test(word)) return 'critical';
  if (/warn/.test(word) && fromPercent === 'calm') return 'warning';
  return fromPercent;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** `resets in 3 days`, `resets in 5 hr`, `resets in 12 min`. Null when no reset time is known. */
export function formatResetsIn(resetsAt: string | null | undefined, now: number): string | null {
  const time = parseTime(resetsAt);
  if (time === null) return null;
  const remaining = time - now;
  if (remaining < MINUTE_MS) return 'resets now';
  if (remaining < HOUR_MS) return `resets in ${Math.floor(remaining / MINUTE_MS)} min`;
  if (remaining < DAY_MS) return `resets in ${Math.floor(remaining / HOUR_MS)} hr`;
  return `resets in ${plural(Math.round(remaining / DAY_MS), 'day')}`;
}

/** The exact reset moment, for a tooltip beside the relative wording. */
export function formatResetMoment(
  resetsAt: string | null | undefined,
  locale?: string
): string | null {
  const time = parseTime(resetsAt);
  if (time === null) return null;
  return new Date(time).toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `2:14 PM` for today, `Nov 3, 2:14 PM` for another day. */
export function formatAsOf(fetchedAt: string, now: number, locale?: string): string {
  const time = parseTime(fetchedAt);
  if (time === null) return 'earlier';
  const then = new Date(time);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  const clock = then.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return clock;
  return `${then.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** `updated just now`, `updated 4 min ago`, `updated 2 hr ago`. */
export function formatUpdatedAgo(checkedAt: number | null, now: number): string | null {
  if (checkedAt === null) return null;
  const elapsed = Math.max(0, now - checkedAt);
  if (elapsed < MINUTE_MS) return 'Updated just now';
  if (elapsed < HOUR_MS) return `Updated ${Math.floor(elapsed / MINUTE_MS)} min ago`;
  return `Updated ${Math.floor(elapsed / HOUR_MS)} hr ago`;
}

export type UsageMeter = {
  key: 'weekly' | 'five-hour';
  label: string;
  /** 0–100, for the bar. */
  percent: number;
  percentLabel: string;
  severity: UsageSeverity;
  /** `resets in 3 days`, or null when unknown. */
  resets: string | null;
  resetsAt: string | null;
};

/** A per-model weekly window, shown small under the main meters. */
export type UsageModelWindow = { label: string; percentLabel: string; severity: UsageSeverity };

export type UsageRowView =
  /** Nothing has come back for this account yet. */
  | { kind: 'loading' }
  | {
      kind: 'meters';
      meters: UsageMeter[];
      models: UsageModelWindow[];
      /** Set when the numbers are from an earlier fetch. */
      stale: { asOf: string; note: string; action: 'sign-in' | null } | null;
    }
  | {
      kind: 'unavailable';
      message: string;
      /** What would help, if anything the user can do here. */
      action: 'sign-in' | null;
    };

function reportedSeverity(snapshot: ClaudeUsageSnapshot, kind: string): string | null {
  return snapshot.limits.find((limit) => limit.kind === kind && !limit.scope)?.severity ?? null;
}

function meter(
  key: UsageMeter['key'],
  label: string,
  window: ClaudeUsageWindow,
  reported: string | null,
  now: number
): UsageMeter {
  return {
    key,
    label,
    percent: clampPercent(window.usedPercent),
    percentLabel: formatUsagePercent(window.usedPercent),
    severity: usageSeverity(window.usedPercent, reported),
    resets: formatResetsIn(window.resetsAt, now),
    resetsAt: window.resetsAt,
  };
}

function modelWindow(label: string, window: ClaudeUsageWindow | null): UsageModelWindow[] {
  if (!window) return [];
  return [
    {
      label,
      percentLabel: formatUsagePercent(window.usedPercent),
      severity: usageSeverity(window.usedPercent),
    },
  ];
}

/** Why the shown numbers are old, in a sentence that follows "As of <time>." */
export function staleUsageNote(reason: ClaudeUsageErrorType | undefined): string {
  switch (reason) {
    case 'token-expired':
      return 'Updates the next time an agent runs on this account.';
    case 'unauthorized':
      return "Claude didn't accept this sign-in. Sign in again to update.";
    case 'rate-limited':
      return 'Claude is limiting usage checks. Try again in a few minutes.';
    case 'network':
      return "Couldn't reach Claude.";
    default:
      return "Couldn't update.";
  }
}

function unavailableUsage(
  reason: ClaudeUsageErrorType | undefined
): Extract<UsageRowView, { kind: 'unavailable' }> {
  switch (reason) {
    case 'not-logged-in':
      return { kind: 'unavailable', message: 'Not signed in.', action: 'sign-in' };
    case 'token-expired':
      return {
        kind: 'unavailable',
        message: 'No usage yet. It shows up the next time an agent runs on this account.',
        action: null,
      };
    case 'unauthorized':
      return {
        kind: 'unavailable',
        message: "Claude didn't accept this sign-in.",
        action: 'sign-in',
      };
    case 'rate-limited':
      return {
        kind: 'unavailable',
        message: 'Claude is limiting usage checks. Try again in a few minutes.',
        action: null,
      };
    case 'network':
      return {
        kind: 'unavailable',
        message: "Couldn't reach Claude. Check your connection.",
        action: null,
      };
    default:
      return { kind: 'unavailable', message: "Couldn't load usage.", action: null };
  }
}

/** Maps one account's usage answer to what its row shows. */
export function usageRowView(
  usage: ClaudeAccountUsage | undefined,
  now: number,
  locale?: string
): UsageRowView {
  if (!usage) return { kind: 'loading' };
  const { snapshot } = usage;
  if (usage.status === 'unavailable' || !snapshot) return unavailableUsage(usage.reason);

  const meters: UsageMeter[] = [];
  if (snapshot.sevenDay) {
    meters.push(
      meter('weekly', 'Weekly', snapshot.sevenDay, reportedSeverity(snapshot, 'weekly_all'), now)
    );
  }
  if (snapshot.fiveHour) {
    meters.push(meter('five-hour', '5-hour', snapshot.fiveHour, null, now));
  }
  if (meters.length === 0) {
    return { kind: 'unavailable', message: 'This plan reports no usage limits.', action: null };
  }

  return {
    kind: 'meters',
    meters,
    models: [
      ...modelWindow('Opus', snapshot.sevenDayOpus),
      ...modelWindow('Sonnet', snapshot.sevenDaySonnet),
    ],
    stale:
      usage.status === 'stale'
        ? {
            asOf: formatAsOf(snapshot.fetchedAt, now, locale),
            note: staleUsageNote(usage.reason),
            action: usage.reason === 'unauthorized' ? 'sign-in' : null,
          }
        : null,
  };
}

/** The plan to show beside an account: what the usage answer says, else the last identity. */
export function usagePlanLabel(
  usage: ClaudeAccountUsage | undefined,
  account: Pick<ClaudeAccount, 'plan'>
): string | null {
  return formatClaudePlan(usage?.snapshot?.subscriptionType ?? account.plan);
}

/** The single figure a compact indicator shows: the weekly window, else the 5-hour one. */
export function headlineUsage(
  usage: ClaudeAccountUsage | undefined
): { label: string; percentLabel: string; severity: UsageSeverity } | null {
  const snapshot = usage?.snapshot;
  if (!snapshot) return null;
  const window = snapshot.sevenDay ?? snapshot.fiveHour;
  if (!window) return null;
  return {
    label: snapshot.sevenDay ? 'weekly' : '5-hour',
    percentLabel: formatUsagePercent(window.usedPercent),
    severity: usageSeverity(
      window.usedPercent,
      snapshot.sevenDay ? reportedSeverity(snapshot, 'weekly_all') : null
    ),
  };
}
