import { FileSearch, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { InvestigationOutcome } from '../../api/contract';
import { getConductorStore } from '../../contributions/browser/app-stores';
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
      <div className="space-y-1 rounded-lg border border-violet-500/40 bg-violet-500/5 px-2.5 py-2">
        <div className="flex items-center gap-2 text-sm">
          <FileSearch className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
          <span className="min-w-0 flex-1 truncate text-foreground">
            Checking the code in {running.target}
            {running.questions.length > 1 ? `: ${running.questions.length} questions` : ''}
          </span>
          <Elapsed since={running.startedAt} />
          <button
            type="button"
            onClick={() => conductor.cancelInvestigation()}
            className="rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
          >
            Cancel <span className="opacity-60">Esc</span>
          </button>
        </div>
        {running.questions.length === 1 && first && (
          <p className="truncate text-xs text-foreground-muted">{first}</p>
        )}
        {running.step && <p className="truncate text-xs text-foreground-muted">{running.step}</p>}
      </div>
    );
  }

  if (!last) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-sm">
        <FileSearch className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <span className="min-w-0 flex-1 truncate text-foreground">
          Code check in {last.folderName}
        </span>
        <button
          type="button"
          aria-label="Dismiss the code check"
          onClick={() => conductor.dismissInvestigation()}
          className="rounded-md p-1 text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="max-h-40 space-y-2 overflow-y-auto">
        {last.outcomes.map((outcome) => (
          <Outcome key={outcome.question} outcome={outcome} />
        ))}
      </div>
    </div>
  );
});

function Outcome({ outcome }: { outcome: InvestigationOutcome }) {
  if (outcome.status === 'failed') {
    return (
      <div className="text-xs">
        <p className="text-foreground-muted">{outcome.question}</p>
        <p className="text-amber-700 dark:text-amber-300">{outcome.message}</p>
      </div>
    );
  }
  const found = outcome.evidence.filter((item) => item.found).length;
  return (
    <div className="space-y-0.5 text-xs">
      <p className="text-foreground-muted">{outcome.question}</p>
      <p className="text-foreground">{outcome.answer}</p>
      {outcome.evidence.length > 0 && (
        <p className="text-foreground-muted">
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
  return (
    <span className="shrink-0 text-xs text-foreground-muted tabular-nums">
      {Math.max(0, Math.round((now - since) / 1000))} s
    </span>
  );
}
