import { compileWorktreePayload } from '@emdash/core/runtimes/workspace-registry/api';
import { FolderGit2, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import {
  resolveRendererEffectiveSettings,
  useEffectiveSettingsInputs,
  type EffectiveSettingsInputs,
} from '@core/features/projects/api/browser/effective-settings/use-effective-settings';
import {
  getProjectStore,
  projectData,
} from '@core/features/projects/api/browser/stores/project-selectors';
import { compileWorktreeGitPlan, type WorkspaceConfig } from '@core/primitives/workspaces/api';

/**
 * The resolved worktree destination shown before creation (spec:
 * github-git-settings §6): the same blessed resolver (`worktreeRoot` over the
 * settings page inputs) and the same derivation (`compileWorktreePayload`)
 * execution runs in `createTask`, so preview and the created worktree cannot
 * diverge. An invalid configured root surfaces the degrade warning here too.
 */
export const WorktreeDestinationPreview = observer(function WorktreeDestinationPreview({
  projectId,
  workspaceConfig,
}: {
  projectId: string;
  workspaceConfig: WorkspaceConfig;
}) {
  const inputs = useEffectiveSettingsInputs(projectId);
  const projectPath = projectData(getProjectStore(projectId))?.path;

  if (!inputs || projectPath === undefined) return null;
  return (
    <WorktreeDestinationPreviewView
      inputs={inputs}
      projectPath={projectPath}
      workspaceConfig={workspaceConfig}
    />
  );
});

/** The store-free rendering over resolver inputs; exported for browser tests. */
export function WorktreeDestinationPreviewView({
  inputs,
  projectPath,
  workspaceConfig,
}: {
  inputs: EffectiveSettingsInputs;
  projectPath: string;
  workspaceConfig: WorkspaceConfig;
}) {
  if (workspaceConfig.workspace.kind !== 'new-worktree') return null;
  const git = workspaceConfig.git;
  if (git.kind === 'none') return null;

  const effective = resolveRendererEffectiveSettings(inputs);

  let branchName: string;
  try {
    // The identical plan compilation createTask runs, over the identical
    // resolver-backed base and push remotes.
    branchName = compileWorktreeGitPlan(git, {
      baseRemote: effective.baseRemote.value,
      pushRemote: effective.pushRemote.value,
    }).branch;
  } catch {
    return null;
  }
  if (branchName.trim() === '') return null;

  const worktreeRoot = effective.worktreeRoot;
  let worktreePath: string;
  try {
    worktreePath = compileWorktreePayload({
      repoPath: projectPath,
      worktreeRoot: worktreeRoot.value,
      branchName,
    }).worktreePath;
  } catch (error) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-foreground-muted">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
        <span className="min-w-0">{error instanceof Error ? error.message : String(error)}</span>
      </p>
    );
  }

  // A caption line (design brief 2.4): where the worktree will live, the path in mono and
  // truncated from the end with the full path on hover. A broken configured root is a
  // warning glyph and words under it, never a tinted box.
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-foreground-passive">
      <span className="flex min-w-0 items-center gap-1.5">
        <FolderGit2 className="size-3.5 shrink-0" />
        <span className="shrink-0 text-foreground-muted">Worktree:</span>
        <code className="min-w-0 truncate font-mono" title={worktreePath}>
          {worktreePath}
        </code>
      </span>
      {worktreeRoot.provenance.kind === 'broken-setting' ? (
        <span className="flex items-start gap-1.5 text-foreground-muted">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
          <span className="min-w-0 text-pretty">
            The configured worktree root '{worktreeRoot.provenance.staleValue}' is not usable —
            falling back to <code className="font-mono">{worktreeRoot.value}</code>.
          </span>
        </span>
      ) : null}
    </div>
  );
}
