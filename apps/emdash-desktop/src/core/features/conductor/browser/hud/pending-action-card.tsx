import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Kbd } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { HudCard, HudCardHeader } from './hud-card';

/** A side effect that runs only on the user's explicit confirmation. */
export const PendingActionCard = observer(function PendingActionCard() {
  const conductor = getConductorStore();
  const pending = conductor.pending;
  if (!pending) return null;
  return (
    <HudCard label="Waiting for your confirmation">
      <HudCardHeader
        glyph={<StateGlyph state="needs-you" />}
        title={pending.label}
        wrapTitle
        actions={
          <>
            <span className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="text"
                size="xs"
                onClick={() => conductor.cancelPending()}
              >
                Cancel
              </Button>
              <Kbd>Esc</Kbd>
            </span>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => conductor.confirmPending()}
            >
              Confirm <Kbd>Enter</Kbd>
            </Button>
          </>
        }
      />
      {pending.detail && (
        // Everything the action carries, so a yes is given to all of it and not to one line.
        <p className="mt-2 max-h-24 overflow-y-auto rounded-md bg-surface-emphasis px-2.5 py-1.5 text-xs whitespace-pre-wrap text-foreground-muted">
          {pending.detail}
        </p>
      )}
      <p className="mt-2 text-tiny text-foreground-passive">
        {pending.held
          ? 'Waiting while this is read out or you are speaking. Nothing runs until then.'
          : 'Say “yes” or press Enter to confirm (Enter typed into a terminal or text field doesn’t count).'}
      </p>
    </HudCard>
  );
});
