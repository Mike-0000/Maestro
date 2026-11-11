import { Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/** The left-sidebar rows of the Interface page (rows only; the page owns the card). */
const SidebarMetadataSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading,
    isSaving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');

  const busy = isLoading || isSaving;
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? true;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;

  return (
    <>
      <SettingRow
        title="Line changes"
        description="Added and removed line counts."
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarLineChanges')}
              defaultLabel="on"
              onReset={() => resetField('showLeftSidebarLineChanges')}
              disabled={busy}
            />
            <Switch
              checked={showLineChanges}
              onCheckedChange={(checked) => update({ showLeftSidebarLineChanges: checked })}
              disabled={busy}
              aria-label="Show left sidebar line changes"
            />
          </>
        }
      />
      <SettingRow
        title="Pull request status"
        description="The merge and check state of the task's pull request."
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarPrStatus')}
              defaultLabel="on"
              onReset={() => resetField('showLeftSidebarPrStatus')}
              disabled={busy}
            />
            <Switch
              checked={showPrStatus}
              onCheckedChange={(checked) => update({ showLeftSidebarPrStatus: checked })}
              disabled={busy}
              aria-label="Show left sidebar PR status"
            />
          </>
        }
      />
      <SettingRow
        title="Timestamps"
        description="How long ago the task last changed."
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarTimestamps')}
              defaultLabel="on"
              onReset={() => resetField('showLeftSidebarTimestamps')}
              disabled={busy}
            />
            <Switch
              checked={showTimestamps}
              onCheckedChange={(checked) => update({ showLeftSidebarTimestamps: checked })}
              disabled={busy}
              aria-label="Show left sidebar timestamps"
            />
          </>
        }
      />
    </>
  );
};

export default SidebarMetadataSettingsCard;
