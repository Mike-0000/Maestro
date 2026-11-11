import { Input, Select } from '@emdash/ui/react/primitives';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@core/primitives/styling/browser/cn';
import {
  changePeriod,
  DEFAULT_CRON_STATE,
  MONTH_LABELS,
  ordinal,
  parseCron,
  PERIOD_LABELS,
  PERIOD_ORDER,
  toCron,
  WEEKDAY_LABELS,
} from './cron-utils';
import type { CronPeriod, CronState } from './types';

interface CronPickerProps {
  value: string;
  onChange: (cron: string) => void;
  className?: string;
}

function useCronState(value: string): { state: CronState; parseError: boolean } {
  return useMemo(() => {
    const parsed = parseCron(value);
    if (parsed) return { state: parsed, parseError: false };
    return { state: DEFAULT_CRON_STATE, parseError: true };
  }, [value]);
}

function formatTwoDigit(value: number) {
  return value.toString().padStart(2, '0');
}

/** Wraps a value by `delta` within the inclusive range [min, max]. */
function wrapValue(value: number, delta: number, min: number, max: number) {
  const range = max - min + 1;
  return ((value - min + delta + range) % range) + min;
}

function sanitizeTimeSegmentDraft(raw: string, max: number) {
  const digits = raw.replace(/\D/g, '').slice(0, 2);
  if (!digits) return '';
  const parsed = parseInt(digits, 10);
  if (Number.isNaN(parsed)) return '';
  return String(Math.min(max, parsed));
}

/**
 * The field look the sentence's controls share (the kit's input shell, at the 28px control
 * height), so each blank reads as something to change without a box around the whole picker.
 */
const SENTENCE_FIELD = 'h-7 w-auto gap-1.5 px-2 text-sm text-foreground tabular-nums';

/** A small inline select that reads as one blank in the schedule sentence. */
function InlineSelect({
  value,
  onValueChange,
  children,
  className,
  renderValue,
  ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  /** Map the raw value to a display label. Required when value !== display text. */
  renderValue?: (v: string) => string;
  ariaLabel: string;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => {
        if (v !== null) onValueChange(v);
      }}
    >
      <Select.Trigger
        appearance="input"
        aria-label={ariaLabel}
        className={cn(SENTENCE_FIELD, className)}
      >
        {renderValue ? <Select.Value>{renderValue}</Select.Value> : <Select.Value />}
      </Select.Trigger>
      <Select.Content alignItemWithTrigger={false} side="bottom" align="start">
        {children}
      </Select.Content>
    </Select.Root>
  );
}

/**
 * A single editable time segment (hour or minute). Type a number, or adjust with
 * ArrowUp/ArrowDown and the mouse wheel (the wheel only adjusts while focused, so it
 * never hijacks page scroll). Arrow/wheel wrap within [min, max]; typed values clamp.
 */
function TimeSegment({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ value, min, max, onChange });
  stateRef.current = { value, min, max, onChange };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    function handleWheel(event: WheelEvent) {
      if (document.activeElement !== input) return;
      event.preventDefault();
      const { value, min, max, onChange } = stateRef.current;
      onChange(wrapValue(value, event.deltaY < 0 ? 1 : -1, min, max));
    }

    // Non-passive so preventDefault works; React's onWheel is passive.
    input.addEventListener('wheel', handleWheel, { passive: false });
    return () => input.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(raw: string | null) {
    setDraft(null);
    if (!raw) return;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    onChange(Math.max(min, Math.min(max, parsed)));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setDraft(null);
      onChange(wrapValue(value, 1, min, max));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDraft(null);
      onChange(wrapValue(value, -1, min, max));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commit(draft);
      inputRef.current?.blur();
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={draft ?? formatTwoDigit(value)}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(sanitizeTimeSegmentDraft(event.target.value, max))}
      onKeyDown={handleKeyDown}
      onBlur={() => commit(draft)}
      className="w-[2.25ch] rounded-xs bg-transparent text-center leading-none tabular-nums outline-none focus:bg-surface-selected"
    />
  );
}

function TimePicker({
  hour,
  minute,
  onChange,
}: {
  hour: number;
  minute: number;
  onChange: (next: { hour: number; minute: number }) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Time"
      className="inline-flex h-7 items-center gap-0.5 rounded-md border border-border bg-(--em-surface-input) px-2 text-sm leading-none text-foreground tabular-nums transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring hover:border-border-1 emlight:border-border-1"
    >
      <TimeSegment
        value={hour}
        min={0}
        max={23}
        ariaLabel="Hour"
        onChange={(nextHour) => onChange({ hour: nextHour, minute })}
      />
      <span className="text-foreground-passive">:</span>
      <TimeSegment
        value={minute}
        min={0}
        max={59}
        ariaLabel="Minute"
        onChange={(nextMinute) => onChange({ hour, minute: nextMinute })}
      />
    </div>
  );
}
/** The words between the blanks: they carry the sentence, so they read in the muted role. */
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-foreground-muted">{children}</span>;
}

/** Period names read inside the sentence ("Every day at …"), so they go lower case. */
function periodWord(period: CronPeriod): string {
  return PERIOD_LABELS[period].toLowerCase();
}

export function CronPicker({ value, onChange, className }: CronPickerProps) {
  const { state, parseError } = useCronState(value);

  function emit(next: CronState) {
    onChange(toCron(next));
  }

  function handlePeriodChange(period: string) {
    emit(changePeriod(state, period as CronPeriod));
  }

  function handleWeekDayChange(v: string) {
    emit({ ...state, weekDay: parseInt(v, 10) });
  }

  function handleMonthChange(v: string) {
    emit({ ...state, month: parseInt(v, 10) });
  }

  function handleMonthDayChange(v: string) {
    emit({ ...state, monthDay: parseInt(v, 10) });
  }

  function handleTimeChange(next: { hour: number; minute: number }) {
    emit({ ...state, hour: next.hour, minute: next.minute });
  }

  function handleMinuteChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10);
    if (Number.isNaN(raw)) return;
    emit({ ...state, minute: Math.max(0, Math.min(59, raw)) });
  }

  const { period, hour, minute, weekDay, monthDay, month } = state;

  const showMonth = period === 'year';
  const showMonthDay = period === 'month' || period === 'year';
  const showWeekDay = period === 'week';
  const showTime = period === 'day' || period === 'week' || period === 'month' || period === 'year';
  const showHourMinute = period === 'hour';

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        <Label>Every</Label>

        {/* Period selector */}
        <InlineSelect
          ariaLabel="Repeats every"
          value={period}
          onValueChange={handlePeriodChange}
          renderValue={(v) => (v in PERIOD_LABELS ? periodWord(v as CronPeriod) : v)}
        >
          {PERIOD_ORDER.map((p) => (
            <Select.Item key={p} value={p}>
              {periodWord(p)}
            </Select.Item>
          ))}
        </InlineSelect>

        {/* Year: month selector */}
        {showMonth && (
          <>
            <Label>in</Label>
            <InlineSelect
              ariaLabel="Month"
              value={String(month)}
              onValueChange={handleMonthChange}
              renderValue={(v) => MONTH_LABELS[parseInt(v, 10) - 1] ?? v}
            >
              {MONTH_LABELS.map((label, i) => (
                <Select.Item key={i + 1} value={String(i + 1)}>
                  {label}
                </Select.Item>
              ))}
            </InlineSelect>
          </>
        )}

        {/* Month / Year: day-of-month selector */}
        {showMonthDay && (
          <>
            <Label>on the</Label>
            <InlineSelect
              ariaLabel="Day of the month"
              value={String(monthDay)}
              onValueChange={handleMonthDayChange}
              renderValue={(v) => ordinal(parseInt(v, 10))}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <Select.Item key={d} value={String(d)}>
                  {ordinal(d)}
                </Select.Item>
              ))}
            </InlineSelect>
          </>
        )}

        {/* Week: day-of-week selector */}
        {showWeekDay && (
          <>
            <Label>on</Label>
            <InlineSelect
              ariaLabel="Day of the week"
              value={String(weekDay)}
              onValueChange={handleWeekDayChange}
              renderValue={(v) => WEEKDAY_LABELS[parseInt(v, 10)] ?? v}
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <Select.Item key={i} value={String(i)}>
                  {label}
                </Select.Item>
              ))}
            </InlineSelect>
          </>
        )}

        {/* Day / Week / Month / Year: time picker */}
        {showTime && (
          <>
            <Label>at</Label>
            <TimePicker hour={hour} minute={minute} onChange={handleTimeChange} />
          </>
        )}

        {/* Hour: minute-of-hour input */}
        {showHourMinute && (
          <>
            <Label>at minute</Label>
            <Input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={handleMinuteChange}
              aria-label="Minute past the hour"
              className="h-7 w-16 px-2 text-sm tabular-nums"
            />
          </>
        )}
      </div>

      {parseError && (
        <p className="text-xs text-foreground-warning">
          This schedule can't be shown in the picker, so it shows the default. Saving replaces it.
        </p>
      )}
    </div>
  );
}
