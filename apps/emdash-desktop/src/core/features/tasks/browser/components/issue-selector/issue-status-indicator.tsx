import { cn } from '@core/primitives/styling/browser/cn';

export type IssueStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'cancelled'
  | 'backlog'
  | 'duplicate'
  | 'triage';

/**
 * The tracker's status as a small mark (design brief 2.6): the shape carries the state and
 * the colour stays quiet. Finished reads in full strength, work in progress muted, parked
 * states passive; only triage (it needs a person) uses the warning tone. All marks draw in
 * `currentColor`, so they follow both themes.
 */
export function IssueStatusIndicator({
  status,
  className,
}: {
  status: IssueStatus;
  className?: string;
}) {
  const base = 'size-3 shrink-0';
  switch (status) {
    case 'done':
      return (
        <svg viewBox="0 0 16 16" aria-hidden className={cn(base, 'text-foreground', className)}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.2 7 10.2 11 6"
            fill="none"
            className="stroke-(--em-surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'cancelled':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-passive', className)}
        >
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4"
            fill="none"
            className="stroke-(--em-surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'in_progress':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-muted', className)}
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M 8 3 A 5 5 0 0 1 8 13 L 8 8 Z" fill="currentColor" />
        </svg>
      );
    case 'review':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-muted', className)}
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path d="M 8 3 A 5 5 0 1 1 3 8 L 8 8 Z" fill="currentColor" />
        </svg>
      );
    case 'backlog':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-passive', className)}
        >
          <circle
            cx="8"
            cy="8"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="1.6 2"
          />
        </svg>
      );
    case 'duplicate':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-passive', className)}
        >
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="3.5" fill="currentColor" />
        </svg>
      );
    case 'triage':
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-warning', className)}
        >
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4.5 8h7M9.5 6l2 2-2 2M6.5 6l-2 2 2 2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className={cn(base, 'text-foreground-passive', className)}
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      );
  }
}

export function toIssueStatus(raw: string | undefined): IssueStatus {
  if (!raw) return 'todo';
  const s = raw.toLowerCase().trim();
  if (s === 'done' || s === 'closed' || s === 'completed' || s === 'resolved' || s === 'fixed') {
    return 'done';
  }
  if (
    s === 'cancelled' ||
    s === 'canceled' ||
    s === "won't do" ||
    s === "won't fix" ||
    s === 'declined' ||
    s === 'rejected'
  ) {
    return 'cancelled';
  }
  if (
    s === 'in progress' ||
    s === 'in development' ||
    s === 'in_progress' ||
    s === 'open' ||
    s === 'opened'
  ) {
    return 'in_progress';
  }
  if (s === 'review' || s === 'in review' || s === 'code review' || s === 'pr review') {
    return 'review';
  }
  if (s === 'backlog') {
    return 'backlog';
  }
  if (s === 'triage' || s === 'needs triage') {
    return 'triage';
  }
  if (s === 'duplicate') {
    return 'duplicate';
  }
  if (s === 'todo' || s === 'to do' || s === 'to-do' || s === 'not started') {
    return 'todo';
  }

  return 'todo';
}
