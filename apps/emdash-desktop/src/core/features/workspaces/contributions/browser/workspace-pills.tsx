import { Badge, Tooltip, type BadgeTone } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  workspaceRemovalNeedsAttention,
  type ProjectWorkspacePathIssue,
  type ProjectWorkspaceRow,
} from '@core/primitives/workspaces/api';
import { workspaceRowLabel } from './workspace-row-label';

/**
 * Workspace state chips are the kit's quiet `Badge`: caption-role words in sentence case on one
 * neutral step. Only a failure (error) or something to look at (warning) colours the words; a
 * removal still on its way reads muted.
 */
type ChipTone = Extract<BadgeTone, 'neutral' | 'warning' | 'error'>;

function Chip({
  tone,
  className,
  children,
}: {
  tone: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  // The wrapper lets a chip give way to the name beside it in a narrow row (the kit Badge itself
  // never shrinks), down to a few letters; the words then truncate inside it.
  return (
    <span className="inline-flex max-w-full min-w-10 shrink-4">
      <Badge tone={tone} className={cn('max-w-full', className)}>
        <span className="min-w-0 truncate">{children}</span>
      </Badge>
    </span>
  );
}

/** A chip whose detail sits in a tooltip; the trigger is a focusable button so keyboards reach it. */
export function ChipWithDetail({
  tone,
  className,
  label,
  detail,
  detailClassName = 'max-w-80',
}: {
  tone: ChipTone;
  className?: string;
  label: ReactNode;
  detail: ReactNode;
  detailClassName?: string;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className="inline-flex max-w-full min-w-10 shrink-4 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Chip tone={tone} className={className}>
          {label}
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content className={cn('text-xs', detailClassName)}>{detail}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/** Pending-deletion treatment: the tombstoned row is its own visible state (ADR 0006). */
export function RemovalPill({
  pendingRemoval,
  needsAttention,
  message,
  className,
}: {
  pendingRemoval: boolean;
  needsAttention: boolean;
  message?: string;
  className?: string;
}) {
  if (!pendingRemoval) return null;
  if (needsAttention) {
    return (
      <ChipWithDetail
        tone="error"
        className={className}
        label="Removal failed"
        detailClassName="max-w-70"
        detail={message ?? 'The removal stopped after a failure that needs your decision.'}
      />
    );
  }
  return (
    <Chip tone="neutral" className={className}>
      Removing…
    </Chip>
  );
}

/** Aggregate pending-removal pill for a whole project; renders nothing while clear. */
export function RemovalSummaryPill({
  rows,
  className,
}: {
  rows: readonly ProjectWorkspaceRow[];
  className?: string;
}) {
  const pendingRows = rows.filter((row) => row.pendingRemoval);
  if (pendingRows.length === 0) return null;
  const needsAttention = pendingRows.filter((row) => workspaceRemovalNeedsAttention(row)).length;
  const label =
    needsAttention > 0
      ? `${needsAttention} ${needsAttention === 1 ? 'removal needs' : 'removals need'} attention`
      : `${pendingRows.length} ${pendingRows.length === 1 ? 'removal' : 'removals'} pending`;
  return (
    <Chip tone={needsAttention > 0 ? 'error' : 'neutral'} className={className}>
      {label}
    </Chip>
  );
}

export function pathIssueMessage(
  issue: ProjectWorkspacePathIssue | undefined,
  path: string
): string {
  if (!issue) return 'Workspace path needs attention.';
  if (issue.reason) return issue.reason;
  if (issue.kind === 'prunable') return 'Git reports this worktree as prunable.';
  return `Directory not found at ${path}.`;
}

export function PathIssueChip({
  issue,
  path,
  className,
}: {
  issue: ProjectWorkspacePathIssue;
  path: string;
  className?: string;
}) {
  return (
    <ChipWithDetail
      tone={issue.kind === 'prunable' ? 'warning' : 'error'}
      className={className}
      label={issue.kind === 'prunable' ? 'Stale git record' : 'Missing'}
      detail={pathIssueMessage(issue, path)}
    />
  );
}

/** Aggregate path-issue pill for a whole project; renders nothing while clear. */
export function PathIssueSummaryPill({
  rows,
  className,
}: {
  rows: readonly ProjectWorkspaceRow[];
  className?: string;
}) {
  const issueRows = rows.filter((row) => row.pathIssue !== undefined);
  const summary = pathIssueSummary(issueRows);
  if (!summary) return null;
  return (
    <ChipWithDetail
      tone="warning"
      className={className}
      label={summary}
      detailClassName="max-w-96"
      detail={
        <div className="flex flex-col gap-1">
          {issueRows.map((row) => (
            <div key={`${row.workspaceId ?? row.path}:${row.path}`} className="min-w-0">
              <div className="font-medium">{workspaceRowLabel(row)}</div>
              <div className="text-foreground-muted">
                {pathIssueMessage(row.pathIssue, row.path)}
              </div>
            </div>
          ))}
        </div>
      }
    />
  );
}

function pathIssueSummary(rows: readonly ProjectWorkspaceRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  const [first] = rows;
  if (rows.length === 1 && first?.pathIssue) {
    return first.pathIssue.kind === 'prunable'
      ? `${workspaceRowLabel(first)} has a stale git record`
      : `${workspaceRowLabel(first)} missing`;
  }
  return `${rows.length} worktrees need attention`;
}
