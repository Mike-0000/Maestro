import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Kbd } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { InvestigationOutcome } from '../../api/contract';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { HudCard, HudCardHeader } from './hud-card';
import { isTextEntryTarget } from './pending-keys';

/**
 * A code check: while it runs, what is being read and a way to stop it; afterwards, each answer
 * with the files it rests on and how many of its quotes were found in them.
 */
export const InvestigationCard = observer(function InvestigationCard() {
  const conductor = getConductorStore();
  const running = conductor.investigation;
  const last = conductor.lastInvestigation;

  // Escape stops a running check, but not while something is pending (that owns Escape) and not
  // when it was typed into a terminal or a text field.
  useEffect(() => {
    if (!running || conductor.pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || isTextEntryTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      conductor.cancelInvestigation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [conductor, running, conductor.pending]);

  if (running) {
    const [first] = running.questions;
    return (
      <HudCard label="Code check">
        <HudCardHeader
          glyph={<StateGlyph state="working" />}
          title={`Checking the code in ${running.target}`}
          meta={
            <>
              {running.questions.length > 1 ? `${running.questions.length} questions · ` : ''}
              <Elapsed since={running.startedAt} />
            </>
          }
          actions={
            <span className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="text"
                size="xs"
                onClick={() => conductor.cancelInvestigation()}
              >
                Cancel
              </Button>
              <Kbd>Esc</Kbd>
            </span>
          }
        />
        {running.questions.length === 1 && first && (
          <p className="mt-1 truncate pl-6 text-xs text-foreground-muted">{first}</p>
        )}
        {running.step && (
          <p className="mt-0.5 truncate pl-6 text-tiny text-foreground-passive">{running.step}</p>
        )}
      </HudCard>
    );
  }

  if (!last) return null;
  return (
    <HudCard label="Code check">
      <HudCardHeader
        glyph={<StateGlyph state="done" />}
        title={`Code check in ${last.folderName}`}
        onClose={() => conductor.dismissInvestigation()}
        closeLabel="Dismiss the code check"
      />
      <div className="mt-2 max-h-40 space-y-3 overflow-y-auto pl-6">
        {last.outcomes.map((outcome) => (
          <Outcome key={outcome.question} outcome={outcome} />
        ))}
      </div>
    </HudCard>
  );
});

function Outcome({ outcome }: { outcome: InvestigationOutcome }) {
  if (outcome.status === 'failed') {
    return (
      <div>
        <p className="text-xs text-foreground-muted">{outcome.question}</p>
        <p className="mt-0.5 text-sm text-foreground-warning">{outcome.message}</p>
      </div>
    );
  }
  const found = outcome.evidence.filter((item) => item.found).length;
  return (
    <div>
      <p className="text-xs text-foreground-muted">{outcome.question}</p>
      <p className="mt-0.5 text-sm text-foreground-body">{outcome.answer}</p>
      {outcome.evidence.length > 0 && (
        <p className="mt-0.5 text-tiny text-foreground-passive">
          {found} of {outcome.evidence.length} quotes found in{' '}
          {[...new Set(outcome.evidence.map((item) => baseName(item.path)))].join(', ')}
        </p>
      )}
    </div>
  );
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Whole seconds since `since`, counting up. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))} s</>;
}
