import { Button } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';
import { ConductorStateGlyph } from './status-strip';
import type { ConductorVitals } from './vitals';

export interface VitalsFooterProps {
  vitals: ConductorVitals;
  /** Shown while a conductor turn runs; ends it at its next step. */
  onStop: (() => void) | null;
  /** The helpers fact, drawn only while sub-agents run. */
  helpers?: ReactNode;
  /** The task's diff size, after the facts. */
  diffStat?: ReactNode;
}

/**
 * One quiet line above the composer: where the conductor stands on the left ("Working · 14s ·
 * Reading the chat…", "Finished · 6m ago"), the helpers in the middle, and on the right the facts
 * the screen really knows (the agent, its account, the conductor's effort) and the diff size. A
 * narrow pane keeps the state and the helper count.
 */
export function VitalsFooter({ vitals, onStop, helpers, diffStat }: VitalsFooterProps) {
  const facts = vitals.facts.join(' · ');
  return (
    <div className="flex h-6 min-w-0 items-center gap-4 text-tiny text-foreground-passive">
      <span className="flex min-w-0 shrink items-center gap-1.5">
        <ConductorStateGlyph glyph={vitals.glyph} className="size-2.5" />
        <span
          className={vitals.glyph === 'needs_you' ? 'truncate text-foreground-muted' : 'truncate'}
          title={vitals.left}
        >
          {vitals.left}
        </span>
        {onStop && (
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={onStop}
            className="ml-1 text-tiny underline-offset-2"
          >
            Stop
          </Button>
        )}
      </span>
      {helpers}
      {(facts || diffStat) && (
        <span className="ml-auto flex min-w-0 shrink-[2] items-center gap-3 @max-[34rem]/conductor:hidden">
          {facts && (
            <span className="truncate" title={facts}>
              {facts}
            </span>
          )}
          {diffStat}
        </span>
      )}
    </div>
  );
}
