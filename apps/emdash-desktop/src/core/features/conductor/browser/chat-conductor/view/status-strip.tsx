import { StateGlyph, type StateGlyphState } from '@emdash/ui/react/components';
import { cn } from '@core/primitives/styling/browser/cn';
import type { ChatConductorSession } from '../session';
import { conductorVitals, type ConductorVitals } from './vitals';

export type ConductorGlyph = ConductorVitals['glyph'];

/**
 * A conductor's mark: the same one its footer shows, or none before there is anything to report
 * (no thread yet, still loading, or nothing in it and nothing running).
 */
export function sessionGlyph(session: ChatConductorSession | undefined): ConductorGlyph | null {
  if (!session?.loaded) return null;
  const last = session.entries.at(-1) ?? null;
  if (!last && !session.busy && !session.status) return null;
  return conductorVitals({
    state: session.status?.state ?? null,
    busy: session.busy,
    activity: null,
    busySinceMs: null,
    lastEntryAt: last?.at ?? null,
    lastEntryKind: last?.kind ?? null,
    nowMs: 0,
    providerLabel: null,
    accountLabel: null,
    conductorEffort: null,
  }).glyph;
}

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
}

/**
 * The line above a chat and above the conductor's thread: the conductor's state and headline. It
 * sits on the reading surface with no rule under it. In a very narrow pane the headline steps
 * aside and stays in the tooltip.
 */
export function StatusStrip({ glyph, headline, needsYou }: StatusStripProps) {
  return (
    <div className="surface-paper @container/strip flex h-9 shrink-0 items-center gap-3 bg-surface px-4">
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
    </div>
  );
}
