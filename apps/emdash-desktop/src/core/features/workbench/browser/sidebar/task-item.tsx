import { observer } from 'mobx-react-lite';
import { TaskConductorSubtitle } from '@core/features/conductor/contributions/browser/task-conductor-subtitle';
import { isSidebarTaskYours } from '@core/features/conductor/contributions/browser/task-ownership';
import { projectViewDef } from '@core/features/projects/contributions/views';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import {
  canIntegrateTask,
  getTaskGitCheckoutStore,
  getTaskPrAssociationStore,
} from '@core/features/source-control/api/browser/stores/task-source-control-selectors';
import { type TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import {
  getTaskManagerStore,
  getTaskStore,
} from '@core/features/tasks/api/browser/task-state/task-selectors';
import { TaskContextMenu } from '@core/features/tasks/contributions/browser/task-context-menu';
import { TaskGitDiffStats } from '@core/features/tasks/contributions/browser/task-git-diff-stats';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskWorkspace } from '@core/features/workbench/api/browser/task-composition-selectors';
import { TaskSidebarTrailingSlot } from '@core/features/workbench/browser/sidebar/task-sidebar-agent-status';
import { useOpenModal } from '@core/manifests/browser/modal-api';
import {
  useNavigate,
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';
import { cn } from '@core/primitives/styling/browser/cn';
import { selectCurrentPr } from '@root/src/core/services/pull-requests/api';
import { PrBadge } from '@root/src/core/services/pull-requests/browser/components/pr-badge';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

interface SidebarTaskItemProps {
  taskId: string;
  projectId: string;
  /** Pinned strip uses tighter padding than tasks nested under a project. */
  rowVariant?: 'underProject' | 'pinned';
}

export const SidebarTaskItem = observer(function SidebarTaskItem({
  taskId,
  projectId,
  rowVariant = 'underProject',
}: SidebarTaskItemProps) {
  const { navigate } = useNavigate();
  const openRename = useOpenModal('renameTaskModal');
  const openDeleteTask = useOpenModal('deleteTaskModal');
  const openIntegrate = useOpenModal('integrateWorktreeModal');

  const { currentView } = useWorkspaceSlots();
  const params = useViewParams(taskViewDef);
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const isActive =
    currentView === 'task' && params?.taskId === taskId && params.projectId === projectId;

  const task = getTaskStore(projectId, taskId)!;
  const taskManager = getTaskManagerStore(projectId);

  const taskName = task.data.name;

  const openTask = () => {
    navigate(taskViewDef({ projectId, taskId }));
  };

  const handleArchive = () => {
    if (isActive) navigate(projectViewDef({ projectId }));
    void taskManager?.archiveTask(taskId);
  };

  const handleRename = () => {
    void openRename({ projectId, taskId, currentName: taskName });
  };

  const handleDelete = () => {
    void openDeleteTask({
      projectId,
      tasks: [{ taskId, taskName }],
    }).then((outcome) => {
      if (!outcome.success) return;
      const { deleteWorktree, deleteBranch, deleteConversations } = outcome.data;
      void taskManager?.deleteTasks([taskId], {
        deleteWorktree,
        deleteBranch,
        deleteConversations,
      });
      if (isActive) navigate(projectViewDef({ projectId }));
    });
  };

  const canPin = task.state !== 'unregistered';

  const workspaceStore = getTaskWorkspace(projectId, taskId);
  const git = getTaskGitCheckoutStore(projectId, taskId);
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? true;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;
  const branchName = git?.branchName ?? undefined;
  const handleIntegrate = canIntegrateTask(projectId, taskId)
    ? () => void openIntegrate({ projectId, taskId })
    : undefined;
  const handleReconnect =
    workspaceStore?.connectionState != null ? () => workspaceStore.reconnect() : undefined;

  // A task that is the developer's (the ownership line's rule) reads at full strength.
  const yours = isSidebarTaskYours(taskId);

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={false}
      branchName={branchName}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => void task.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={handleReconnect}
      onConvertAutomation={undefined}
      onIntegrate={handleIntegrate}
      onDelete={handleDelete}
    >
      {/*
       * Two lines at a fixed 46px: the title with its trailing facts, then one line of what the
       * task's conductor or chats last said. Without a second line the title sits centred in the
       * same height, so rows never jump when a subtitle comes or goes.
       */}
      <SidebarMenuRow
        className={cn(
          'group/row h-[46px] gap-0 py-0 pr-2',
          rowVariant === 'pinned' ? 'pl-2' : 'pl-8'
        )}
        isActive={isActive}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openTask}
      >
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarMenuAction
              aria-label={`Open conductor ${taskName || 'conductor'}`}
              className="overflow-hidden"
            >
              <span
                className={cn(
                  'min-w-0 truncate text-sm/[18px]',
                  task.isBootstrapping
                    ? 'text-foreground/40'
                    : cn('text-foreground', yours && 'font-medium')
                )}
              >
                {taskName}
              </span>
            </SidebarMenuAction>
            <div className="flex shrink-0 items-center justify-end gap-1.5">
              {showPrStatus && <RenderPrBadge task={task} />}
              <TaskSidebarTrailingSlot task={task} showTimestamp={showTimestamps} />
            </div>
          </div>
          {/* Collapses when it has nothing to show, so a lone title centres in the row. */}
          <div className="flex min-w-0 items-center gap-2 empty:hidden">
            <TaskConductorSubtitle
              taskId={taskId}
              branchName={branchName ?? null}
              className="flex-1 leading-4"
            />
            {showLineChanges && <TaskGitDiffStats task={task} className="ml-auto leading-4" />}
          </div>
        </div>
      </SidebarMenuRow>
    </TaskContextMenu>
  );
});

const RenderPrBadge = observer(function RenderPrBadge({ task }: { task: TaskStore }) {
  const pr = selectCurrentPr(getTaskPrAssociationStore(task).pullRequests);
  return pr ? (
    <span onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <PrBadge variant="compact" pr={pr} hoverDelay={100} />
    </span>
  ) : null;
});
