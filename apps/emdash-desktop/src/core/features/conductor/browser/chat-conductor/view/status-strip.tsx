import { Tabs } from '@emdash/ui/react/primitives';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ConductorVitals } from './vitals';

export type ConductorGlyph = ConductorVitals['glyph'];
export type ChatViewChoice = 'conductor' | 'raw';

/**
 * Where the conductor stands, as one small mark: a filled dot when it needs the developer (red on
 * an error), a softly pulsing accent dot while it works, a hollow ring when the work is done, and
 * a dimmer ring at rest. The pulse stops under reduced motion.
 */
export function StateGlyph({ glyph, className }: { glyph: ConductorGlyph; className?: string }) {
  return (
    <span
      aria-hidden
      data-glyph={glyph}
      className={cn('inline-flex size-3 shrink-0 items-center justify-center', className)}
    >
      {glyph === 'working' ? (
        <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
      ) : glyph === 'needs_you' ? (
        <span className="size-2 rounded-full bg-foreground" />
      ) : glyph === 'error' ? (
        <span className="size-2 rounded-full bg-foreground-error" />
      ) : (
        <span
          className={cn(
            'size-2 rounded-full border-[1.5px] border-foreground-passive',
            glyph === 'idle' && 'opacity-60'
          )}
        />
      )}
    </span>
  );
}

const TAB =
  'relative after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-px after:rounded-full after:bg-current after:opacity-0 after:transition-opacity after:duration-150 aria-selected:after:opacity-100';

export interface StatusStripProps {
  /** The mark to show, or null when there is nothing to report yet. */
  glyph: ConductorGlyph | null;
  /** The conductor's one-line status; empty before it set one. */
  headline: string;
  /** The developer is waited on: the headline reads in full strength. */
  needsYou: boolean;
  view: ChatViewChoice;
  onViewChange: (view: ChatViewChoice) => void;
}

/**
 * The line above a chat: the conductor's state and headline on the left, and the Conductor | Raw
 * switch on the right as two plain text tabs, the one on screen underlined. It sits on the
 * reading surface with no rule under it. In a very narrow pane the headline steps aside for the
 * switch and stays in the tooltip.
 */
export function StatusStrip({ glyph, headline, needsYou, view, onViewChange }: StatusStripProps) {
  return (
    <div className="surface-paper @container/strip flex h-9 shrink-0 items-center gap-3 bg-(--em-surface) pr-1.5 pl-4">
      <span
        role="status"
        className="flex min-w-0 flex-1 items-center gap-2"
        title={headline || undefined}
      >
        {glyph && <StateGlyph glyph={glyph} />}
        {headline && (
          <span
            className={cn(
              'min-w-0 truncate text-sm @max-[24rem]/strip:sr-only',
              needsYou ? 'font-medium text-foreground' : 'text-foreground-muted'
            )}
          >
            {headline}
          </span>
        )}
      </span>
      <Tabs.Root
        value={view}
        onValueChange={(value) => {
          if (value === 'conductor' || value === 'raw') onViewChange(value);
        }}
      >
        <Tabs.List aria-label="Chat view">
          <Tabs.Tab value="conductor" className={TAB}>
            Conductor
          </Tabs.Tab>
          <Tabs.Tab value="raw" className={TAB}>
            Raw
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
}
