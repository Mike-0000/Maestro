import { Label, Select } from '@emdash/ui/react/primitives';
import { useId } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';

/** One effort level the agent offers; the list is ordered lowest first. */
export type EffortOption = { id: string; label: string };

/** Select value for "no effort chosen": the agent runs at its own default. */
const AGENT_DEFAULT = '__agent-default__';

interface EffortSelectProps {
  options: readonly EffortOption[];
  /** The chosen effort id, or null for the agent's default. */
  value: string | null;
  onChange: (effort: string | null) => void;
  disabled?: boolean;
}

/**
 * The reasoning effort of the agent a form starts: a quiet label and select that sit in the
 * conversation's options row, beside the agent and under the model. "Default" leaves the choice
 * to the agent, and reads a step quieter than a chosen level.
 */
export function EffortSelect({ options, value, onChange, disabled = false }: EffortSelectProps) {
  const selectId = useId();
  const labelId = useId();
  const selected = options.find((option) => option.id === value) ?? null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* Same label classes as the row's other controls (Claude account, Use chat UI). */}
      <Label id={labelId} htmlFor={selectId} className="shrink-0 font-normal text-foreground-muted">
        Effort
      </Label>
      <Select.Root
        value={selected?.id ?? AGENT_DEFAULT}
        onValueChange={(next) => {
          if (next === null) return;
          onChange(next === AGENT_DEFAULT ? null : next);
        }}
        disabled={disabled}
      >
        {/* Named by its own label: inside a Field the trigger would otherwise take the
            field's label, which belongs to another control of the row. */}
        <Select.Trigger id={selectId} size="sm" aria-labelledby={labelId} className="px-2">
          <Select.Value className={cn('whitespace-nowrap', selected && 'text-foreground')}>
            {selected?.label ?? 'Default'}
          </Select.Value>
        </Select.Trigger>
        <Select.Content align="start">
          <Select.Item value={AGENT_DEFAULT}>Default</Select.Item>
          <Select.Separator />
          {options.map((option) => (
            <Select.Item key={option.id} value={option.id}>
              {option.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
}
