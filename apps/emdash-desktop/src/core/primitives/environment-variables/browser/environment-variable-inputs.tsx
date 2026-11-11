import { Button, Input } from '@emdash/ui/react/primitives';
import { Plus, Trash2 } from 'lucide-react';
import {
  parseEnvAssignmentPaste,
  replaceEnvEntryWithPaste,
} from '@core/primitives/env-paste/browser/env-paste';

export type EnvironmentVariableEntry = { key: string; value: string };

/**
 * Name / value pairs for environment variables: two mono inputs per row, a quiet remove action,
 * and "Add variable" as a ghost action under the list. Pasting `KEY=value` lines splits them into
 * rows.
 */
export function EnvironmentVariableInputs({
  entries,
  onChange,
  onCommit,
}: {
  entries: EnvironmentVariableEntry[];
  onChange: (entries: EnvironmentVariableEntry[]) => void;
  onCommit?: (entries: EnvironmentVariableEntry[]) => void;
}) {
  const updateEntry = (index: number, patch: Partial<EnvironmentVariableEntry>) => {
    onChange(
      entries.map((entry, candidate) => (candidate === index ? { ...entry, ...patch } : entry))
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, index) => {
        const validName =
          entry.key.trim() === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key.trim());
        return (
          <div key={index} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                value={entry.key}
                placeholder="KEY"
                aria-label={`Environment variable ${index + 1} name`}
                aria-invalid={!validName}
                className="min-w-0 flex-1 font-mono text-xs"
                onChange={(event) => updateEntry(index, { key: event.target.value })}
                onBlur={() => onCommit?.(entries)}
                onPaste={(event) => {
                  const pasted = parseEnvAssignmentPaste(event.clipboardData.getData('text'));
                  if (pasted.length === 0) return;
                  event.preventDefault();
                  onChange(replaceEnvEntryWithPaste(entries, index, pasted));
                }}
              />
              <Input
                value={entry.value}
                placeholder="value"
                aria-label={`Environment variable ${index + 1} value`}
                className="min-w-0 flex-[1.5] font-mono text-xs"
                onChange={(event) => updateEntry(index, { value: event.target.value })}
                onBlur={() => onCommit?.(entries)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="shrink-0"
                aria-label={`Remove environment variable ${index + 1}`}
                onClick={() => {
                  const next = entries.filter((_, candidate) => candidate !== index);
                  onChange(next);
                  onCommit?.(next);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {!validName ? (
              <p className="text-xs text-foreground-error">
                Use letters, digits and underscores, not starting with a digit.
              </p>
            ) : null}
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2.5 self-start"
        onClick={() => onChange([...entries, { key: '', value: '' }])}
      >
        <Plus className="size-3.5" />
        Add variable
      </Button>
    </div>
  );
}
