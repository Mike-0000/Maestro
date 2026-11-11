import { Button, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowDown, ArrowUp, GitBranch, RefreshCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  asAvailableProject,
  getProjectStore,
  projectDisplayName,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitRepositoryStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import {
  canIntegrateTask,
  getTaskGitCheckoutStore,
} from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { useGitActions } from '@core/features/source-control/api/browser/use-git-actions';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useTaskViewContext } from '@core/features/tasks/contributions/browser/task-view-context';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { cn } from '@core/primitives/styling/browser/cn';
import { getBranchTooltipText, getPublishTooltipText } from './git-status-tooltips';

export const GitStatusSection = observer(function GitStatusSection() {
  const { projectId, taskId } = useTaskViewContext();
  const workspaceId = getTaskStore(projectId, taskId)?.workspaceId;
  const git = getTaskGitCheckoutStore(projectId, taskId);
  const headDisplay = git?.headDisplay ?? null;
  const headKind = git?.headKind ?? 'branch';
  const isDetached = headKind === 'detached';
  const project = getProjectStore(projectId);
  const projectName = projectDisplayName(project) ?? 'repository';
  const context = asAvailableProject(project);
  const hostActionReason = context
    ? projectAvailabilityUi.getLiveActionDisabledReason(projectId)
    : 'Unavailable until access to this Project is restored.';
  const hostActionDisabled = hostActionReason !== null;
  const repositoryStore = getGitRepositoryStore(projectId);
  const openAddRemoteModal = useOpenModal('addRemoteModal');
  const openIntegrateModal = useOpenModal('integrateWorktreeModal');
  const showIntegrate = canIntegrateTask(projectId, taskId);

  const {
    isPublished,
    aheadCount,
    behindCount,
    fetch,
    pull,
    push,
    publish,
    isPublishing,
    isFetching,
    isPulling,
    isPushing,
  } = useGitActions(projectId, taskId);
  const shouldOfferAddRemote = (repositoryStore?.remotes.length ?? 0) === 0;

  const handlePublishClick = () => {
    if (hostActionDisabled || !headDisplay || headKind !== 'branch' || !workspaceId) return;
    if (shouldOfferAddRemote) {
      void openAddRemoteModal({
        projectId,
        projectName,
        workspaceId,
      });
      return;
    }
    publish();
  };

  const fetchLabel = isFetching ? 'Fetching…' : 'Fetch changes';
  const pullLabel = isPulling ? 'Pulling…' : behindCount === 0 ? 'Nothing to pull' : 'Pull changes';
  const pushLabel = isPushing ? 'Pushing…' : aheadCount === 0 ? 'Nothing to push' : 'Push changes';

  // The panel's footer strip: where this worktree's branch stands on the left,
  // the sync moves on the right as quiet icon buttons that carry their
  // ahead / behind counts, and Merge… as a text action. No rule above it.
  return (
    <Tooltip.Provider>
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 pr-2 pl-4">
        <Tooltip.Root>
          <Tooltip.Trigger className="flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-foreground-muted outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-foreground-passive" />
            <span className="truncate">{headDisplay}</span>
          </Tooltip.Trigger>
          <Tooltip.Content side="top">
            {getBranchTooltipText(headDisplay, headKind)}
          </Tooltip.Content>
        </Tooltip.Root>
        <div className="flex shrink-0 items-center gap-0.5">
          {showIntegrate && (
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button
                    variant="text"
                    size="xs"
                    className="mr-2"
                    aria-disabled={hostActionDisabled}
                    aria-description={hostActionReason ?? undefined}
                    onClick={() => {
                      if (!hostActionDisabled) void openIntegrateModal({ projectId, taskId });
                    }}
                  >
                    Merge…
                  </Button>
                }
              />
              <Tooltip.Content className="max-w-64">
                {hostActionReason ??
                  "Merge this task's commits into the branch checked out in the project's main directory"}
              </Tooltip.Content>
            </Tooltip.Root>
          )}
          {isPublished && !isDetached ? (
            <>
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      icon
                      aria-label={fetchLabel}
                      disabled={isFetching}
                      aria-disabled={hostActionDisabled}
                      aria-description={hostActionReason ?? undefined}
                      onClick={() => {
                        if (!hostActionDisabled) fetch();
                      }}
                    >
                      <RefreshCcw
                        className={cn('size-3.5', isFetching && 'motion-safe:animate-spin')}
                      />
                    </Button>
                  }
                />
                <Tooltip.Content>{hostActionReason ?? fetchLabel}</Tooltip.Content>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={behindCount === 0}
                      aria-label={pullLabel}
                      disabled={isPulling || behindCount === 0}
                      aria-disabled={hostActionDisabled}
                      aria-description={hostActionReason ?? undefined}
                      onClick={() => {
                        if (!hostActionDisabled) pull();
                      }}
                      className="tabular-nums"
                    >
                      <ArrowDown className="size-3.5" />
                      {behindCount > 0 && behindCount}
                    </Button>
                  }
                />
                <Tooltip.Content>{hostActionReason ?? pullLabel}</Tooltip.Content>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={aheadCount === 0}
                      aria-label={pushLabel}
                      disabled={isPushing || aheadCount === 0}
                      aria-disabled={hostActionDisabled}
                      aria-description={hostActionReason ?? undefined}
                      onClick={() => {
                        if (!hostActionDisabled) push();
                      }}
                      className="tabular-nums"
                    >
                      <ArrowUp className="size-3.5" />
                      {aheadCount > 0 && aheadCount}
                    </Button>
                  }
                />
                <Tooltip.Content>{hostActionReason ?? pushLabel}</Tooltip.Content>
              </Tooltip.Root>
            </>
          ) : (
            !isDetached && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Button
                      variant="text"
                      size="xs"
                      className="mr-2"
                      disabled={isPublishing || !headDisplay || headKind !== 'branch'}
                      aria-disabled={hostActionDisabled}
                      aria-description={hostActionReason ?? undefined}
                      onClick={handlePublishClick}
                    >
                      {isPublishing
                        ? 'Publishing…'
                        : shouldOfferAddRemote
                          ? 'Add remote'
                          : 'Publish'}
                    </Button>
                  }
                />
                <Tooltip.Content>
                  {hostActionReason ??
                    getPublishTooltipText({
                      isPublishing,
                      headDisplay,
                      headKind,
                      shouldOfferAddRemote,
                    })}
                </Tooltip.Content>
              </Tooltip.Root>
            )
          )}
        </div>
      </div>
    </Tooltip.Provider>
  );
});
