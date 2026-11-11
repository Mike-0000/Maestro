import { Tabs, toast } from '@emdash/ui/react/primitives';
import { ExternalLink } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import { computeCheckRunsSummary } from '@core/features/github/api/browser/checks';
import { useTaskComposition } from '@core/features/workbench/api/browser/task-composition-context';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { getPrNumber, type PullRequest } from '@root/src/core/services/pull-requests/api';
import { PrMergeLine } from '@root/src/core/services/pull-requests/browser/components/pr-merge-line';
import { PrNumberBadge } from '@root/src/core/services/pull-requests/browser/components/pr-number-badge';
import { StatusIcon } from '@root/src/core/services/pull-requests/browser/components/pr-status-icon';
import { PrUrlCopyButton } from '@root/src/core/services/pull-requests/browser/components/pr-url-copy-button';
import { PrCheckoutDriftLine } from './checkout-drift-line';
import { PrChecksList } from './checks-list';
import { CommitRangeCommitsList } from './commits-list';
import { PrFilesList } from './files-list';
import { type MergeAction } from './merge-footer';
import { MergeFooter } from './merge-footer';
import { computeMergeUiState } from './merge-ui-state';
import { commitRangeForPullRequest } from './use-commits';

export type MergeMode = 'merge' | 'squash' | 'rebase';

const mergeLabels: Record<MergeMode, string> = {
  merge: 'Merge pull request',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

const mergeDescriptions: Record<MergeMode, string> = {
  merge: 'All commits from this branch will be added to the base branch via a merge commit.',
  squash: 'All commits from this branch will be combined into one commit in the base branch.',
  rebase: 'All commits from this branch will be rebased and added to the base branch.',
};

const bypassMergeLabels: Record<MergeMode, string> = {
  merge: 'Bypass rules and merge',
  squash: 'Squash without waiting',
  rebase: 'Rebase without waiting',
};

const bypassMergeDescriptions: Record<MergeMode, string> = {
  merge: 'Bypass unmet requirements and add all commits via a merge commit.',
  squash: 'Bypass unmet requirements and combine all commits into one commit.',
  rebase: 'Bypass unmet requirements and rebase all commits onto the base branch.',
};

/** A tab's count, in the caption tone so the tab word leads. */
function TabCount({ children }: { children: ReactNode }) {
  return <span className="ml-1.5 text-foreground-passive tabular-nums">{children}</span>;
}

export const PullRequestEntry = observer(function PullRequestEntry({
  pr: cachedPr,
}: {
  pr: PullRequest;
}) {
  const taskView = useTaskComposition();
  const prStore = taskView.prStore!;
  const diffView = taskView.diffView;
  const [isMerging, setIsMerging] = useState(false);
  const [isMarkingReady, setIsMarkingReady] = useState(false);
  const [bypassRequirements, setBypassRequirements] = useState(false);
  const [isUpdatingCheckout, setIsUpdatingCheckout] = useState(false);
  const details = prStore.details;
  const pr = details?.pr ?? cachedPr;
  const checks = pr.checks;
  if (!diffView) return null;
  const tab = diffView.effectivePrTab;
  const isOpen = pr.status === 'open';

  const uiState = computeMergeUiState(pr);
  const shouldBypassRequirements = uiState.canBypassRequirements && bypassRequirements;

  const doMerge = async (strategy: MergeMode, bypassRequirements: boolean) => {
    setIsMerging(true);
    try {
      const result = await prStore.mergePr(pr.url, {
        strategy,
        commitHeadOid: pr.headRefOid,
        bypassRequirements,
      });
      if (!result.success) {
        toast.error(
          bypassRequirements ? 'Failed to merge without waiting' : 'Failed to merge pull request',
          { description: result.error }
        );
      }
    } finally {
      setIsMerging(false);
    }
  };

  const handleMergeClick = (strategy: MergeMode) => {
    if (uiState.canMerge) {
      void doMerge(strategy, false);
    } else if (shouldBypassRequirements) {
      void doMerge(strategy, true);
    }
  };

  // Manual "Update now": guard refusals (dirty, active sessions, diverged) come
  // back as ordinary error messages through the same toast pattern merges use.
  const updateCheckout = async () => {
    setIsUpdatingCheckout(true);
    try {
      const result = await prStore.updatePrCheckout();
      if (!result.success) {
        toast.error('Could not update the checkout', { description: result.error });
      }
    } finally {
      setIsUpdatingCheckout(false);
    }
  };

  const mergeActions: MergeAction[] = (['merge', 'squash', 'rebase'] as const).map((strategy) => ({
    value: strategy,
    label: shouldBypassRequirements ? bypassMergeLabels[strategy] : mergeLabels[strategy],
    description: shouldBypassRequirements
      ? bypassMergeDescriptions[strategy]
      : mergeDescriptions[strategy],
    action: () => handleMergeClick(strategy),
  }));

  const checkSummary = computeCheckRunsSummary(checks);

  return (
    // One scroller for the whole entry: when the section is shorter than the brief + tabs +
    // footer, the entry scrolls as a unit rather than letting the footer paint over the tabs.
    // The tab body keeps a floor (min-h-40) and scrolls inside itself when there is room.
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {/* The PR in brief: its state and title (opens on GitHub), who wants to
          merge what, and whether this checkout matches the PR head. */}
      <div className="flex w-full shrink-0 flex-col gap-2 px-4 pt-1 pb-3">
        <div className="group/header flex min-w-0 items-start gap-2">
          <span className="flex h-5 shrink-0 items-center">
            <StatusIcon className="size-4" pr={pr} />
          </span>
          <button
            type="button"
            className="group/title flex min-w-0 flex-1 items-start rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => openExternal(pr.url)}
            title="Open on GitHub"
          >
            <span className="min-w-0 flex-1 text-sm leading-5 font-medium text-pretty text-foreground decoration-foreground-passive/60 underline-offset-4 group-hover/title:underline">
              {pr.title}
              <PrNumberBadge
                number={getPrNumber(pr) ?? 0}
                className="ml-1.5 font-normal text-foreground-passive tabular-nums"
              />
              <ExternalLink
                aria-hidden
                className="ml-1 inline size-3 align-[-1px] text-foreground-passive opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100"
              />
            </span>
          </button>
          <PrUrlCopyButton
            url={pr.url}
            className="-mt-0.5 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
          />
        </div>
        <PrMergeLine pr={pr} className="pl-6" />
        <PrCheckoutDriftLine
          drift={prStore.checkoutDrift}
          onUpdateNow={() => void updateCheckout()}
          isUpdating={isUpdatingCheckout}
          className="pl-6"
        />
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          if (value) diffView.setPrTab(value as 'files' | 'commits' | 'checks');
        }}
        className="flex min-h-40 flex-1 flex-col"
      >
        <Tabs.List variant="underline" aria-label="Pull request details" className="shrink-0 px-2">
          <Tabs.Tab value="files" disabled={!isOpen}>
            Files
            {(pr.changedFiles ?? 0) > 0 && <TabCount>{pr.changedFiles}</TabCount>}
          </Tabs.Tab>
          <Tabs.Tab value="commits">
            Commits
            {(pr.commitCount ?? 0) > 0 && <TabCount>{pr.commitCount}</TabCount>}
          </Tabs.Tab>
          <Tabs.Tab value="checks">
            Checks
            {checkSummary.failed > 0 ? (
              <span className="ml-1.5 flex items-center gap-1 text-foreground-error tabular-nums">
                <span aria-hidden className="size-1.5 rounded-full bg-foreground-error" />
                {checkSummary.failed}
                <span className="sr-only"> failing</span>
              </span>
            ) : (
              checks.length > 0 && <TabCount>{checks.length}</TabCount>
            )}
          </Tabs.Tab>
        </Tabs.List>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'files' && <PrFilesList pr={pr} />}
          {tab === 'commits' && (
            <div className="h-full px-2">
              <CommitRangeCommitsList range={commitRangeForPullRequest(pr)} />
            </div>
          )}
          {tab === 'checks' && <PrChecksList pr={pr} checks={checks} details={details} />}
        </div>
      </Tabs.Root>
      {pr.status === 'open' && (
        <MergeFooter
          uiState={uiState}
          mergeActions={mergeActions}
          isMerging={isMerging}
          isMarkingReady={isMarkingReady}
          bypassRequirements={bypassRequirements}
          onMarkReady={() => {
            setIsMarkingReady(true);
            prStore
              .markReadyForReview(pr.url)
              .catch(() => {
                toast.error('Failed to mark pull request ready', {
                  description: 'Refresh PR status and try again.',
                });
              })
              .finally(() => setIsMarkingReady(false));
          }}
          onBypassRequirementsChange={setBypassRequirements}
        />
      )}
    </div>
  );
});
