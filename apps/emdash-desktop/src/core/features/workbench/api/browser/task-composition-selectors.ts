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

export function getTaskWorkspace(projectId: string, taskId: string) {
  const workspaceId = getTaskStore(projectId, taskId)?.workspaceId;
  return workspaceId ? workspaceRegistry.get(workspaceId) : undefined;
}
