import { when } from 'mobx';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskCompositionHandleStoreToken } from '@core/features/workbench/contributions/browser/task-store-tokens';
import { workspaceRegistry } from '@core/features/workspaces/api/browser/stores/workspace-registry';

export function getTaskComposition(projectId: string, taskId: string) {
  return getTaskStore(projectId, taskId)?.get(taskCompositionHandleStoreToken).current ?? undefined;
}

const TASK_COMPOSITION_TIMEOUT_MS = 30_000;

/**
 * Opens a conversation in the task's pane layout. A task created a moment ago has no composition
 * until its workspace is known, so this waits for one rather than dropping the request.
 */
export async function openTaskConversation(
  projectId: string,
  taskId: string,
  conversationId: string
): Promise<void> {
  const handle = getTaskStore(projectId, taskId)?.get(taskCompositionHandleStoreToken);
  if (!handle) return;
  try {
    await when(() => handle.current !== null, { timeout: TASK_COMPOSITION_TIMEOUT_MS });
  } catch {
    return;
  }
  await handle.current?.openConversation(conversationId);
}

/**
 * Opens a tab beside what the developer is looking at in a task view: in the pane that already
 * holds a tab of this kind, else in the pane to the right of the focused one, splitting if there
 * is none. Reusing the pane keeps a run of opens from splitting the view again each time. Waits
 * for the task's pane layout to exist and be restored. False when the task has no view to open
 * the tab in.
 */
export async function openTaskTabBeside(
  projectId: string,
  taskId: string,
  kind: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const handle = getTaskStore(projectId, taskId)?.get(taskCompositionHandleStoreToken);
  if (!handle) return false;
  try {
    await when(() => handle.current !== null, { timeout: TASK_COMPOSITION_TIMEOUT_MS });
  } catch {
    return false;
  }
  const composition = handle.current;
  if (!composition || !(await composition.whenPaneLayoutRestored())) return false;
  const layout = composition.paneLayout;
  const home = layout.groups.find((group) =>
    group.pane.resolvedTabs.some((tab) => tab.kind === kind)
  );
  layout.open(kind, args, { target: home ? { paneId: home.paneId } : 'right', preview: false });
  return true;
}

export function getTaskWorkspace(projectId: string, taskId: string) {
  const workspaceId = getTaskStore(projectId, taskId)?.workspaceId;
  return workspaceId ? workspaceRegistry.get(workspaceId) : undefined;
}
