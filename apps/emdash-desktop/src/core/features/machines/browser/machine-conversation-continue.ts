import type { HostConversationRow } from '@core/primitives/conversations/api';
import {
  projectWorkspaceOpenInTaskDisabledReason,
  type HostWorkspaceGroup,
  type ProjectWorkspaceRow,
} from '@core/primitives/workspaces/api';

/**
 * Where "Continue here" takes a host conversation on this client: an existing task (linking the
 * conversation to it first when it is not yet linked), a new task on the conversation's
 * workspace, or nowhere, with the reason to show.
 */
export type MachineConversationContinueTarget =
  | { kind: 'open'; projectId: string; taskId: string; link: boolean }
  | { kind: 'create'; projectId: string; workspaceId: string }
  | { kind: 'unavailable'; reason: string };

export function resolveMachineConversationContinue(
  conversation: Pick<
    HostConversationRow,
    'projectId' | 'taskId' | 'taskName' | 'workspacePath' | 'pendingRemoval'
  >,
  /** The host's workspace groups; undefined while they have not loaded yet. */
  groups: readonly HostWorkspaceGroup[] | undefined
): MachineConversationContinueTarget {
  if (conversation.pendingRemoval) {
    return { kind: 'unavailable', reason: 'This conversation is being deleted.' };
  }
  // A link whose task no longer resolves (no task name) is dangling; resolve it again.
  if (conversation.projectId && conversation.taskId && conversation.taskName !== null) {
    return {
      kind: 'open',
      projectId: conversation.projectId,
      taskId: conversation.taskId,
      link: false,
    };
  }
  const workspacePath = conversation.workspacePath;
  if (!workspacePath) {
    return {
      kind: 'unavailable',
      reason: 'This conversation has no workspace, so it cannot be opened in a task.',
    };
  }
  if (groups === undefined) {
    return {
      kind: 'unavailable',
      reason: 'The workspaces on this machine are still loading. Try again in a moment.',
    };
  }

  const rows = groups
    .flatMap((group) => group.workspaces)
    .filter((row) => !row.pendingRemoval && sameHostPath(row.path, workspacePath));
  const row = rows.find((candidate) => candidate.workspaceId !== null) ?? rows[0];
  if (!row) {
    return {
      kind: 'unavailable',
      reason: `Add ${workspacePath} as a project on this machine to continue this conversation here.`,
    };
  }

  const task = latestOpenTask(row);
  if (task) return { kind: 'open', projectId: row.projectId, taskId: task.taskId, link: true };

  const disabled = projectWorkspaceOpenInTaskDisabledReason(row);
  if (disabled || !row.workspaceId) {
    return { kind: 'unavailable', reason: disabled ?? 'This workspace is not registered.' };
  }
  return { kind: 'create', projectId: row.projectId, workspaceId: row.workspaceId };
}

function latestOpenTask(row: ProjectWorkspaceRow) {
  return row.tasks.filter((task) => !task.archivedAt).sort((a, b) => activity(b) - activity(a))[0];
}

function activity(task: { lastInteractedAt?: string; updatedAt: string }): number {
  const parsed = Date.parse(task.lastInteractedAt ?? task.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Host paths can reach the client with either separator and, on Windows hosts, any drive-letter
 * or case spelling; compare them the way the host's filesystem would.
 */
export function sameHostPath(a: string, b: string): boolean {
  return normalizeHostPath(a) === normalizeHostPath(b);
}

function normalizeHostPath(path: string): string {
  const windows = /^[a-z]:[\\/]/iu.test(path) || path.startsWith('\\\\');
  let normalized = windows ? path.replace(/\\/gu, '/') : path;
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[a-z]:\/$/iu.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return windows ? normalized.toLowerCase() : normalized;
}
