import { Collapsible, Combobox, Field, Switch } from '@emdash/ui/react/primitives';
import { ChevronDown, GitBranch } from 'lucide-react';
import { BranchDisplay } from '@core/features/source-control/contributions/browser/branch-display';
import { ProjectBranchSelector } from '@core/features/source-control/contributions/browser/project-branch-selector';
import type { BranchNameState } from '@core/features/tasks/browser/create-task-modal/use-branch-name';
import type { BranchSelectionState } from '@core/features/tasks/browser/create-task-modal/use-branch-selection';
import { cn } from '@core/primitives/styling/browser/cn';
import { BranchNameField } from './branch-name-field';
import { FIELD_TRIGGER_CLASS } from './field-trigger';

interface BranchPickerFieldProps {
  state: BranchSelectionState;
  branchNameState?: BranchNameState;
  projectId?: string;
  currentBranch?: string | null;
  label?: string;
  className?: string;
  isUnborn?: boolean;
}

/**
 * The source branch as a labelled field, then a quiet disclosure for creating and pushing a
 * feature branch. No outer box or rules (design brief 2.2): space groups the parts.
 */
export function BranchPickerField({
  state,
  branchNameState,
  projectId,
  currentBranch,
  label = 'From Branch',
  className,
  isUnborn = false,
}: BranchPickerFieldProps) {
  const { createBranchAndWorktree, setCreateBranchAndWorktree, pushBranch, setPushBranch } = state;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {!createBranchAndWorktree && currentBranch ? (
        <BranchDisplay label={label} branchName={currentBranch} />
      ) : projectId ? (
        <div className="flex flex-col gap-1.5">
          <span aria-hidden className="text-xs text-foreground-muted">
            {label}
          </span>
          <ProjectBranchSelector
            projectId={projectId}
            value={state.selectedBranch}
            onValueChange={state.setSelectedBranch}
            showRemoteSelectorFooter
            trigger={
              <Combobox.Trigger aria-label={label} className={cn(FIELD_TRIGGER_CLASS, 'h-8')}>
                <GitBranch className="size-3.5 shrink-0 text-foreground-passive" />
                <span className="min-w-0 flex-1 truncate">
                  <Combobox.Value placeholder="Select a branch" />
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-foreground-passive" />
              </Combobox.Trigger>
            }
          />
        </div>
      ) : null}
      {!isUnborn && (
        <Collapsible.Root className="flex flex-col">
          <Collapsible.Trigger variant="text">Create and push a feature branch</Collapsible.Trigger>
          <Collapsible.Panel>
            <div className="flex flex-col gap-3 pt-3">
              <Field.Root orientation="horizontal" className="items-center gap-2">
                <Switch
                  size="sm"
                  checked={createBranchAndWorktree}
                  onCheckedChange={setCreateBranchAndWorktree}
                />
                <Field.Label className="font-normal">Create a branch and worktree</Field.Label>
              </Field.Root>
              {createBranchAndWorktree && (
                <>
                  {branchNameState && <BranchNameField state={branchNameState} />}
                  <Field.Root orientation="horizontal" className="items-center gap-2">
                    <Switch size="sm" checked={pushBranch} onCheckedChange={setPushBranch} />
                    <Field.Label className="font-normal">Push branch to remote</Field.Label>
                  </Field.Root>
                </>
              )}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {isUnborn && (
        <p className="text-xs text-foreground-muted">
          Create an initial commit to enable branch-based tasks.
        </p>
      )}
    </div>
  );
}
