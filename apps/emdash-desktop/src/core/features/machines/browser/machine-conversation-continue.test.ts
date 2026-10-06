import { describe, expect, it } from 'vitest';
import type { HostConversationRow } from '@core/primitives/conversations/api';
import {
  sameHostPath,
  type HostWorkspaceGroup,
  type ProjectWorkspaceRow,
  type ProjectWorkspaceTask,
} from '@core/primitives/workspaces/api';
import { resolveMachineConversationContinue } from './machine-conversation-continue';

type ConversationLink = Parameters<typeof resolveMachineConversationContinue>[0];

function conversation(overrides: Partial<HostConversationRow> = {}): ConversationLink {
  return {
    projectId: null,
    taskId: null,
    taskName: null,
    workspacePath: 'C:\\Github\\chorus',
    pendingRemoval: false,
    ...overrides,
  };
}

function task(overrides: Partial<ProjectWorkspaceTask> & { taskId: string }): ProjectWorkspaceTask {
  return {
    name: overrides.taskId,
    status: 'in_progress',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function workspace(overrides: Partial<ProjectWorkspaceRow> = {}): ProjectWorkspaceRow {
  return {
    kind: 'root',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    path: 'C:\\Github\\chorus',
    tasks: [],
    usage: null,
    gitStats: null,
    pathState: 'remote',
    canCleanArtifacts: false,
    canDelete: false,
    hasActiveSessions: false,
    pendingRemoval: false,
    errors: [],
    ...overrides,
  };
}

function groups(...workspaces: ProjectWorkspaceRow[]): HostWorkspaceGroup[] {
  return [
    {
      project: { id: 'project-1', name: 'Chorus' },
      workspaces,
      unlinkedConversations: [],
      warnings: [],
    },
  ];
}

describe('resolveMachineConversationContinue', () => {
  it('opens the task a conversation is already linked to', () => {
    expect(
      resolveMachineConversationContinue(
        conversation({ projectId: 'project-9', taskId: 'task-9', taskName: 'Linked' }),
        undefined
      )
    ).toEqual({ kind: 'open', projectId: 'project-9', taskId: 'task-9', link: false });
  });

  it('re-resolves a link whose task no longer exists', () => {
    expect(
      resolveMachineConversationContinue(
        conversation({ projectId: 'project-9', taskId: 'gone', taskName: null }),
        groups(workspace())
      )
    ).toEqual({ kind: 'create', projectId: 'project-1', workspaceId: 'workspace-1' });
  });

  it("links into the workspace's most recent open task", () => {
    const target = resolveMachineConversationContinue(
      conversation({ workspacePath: 'c:/github/chorus/' }),
      groups(
        workspace({
          tasks: [
            task({ taskId: 'older', updatedAt: '2026-01-01T00:00:00.000Z' }),
            task({ taskId: 'archived', updatedAt: '2026-03-01T00:00:00.000Z', archivedAt: 'x' }),
            task({ taskId: 'newer', lastInteractedAt: '2026-02-01T00:00:00.000Z' }),
          ],
        })
      )
    );
    expect(target).toEqual({ kind: 'open', projectId: 'project-1', taskId: 'newer', link: true });
  });

  it('creates a task on the workspace when it has no open task', () => {
    expect(
      resolveMachineConversationContinue(
        conversation(),
        groups(workspace({ tasks: [task({ taskId: 'archived', archivedAt: 'x' })] }))
      )
    ).toEqual({ kind: 'create', projectId: 'project-1', workspaceId: 'workspace-1' });
  });

  it('explains why a conversation cannot be continued', () => {
    const reason = (link: ConversationLink, known?: HostWorkspaceGroup[]) => {
      const target = resolveMachineConversationContinue(link, known);
      return target.kind === 'unavailable' ? target.reason : target.kind;
    };
    expect(reason(conversation({ pendingRemoval: true }), groups())).toContain('being deleted');
    expect(reason(conversation({ workspacePath: null }), groups())).toContain('no workspace');
    expect(reason(conversation(), undefined)).toContain('still loading');
    expect(reason(conversation(), groups())).toContain('as a project on this machine');
    expect(reason(conversation(), groups(workspace({ pendingRemoval: true })))).toContain(
      'as a project on this machine'
    );
    expect(
      reason(conversation(), groups(workspace({ workspaceId: null, kind: 'candidate' })))
    ).toBe('This workspace is not registered.');
    expect(reason(conversation(), groups(workspace({ pathState: 'missing' })))).toBe(
      'This workspace path is no longer available.'
    );
  });
});

describe('sameHostPath', () => {
  it('ignores separator, case, and trailing slashes on Windows paths only', () => {
    expect(sameHostPath('C:\\Github\\Chorus\\', 'c:/github/chorus')).toBe(true);
    expect(sameHostPath('C:\\', 'c:/')).toBe(true);
    expect(sameHostPath('/home/me/repo/', '/home/me/repo')).toBe(true);
    expect(sameHostPath('/home/me/Repo', '/home/me/repo')).toBe(false);
    expect(sameHostPath('C:\\Github\\chorus', 'C:\\Github\\chorus-2')).toBe(false);
  });
});
