import { PortalContainerProvider } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { TaskWindowProvider } from '../../api/browser/hooks/use-is-active-task';
import { getRegisteredTaskData, getTaskStore } from '../../api/browser/task-state/task-selectors';
import { taskWindows, type TaskWindow } from '../../api/browser/task-windows/task-windows';
import { TaskMainPanel } from '../../browser/main-panel';
import { TaskViewWrapperWithProviders } from '../../browser/view';

/**
 * The task view of one popped-out task, in its own window: the same tab strip (the pinned
 * Conductor tab, then the chats) and panes as in the main window, without the app's sidebar
 * and title bar. Its menus and dialogs mount in that window.
 */
const TaskWindowContent = observer(function TaskWindowContent({ entry }: { entry: TaskWindow }) {
  const { projectId, taskId } = entry;
  const task = getTaskStore(projectId, taskId);
  const name = task?.data.name;

  useEffect(() => {
    entry.window.document.title = name ? `${name} - ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [entry, name]);

  // A deleted or archived task has nothing left to show; its window goes with it.
  const gone = !task || Boolean(getRegisteredTaskData(projectId, taskId)?.archivedAt);
  useEffect(() => {
    if (gone) taskWindows.close(taskId);
  }, [gone, taskId]);
  if (gone) return null;

  return (
    <PortalContainerProvider container={entry.container}>
      <TaskWindowProvider taskId={taskId}>
        <div className="flex h-full flex-col bg-background text-foreground">
          <TaskViewWrapperWithProviders projectId={projectId} taskId={taskId} activateScope={false}>
            <TaskMainPanel />
          </TaskViewWrapperWithProviders>
        </div>
      </TaskWindowProvider>
    </PortalContainerProvider>
  );
});

/**
 * Renders every popped-out task into its window. It sits in the main window's tree, so the task
 * views share its providers, stores and live models; only their DOM lives in the other window.
 */
export const TaskWindowsHost = observer(function TaskWindowsHost() {
  return (
    <>
      {taskWindows.windows.map((entry) =>
        createPortal(<TaskWindowContent entry={entry} />, entry.container, entry.taskId)
      )}
    </>
  );
});
