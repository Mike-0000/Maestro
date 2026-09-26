import { SettingsCard, SettingsSection } from '@emdash/ui/react/patterns';
import { SeparatedList, Switch } from '@emdash/ui/react/primitives';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { SettingRow } from './SettingRow';

/** Canvas app browsers and who may watch or drive them. */
export function CanvasBrowserSettingsCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('canvasBrowser');
  const disabled = isLoading || isSaving || !value;
  const off = disabled || value?.enabled === false;

  return (
    <SettingsSection title="Canvas app browser" bare>
      <SettingsCard>
        <SeparatedList>
          <SettingRow
            title="App browsers on the canvas"
            description="Show a task's running app in a browser tile next to its agents (Run app, Show app)."
            control={
              <Switch
                checked={value?.enabled ?? true}
                disabled={disabled}
                onCheckedChange={(next) => update({ enabled: next })}
              />
            }
          />
          <SettingRow
            title="Coding agents can use their task's app"
            description="Agents get Chorus browser tools for their own task's tile: screenshots and page structure any time, clicking and typing once the tile is set to Agents. New agent sessions pick this up."
            control={
              <Switch
                checked={value?.agentControl ?? true}
                disabled={off}
                onCheckedChange={(next) => update({ agentControl: next })}
              />
            }
          />
          <SettingRow
            title="Conductor can use apps"
            description="The conductor can look at and use apps in tiles set to Agents."
            control={
              <Switch
                checked={value?.conductorControl ?? true}
                disabled={off}
                onCheckedChange={(next) => update({ conductorControl: next })}
              />
            }
          />
        </SeparatedList>
      </SettingsCard>
    </SettingsSection>
  );
}
