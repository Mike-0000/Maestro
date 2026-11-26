import { Switch } from '@emdash/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { isClientMode } from '@core/primitives/client-mode/browser/client-mode';
import { detectPlatformContext } from '@core/primitives/keybindings/api';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingRow } from './SettingRow';

/** The tray icon belongs to the host's window; a Maestro client has none, so the row is hidden. */
export function TrayIconSettingsRow() {
  return isClientMode() ? null : <LocalTrayIconSettingsRow />;
}

function LocalTrayIconSettingsRow() {
  const { value, update, isLoading, isSaving, isFieldOverridden, resetField } =
    useAppSettingsKey('interface');
  const location = detectPlatformContext().os === 'mac' ? 'menu bar' : 'system tray';
  const title = `Show Maestro in the ${location}`;
  const disabled = isLoading || isSaving;

  return (
    <SettingRow
      title={title}
      description={`Quick access to Maestro from the ${location}.`}
      control={
        <>
          <ResetToDefaultButton
            visible={isFieldOverridden('showTrayIcon')}
            defaultLabel="shown"
            onReset={() => resetField('showTrayIcon')}
            disabled={disabled}
          />
          <Switch
            aria-label={title}
            checked={value?.showTrayIcon ?? true}
            disabled={disabled}
            onCheckedChange={(checked) => update({ showTrayIcon: checked })}
          />
        </>
      }
    />
  );
}
