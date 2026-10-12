import { observer } from 'mobx-react-lite';
import { getConductorStore } from '../../contributions/browser/app-stores';

/** A side effect that runs only on the user's explicit confirmation. */
export const PendingActionCard = observer(function PendingActionCard() {
  const conductor = getConductorStore();
  const pending = conductor.pending;
  if (!pending) return null;
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
          Confirm <span className="opacity-60">Enter</span>
        </button>
      </div>
      {pending.detail && (
        // Everything the action carries, so a yes is given to all of it and not to one line.
        <p className="max-h-24 overflow-y-auto rounded-md bg-background-secondary px-2 py-1 text-xs whitespace-pre-wrap text-foreground-muted">
          {pending.detail}
        </p>
      )}
      {pending.held ? (
        <p className="text-xs text-foreground-muted">
          Waiting while this is read out or you are speaking. Nothing runs until then.
        </p>
      ) : (
        <p className="text-xs text-foreground-muted">
          Say “yes” or press Enter to confirm (Enter typed into a terminal or text field doesn’t
          count).
        </p>
      )}
    </div>
  );
});
