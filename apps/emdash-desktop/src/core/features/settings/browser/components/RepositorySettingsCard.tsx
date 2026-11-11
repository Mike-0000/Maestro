import { Input, Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { normalizeBranchPrefix } from '@core/primitives/tasks/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/** The branch rows of the Repository page (rows only; the page owns the card). */
const RepositorySettingsCard: React.FC = () => {
  const {
    value: project,
    update: updateProject,
    isLoading: projectLoading,
    isSaving: projectSaving,
    isFieldOverridden: isProjectFieldOverridden,
    resetField: resetProjectField,
  } = useAppSettingsKey('project');
  const branchPrefix = project?.branchPrefix ?? '';
  const appendRandomBranchSuffix = project?.appendRandomBranchSuffix ?? true;
  const pushOnCreate = project?.pushOnCreate ?? true;
  const projectBusy = projectLoading || projectSaving;

  return (
    <>
      <SettingRow
        title="Branch prefix"
        description="Added before every task branch name. Leave empty for none."
        htmlFor="settings-branch-prefix"
        control={
          <>
            <ResetToDefaultButton
              visible={isProjectFieldOverridden('branchPrefix')}
              defaultLabel="emdash"
              onReset={() => resetProjectField('branchPrefix')}
              disabled={projectBusy}
            />
            <Input
              id="settings-branch-prefix"
              key={branchPrefix}
              defaultValue={branchPrefix}
              onBlur={(e) => {
                const next = normalizeBranchPrefix(e.currentTarget.value);
                e.currentTarget.value = next;
                if (next !== branchPrefix) {
                  updateProject({ branchPrefix: next });
                }
              }}
              placeholder="No prefix"
              aria-label="Branch prefix"
              disabled={projectBusy}
              className="w-56 font-mono text-xs"
            />
          </>
        }
      />
      <SettingRow
        title="Random branch suffix"
        description="Add a random suffix to branch names."
        control={
          <>
            <ResetToDefaultButton
              visible={isProjectFieldOverridden('appendRandomBranchSuffix')}
              defaultLabel="on"
              onReset={() => resetProjectField('appendRandomBranchSuffix')}
              disabled={projectBusy}
            />
            <Switch
              checked={appendRandomBranchSuffix}
              onCheckedChange={(checked) => updateProject({ appendRandomBranchSuffix: checked })}
              disabled={projectBusy}
              aria-label="Append random branch suffix"
            />
          </>
        }
      />
      <SettingRow
        title="Auto-push on create"
        description="Push the new branch to the selected project remote and set upstream after creation."
        control={
          <>
            <ResetToDefaultButton
              visible={isProjectFieldOverridden('pushOnCreate')}
              defaultLabel="on"
              onReset={() => resetProjectField('pushOnCreate')}
              disabled={projectBusy}
            />
            <Switch
              checked={pushOnCreate}
              onCheckedChange={(checked) => updateProject({ pushOnCreate: checked })}
              disabled={projectBusy}
              aria-label="Enable automatic push on create"
            />
          </>
        }
      />
    </>
  );
};

export default RepositorySettingsCard;
