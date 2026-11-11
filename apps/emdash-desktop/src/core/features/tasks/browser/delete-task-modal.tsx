import { Button, Checkbox, Dialog, ModalLayout } from '@emdash/ui/react/primitives';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { getTasksWireClient } from '@core/features/tasks/api/browser/client';
import { useTaskSettings } from '@core/features/tasks/api/browser/hooks/useTaskSettings';
import { taskHostActionAvailability } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';

export type DeleteTaskModalArgs = {
  projectId: string;
  tasks: Array<{ taskId: string; taskName: string }>;
};

export type DeleteTaskModalResult = {
  deleteWorktree: boolean;
  deleteBranch: boolean;
  deleteConversations: boolean;
};

export const DeleteTaskModal = observer(function DeleteTaskModal({
  projectId,
  tasks,
}: DeleteTaskModalArgs) {
  const { complete, dismiss } = useModalController('deleteTaskModal');
  const { deleteBranchByDefault } = useTaskSettings();
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [deleteBranchOverride, setDeleteBranchOverride] = useState<boolean>();
  const [deleteConversations, setDeleteConversations] = useState(true);

  const count = tasks.length;
  const isBulk = count > 1;

  const taskIds = useMemo(() => tasks.map((t) => t.taskId), [tasks]);
  const hostAction = taskHostActionAvailability(projectId);
  const hostActionDisabledReason =
    hostAction.kind === 'disabled'
      ? (projectAvailabilityUi.getLiveActionDisabledReason(projectId) ??
        projectAvailabilityUi.defaultLiveActionDisabledReason)
      : undefined;

  const { data: preflight = null } = useQuery({
    queryKey: ['deleteTaskPreflight', projectId, taskIds],
    enabled: !hostActionDisabledReason,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return (await (await getTasksWireClient()).getDeletePreflight({ projectId, taskIds }))
          .tasks;
      } catch {
        return [];
      }
    },
  });

  const isLoading = !hostActionDisabledReason && preflight === null;

  const worktreeTasks = preflight?.filter((t) => t.hasWorktree) ?? [];
  const dirtyTasks = preflight?.filter((t) => t.hasUncommittedChanges) ?? [];
  const branchTasks = preflight?.filter((t) => t.hasDeletableBranch) ?? [];
  // Nothing is queued for an unreachable host (ADR 0006): artifact deletion is
  // disabled with the reason shown, never silently deferred.
  const hostUnreachable =
    !!hostActionDisabledReason || worktreeTasks.some((t) => t.hostReachable === false);

  const showWorktreeCheckbox = !isLoading && worktreeTasks.length > 0;
  const showBranchCheckbox = !isLoading && branchTasks.length > 0;
  const effectiveDeleteWorktree = showWorktreeCheckbox && deleteWorktree && !hostUnreachable;
  const effectiveDeleteBranch = deleteBranchOverride ?? deleteBranchByDefault;
  const shouldDeleteBranch = effectiveDeleteWorktree && effectiveDeleteBranch;

  const handleWorktreeChange = (checked: boolean) => {
    setDeleteWorktree(checked);
    if (!checked) setDeleteBranchOverride(undefined);
  };

  const title = isBulk ? `Delete ${count} conductors` : 'Delete conductor';

  const description = isBulk
    ? `${count} conductors will be permanently deleted. This action cannot be undone.`
    : `"${tasks[0]!.taskName}" will be permanently deleted. This action cannot be undone.`;

  const worktreeLabel = isBulk
    ? `Delete worktrees (${worktreeTasks.length} of ${count} conductors)`
    : 'Delete worktree';

  const branchLabel = isBulk
    ? `Delete branches (${branchTasks.length} of ${count} conductors)`
    : `Delete branch`;

  const dirtyWarning = (() => {
    if (dirtyTasks.length === 0) return null;
    if (!isBulk) {
      const stats = dirtyTasks[0]?.changedLines;
      const lines =
        stats && (stats.added > 0 || stats.deleted > 0)
          ? ` (+${stats.added} −${stats.deleted})`
          : '';
      return `"${tasks[0]!.taskName}" has uncommitted changes${lines} that will be lost.`;
    }
    const names = dirtyTasks
      .map((t) => `"${tasks.find((task) => task.taskId === t.taskId)?.taskName ?? t.taskId}"`)
      .join(', ');
    return `${dirtyTasks.length} ${dirtyTasks.length === 1 ? 'conductor has' : 'conductors have'} uncommitted changes that will be lost: ${names}`;
  })();

  const unpushedWarning = (() => {
    const unpushed = worktreeTasks.filter((t) => (t.unpushedCommits ?? 0) > 0);
    if (unpushed.length === 0) return null;
    if (!isBulk) {
      const count = unpushed[0]!.unpushedCommits!;
      return `"${tasks[0]!.taskName}" has ${count} unpushed ${count === 1 ? 'commit' : 'commits'}.`;
    }
    return `${unpushed.length} ${unpushed.length === 1 ? 'conductor has' : 'conductors have'} unpushed commits.`;
  })();

  // A confirm dialog (design brief 2.9): the title, one sentence, the choices as checkbox rows
  // with any warning as a glyph and words under its row (never a tinted box), Cancel and the
  // destructive confirm.
  const checkRow =
    'flex cursor-pointer items-center gap-2.5 text-sm text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
  const warningRow = 'flex items-start gap-2 pl-6.5 text-xs text-pretty text-foreground-muted';

  return (
    <ModalLayout
      title={title}
      description={description}
      showCloseButton={false}
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <ConfirmButton
            variant="destructive"
            disabled={isLoading}
            onClick={() =>
              complete({
                deleteWorktree: effectiveDeleteWorktree,
                deleteBranch: showBranchCheckbox && shouldDeleteBranch,
                deleteConversations: deleteConversations && !hostActionDisabledReason,
              })
            }
          >
            {isLoading ? 'Loading…' : isBulk ? `Delete ${count} tasks` : 'Delete'}
          </ConfirmButton>
        </>
      }
    >
      <Dialog.Body>
        {(showWorktreeCheckbox || showBranchCheckbox) && (
          <div className="flex flex-col gap-3">
            {showWorktreeCheckbox && (
              <div className="flex flex-col gap-2">
                <label className={checkRow} aria-disabled={hostUnreachable}>
                  <Checkbox
                    checked={effectiveDeleteWorktree}
                    onCheckedChange={(checked) => handleWorktreeChange(Boolean(checked))}
                    disabled={hostUnreachable}
                  />
                  {worktreeLabel}
                </label>
                {hostUnreachable && (
                  <p className={warningRow}>
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
                    <span>
                      {hostActionDisabledReason ?? 'Live Project access is unavailable.'} The
                      worktree cannot be deleted right now. The conductor record will be removed;
                      delete the worktree later from the workspaces view.
                    </span>
                  </p>
                )}
                {effectiveDeleteWorktree && dirtyWarning && (
                  <p className={warningRow}>
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
                    <span>{dirtyWarning}</span>
                  </p>
                )}
                {effectiveDeleteWorktree && unpushedWarning && (
                  <p className={warningRow}>
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
                    <span>{unpushedWarning}</span>
                  </p>
                )}
              </div>
            )}

            {showBranchCheckbox && (
              <label className={checkRow} aria-disabled={!deleteWorktree}>
                <Checkbox
                  checked={shouldDeleteBranch}
                  onCheckedChange={(checked) => setDeleteBranchOverride(Boolean(checked))}
                  disabled={!deleteWorktree}
                />
                {branchLabel}
              </label>
            )}
          </div>
        )}

        {hostActionDisabledReason && (
          <p
            role="status"
            className="flex items-start gap-2 text-xs text-pretty text-foreground-muted"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
            <span>
              {hostActionDisabledReason} The conductor record can still be deleted without removing
              workspace artifacts.
            </span>
          </p>
        )}

        <label className={checkRow} aria-disabled={!!hostActionDisabledReason}>
          <Checkbox
            checked={deleteConversations && !hostActionDisabledReason}
            onCheckedChange={(checked) => setDeleteConversations(Boolean(checked))}
            disabled={!!hostActionDisabledReason}
            aria-label={
              hostActionDisabledReason
                ? `Delete conversations. ${hostActionDisabledReason}`
                : 'Delete conversations'
            }
          />
          Delete conversations
        </label>
      </Dialog.Body>
    </ModalLayout>
  );
});

export const deleteTaskModal = defineModal<DeleteTaskModalResult>()({
  id: 'deleteTaskModal',
  component: DeleteTaskModal,
  size: 'sm',
});
