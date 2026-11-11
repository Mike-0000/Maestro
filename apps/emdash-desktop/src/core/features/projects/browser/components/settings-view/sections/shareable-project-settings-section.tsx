import { SettingsSection } from '@emdash/ui/react/patterns';
import { Button, Field, Input, Switch, Textarea } from '@emdash/ui/react/primitives';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { EnvironmentVariableInputs } from '@core/primitives/environment-variables/browser/environment-variable-inputs';
import type {
  ProjectConfigMigration,
  ShareableProjectSettingsWriteField,
} from '@core/primitives/project-settings/api';
import type {
  ProjectFileHandlingDomainSnapshot,
  ProjectLifecycleDomainSnapshot,
} from '../../../../api/project-settings-page';
import { ConfigMigrationNotice } from '../config-migration-notice';
import {
  effectiveAutoRunToggleValue,
  type EnvironmentFormState,
  type FileHandlingFormState,
  type FormUpdate,
  type LifecycleFormState,
} from '../project-settings-form-model';
import {
  SHAREABLE_FIELD_DESCRIPTORS,
  type ShareableFieldDescriptor,
} from '../shareable-project-settings-fields';
import { ShareableSettingTitle } from '../shareable-setting-title';

type ShareableSettingsSectionProps = {
  lifecycleForm: LifecycleFormState;
  fileHandlingForm: FileHandlingFormState;
  environmentForm: EnvironmentFormState;
  updateLifecycle: FormUpdate<LifecycleFormState>;
  updateFileHandling: FormUpdate<FileHandlingFormState>;
  updateEnvironment: FormUpdate<EnvironmentFormState>;
  getOverrideSources: (
    field: ShareableProjectSettingsWriteField
  ) => { label: string; path: string; value: string }[];
  configMigrations: ProjectConfigMigration[];
  importDisabled: boolean;
  openImportConfigModal: () => void;
  lifecycle: ProjectLifecycleDomainSnapshot;
  fileHandling: ProjectFileHandlingDomainSnapshot;
  hostActionReason: string | null;
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ShareableField({
  descriptor,
  value,
  isPersonal,
  onChange,
  getOverrideSources,
  beforeInput,
}: {
  descriptor: ShareableFieldDescriptor;
  value: string;
  isPersonal: boolean;
  onChange: (value: string) => void;
  getOverrideSources: ShareableSettingsSectionProps['getOverrideSources'];
  beforeInput?: React.ReactNode;
}) {
  return (
    <Field.Root>
      <ShareableSettingTitle
        leafLabel={descriptor.leafLabel}
        overrideSources={getOverrideSources(descriptor.id)}
        isPersonal={isPersonal}
        onRestore={() => onChange('')}
      >
        {descriptor.group ? titleCase(descriptor.leafLabel) : descriptor.modalLabel}
      </ShareableSettingTitle>
      {descriptor.description ? (
        <Field.Description className="text-foreground-muted">
          {descriptor.description}
        </Field.Description>
      ) : null}
      {beforeInput}
      {descriptor.multiline ? (
        <Textarea
          rows={descriptor.id === 'preservePatterns' ? 5 : 3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={descriptor.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={descriptor.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field.Root>
  );
}

function AutoRunToggle({
  label,
  value,
  resolved,
  onCheckedChange,
  onReset,
}: {
  label: string;
  value: boolean | undefined;
  resolved: {
    value: boolean;
    from: ProjectLifecycleDomainSnapshot['resolved']['autoRunSetup']['from'];
  };
  onCheckedChange: (checked: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-foreground-muted">{label}</span>
      <div className="flex items-center gap-3">
        {value !== undefined ? (
          <Button type="button" variant="text" size="xs" onClick={onReset}>
            Reset
          </Button>
        ) : null}
        <Switch
          aria-label={label}
          checked={effectiveAutoRunToggleValue(value, resolved.value)}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  );
}

function ProjectEnvironmentVariables({
  form,
  update,
}: {
  form: EnvironmentFormState;
  update: FormUpdate<EnvironmentFormState>;
}) {
  return (
    // The section above carries the title and the explanation.
    <Field.Root>
      <Field.Label className="sr-only">Environment variables</Field.Label>
      <EnvironmentVariableInputs
        entries={form.variables}
        onChange={(variables) => update('variables', variables)}
      />
    </Field.Root>
  );
}

export function ShareableSettingsSection({
  lifecycleForm,
  fileHandlingForm,
  environmentForm,
  updateLifecycle,
  updateFileHandling,
  updateEnvironment,
  getOverrideSources,
  configMigrations,
  importDisabled,
  openImportConfigModal,
  lifecycle,
  fileHandling,
  hostActionReason,
}: ShareableSettingsSectionProps) {
  const topLevelFields = SHAREABLE_FIELD_DESCRIPTORS.filter((descriptor) => !descriptor.group);
  const lifecycleFields = SHAREABLE_FIELD_DESCRIPTORS.filter(
    (descriptor) => descriptor.group === 'lifecycle'
  );
  const valueFor = (descriptor: ShareableFieldDescriptor): string =>
    descriptor.id === 'preservePatterns'
      ? fileHandlingForm.preservePatterns
      : (lifecycleForm[descriptor.formKey as keyof LifecycleFormState] as string);
  const updateField = (descriptor: ShareableFieldDescriptor, value: string): void => {
    if (descriptor.id === 'preservePatterns') {
      updateFileHandling('preservePatterns', value);
      return;
    }
    updateLifecycle(descriptor.formKey as keyof LifecycleFormState, value);
  };
  const hasPersonalValue = (descriptor: ShareableFieldDescriptor): boolean => {
    if (valueFor(descriptor).trim()) return true;
    if (descriptor.id === 'preservePatterns') {
      return fileHandling.personal.preservePatterns !== undefined;
    }
    const script = descriptor.id.slice('scripts.'.length) as
      | 'prepare'
      | 'setup'
      | 'run'
      | 'teardown';
    return lifecycle.personal.scripts?.[script] !== undefined;
  };

  return (
    <fieldset disabled={hostActionReason !== null} className="contents">
      {hostActionReason ? (
        <p role="status" className="px-4 text-xs text-foreground-muted">
          Repository-backed settings are {hostActionReason.toLocaleLowerCase()}
        </p>
      ) : null}

      <SettingsSection
        title="Environment variables"
        description="Added to new terminals, lifecycle scripts and agent processes in this Project. Values stay on this Machine, are not written to .emdash.json, and are passed literally: use absolute paths for config directories."
      >
        <ProjectEnvironmentVariables form={environmentForm} update={updateEnvironment} />
      </SettingsSection>

      <SettingsSection
        title="Files"
        description="Shared through .emdash.json when you share settings with your team."
      >
        {topLevelFields.map((descriptor) => (
          <ShareableField
            key={descriptor.id}
            descriptor={descriptor}
            value={valueFor(descriptor)}
            isPersonal={hasPersonalValue(descriptor)}
            onChange={(value) => updateField(descriptor, value)}
            getOverrideSources={getOverrideSources}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Lifecycle scripts"
        description={
          <>
            Shell commands run at each stage of the worktree lifecycle. Prepare blocks task startup;
            Setup and Run start after the workspace is ready. When both are set to auto-run, Run
            waits for Setup to complete. See the{' '}
            <Button
              type="button"
              variant="text"
              size="xs"
              onClick={() => openExternal('https://www.emdash.sh/docs/project-config')}
            >
              project config reference ↗
            </Button>
          </>
        }
      >
        {lifecycleFields.map((descriptor) => (
          <ShareableField
            key={descriptor.id}
            descriptor={descriptor}
            value={valueFor(descriptor)}
            isPersonal={hasPersonalValue(descriptor)}
            onChange={(value) => updateField(descriptor, value)}
            getOverrideSources={getOverrideSources}
            beforeInput={
              descriptor.id === 'scripts.setup' ? (
                <AutoRunToggle
                  label="Auto-run on task creation"
                  value={lifecycleForm.autoRunSetupScriptOnTaskCreation}
                  resolved={lifecycle.resolved.autoRunSetup}
                  onCheckedChange={(checked) =>
                    updateLifecycle('autoRunSetupScriptOnTaskCreation', checked)
                  }
                  onReset={() => updateLifecycle('autoRunSetupScriptOnTaskCreation', undefined)}
                />
              ) : descriptor.id === 'scripts.run' ? (
                <AutoRunToggle
                  label="Auto-run on task creation"
                  value={lifecycleForm.autoRunRunScriptOnTaskCreation}
                  resolved={lifecycle.resolved.autoRunRun}
                  onCheckedChange={(checked) =>
                    updateLifecycle('autoRunRunScriptOnTaskCreation', checked)
                  }
                  onReset={() => updateLifecycle('autoRunRunScriptOnTaskCreation', undefined)}
                />
              ) : undefined
            }
          />
        ))}

        <ConfigMigrationNotice
          migrations={configMigrations}
          disabled={importDisabled}
          onImport={openImportConfigModal}
        />
      </SettingsSection>
    </fieldset>
  );
}
