import { describe, expect, it } from 'vitest';
import type { ProjectWorkspaceRow } from '@core/primitives/workspaces/api';
import { placeUnlinkedConversations } from './list-host-workspace-groups';

function workspaceRow(overrides: Partial<ProjectWorkspaceRow> = {}): ProjectWorkspaceRow {
  return {
    kind: 'root',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    path: 'C:\\Github\\chorus',
    tasks: [],
    usage: null,
    gitStats: null,
    pathState: 'measured',
    canCleanArtifacts: true,
    canDelete: true,
    hasActiveSessions: false,
    pendingRemoval: false,
    errors: [],
    ...overrides,
  };
}

function record(id: string, workspacePath: string | null, lastActivityAt: string) {
  return { id, title: id, provider: 'claude', workspacePath, lastActivityAt };
}

describe('placeUnlinkedConversations', () => {
  it('keeps the conversations that ran in a project workspace, newest first', () => {
    const placed = placeUnlinkedConversations(
      [workspaceRow()],
      [
        record('older', 'c:/github/chorus/', '2026-10-01T00:00:00.000Z'),
        record('elsewhere', 'C:\\Github\\other', '2026-10-03T00:00:00.000Z'),
        record('no-workspace', null, '2026-10-04T00:00:00.000Z'),
        record('newer', 'C:\\Github\\chorus', '2026-10-02T00:00:00.000Z'),
      ]
    );

    expect(placed.map(({ id, workspaceId }) => ({ id, workspaceId }))).toEqual([
      { id: 'newer', workspaceId: 'workspace-1' },
      { id: 'older', workspaceId: 'workspace-1' },
    ]);
    expect(placed[0]?.resumeDisabledReason).toBeUndefined();
  });

  it('says why a conversation cannot be resumed on its workspace', () => {
    const placed = placeUnlinkedConversations(
      [workspaceRow({ kind: 'candidate', workspaceId: null })],
      [record('conversation', 'C:\\Github\\chorus', '2026-10-01T00:00:00.000Z')]
    );

    expect(placed).toMatchObject([
      { id: 'conversation', workspaceId: null, resumeDisabledReason: expect.any(String) },
    ]);
  });

  it('ignores workspaces that are being removed', () => {
    expect(
      placeUnlinkedConversations(
        [workspaceRow({ pendingRemoval: true })],
        [record('conversation', 'C:\\Github\\chorus', '2026-10-01T00:00:00.000Z')]
      )
    ).toEqual([]);
  });
});
