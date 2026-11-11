import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { Tabs } from '@emdash/ui/react/primitives';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ConductorVitals } from './vitals';

export type ConductorGlyph = ConductorVitals['glyph'];
export type ChatViewChoice = 'conductor' | 'raw';

const KIT_STATE: Record<ConductorGlyph, StateGlyphState> = {
  working: 'working',
  needs_you: 'needs-you',
  error: 'error',
  done: 'done',
  idle: 'idle',
};

/**
 * Where the conductor stands, as the kit's one state mark: a filled dot when it needs the
 * developer (the error dot on an error), a softly pulsing accent dot while it works, a hollow
 * ring when the work is done, and a dimmer ring at rest. The pulse stops under reduced motion.
 */
export function ConductorStateGlyph({
  glyph,
  className,
}: {
  glyph: ConductorGlyph;
  className?: string;
}) {
  return <StateGlyph state={KIT_STATE[glyph]} size="sm" data-glyph={glyph} className={className} />;
}

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
    <div className="surface-paper @container/strip flex h-9 shrink-0 items-center gap-3 bg-surface pr-1.5 pl-4">
      <span
        role="status"
        className="flex min-w-0 flex-1 items-center gap-2"
        title={headline || undefined}
      >
        {glyph && <ConductorStateGlyph glyph={glyph} />}
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
        <Tabs.List variant="underline" aria-label="Chat view">
          <Tabs.Tab value="conductor">Conductor</Tabs.Tab>
          <Tabs.Tab value="raw">Raw</Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    </div>
  );
}
