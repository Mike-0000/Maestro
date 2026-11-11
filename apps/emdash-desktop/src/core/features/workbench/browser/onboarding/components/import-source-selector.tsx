import { Checkbox } from '@emdash/ui/react/primitives';
import {
  type LegacyImportSource,
  type LegacyPortPreviewSource,
} from '@core/primitives/legacy-port/api/legacy-port';
import { cn } from '@core/primitives/styling/browser/cn';
import { formatCount, sourceLabel } from './import-format';

/** One earlier version as a checkbox row: its name, then what it holds in a muted line. */
function SourceRow({
  source,
  preview,
  selected,
  disabled,
  onToggle,
}: {
  source: LegacyImportSource;
  preview: LegacyPortPreviewSource;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-hover'
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={selected}
        disabled={disabled}
        onCheckedChange={() => onToggle()}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-foreground">{sourceLabel(source)}</span>
        <span className="text-xs text-foreground-muted tabular-nums">
          {formatCount(preview.projects, 'project')} · {formatCount(preview.tasks, 'task')}
        </span>
      </span>
    </label>
  );
}

export function ImportSourceSelector({
  sources,
  v0Preview,
  betaPreview,
  selectedSources,
  disabled = false,
  onToggle,
}: {
  sources: LegacyImportSource[];
  v0Preview: LegacyPortPreviewSource;
  betaPreview: LegacyPortPreviewSource;
  selectedSources: LegacyImportSource[];
  disabled?: boolean;
  onToggle: (source: LegacyImportSource) => void;
}) {
  if (sources.length === 0) return null;

  return (
    <div
      role="group"
      aria-label="Versions to import"
      className="surface-emphasis flex w-full shrink-0 flex-col gap-0.5 rounded-lg bg-surface p-1 ring-1 ring-border-subtle"
    >
      {sources.includes('v0') && (
        <SourceRow
          source="v0"
          preview={v0Preview}
          selected={selectedSources.includes('v0')}
          disabled={disabled}
          onToggle={() => onToggle('v0')}
        />
      )}
      {sources.includes('v1-beta') && (
        <SourceRow
          source="v1-beta"
          preview={betaPreview}
          selected={selectedSources.includes('v1-beta')}
          disabled={disabled}
          onToggle={() => onToggle('v1-beta')}
        />
      )}
    </div>
  );
}
