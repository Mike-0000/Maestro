import { err, type Result } from '@emdash/shared';
import {
  Button,
  Dialog,
  Field,
  ModalLayout,
  RadioGroup,
  Select,
} from '@emdash/ui/react/primitives';
import { Check, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import type {
  MigrateProjectConfigRequest,
  ProjectConfigMigration,
  ProjectConfigMigrationDestination,
  ProjectConfigMigrationProvider,
} from '@core/primitives/project-settings/api';
import type {
  MigrateProjectConfigResult,
  ProjectSettingsError,
} from '../../../api/project-settings-page';
import { SHAREABLE_FIELD_DESCRIPTOR_BY_ID } from './shareable-project-settings-fields';

type ImportStatus = 'idle' | 'importing' | 'imported' | 'error';

export type ProjectConfigImportModalArgs = {
  migrations: ProjectConfigMigration[];
  migrateProjectConfig: (
    request: MigrateProjectConfigRequest
  ) => Promise<Result<MigrateProjectConfigResult, ProjectSettingsError>>;
};

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldLabel(field: ProjectConfigMigration['fields'][number]): string {
  return SHAREABLE_FIELD_DESCRIPTOR_BY_ID[field].modalLabel;
}

function filesLabel(files: string[]): string {
  return files.length === 1 ? files[0] : files.join(', ');
}

export function ProjectConfigImportModal({
  migrations,
  migrateProjectConfig,
}: ProjectConfigImportModalArgs) {
  const modal = useModalController('projectConfigImportModal');
  const [selectedProvider, setSelectedProvider] = useState<ProjectConfigMigrationProvider>(
    migrations[0]?.provider ?? 'conductor'
  );
  const [destination, setDestination] = useState<ProjectConfigMigrationDestination>('local');
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedMigration = useMemo(
    () => migrations.find((migration) => migration.provider === selectedProvider) ?? migrations[0],
    [migrations, selectedProvider]
  );
  const description =
    migrations.length === 1 && selectedMigration
      ? `Found configuration file from ${selectedMigration.label} that can be imported into Maestro.`
      : 'Found configuration files that can be imported into Maestro.';

  const disabled = !selectedMigration || status === 'importing' || status === 'imported';

  async function handleImport() {
    if (!selectedMigration) return;

    setStatus('importing');
    setErrorMessage(null);
    const result = await migrateProjectConfig({
      provider: selectedMigration.provider,
      destination,
    }).catch((error) =>
      err({
        type: 'write-config-failed' as const,
        message: unknownErrorMessage(error),
      })
    );

    if (result.success) {
      setStatus('imported');
      modal.complete(result.data);
      return;
    }

    setErrorMessage(
      result.error.type === 'write-config-failed'
        ? result.error.message
        : 'Failed to import project config.'
    );
    setStatus('error');
  }

  return (
    <ModalLayout
      title="Import project config"
      description={description}
      showCloseButton={false}
      actions={
        <>
          <Button variant="ghost" onClick={modal.dismiss} disabled={status === 'importing'}>
            {status === 'imported' ? 'Close' : 'Cancel'}
          </Button>
          <ConfirmButton variant="primary" onClick={() => void handleImport()} disabled={disabled}>
            <span className="inline-flex items-center justify-center gap-1.5">
              {status === 'importing' && (
                <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
              )}
              {status === 'imported' && <Check className="size-4" aria-hidden />}
              {status === 'importing'
                ? 'Importing…'
                : status === 'imported'
                  ? 'Imported'
                  : 'Import'}
            </span>
          </ConfirmButton>
        </>
      }
    >
      <Dialog.Body>
        <Field.Group className="gap-5">
          {migrations.length > 1 && (
            <Field.Root>
              <Field.Label>Config to import</Field.Label>
              <Select.Root
                value={selectedMigration?.provider ?? ''}
                onValueChange={(value) =>
                  setSelectedProvider(value as ProjectConfigMigrationProvider)
                }
              >
                <Select.Trigger appearance="input" className="w-full min-w-0">
                  <span className="min-w-0 truncate">
                    {selectedMigration?.label ?? 'Select config'}
                  </span>
                </Select.Trigger>
                <Select.Content align="start" alignItemWithTrigger={false} sideOffset={6}>
                  {migrations.map((migration) => (
                    <Select.Item key={migration.provider} value={migration.provider}>
                      {migration.label} ({filesLabel(migration.files)})
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field.Root>
          )}

          {selectedMigration ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-foreground">Settings it brings</p>
              <ul className="flex flex-col gap-1 text-sm text-foreground-muted">
                {selectedMigration.fields.map((field) => (
                  <li key={field} className="flex items-center gap-2">
                    <span aria-hidden className="size-1 rounded-full bg-foreground-passive" />
                    {fieldLabel(field)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-foreground">Save to</p>
            <RadioGroup.Root
              value={destination}
              onValueChange={(value) => setDestination(value as ProjectConfigMigrationDestination)}
              className="grid gap-1"
            >
              <label className="flex min-h-8 cursor-pointer items-center gap-3 text-sm">
                <RadioGroup.Item value="local" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground">Personal settings</span>
                  <span className="text-xs text-foreground-muted">
                    Stored only on this machine.
                  </span>
                </span>
              </label>
              <label className="flex min-h-8 cursor-pointer items-center gap-3 text-sm">
                <RadioGroup.Item value="shared" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-xs text-foreground">.emdash.json</span>
                  <span className="text-xs text-foreground-muted">
                    Commit it to share with your team.
                  </span>
                </span>
              </label>
            </RadioGroup.Root>
          </div>
          {status === 'error' ? (
            <p role="alert" className="text-xs text-foreground-error">
              {errorMessage}
            </p>
          ) : null}
        </Field.Group>
      </Dialog.Body>
    </ModalLayout>
  );
}

export const projectConfigImportModal = defineModal<MigrateProjectConfigResult>()({
  id: 'projectConfigImportModal',
  component: ProjectConfigImportModal,
  size: 'md',
});
