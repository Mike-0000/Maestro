import { Button, Combobox } from '@emdash/ui/react/primitives';
import { ChevronDown, GitBranch, TriangleAlert } from 'lucide-react';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import type { WorkspaceConfigState } from '@core/features/tasks/api/browser/create-task-modal/use-workspace-config';
import { cn } from '@core/primitives/styling/browser/cn';
import { BranchNameField } from './branch-name-field';
import { FIELD_TRIGGER_CLASS } from './field-trigger';

export type WorkspacePanelProps = {
  workspaceConfig: WorkspaceConfigState;
  projectId?: string;
  isUnborn?: boolean;
};

export function NewWorktreePanel({
  workspaceConfig,
  projectId,
  isUnborn = false,
}: WorkspacePanelProps) {
  const { branchSelection, branchNameState, branchConflict } = workspaceConfig;
  const { createBranchAndWorktree } = branchSelection;
  const branchLabel = createBranchAndWorktree ? 'From branch' : 'Branch';
  const branchValue = branchSelection.selectedBranch?.branch;

  function handleReuseExisting() {
    workspaceConfig.setPresetId('use-existing');
    if (branchConflict?.workspaceId) {
      workspaceConfig.setSelectedWorkspaceId(branchConflict.workspaceId);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {projectId && (
        <div className="flex flex-col gap-1.5">
          <span aria-hidden className="text-xs text-foreground-muted">
            {branchLabel}
          </span>
          <ProjectBranchSelector
            projectId={projectId}
            value={branchSelection.selectedBranch}
            onValueChange={branchSelection.setSelectedBranch}
            showRemoteSelectorFooter
            trigger={
              <Combobox.Trigger
                aria-label={branchValue ? `${branchLabel} ${branchValue}` : branchLabel}
                className={cn(FIELD_TRIGGER_CLASS, 'h-8')}
              >
                <GitBranch className="size-3.5 shrink-0 text-foreground-passive" />
                <span className="min-w-0 flex-1 truncate">
                  <Combobox.Value placeholder="Select a branch" />
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
              </Combobox.Trigger>
            }
          />
        </div>
      )}

      {/* A warning is a glyph and words, never a tinted panel; the way out is a text action. */}
      {!createBranchAndWorktree && branchConflict && (
        <div className="flex items-start gap-2 text-xs text-foreground-muted">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-foreground-warning" />
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <p className="text-pretty">
              <span className="font-medium text-foreground">{branchConflict.branchName}</span> is
              already checked out in{' '}
              {branchConflict.taskName ? (
                <span className="font-medium text-foreground">{branchConflict.taskName}</span>
              ) : (
                'an existing workspace'
              )}
              . A second worktree cannot use a branch that is already in use.
            </p>
            <Button variant="text" size="xs" onClick={handleReuseExisting}>
              Reuse existing workspace
            </Button>
          </div>
        </div>
      )}

      {createBranchAndWorktree && !isUnborn && (
        <BranchNameField
          state={branchNameState}
          pushBranch={branchSelection.pushBranch}
          onPushBranchChange={branchSelection.setPushBranch}
        />
      )}
    </div>
  );
}
