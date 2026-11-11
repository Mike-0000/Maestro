import { Tooltip } from '@emdash/ui/react/primitives';
import { ArrowRight, GitBranch } from 'lucide-react';
import { parseRepositoryRef } from '@core/primitives/repository/api';
import { cn } from '@core/primitives/styling/browser/cn';
import type { PullRequest } from '@core/services/pull-requests/api';

export function PrMergeLine({ pr, className }: { pr: PullRequest; className?: string }) {
  const author = pr.author?.userName;
  const baseOwner = parseRepositoryRef(pr.repositoryUrl)?.owner;
  const baseBranch = pr.baseRefName;
  const headOwner = parseRepositoryRef(pr.headRepositoryUrl)?.owner ?? author;
  const headBranch = pr.headRefName;
  const actionText = getPrMergeLineActionText(pr.status);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1 text-xs text-foreground-muted', className)}>
      <div className="flex flex-wrap items-center gap-x-1">
        {author && <span className="font-medium text-foreground-body">{author}</span>}
        <span>{actionText}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <PrBranchBadge owner={headOwner} branch={headBranch} />
        <ArrowRight
          role="img"
          aria-label="into"
          className="size-3 shrink-0 text-foreground-passive"
        />
        <PrBranchBadge owner={baseOwner} branch={baseBranch} />
      </div>
    </div>
  );
}

export function getPrMergeLineActionText(status: PullRequest['status']) {
  switch (status) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'was closed without merging';
    case 'open':
      return 'wants to merge';
  }
}

function PrBranchBadge({ owner, branch }: { owner?: string; branch: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className="min-w-0 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {/* The inline-code role: a 4px chip one surface step up, mono caption text. */}
        <span className="flex min-w-0 items-center gap-1 rounded-xs bg-surface-emphasis px-1 py-px font-mono text-tiny text-foreground-muted">
          <GitBranch aria-hidden className="size-3 shrink-0 text-foreground-passive" />
          <span className="truncate">
            {owner}:{branch}
          </span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {owner}:{branch}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
