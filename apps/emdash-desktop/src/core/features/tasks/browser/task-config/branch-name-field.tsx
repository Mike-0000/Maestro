import { Input, Label, Switch } from '@emdash/ui/react/primitives';
import { useId } from 'react';
import type { BranchNameState } from '@core/features/tasks/browser/create-task-modal/use-branch-name';
import { useTaskConfig } from '@core/features/tasks/contributions/browser/task-config/task-config-context';

interface BranchNameFieldProps {
  state: Pick<BranchNameState, 'branchName' | 'setBranchName' | 'branchAlreadyExists'>;
  pushBranch?: boolean;
  onPushBranchChange?: (value: boolean) => void;
}

/** A plain labelled field (design brief 2.8): label, the input, helper text, then the switch. */
export function BranchNameField({ state, pushBranch, onPushBranchChange }: BranchNameFieldProps) {
  const { autoBranchName } = useTaskConfig();
  const { branchName, setBranchName, branchAlreadyExists } = state;
  const showPush = pushBranch !== undefined && onPushBranchChange !== undefined;
  const inputId = useId();
  const pushId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={autoBranchName ? undefined : inputId}
        className="text-xs text-foreground-muted"
      >
        Branch name
      </label>
      {autoBranchName ? (
        <p className="text-sm text-foreground-passive">Generated when the conductor starts</p>
      ) : (
        <>
          <Input
            id={inputId}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="branch-name"
            className="font-mono"
          />
          {branchAlreadyExists && (
            <p className="text-xs text-pretty text-foreground-muted">
              This branch already exists, so the conductor checks it out instead of creating it.
            </p>
          )}
        </>
      )}
      {showPush && (
        <div className="mt-1.5 flex items-center gap-2">
          <Switch id={pushId} size="sm" checked={pushBranch} onCheckedChange={onPushBranchChange} />
          <Label htmlFor={pushId} className="font-normal">
            Push branch to remote
          </Label>
        </div>
      )}
    </div>
  );
}
