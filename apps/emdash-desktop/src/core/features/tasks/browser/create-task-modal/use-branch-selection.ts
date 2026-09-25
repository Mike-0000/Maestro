import type { GitBranchRef } from '@emdash/core/runtimes/git/api';
import { useCallback, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

export type BranchSelectionState = ReturnType<typeof useBranchSelection>;

export type BranchSelectionInitial = {
  createBranchAndWorktree?: boolean;
  pushBranch?: boolean;
  branchOverride?: GitBranchRef;
};

export function useBranchSelection(
  selectedProjectId: string | undefined,
  defaultBranch: GitBranchRef | undefined,
  currentBranchName: string | null,
  isUnborn: boolean,
  initial?: BranchSelectionInitial,
  createBranchAndWorktreeByDefault = true,
  branchFromCurrentBranch = false
) {
  const { value: project } = useAppSettingsKey('project');
  const pushOnCreateByDefault = project?.pushOnCreate ?? true;

  const [createBranchAndWorktreeOverride, setCreateBranchAndWorktreeOverride] = useState<
    boolean | undefined
  >(initial?.createBranchAndWorktree);
  const [pushBranchOverride, setPushBranchOverride] = useState<boolean | undefined>(
    initial?.pushBranch
  );
  const pushBranch = pushBranchOverride ?? pushOnCreateByDefault;
  const createBranchAndWorktreePreference =
    createBranchAndWorktreeOverride ?? createBranchAndWorktreeByDefault;
  const createBranchAndWorktree = isUnborn ? false : createBranchAndWorktreePreference;

  // Store the user's branch override alongside the project it belongs to.
  // When the project changes the override is for a different project and is
  // ignored, so defaultBranch takes effect automatically — no effect needed.
  const [branchOverride, setBranchOverride] = useState<
    { projectId: string; branch: GitBranchRef } | undefined
  >(
    initial?.branchOverride && selectedProjectId
      ? { projectId: selectedProjectId, branch: initial.branchOverride }
      : undefined
  );

  const fallbackBranch = createBranchAndWorktree
    ? newBranchSource(defaultBranch, currentBranchName, branchFromCurrentBranch)
    : currentBranchName &&
        !(initial?.createBranchAndWorktree === false && initial.branchOverride === undefined)
      ? ({ type: 'local', branch: currentBranchName } satisfies GitBranchRef)
      : defaultBranch;

  const selectedBranch: GitBranchRef | undefined =
    branchOverride !== undefined && branchOverride.projectId === selectedProjectId
      ? branchOverride.branch
      : fallbackBranch;

  const setSelectedBranch = useCallback(
    (branch: GitBranchRef | undefined) => {
      if (!selectedProjectId || !branch) {
        setBranchOverride(undefined);
        return;
      }
      setBranchOverride({ projectId: selectedProjectId, branch });
    },
    [selectedProjectId]
  );
  const setPushBranch = useCallback((value: boolean) => {
    setPushBranchOverride(value);
  }, []);
  const setCreateBranchAndWorktree = useCallback(
    (value: boolean) => {
      if (isUnborn) return;
      setCreateBranchAndWorktreeOverride(value);
    },
    [isUnborn]
  );

  return {
    selectedBranch,
    setSelectedBranch,
    createBranchAndWorktree,
    setCreateBranchAndWorktree,
    pushBranch,
    setPushBranch,
  };
}

/**
 * Source for a new task branch when the user has not picked one. With
 * `branchFromCurrentBranch`, fork from the branch checked out in the project
 * root so the agent starts from the code the user is working on; the default
 * branch ref is kept when the checkout is on it (it may be the fresher remote
 * ref) or when the checkout branch is unknown (detached HEAD, still loading).
 */
function newBranchSource(
  defaultBranch: GitBranchRef | undefined,
  currentBranchName: string | null,
  branchFromCurrentBranch: boolean
): GitBranchRef | undefined {
  if (!branchFromCurrentBranch || !currentBranchName) return defaultBranch;
  if (currentBranchName === defaultBranch?.branch) return defaultBranch;
  return { type: 'local', branch: currentBranchName };
}
