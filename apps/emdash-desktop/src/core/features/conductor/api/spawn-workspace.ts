import type { GitBranchRef } from '@core/primitives/git/api';
import type { WorkspaceConfig } from '@core/primitives/workspaces/api';

export type SpawnWorkspaceContext = {
  /** The project's own repository workspace (its checkout directory). */
  repositoryWorkspaceId: string | null | undefined;
  /** Names the new branch; only called when a worktree is requested. */
  branchName: () => string;
  fromBranch: GitBranchRef | undefined;
  pushBranch: boolean;
  /** What the branch lookup found, to say why there is no default branch. */
  branches?: {
    /** The configured default branch (such as "main"), when the project has one. */
    defaultName: string | null;
    count: number;
    loading: boolean;
  };
};

/** Why a project has no usable default branch, in words that name the real cause. */
function noDefaultBranchMessage(branches: SpawnWorkspaceContext['branches']): string {
  if (!branches) return 'The project has no default branch yet (commit something first).';
  if (branches.loading) {
    return "The project's branches have not loaded yet, so its default branch is unknown. Try again in a moment.";
  }
  if (branches.count === 0) {
    return 'The project has no branches yet (commit something first).';
  }
  if (branches.defaultName) {
    return `The project's default branch "${branches.defaultName}" was not found among its ${branches.count} branches.`;
  }
  return "The project's default branch could not be worked out from its branches.";
}

/**
 * The task workspace for a conductor-spawned agent. By default the agent edits the project
 * directory itself, like the create-task modal's "Use the repository directory" preset. With
 * `worktree`, it gets a fresh branch and worktree, like the "Create new worktree" preset.
 * Throws a speakable error when the project can't host the requested workspace.
 */
export function buildSpawnWorkspaceConfig(
  worktree: boolean | undefined,
  context: SpawnWorkspaceContext
): WorkspaceConfig {
  if (!worktree) {
    if (!context.repositoryWorkspaceId) {
      throw new Error('The project directory is not registered yet.');
    }
    return {
      version: '2',
      git: { kind: 'none' },
      workspace: { kind: 'repository-instance', workspaceId: context.repositoryWorkspaceId },
    };
  }
  if (!context.fromBranch) {
    throw new Error(noDefaultBranchMessage(context.branches));
  }
  return {
    version: '2',
    git: {
      kind: 'create-branch',
      branchName: context.branchName(),
      fromBranch: context.fromBranch,
      pushBranch: context.pushBranch,
    },
    workspace: { kind: 'new-worktree' },
  };
}
