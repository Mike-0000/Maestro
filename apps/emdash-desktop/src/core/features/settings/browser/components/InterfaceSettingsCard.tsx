import { Switch } from '@emdash/ui/react/primitives';
import React from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/** The context bar row of the Interface page's Window section (a row, not a card). */
const InterfaceSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');

  const hideContextBar = interfaceSettings?.hideContextBar ?? false;

  return (
    <SettingRow
      title="Hide the context bar"
      description="Remove the on-screen context trigger. Its keyboard shortcut still works."
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('hideContextBar')}
            defaultLabel="shown"
            onReset={() => resetField('hideContextBar')}
            disabled={loading || saving}
          />
          <Switch
            checked={hideContextBar}
            disabled={loading || saving}
            aria-label="Hide the context bar"
            onCheckedChange={(checked) => update({ hideContextBar: checked })}
          />
        </>
      }
    />
  );
};

export default InterfaceSettingsCard;
