import { Field, Switch } from '@emdash/ui/react/primitives';
import { BranchNameField } from './branch-name-field';
import type { WorkspacePanelProps } from './new-worktree-panel';
import { SetupStepPreview } from './setup-step-preview';

export function PrNewBranchPanel({ workspaceConfig }: WorkspacePanelProps) {
  const { branchSelection, branchNameState, setupSteps } = workspaceConfig;

  return (
    <div className="flex flex-col gap-4">
      <BranchNameField state={branchNameState} />
      <Field.Root orientation="horizontal" className="items-center gap-2">
        <Switch
          size="sm"
          checked={branchSelection.pushBranch}
          onCheckedChange={branchSelection.setPushBranch}
        />
        <Field.Label className="font-normal">Push branch to remote</Field.Label>
      </Field.Root>
      <SetupStepPreview steps={setupSteps} />
    </div>
  );
}
