import { Button } from '@emdash/ui/react/primitives';
import type { ProjectConfigMigration } from '@core/primitives/project-settings/api';

export function ConfigMigrationNotice({
  migrations,
  disabled,
  onImport,
}: {
  migrations: ProjectConfigMigration[];
  disabled: boolean;
  onImport: () => void;
}) {
  if (migrations.length === 0) return null;

  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-foreground-muted">
      This project has config from another tool.
      <Button type="button" variant="text" size="xs" onClick={onImport} disabled={disabled}>
        Import into Maestro
      </Button>
    </p>
  );
}
