import { describe, expect, it } from 'vitest';
import { findRetiredTasks } from './local-update-service';

const enrolled = (taskId: string, worktreePath = `C:/worktrees/${taskId}`) => ({
  taskId,
  projectId: 'project-a',
  worktreePath,
});

const row = (id: string, overrides: { archivedAt?: string; deletedAt?: string } = {}) => ({
  id,
  projectId: 'project-a',
  archivedAt: overrides.archivedAt ?? null,
  deletedAt: overrides.deletedAt ?? null,
});

describe('findRetiredTasks', () => {
  it('retires enrolled work whose task was archived or deleted and keeps active tasks', async () => {
    const retired = await findRetiredTasks(
      [enrolled('active'), enrolled('archived'), enrolled('soft-deleted')],
      [
        row('active'),
        row('archived', { archivedAt: '2026-09-26T00:00:00Z' }),
        row('soft-deleted', { archivedAt: '2026-09-26T00:00:00Z', deletedAt: '2026-09-26' }),
      ],
      async () => true
    );

    expect(retired.map(({ task, reason }) => [task.taskId, reason])).toEqual([
      ['archived', 'archived'],
      ['soft-deleted', 'deleted'],
    ]);
  });

  it('treats a task unknown to this profile as deleted only when its worktree is gone', async () => {
    const retired = await findRetiredTasks(
      [enrolled('other-clone', 'C:/worktrees/present'), enrolled('removed', 'C:/worktrees/gone')],
      [],
      async (path) => path === 'C:/worktrees/present'
    );

    expect(retired.map(({ task, reason }) => [task.taskId, reason])).toEqual([
      ['removed', 'deleted'],
    ]);
  });

  it('ignores a row that belongs to a different project', async () => {
    const retired = await findRetiredTasks(
      [enrolled('shared-id')],
      [{ ...row('shared-id', { archivedAt: '2026-09-26' }), projectId: 'project-b' }],
      async () => false
    );

    expect(retired).toEqual([]);
  });
});
