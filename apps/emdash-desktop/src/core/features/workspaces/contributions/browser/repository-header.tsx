import { WorkspaceIcon, type WorkspaceIconStatus } from '@emdash/ui/react/components';
import { MetaLine } from '@emdash/ui/react/patterns';
import { Alert, Button, DropdownMenu } from '@emdash/ui/react/primitives';
import { EllipsisIcon, Trash2Icon } from 'lucide-react';
import { useId } from 'react';
import { formatBytes } from '@core/primitives/formatting/browser/formatBytes';
import type {
  ProjectWorkspaceGitStats,
  ProjectWorkspaceRow,
  ProjectWorkspaceUsage,
} from '@core/primitives/workspaces/api';
import { GitStatsCell } from './git-stats-cell';
import { PathIssueSummaryPill, RemovalSummaryPill } from './workspace-pills';

/**
 * The repository root above its worktrees: identity (icon, name, path) and one caption line of
 * facts, with no card around it. Runtime state is words (only an error is coloured); the icon's
 * corner dot repeats it as the kit's mark.
 */
export function RepositoryHeader({
  project,
  rootRow,
  rows,
  status,
  usage,
  gitStats,
  loadingUsage,
  loadingGitStats,
  warnings,
  onDelete,
  actionDisabledReason,
}: {
  project: { id: string; name: string };
  rootRow: ProjectWorkspaceRow;
  rows: readonly ProjectWorkspaceRow[];
  status: WorkspaceIconStatus;
  usage: ProjectWorkspaceUsage | undefined;
  gitStats: ProjectWorkspaceGitStats | undefined;
  loadingUsage: boolean;
  loadingGitStats: boolean;
  warnings: readonly string[];
  onDelete(): void;
  actionDisabledReason?: string;
}) {
  const disabledReasonId = useId();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <WorkspaceIcon type="repository" status={status} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold text-foreground">
              {project.name}
            </h2>
            <PathIssueSummaryPill rows={rows} />
            <RemovalSummaryPill rows={rows} />
          </div>
          <div className="truncate text-xs text-foreground-muted" title={rootRow.path}>
            {rootRow.path}
          </div>
          <MetaLine
            className="mt-1.5"
            keepEndWhenNarrow
            start={[
              status !== 'idle' ? (
                <span
                  key="status"
                  className={status === 'error' ? 'text-foreground-error' : 'text-foreground-muted'}
                >
                  {runtimeStatusLabel(status)}
                </span>
              ) : null,
              rootRow.branch ?? 'No branch',
              <GitStatsCell key="git" stats={gitStats} loading={loadingGitStats} />,
              usageLabel(usage, loadingUsage),
              usage ? `${formatBytes(usage.artifactBytes)} artifacts` : null,
            ]}
            end={syncLabel(rootRow.lastObservedAt)}
          />
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button type="button" variant="ghost" size="sm" icon aria-label="Workspace actions">
              <EllipsisIcon aria-hidden />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item
              variant="destructive"
              disabled={!!actionDisabledReason}
              aria-describedby={actionDisabledReason ? disabledReasonId : undefined}
              onClick={onDelete}
            >
              <Trash2Icon aria-hidden />
              Delete
            </DropdownMenu.Item>
            {actionDisabledReason && (
              <span id={disabledReasonId} className="sr-only">
                {actionDisabledReason}
              </span>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <WorkspaceScanWarnings warnings={warnings} />
    </section>
  );
}

function usageLabel(usage: ProjectWorkspaceUsage | undefined, loading: boolean): string {
  if (usage) return formatBytes(usage.totalBytes);
  return loading ? 'Measuring size…' : 'Size unknown';
}

function syncLabel(lastObservedAt: string | undefined): string {
  if (!lastObservedAt) return 'Not synced yet';
  const timestamp = Date.parse(lastObservedAt);
  if (!Number.isFinite(timestamp)) return 'Sync time unknown';
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days}d ago`;
}

function runtimeStatusLabel(status: WorkspaceIconStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'setting-up':
      return 'Setting up';
    case 'tearing-down':
      return 'Tearing down';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
  }
}

/** A quiet notice: the warning glyph carries the state, the words stay readable. */
function WorkspaceScanWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert.Root status="warning" role="status">
      <Alert.Title>The workspace scan finished with warnings</Alert.Title>
      <Alert.Description className="break-words">{warnings.join(' ')}</Alert.Description>
    </Alert.Root>
  );
}
