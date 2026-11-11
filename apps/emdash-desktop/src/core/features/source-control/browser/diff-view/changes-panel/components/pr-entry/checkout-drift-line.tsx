import { Button } from '@emdash/ui/react/primitives';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@core/primitives/styling/browser/cn';
import type { PrCheckoutDrift } from '@core/services/pull-requests/api';

/**
 * Render-ready text for the derived checkout-drift state (pr-workspace-model
 * spec, Staleness). Null for `unknown`: no honest claim can be made, so no
 * claim is rendered.
 */
export function checkoutDriftLabel(drift: PrCheckoutDrift): string | null {
  switch (drift.kind) {
    case 'unknown':
      return null;
    case 'in-sync':
      return 'Checkout in sync with PR head';
    case 'drifted': {
      const details = [
        drift.prMoved === true ? 'PR head moved' : null,
        drift.localAhead === true ? 'local commits ahead' : null,
      ].filter((part): part is string => part !== null);
      const base = 'Checkout differs from PR head';
      return details.length > 0 ? `${base} (${details.join(', ')})` : base;
    }
  }
}

/** "As of last sync" honesty: the comparison is only as fresh as the PR cache. */
export function checkoutDriftSyncNote(drift: PrCheckoutDrift): string | null {
  if (drift.kind === 'unknown' || drift.syncedAt === null) return null;
  return `as of last sync ${formatDistanceToNow(drift.syncedAt, { addSuffix: true })}`;
}

export function PrCheckoutDriftLine({
  drift,
  onUpdateNow,
  isUpdating = false,
  className,
}: {
  drift: PrCheckoutDrift;
  /** The manual update verb; rendered only while the state is `drifted`. */
  onUpdateNow?: () => void;
  isUpdating?: boolean;
  className?: string;
}) {
  const label = checkoutDriftLabel(drift);
  if (!label) return null;
  const syncNote = checkoutDriftSyncNote(drift);
  const drifted = drift.kind === 'drifted';
  // A caption: the claim in muted words (a step stronger when the checkout has
  // drifted, since that is the one worth acting on), the sync stamp passive,
  // and "Update now" as a text action.
  return (
    <div className={cn('flex min-w-0 items-baseline gap-3 text-xs', className)}>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          drifted ? 'text-foreground-muted' : 'text-foreground-passive'
        )}
        title={syncNote ? `${label} — ${syncNote}` : label}
      >
        {label}
        {syncNote && <span className="text-foreground-passive"> · {syncNote}</span>}
      </span>
      {drifted && onUpdateNow && (
        <Button
          variant="text"
          size="xs"
          disabled={isUpdating}
          onClick={onUpdateNow}
          className="shrink-0"
        >
          {isUpdating ? 'Updating…' : 'Update now'}
        </Button>
      )}
    </div>
  );
}
