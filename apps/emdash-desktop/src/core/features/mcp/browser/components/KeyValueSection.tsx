import { Button, Field, Input } from '@emdash/ui/react/primitives';
import { X } from 'lucide-react';
import React from 'react';
import {
  parseEnvAssignmentPaste,
  replaceEnvEntryWithPaste,
} from '@core/primitives/env-paste/browser/env-paste';

export interface KVEntry {
  id: number;
  key: string;
  value: string;
}

interface KeyValueSectionProps {
  label: string;
  entries: KVEntry[];
  onChange: (entries: KVEntry[]) => void;
  addLabel: string;
  makeId: () => number;
  credentialKeys: Map<string, boolean>;
  splitEnvPaste?: boolean;
}

export const KeyValueSection: React.FC<KeyValueSectionProps> = ({
  label,
  entries,
  onChange,
  addLabel,
  makeId,
  credentialKeys,
  splitEnvPaste = false,
}) => {
  const handlePaste = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!splitEnvPaste) return;

    const pasted = parseEnvAssignmentPaste(e.clipboardData.getData('text'));
    if (pasted.length === 0) return;

    e.preventDefault();
    const pastedEntries = pasted.map((entry, pastedIndex) => ({
      id: pastedIndex === 0 ? entries[index].id : makeId(),
      key: entry.key,
      value: entry.value,
    }));
    onChange(replaceEnvEntryWithPaste(entries, index, pastedEntries));
  };

  const missingRequired = entries
    .filter((entry) => credentialKeys.get(entry.key) === true && !entry.value)
    .map((entry) => entry.key);

  return (
    <Field.Root>
      <Field.Label>{label}</Field.Label>
      <div className="flex flex-col gap-2">
        {entries.map((entry, i) => {
          const isCredential = credentialKeys.has(entry.key);
          const isRequired = credentialKeys.get(entry.key) === true;
          return (
            <div key={entry.id} className="flex items-center gap-2">
              <Input
                value={entry.key}
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = { ...entry, key: e.target.value };
                  onChange(next);
                }}
                className="w-2/5 font-mono text-xs"
                placeholder="KEY"
                aria-label={`${label}: name ${i + 1}`}
                onPaste={(e) => handlePaste(i, e)}
              />
              <Input
                value={entry.value}
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = { ...entry, value: e.target.value };
                  onChange(next);
                }}
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder={isCredential ? (isRequired ? 'Required' : 'Optional') : 'value'}
                aria-label={`${label}: value of ${entry.key || `entry ${i + 1}`}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="shrink-0"
                aria-label={`Remove ${entry.key || 'this entry'}`}
                onClick={() => onChange(entries.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          );
        })}
        {missingRequired.length > 0 && (
          <p className="text-xs text-foreground-warning">
            {missingRequired.join(', ')} {missingRequired.length === 1 ? 'is' : 'are'} needed for
            this server to connect.
          </p>
        )}
        <div>
          <Button
            type="button"
            variant="text"
            size="sm"
            onClick={() => onChange([...entries, { id: makeId(), key: '', value: '' }])}
          >
            {addLabel}
          </Button>
        </div>
      </div>
    </Field.Root>
  );
};
