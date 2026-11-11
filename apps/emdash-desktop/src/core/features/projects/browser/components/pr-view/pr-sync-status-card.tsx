import {
  ListPopoverCard,
  StateGlyph,
  type ListPopoverCardStatus,
} from '@emdash/ui/react/components';
import { Button } from '@emdash/ui/react/primitives';
import { Check, Loader2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { pullRequestErrorMessage } from '@root/src/core/services/pull-requests/api';
import { usePullRequestsStore } from '@root/src/core/services/pull-requests/browser';

const KIND_LABELS: Record<string, string> = {
  repository: 'Pull requests',
  history: 'PR history',
};

interface SyncStatusCardProps {
  icon: ReactNode;
  label?: ReactNode;
  content: ReactNode;
  actions?: ReactNode;
  status?: ListPopoverCardStatus;
  className?: string;
}

function SyncStatusCard({ icon, label, content, actions, status, className }: SyncStatusCardProps) {
  return (
    <ListPopoverCard status={status} className={className}>
      {icon}
      {label && <span className="shrink-0 text-foreground-muted">{label}</span>}

      <span className="min-w-0 grow text-foreground-passive">{content}</span>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </ListPopoverCard>
  );
}

function SyncErrorStatusCard({
  error,
  actions,
}: {
  error: string | null | undefined;
  actions?: ReactNode;
}) {
  return (
    <SyncStatusCard
      status="destructive"
      icon={<StateGlyph state="error" size="sm" />}
      label={<span className="text-foreground">Sync failed</span>}
      content={
        <span className="block truncate text-foreground-muted" title={error ?? undefined}>
          {error ?? 'Unknown error'}
        </span>
      }
      actions={actions}
    />
  );
}

interface Props {
  repositoryUrl: string;
  manualError?: string | null;
}

export const PrSyncStatusCard = observer(function PrSyncStatusCard({
  repositoryUrl,
  manualError,
}: Props) {
  const store = usePullRequestsStore();
  const state = store.syncState(repositoryUrl);
  const canCancelHistory = store.canCancelHistory(repositoryUrl);
  const [showSuccess, setShowSuccess] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  useEffect(() => {
    if (state?.phase === 'idle' && state.outcome === 'success') {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 1000);
      return () => clearTimeout(timer);
    }
    setShowSuccess(false);
  }, [state?.lastSyncedAt, state?.phase, state?.outcome]);

  if (manualError && !canCancelHistory && (!state || state.phase === 'idle')) {
    return <SyncErrorStatusCard error={manualError} />;
  }

  if (showSuccess && !canCancelHistory && state?.phase === 'idle' && state.outcome === 'success') {
    return (
      <SyncStatusCard
        icon={<Check className="size-3.5 shrink-0 text-foreground" aria-hidden />}
        content="Sync complete"
      />
    );
  }

  if ((!state || state.phase === 'idle') && !canCancelHistory) return null;

  const kindLabel = canCancelHistory
    ? KIND_LABELS.history
    : state?.kind
      ? KIND_LABELS[state.kind]
      : undefined;

  if (state?.phase === 'running' || canCancelHistory) {
    const hasProgress =
      (!canCancelHistory || state?.kind === 'history') && state?.total != null && state.total > 0;
    return (
      <SyncStatusCard
        icon={
          <Loader2
            className="size-3.5 shrink-0 text-foreground-passive motion-safe:animate-spin"
            aria-hidden
          />
        }
        label={kindLabel}
        content={
          hasProgress
            ? `Refreshing PRs: ${state?.synced ?? 0} / ${state?.total}`
            : 'Refreshing PRs…'
        }
        actions={
          canCancelHistory ? (
            <Button
              variant="text"
              size="xs"
              className="shrink-0"
              onClick={() => store.cancelHistory(repositoryUrl)}
            >
              Cancel
            </Button>
          ) : undefined
        }
      />
    );
  }

  const error = state?.error ? pullRequestErrorMessage(state.error) : 'Unknown error';
  if (dismissedError === error) return null;
  return (
    <SyncErrorStatusCard
      error={error}
      actions={
        <>
          <Button
            variant="text"
            size="xs"
            className="mr-2"
            onClick={() =>
              void (
                state?.kind === 'history'
                  ? store.refreshHistory(repositoryUrl)
                  : store.refreshRepository(repositoryUrl)
              ).catch(() => {})
            }
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            size="xs"
            icon
            onClick={() => setDismissedError(error)}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </Button>
        </>
      }
    />
  );
});
