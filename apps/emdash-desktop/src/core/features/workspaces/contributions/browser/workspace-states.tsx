import { EmptyState } from '@emdash/ui/react/components';
import { cn } from '@core/primitives/styling/browser/cn';

/** Workspace empty, loading, error and offline states: the kit's one `EmptyState` pattern. */
export function WorkspacesLoadingState({ label = 'Loading workspaces' }: { label?: string }) {
  return <EmptyState bare tone="loading" label={`${label}…`} className="h-40" />;
}

export function WorkspacesErrorState({
  error,
  title = 'Could not load workspaces.',
}: {
  error: unknown;
  title?: string;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <EmptyState
      bare
      tone="error"
      label={title.replace(/\.$/, '')}
      details={message}
      className="min-h-40"
    />
  );
}

export function WorkspacesEmptyState({
  message,
  description,
  className,
}: {
  message: string;
  description?: string;
  className?: string;
}) {
  return (
    <EmptyState
      bare
      label={message.replace(/\.$/, '')}
      description={description}
      className={cn('min-h-40', className)}
    />
  );
}

export function WorkspacesOfflineState({
  title = 'Machine offline',
  description,
}: {
  title?: string;
  description: string;
}) {
  return <EmptyState bare label={title} description={description} className="min-h-40" />;
}
