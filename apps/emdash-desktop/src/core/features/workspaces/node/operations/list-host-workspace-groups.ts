import { and, eq, isNull } from 'drizzle-orm';
import {
  conversationRegistryTable as conversations,
  liveConversations,
} from '@core/features/conversations/api/node/registry';
import { workspaceRegistryTable as workspaces } from '@core/features/workspaces/api/node/registry';
import {
  projectWorkspaceOpenInTaskDisabledReason,
  sameHostPath,
  type HostUnlinkedConversation,
  type HostWorkspaceGroupsData,
  type ProjectWorkspaceRow,
} from '@core/primitives/workspaces/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { projects } from '@core/services/app-db/node/schema';
import {
  listProjectWorkspaces,
  type ListProjectWorkspacesDependencies,
} from './list-project-workspaces';

/** Machines-page scope key: this device or one SSH connection. */
export type WorkspaceGroupsHostKey = 'local' | `ssh:${string}`;

export function workspaceGroupsHostKey(input: {
  location: 'local' | 'remote';
  sshConnectionId: string | null;
}): WorkspaceGroupsHostKey {
  return input.location === 'remote' && input.sshConnectionId !== null
    ? `ssh:${input.sshConnectionId}`
    : 'local';
}

/**
 * The machines-page workspaces read: every project whose repository workspace lives on
 * the host, each with its mirror-served rows. Pure DB reads — grouping updates live
 * through the workspaces/tasks/projects/conversations pokes, never through host scans.
 *
 * A remote host's groups also carry its conversations that no task here is linked to (for
 * example ones started from another computer), so the project tree can offer to resume them.
 */
export async function listHostWorkspaceGroups(
  dependencies: ListProjectWorkspacesDependencies,
  hostKey: WorkspaceGroupsHostKey
): Promise<HostWorkspaceGroupsData> {
  const hostFilter =
    hostKey === 'local'
      ? and(eq(workspaces.location, 'local'), isNull(workspaces.sshConnectionId))
      : and(
          eq(workspaces.location, 'remote'),
          eq(workspaces.sshConnectionId, hostKey.slice('ssh:'.length))
        );

  const projectRows = dependencies.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.repositoryWorkspaceId))
    .where(and(isNull(projects.deletedAt), hostFilter))
    .all();

  const unlinked =
    hostKey === 'local'
      ? []
      : listUnlinkedHostConversations(dependencies.db, hostKey.slice('ssh:'.length));

  const groups = await Promise.all(
    projectRows.map(async (project) => {
      try {
        const listed = await listProjectWorkspaces(dependencies, project.id);
        return {
          project,
          workspaces: listed.rows,
          unlinkedConversations: placeUnlinkedConversations(listed.rows, unlinked),
          warnings: listed.warnings,
        };
      } catch (error) {
        return {
          project,
          workspaces: [],
          unlinkedConversations: [],
          warnings: [error instanceof Error ? error.message : String(error)],
        };
      }
    })
  );

  return {
    groups: groups.sort((left, right) => left.project.name.localeCompare(right.project.name)),
  };
}

type UnlinkedConversationRecord = {
  id: string;
  title: string;
  provider: string | null;
  workspacePath: string | null;
  lastActivityAt: string;
};

function listUnlinkedHostConversations(
  db: AppDb,
  sshConnectionId: string
): UnlinkedConversationRecord[] {
  return db
    .select()
    .from(conversations)
    .where(
      and(
        liveConversations(),
        eq(conversations.location, 'remote'),
        eq(conversations.sshConnectionId, sshConnectionId),
        isNull(conversations.taskId),
        isNull(conversations.deletionTombstone)
      )
    )
    .all()
    .filter((row) => row.observedStatus !== 'missing')
    .map((row) => ({
      id: row.id,
      title: row.title,
      provider: row.provider,
      workspacePath: row.workspacePath,
      lastActivityAt: row.lastSessionActivityAt ?? row.updatedAt,
    }));
}

/** The conversations that ran in one of the project's workspaces, newest first. */
export function placeUnlinkedConversations(
  rows: readonly ProjectWorkspaceRow[],
  records: readonly UnlinkedConversationRecord[]
): HostUnlinkedConversation[] {
  const placed: HostUnlinkedConversation[] = [];
  for (const record of records) {
    const workspacePath = record.workspacePath;
    if (!workspacePath) continue;
    const matches = rows.filter(
      (row) => !row.pendingRemoval && sameHostPath(row.path, workspacePath)
    );
    const row = matches.find((candidate) => candidate.workspaceId !== null) ?? matches[0];
    if (!row) continue;
    const resumeDisabledReason = projectWorkspaceOpenInTaskDisabledReason(row);
    placed.push({
      id: record.id,
      title: record.title,
      provider: record.provider,
      workspacePath,
      workspaceId: row.workspaceId,
      lastActivityAt: record.lastActivityAt,
      ...(resumeDisabledReason ? { resumeDisabledReason } : {}),
    });
  }
  return placed.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
