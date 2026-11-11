import { Button, Collapsible, Field, Input, Label, Switch } from '@emdash/ui/react/primitives';
import { useForm } from '@tanstack/react-form';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import type { ProviderCustomConfig } from '@core/primitives/app-settings/api';
import {
  EnvironmentVariableInputs,
  type EnvironmentVariableEntry,
} from '@core/primitives/environment-variables/browser/environment-variable-inputs';
import { log } from '@core/primitives/logging/browser/logger';
import { InfoMark } from './agent-sheet-section';

export interface InstalledAgentContentProps {
  storedConfig: ProviderCustomConfig | undefined;
  isOverridden: boolean;
  isLoading: boolean;
  update: (
    cfg: ProviderCustomConfig,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
  reset: (
    val?: undefined,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
  /** Offer "Run in WSL2": a local Windows host, and an agent that supports it. */
  showWsl?: boolean;
}

function makeDefaultValues(cfg: ProviderCustomConfig | undefined) {
  return {
    extraArgs: cfg?.extraArgs ?? '',
    wsl: cfg?.wsl === true,
    envEntries: cfg?.env
      ? (Object.entries(cfg.env).map(([key, value]) => ({
          key,
          value,
        })) as EnvironmentVariableEntry[])
      : ([] as EnvironmentVariableEntry[]),
  };
}

export const InstalledAgentContent = observer(function InstalledAgentContent({
  storedConfig,
  isOverridden,
  isLoading,
  update,
  reset,
  showWsl = false,
}: InstalledAgentContentProps) {
  const [open, setOpen] = useState(false);

  const form = useForm({ defaultValues: makeDefaultValues(storedConfig) });

  // Re-sync form when external config changes (e.g. after a reset from outside).
  useEffect(() => {
    if (isLoading) return;
    const next = makeDefaultValues(storedConfig);
    form.setFieldValue('extraArgs', next.extraArgs);
    form.setFieldValue('wsl', next.wsl);
    form.setFieldValue('envEntries', next.envEntries);
  }, [isLoading, storedConfig, isOverridden, form]);

  const commit = useCallback(
    (entries?: EnvironmentVariableEntry[]) => {
      const { extraArgs, wsl, envEntries: currentEntries } = form.state.values;
      const envEntries = entries ?? currentEntries;
      const envRecord: Record<string, string> = {};
      for (const { key, value } of envEntries) {
        const k = key.trim();
        if (k && /^[A-Za-z_]\w*$/.test(k)) {
          envRecord[k] = value;
        }
      }

      const isAtDefaults =
        extraArgs.trim() === '' && !wsl && envEntries.every((e) => !e.key.trim());

      if (isAtDefaults) {
        reset(undefined, {
          onError: (err) => log.error('Failed to reset agent config:', err),
        });
      } else {
        const config: ProviderCustomConfig = {
          ...(storedConfig ?? {}),
          extraArgs: extraArgs.trim() || undefined,
          env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
          wsl: wsl || undefined,
        };
        update(config, {
          onError: (err) => log.error('Failed to save agent config:', err),
        });
      }
    },
    [form, storedConfig, reset, update]
  );

  const handleResetToDefaults = useCallback(() => {
    form.setFieldValue('extraArgs', '');
    form.setFieldValue('wsl', false);
    form.setFieldValue('envEntries', []);
    reset(undefined, {
      onError: (err) => log.error('Failed to reset agent config:', err),
    });
  }, [form, reset]);

  return (
    <section className="flex flex-col">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="flex min-h-6 items-center gap-3">
          <Collapsible.Trigger variant="text" type="button" className="text-sm">
            Advanced settings
          </Collapsible.Trigger>
          {isOverridden && (
            <>
              <span className="text-xs text-foreground-passive">Customized</span>
              <Button
                type="button"
                variant="text"
                size="xs"
                className="ml-auto"
                onClick={handleResetToDefaults}
              >
                Reset to defaults
              </Button>
            </>
          )}
        </div>

        <Collapsible.Panel>
          <div className="flex flex-col gap-5 px-0.5 pt-4 pb-0.5">
            {/* Additional parameters */}
            <form.Field name="extraArgs">
              {(field) => (
                <Field.Root className="gap-1.5">
                  <span className="flex items-center gap-1.5">
                    <Label htmlFor="sheet-extraArgs">Additional parameters</Label>
                    <InfoMark>
                      Extra flags appended to the command (e.g. --enable-all-github-mcp-tools)
                    </InfoMark>
                  </span>
                  <Input
                    id="sheet-extraArgs"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={() => commit()}
                    placeholder="e.g. --enable-all-github-mcp-tools"
                    className="font-mono text-xs"
                  />
                </Field.Root>
              )}
            </form.Field>

            {/* Run in WSL2 */}
            {showWsl && (
              <form.Field name="wsl">
                {(field) => (
                  <Field.Root>
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5">
                        <Label htmlFor="sheet-wsl">Run in WSL2</Label>
                        <InfoMark>
                          Starts this agent&apos;s terminal sessions inside your default WSL2
                          distro. The agent must be installed and signed in there. Without such a
                          distro it runs on Windows as before. Chat sessions always run on Windows.
                        </InfoMark>
                      </span>
                      <Switch
                        id="sheet-wsl"
                        checked={field.state.value}
                        onCheckedChange={(checked) => {
                          field.handleChange(checked);
                          commit();
                        }}
                      />
                    </div>
                  </Field.Root>
                )}
              </form.Field>
            )}

            {/* Environment variables */}
            <form.Field name="envEntries">
              {(field) => (
                <Field.Root className="gap-1.5">
                  <span className="flex items-center gap-1.5">
                    <Label>Environment variables</Label>
                    <InfoMark>Environment variables set when running the agent</InfoMark>
                  </span>
                  <EnvironmentVariableInputs
                    entries={field.state.value}
                    onChange={field.handleChange}
                    onCommit={commit}
                  />
                </Field.Root>
              )}
            </form.Field>
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  );
});
