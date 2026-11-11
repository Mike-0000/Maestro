import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { MetaLine } from '@emdash/ui/react/patterns';
import { Checkbox, RelativeTime } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { StackedAgentLogos } from '@core/features/agents/contributions/browser/stacked-agent-logos';
import { TaskConductorSubtitle } from '@core/features/conductor/contributions/browser/task-conductor-subtitle';
import {
  taskAgentStatus,
  taskConversationStats,
} from '@core/features/conversations/api/browser/conversation-selectors';
import {
  canIntegrateTask,
  getTaskGitCheckoutStore,
  getTaskPrAssociationStore,
} from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskContextMenu } from '@core/features/tasks/contributions/browser/task-context-menu';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import type { AgentStatus } from '@core/primitives/agents/api/agent-events';
import { cn } from '@core/primitives/styling/browser/cn';
import { selectCurrentPr } from '@root/src/core/services/pull-requests/api';
import { PrBadge } from '@root/src/core/services/pull-requests/browser/components/pr-badge';
import { type ReadyTask, type TaskListViewModel } from './task-list-model';

/** The task's state in the one glyph set and the words that go with it (design brief 2.6). */
const ROW_STATE: Record<Exclude<AgentStatus, 'idle'>, { glyph: StateGlyphState; words: string }> = {
  'awaiting-input': { glyph: 'needs-you', words: 'Needs you' },
  working: { glyph: 'working', words: 'Working' },
  completed: { glyph: 'unread', words: 'Finished' },
  error: { glyph: 'error', words: 'Stopped on an error' },
};

/**
 * Row content for the project task list, read like the sidebar's task rows: the title with its
 * age, then one caption line with the state (glyph and words) and what the task last said. The
 * CollectionView shell owns row click (navigation) and modifier-click selection; this component
 * renders the content, the hover-revealed checkbox, and the context menu.
 */
export const TaskRow = observer(function TaskRow({
  task,
  view,
}: {
  task: ReadyTask;
  view: TaskListViewModel;
}) {
  const { id } = view.useItem();
  const selection = view.useSelection();
  const openRename = useOpenModal('renameTaskModal');
  const openDeleteTask = useOpenModal('deleteTaskModal');
  const openIntegrate = useOpenModal('integrateWorktreeModal');
  const taskManager = getTaskManagerStore(task.data.projectId);

  const handleArchive = () => void taskManager?.archiveTask(task.data.id);
  const handleRestore = () => void taskManager?.restoreTask(task.data.id);
  const handleDelete = () => {
    void openDeleteTask({
      projectId: task.data.projectId,
      tasks: [{ taskId: task.data.id, taskName: task.data.name }],
    }).then((outcome) => {
      if (!outcome.success) return;
      const { deleteWorktree, deleteBranch, deleteConversations } = outcome.data;
      void taskManager?.deleteTasks([task.data.id], {
        deleteWorktree,
        deleteBranch,
        deleteConversations,
      });
    });
  };
  const handleRename = () => {
    void openRename({
      projectId: task.data.projectId,
      taskId: task.data.id,
      currentName: task.data.name,
    });
  };
  const isArchived = Boolean(task.data.archivedAt);
  const handleIntegrate =
    !isArchived && canIntegrateTask(task.data.projectId, task.data.id)
      ? () => void openIntegrate({ projectId: task.data.projectId, taskId: task.data.id })
      : undefined;
  const isSelected = selection.isSelected(id);
  const canPin = task.state !== 'unregistered';
  const agentAttention = taskAgentStatus(task);
  const state =
    !isArchived && agentAttention && agentAttention !== 'idle' ? ROW_STATE[agentAttention] : null;
  const stateWords = isArchived ? 'Archived' : state?.words;
  const currentPr = selectCurrentPr(getTaskPrAssociationStore(task).pullRequests);
  const branchName =
    getTaskGitCheckoutStore(task.data.projectId, task.data.id)?.branchName ?? undefined;

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={isArchived}
      branchName={branchName}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => void task.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onRestore={handleRestore}
      onConvertAutomation={undefined}
      onIntegrate={handleIntegrate}
      onDelete={handleDelete}
    >
      <div className="group flex w-full min-w-0 items-center gap-3">
        {/*
          Mouse clicks land on the wrapper (the checkbox is pointer-events-none)
          so the real event's modifier keys reach `toggle`; keyboard activation
          reaches the focusable checkbox itself and toggles via onCheckedChange.
          The target check keeps the keyboard path from double-toggling through
          the synthetic click that bubbles up.
        */}
        <span
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) selection.toggle(id, event);
          }}
          className={cn(
            'inline-flex cursor-pointer transition-opacity focus-within:opacity-100',
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => selection.toggle(id)}
            className="pointer-events-none"
            aria-label="Select task"
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'min-w-0 truncate text-left text-sm',
                isArchived ? 'text-foreground-muted' : 'text-foreground',
                state?.glyph === 'needs-you' && 'font-medium'
              )}
            >
              {task.data.name}
            </span>
            {currentPr && (
              <span className="shrink-0">
                <PrBadge pr={currentPr} variant="compact" />
              </span>
            )}
          </div>
          {/*
            The subtitle renders nothing when the task has nothing to say, so it brings its own
            " · " (only after state words) instead of going through MetaLine's joiner.
          */}
          <MetaLine
            className="min-h-4"
            glyph={state ? <StateGlyph state={state.glyph} size="sm" /> : undefined}
            start={
              <>
                {stateWords ? (
                  <span className={cn(state?.glyph === 'needs-you' && 'text-foreground-muted')}>
                    {stateWords}
                  </span>
                ) : null}
                <TaskConductorSubtitle
                  taskId={task.data.id}
                  branchName={branchName ?? null}
                  className={cn(
                    // Free text, not figures: tabular spacing would widen its hyphens.
                    'inline text-tiny text-foreground-passive normal-nums',
                    stateWords && "before:content-['_·_']"
                  )}
                />
              </>
            }
          />
        </div>
        <StackedAgentLogos stats={taskConversationStats(task)} />
        <TaskGitDiffStats task={task} className="shrink-0 text-xs tabular-nums" />
        <RelativeTime
          value={task.data.createdAt}
          className="w-8 shrink-0 text-right font-sans text-tiny text-foreground-passive tabular-nums"
          compact
        />
      </div>
    </TaskContextMenu>
  );
});
