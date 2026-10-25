import { describe, expect, it, vi } from 'vitest';
import type { GitBranchRef } from '@core/primitives/git/api';
import { buildSpawnWorkspaceConfig, type SpawnWorkspaceContext } from './spawn-workspace';

const main: GitBranchRef = { type: 'local', branch: 'main' };

function context(overrides: Partial<SpawnWorkspaceContext> = {}): SpawnWorkspaceContext {
  return {
    repositoryWorkspaceId: 'ws-repo',
    branchName: vi.fn(() => 'fix-login-abc12'),
    fromBranch: main,
    pushBranch: true,
    ...overrides,
  };
}

describe('buildSpawnWorkspaceConfig', () => {
  it('edits the project directory by default, without a branch or worktree', () => {
    const ctx = context();
    expect(buildSpawnWorkspaceConfig(undefined, ctx)).toEqual({
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: 'ws-repo' },
    });
    expect(buildSpawnWorkspaceConfig(false, ctx).workspace.kind).toBe('repository-instance');
    expect(ctx.branchName).not.toHaveBeenCalled();
  });

  it('needs no commits or default branch to use the project directory', () => {
    expect(buildSpawnWorkspaceConfig(undefined, context({ fromBranch: undefined })).git).toEqual({
      kind: 'none',
    });
  });

  it('refuses the project directory before the repository workspace is registered', () => {
    expect(() =>
      buildSpawnWorkspaceConfig(undefined, context({ repositoryWorkspaceId: null }))
    ).toThrow('The project directory is not registered yet.');
  });

  it('creates a branch and worktree when one is requested', () => {
    expect(buildSpawnWorkspaceConfig(true, context({ pushBranch: false }))).toEqual({
      version: '2',
      git: {
        kind: 'create-branch',
        branchName: 'fix-login-abc12',
        fromBranch: main,
        pushBranch: false,
      },
      workspace: { kind: 'new-worktree' },
    });
  });

  it('refuses a worktree when the project has no default branch', () => {
    expect(() => buildSpawnWorkspaceConfig(true, context({ fromBranch: undefined }))).toThrow(
      'no default branch'
    );
  });

  it('names the real cause when there is no default branch', () => {
    const fail = (branches: SpawnWorkspaceContext['branches']) => () =>
      buildSpawnWorkspaceConfig(true, context({ fromBranch: undefined, branches }));
    expect(fail({ defaultName: 'main', count: 0, loading: true })).toThrow('have not loaded yet');
    expect(fail({ defaultName: 'main', count: 2, loading: false })).toThrow(
      'default branch "main" was not found among its 2 branches'
    );
    expect(fail({ defaultName: null, count: 0, loading: false })).toThrow('no branches yet');
    expect(fail({ defaultName: null, count: 3, loading: false })).toThrow(
      'could not be worked out'
    );
  });
});
