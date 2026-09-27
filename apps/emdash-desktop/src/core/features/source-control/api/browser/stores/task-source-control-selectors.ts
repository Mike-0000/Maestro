import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { getGitCheckoutStore } from '@core/features/source-control/api/browser/stores/source-control-selectors';
import type { TaskPrAssociationStore } from '@core/features/source-control/api/browser/stores/task-pr-association-store';
import { taskPrAssociationStoreToken } from '@core/features/source-control/contributions/browser/task-stores';
import type { TaskStore } from '@core/features/tasks/api/browser/stores/task-store';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import type { GitCheckoutStore } from '../../../browser/stores/git-checkout-store';

/** Call only inside `observer` components (or other MobX reactions). */
export function getTaskGitCheckoutStore(
  projectId: string,
  taskId: string
): GitCheckoutStore | undefined {
  const workspaceId = getTaskStore(projectId, taskId)?.workspaceId;
  return workspaceId ? getGitCheckoutStore(workspaceId) : undefined;
}

/**
 * Whether the task runs in its own worktree and so can be integrated into the project's main
 * directory. Tasks that run in the main directory itself have nothing to integrate.
 * Call only inside `observer` components (or other MobX reactions).
 */
export function canIntegrateTask(projectId: string, taskId: string): boolean {
  const workspaceId = getTaskStore(projectId, taskId)?.workspaceId;
  if (!workspaceId) return false;
  const repositoryWorkspaceId = projectData(getProjectStore(projectId))?.repositoryWorkspaceId;
  return !!repositoryWorkspaceId && repositoryWorkspaceId !== workspaceId;
}

/** Task-lifetime PR association state, available for active and inactive tasks. */
export function getTaskPrAssociationStore(task: TaskStore): TaskPrAssociationStore {
  return task.get(taskPrAssociationStoreToken);
}
