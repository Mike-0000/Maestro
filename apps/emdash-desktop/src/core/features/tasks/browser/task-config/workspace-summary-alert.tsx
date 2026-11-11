import { Collapsible } from '@emdash/ui/react/primitives';
import { ChevronRight, Info } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';
import type { WorkspacePresetId } from '@core/primitives/workspaces/api';

// ---------------------------------------------------------------------------
// Intent text per preset
// ---------------------------------------------------------------------------

export function getWorkspaceIntent(presetId: WorkspacePresetId, createBranch: boolean): string {
  switch (presetId) {
    case 'new-worktree':
      return createBranch
        ? 'Creates a new branch and an isolated worktree'
        : 'Checks out an existing branch in a new isolated worktree';
    case 'repo-root':
      return 'Uses the repository root directly — no worktree is created';
    case 'use-existing':
      return 'Reuses an existing workspace, no git setup required';
    case 'checkout-pr':
      return 'Fetches and checks out the PR branch in a dedicated worktree';
    case 'pr-new-branch':
      return 'Creates a new branch on top of the PR head in a dedicated worktree';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface WorkspaceSummaryAlertProps {
  description: string;
  steps: string[];
  className?: string;
}

/**
 * A quiet notice (design brief 2.12): a passive glyph and one sentence, with the steps behind
 * a disclosure in the caption role. No tinted fill, no coloured edge.
 */
export function WorkspaceSummaryAlert({
  description,
  steps,
  className,
}: WorkspaceSummaryAlertProps) {
  const hasSteps = steps.length > 0;

  return (
    <Collapsible.Root
      disabled={!hasSteps}
      className={cn('group/summary flex flex-col text-xs text-foreground-muted', className)}
    >
      <Collapsible.Trigger variant="text" hideChevron className="flex w-auto items-start gap-2">
        <Info className="mt-0.5 size-3.5 shrink-0 text-foreground-passive" />
        <span className="flex-1 text-pretty">{description}</span>
        {hasSteps && (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-foreground-passive transition-transform duration-150 group-data-open/summary:rotate-90 motion-reduce:transition-none" />
        )}
      </Collapsible.Trigger>

      {hasSteps && (
        <Collapsible.Panel>
          <ol className="flex flex-col gap-1 pt-2 pl-5.5">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="w-3 shrink-0 text-right text-foreground-passive tabular-nums">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </Collapsible.Panel>
      )}
    </Collapsible.Root>
  );
}
