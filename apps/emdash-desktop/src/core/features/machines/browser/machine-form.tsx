import { FormFieldShell } from '@emdash/ui/react/form';
import { Input, Spinner, ToggleGroup, Tooltip } from '@emdash/ui/react/primitives';
import { MachineAuthenticationFields } from './machine-authentication-fields';
import { MachineConnectionDetails } from './machine-connection-details';
import { MachineFormFeedback } from './machine-form-actions';
import { MachineHostPicker } from './machine-host-picker';
import { MachineManualFields, MachineManualRouting } from './machine-manual-fields';
import type { MachineFormController } from './use-machine-form';
import { WindowsHostSetupHelp } from './windows-host-setup-help';

/**
 * The machine form: an optional name, where the connection settings come from (your SSH config
 * or typed by hand), the connection itself, then authentication. Fields sit 20px apart; errors
 * are one line of error text under what they are about.
 */
export function MachineFormFields({
  controller,
  formId,
}: {
  controller: MachineFormController;
  formId: string;
}) {
  const {
    form,
    mode,
    selectMode,
    name,
    config,
    details,
    authentication,
    actions,
    feedback,
    isSaving,
  } = controller;
  const showConnection = mode === 'manual' || !!details;
  const sourceLabelId = `${formId}-source-label`;
  return (
    <Tooltip.Provider delay={150}>
      <div className="flex flex-col gap-5">
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            actions.submit();
          }}
        >
          <fieldset disabled={isSaving} className="m-0 grid min-w-0 gap-5 border-0 p-0">
            <div className="grid gap-1.5">
              <form.AppField name="name">
                {(field) => (
                  <FormFieldShell label="Connection name" className="min-w-0">
                    {({ id, invalid }) => (
                      <Input
                        id={id}
                        name={field.name}
                        autoFocus
                        placeholder={name.fallback || 'Defaults to the host'}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={!!name.error || invalid || undefined}
                        aria-describedby={name.error ? formId + '-name-error' : undefined}
                      />
                    )}
                  </FormFieldShell>
                )}
              </form.AppField>
              {name.error && (
                <p
                  id={formId + '-name-error'}
                  role="alert"
                  className="text-xs text-foreground-error"
                >
                  {name.error}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span id={sourceLabelId} className="text-sm text-foreground">
                Connection settings
              </span>
              <ToggleGroup.Root
                aria-label="Connection source"
                className="shrink-0"
                value={[mode]}
                onValueChange={([value]) => {
                  if (value === 'manual' || value === 'config') selectMode(value);
                }}
              >
                <ToggleGroup.Item value="config" disabled={isSaving}>
                  SSH config
                </ToggleGroup.Item>
                <ToggleGroup.Item value="manual" disabled={isSaving}>
                  Manual
                </ToggleGroup.Item>
              </ToggleGroup.Root>
            </div>
            {mode === 'config' && !showConnection && (
              <div className="grid gap-2">
                <MachineHostPicker
                  id={formId + '-target'}
                  target={config.target}
                  onTargetChange={config.changeTarget}
                  hosts={config.hosts}
                  disabled={isSaving}
                />
                {config.suggestionsError && (
                  <p className="text-xs text-foreground-muted">{config.suggestionsError}</p>
                )}
                {config.resolution.status === 'resolving' && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-xs text-foreground-muted"
                  >
                    <Spinner size="sm" /> Resolving connection settings…
                  </p>
                )}
                {config.resolution.status === 'failed' && (
                  <p role="alert" className="text-xs text-foreground-error">
                    {config.resolution.error}
                  </p>
                )}
              </div>
            )}
            {mode === 'config' && details && (
              <MachineConnectionDetails host={details} target={config.target} />
            )}
            {mode === 'manual' && <MachineManualFields form={form} />}
            {showConnection && (
              <MachineAuthenticationFields
                key={mode}
                form={form}
                mode={mode}
                alias={mode === 'config' ? config.target : ''}
                {...authentication}
              />
            )}
            {mode === 'manual' && <MachineManualRouting form={form} />}
          </fieldset>
        </form>
        <MachineFormFeedback {...feedback} />
        <WindowsHostSetupHelp />
      </div>
    </Tooltip.Provider>
  );
}
