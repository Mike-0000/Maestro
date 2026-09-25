import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { getConductorStore } from '../../contributions/browser/app-stores';

/** A side effect waiting to run: a countdown the user can cancel, or an explicit confirmation. */
export const PendingActionCard = observer(function PendingActionCard() {
  const conductor = getConductorStore();
  const pending = conductor.pending;
  if (!pending) return null;
  const countdown = pending.kind === 'countdown';
  return (
    <div className="space-y-2 rounded-lg border border-blue-500/40 bg-blue-500/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-foreground">{pending.label}</span>
        <button
          type="button"
          onClick={() => conductor.cancelPending()}
          className="rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        >
          Cancel <span className="opacity-60">Esc</span>
        </button>
        <button
          type="button"
          onClick={() => conductor.confirmPending()}
          className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90"
        >
          {countdown ? 'Now' : 'Confirm'} <span className="opacity-60">Enter</span>
        </button>
      </div>
      {countdown ? (
        <CountdownBar key={pending.id} durationMs={pending.durationMs} />
      ) : (
        <p className="text-xs text-foreground-muted">Say “yes” or press Enter to confirm.</p>
      )}
    </div>
  );
});

function CountdownBar({ durationMs }: { durationMs: number }) {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setStarted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
      <div
        className="h-full bg-blue-500 ease-linear"
        style={{
          width: started ? '0%' : '100%',
          transitionProperty: 'width',
          transitionDuration: `${durationMs}ms`,
        }}
      />
    </div>
  );
}
