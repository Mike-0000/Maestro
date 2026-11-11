import { RadioGroup, SectionLabel } from '@emdash/ui/react/primitives';
import { useId } from 'react';
import {
  type LegacyImportSource,
  type LegacyProjectConflict,
} from '@core/primitives/legacy-port/api/legacy-port';
import { cn } from '@core/primitives/styling/browser/cn';
import { formatCount, sourceLabel } from './import-format';

/** One copy of a project: a radio, the version and its task count, the folder in a caption. */
function ConflictChoice({
  source,
  conflict,
  disabled,
}: {
  source: LegacyImportSource;
  conflict: LegacyProjectConflict;
  disabled: boolean;
}) {
  const details = source === 'v0' ? conflict.v0 : conflict.v1Beta;
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-hover'
      )}
    >
      <RadioGroup.Item id={id} value={source} disabled={disabled} className="mt-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">
          {sourceLabel(source)}
          <span className="text-foreground-muted"> · {formatCount(details.taskCount, 'task')}</span>
        </span>
        <span className="truncate text-tiny text-foreground-passive" title={details.path}>
          {details.path}
        </span>
      </span>
    </label>
  );
}

/** A project both versions hold: its name, then a choice of which copy to keep. */
function ConflictRow({
  conflict,
  selectedSource,
  disabled,
  onSelect,
}: {
  conflict: LegacyProjectConflict;
  selectedSource: LegacyImportSource;
  disabled: boolean;
  onSelect: (source: LegacyImportSource) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-1 py-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3 px-2">
        <span className="truncate text-sm font-medium text-foreground">{conflict.v1Beta.name}</span>
        <span className="shrink-0 text-tiny text-foreground-passive">
          {conflict.kind === 'ssh' ? 'SSH' : 'Local'}
        </span>
      </div>
      <RadioGroup.Root
        aria-label={`Copy of ${conflict.v1Beta.name} to keep`}
        value={selectedSource}
        onValueChange={(value) => onSelect(value as LegacyImportSource)}
        disabled={disabled}
      >
        <ConflictChoice source="v1-beta" conflict={conflict} disabled={disabled} />
        <ConflictChoice source="v0" conflict={conflict} disabled={disabled} />
      </RadioGroup.Root>
    </div>
  );
}

export function ProjectConflicts({
  conflicts,
  choices,
  disabled = false,
  onChoiceChange,
}: {
  conflicts: LegacyProjectConflict[];
  choices: Record<string, LegacyImportSource>;
  disabled?: boolean;
  onChoiceChange: (identityKey: string, source: LegacyImportSource) => void;
}) {
  if (conflicts.length === 0) return null;

  return (
    <section className="flex min-h-0 w-full flex-col gap-3">
      <div className="flex flex-col gap-1 px-1">
        <SectionLabel as="h2">In both versions</SectionLabel>
        <p className="text-xs text-foreground-muted">
          These projects exist in both versions. Choose which copy of each to keep.
        </p>
      </div>
      <div className="surface-emphasis flex max-h-72 min-h-0 flex-col divide-y divide-border-subtle overflow-y-auto rounded-lg bg-surface ring-1 ring-border-subtle">
        {conflicts.map((conflict) => (
          <ConflictRow
            key={conflict.identityKey}
            conflict={conflict}
            selectedSource={choices[conflict.identityKey] ?? 'v1-beta'}
            disabled={disabled}
            onSelect={(source) => onChoiceChange(conflict.identityKey, source)}
          />
        ))}
      </div>
    </section>
  );
}
