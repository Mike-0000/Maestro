const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age for list rows: `now`, `4m`, `3h`, `2d`, then a short date. */
export function formatRelativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return '';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 45_000) return 'now';
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Spoken form of the same age, for screen readers. */
export function describeRelativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'no activity yet';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR) return plural(Math.max(1, Math.round(elapsed / MINUTE)), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
