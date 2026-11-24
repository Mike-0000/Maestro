import { createContext, createElement, useContext, type ReactNode } from 'react';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import {
  useViewParams,
  useWorkspaceSlots,
} from '@core/primitives/navigation/browser/navigation-hooks';

/** The task whose own window the subtree renders in, or null in the main window. */
const TaskWindowContext = createContext<string | null>(null);

/** Marks a subtree as the content of a task's own window: that task is on screen there. */
export function TaskWindowProvider({ taskId, children }: { taskId: string; children: ReactNode }) {
  return createElement(TaskWindowContext.Provider, { value: taskId }, children);
}

/** The subtree renders in a task's own window rather than in the main window. */
export function useInTaskWindow(): boolean {
  return useContext(TaskWindowContext) !== null;
}

/** The task is on screen: the main window shows its view, or this is its own window. */
export function useIsActiveTask(taskId: string): boolean {
  const windowTaskId = useContext(TaskWindowContext);
  const { currentView } = useWorkspaceSlots();
  const params = useViewParams(taskViewDef);
  if (windowTaskId !== null) return windowTaskId === taskId;
  return currentView === 'task' && params?.taskId === taskId;
}
