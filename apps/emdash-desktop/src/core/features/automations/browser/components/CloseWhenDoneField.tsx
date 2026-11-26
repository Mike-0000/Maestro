import { Field, Label, Switch } from '@emdash/ui/react/primitives';
import { useId, useRef, useState } from 'react';
import {
  DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES,
  type CloseWhenDoneConfig,
} from '@core/primitives/automations/api';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  formatCloseTimeout,
  normalizeCloseTimeoutMinutes,
  splitCloseTimeout,
} from '../automation-run-options';

const MAX_HOURS = 999;
const MAX_TIMEOUT_MINUTES = MAX_HOURS * 60 + 59;

/** What the two blanks show while no timeout is set: the runtime default, as placeholders. */
const DEFAULT_PARTS = splitCloseTimeout(DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES);

function sanitizeDraft(raw: string, maxDigits: number, max: number): string {
  const digits = raw.replace(/\D/g, '').slice(0, maxDigits);
  if (!digits) return '';
  return String(Math.min(max, parseInt(digits, 10)));
}

/**
 * One blank of the time limit (hours or minutes) with its unit. Type a number, or nudge the
 * whole limit with ArrowUp / ArrowDown; the value is committed on blur or Enter.
 */
function TimeoutSegment({
  value,
  placeholder,
  unit,
  ariaLabel,
  maxDigits,
  max,
  disabled,
  onCommit,
  onNudge,
}: {
  /** The committed number, or null while no timeout is set (the placeholder shows). */
  value: number | null;
  placeholder: number;
  unit: string;
  ariaLabel: string;
  maxDigits: number;
  max: number;
  disabled: boolean;
  onCommit: (next: number | null) => void;
  onNudge: (direction: 1 | -1) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = draft ?? (value === null ? '' : String(value));

  function commit() {
    if (draft === null) return;
    setDraft(null);
    onCommit(draft === '' ? null : parseInt(draft, 10));
  }

  return (
    <span className="inline-flex items-baseline gap-1">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        disabled={disabled}
        value={shown}
        placeholder={String(placeholder)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(sanitizeDraft(event.target.value, maxDigits, max))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setDraft(null);
            onNudge(event.key === 'ArrowUp' ? 1 : -1);
          } else if (event.key === 'Enter') {
            commit();
            // A modified Enter is the form's confirm shortcut: commit, then let it through.
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            inputRef.current?.blur();
          }
        }}
        onBlur={commit}
        // As wide as what it shows, so the unit sits right beside the number.
        style={{ width: `${Math.max(1, (shown || String(placeholder)).length) + 0.5}ch` }}
        className="rounded-xs bg-transparent text-center leading-none tabular-nums outline-none placeholder:text-foreground-passive focus:bg-surface-selected"
      />
      <span className="text-foreground-passive">{unit}</span>
    </span>
  );
}

/**
 * The time limit as hours and minutes in one field shell (the look of the schedule's time
 * picker). Empty means the runtime default, which the placeholders spell out.
 */
function CloseTimeoutInput({
  minutes,
  disabled,
  onChange,
}: {
  minutes: number | null;
  disabled: boolean;
  onChange: (minutes: number | null) => void;
}) {
  const parts = minutes === null ? null : splitCloseTimeout(minutes);

  function commit(total: number) {
    const next = normalizeCloseTimeoutMinutes(Math.min(MAX_TIMEOUT_MINUTES, total));
    if (next !== minutes) onChange(next);
  }

  // The arrows step the whole limit, starting from the default while none is set.
  function nudge(stepMinutes: number) {
    const base = minutes ?? DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES;
    commit(Math.max(1, base + stepMinutes));
  }

  return (
    <div
      role="group"
      aria-label={`Time limit, ${formatCloseTimeout(minutes ?? DEFAULT_CLOSE_WHEN_DONE_TIMEOUT_MINUTES)}${minutes === null ? ' by default' : ''}`}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-(--em-surface-input) px-2 text-sm leading-none text-foreground tabular-nums transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring hover:border-border-1 emlight:border-border-1',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      <TimeoutSegment
        value={parts ? parts.hours : null}
        placeholder={DEFAULT_PARTS.hours}
        unit="h"
        ariaLabel="Hours"
        maxDigits={3}
        max={MAX_HOURS}
        disabled={disabled}
        onCommit={(hours) => commit((hours ?? 0) * 60 + (parts?.minutes ?? 0))}
        onNudge={(direction) => nudge(direction * 60)}
      />
      <TimeoutSegment
        value={parts ? parts.minutes : null}
        placeholder={DEFAULT_PARTS.minutes}
        unit="min"
        ariaLabel="Minutes"
        maxDigits={2}
        max={59}
        disabled={disabled}
        onCommit={(mins) => commit((parts?.hours ?? 0) * 60 + (mins ?? 0))}
        onNudge={(direction) => nudge(direction * 5)}
      />
    </div>
  );
}

interface CloseWhenDoneFieldProps {
  /** Whether close-when-done is saved on the automation. */
  checked: boolean;
  /** The saved time limit, or null for the runtime default. */
  timeoutMinutes: CloseWhenDoneConfig['timeoutMinutes'] | null;
  /** On-demand automations ignore the option: their runs end as a pull request. */
  onDemand: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  onTimeoutChange: (minutes: number | null) => void;
}

/**
 * "Close when done": the switch beside its label (the row the schedule field uses for On
 * demand), one sentence saying what it means for a run, and, once it is on, the time limit as a
 * sentence with one blank, like the schedule picker. On demand it shows off and locked, with
 * the reason; the saved choice comes back when On demand is turned off again.
 */
export function CloseWhenDoneField({
  checked,
  timeoutMinutes,
  onDemand,
  disabled = false,
  onCheckedChange,
  onTimeoutChange,
}: CloseWhenDoneFieldProps) {
  const switchId = useId();
  const descriptionId = useId();
  const active = checked && !onDemand;

  return (
    <Field.Root>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={switchId}>Close when done</Label>
        <Switch
          id={switchId}
          checked={active}
          disabled={disabled || onDemand}
          onCheckedChange={(next) => onCheckedChange(next)}
          aria-describedby={descriptionId}
        />
      </div>
      <p id={descriptionId} className="text-xs text-foreground-muted">
        {onDemand
          ? 'Not used on demand: those runs end as a pull request.'
          : 'Each run works without permission prompts and ends the agent when it finishes. A scheduled start is skipped while the last run is still going.'}
      </p>
      {active && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 pt-0.5">
          <span className="text-sm text-foreground-muted">Stop after</span>
          <CloseTimeoutInput
            minutes={normalizeCloseTimeoutMinutes(timeoutMinutes)}
            disabled={disabled}
            onChange={onTimeoutChange}
          />
          <span className="text-sm text-foreground-muted">if the agent is still working</span>
        </div>
      )}
    </Field.Root>
  );
}
