import { StateGlyph } from '@emdash/ui/react/components';
import { Button, Kbd } from '@emdash/ui/react/primitives';
import { PhoneForwarded } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import type { CallKind } from '../../api/calls';
import { getConductorStore } from '../../contributions/browser/app-stores';
import { HudCard, HudCardHeader } from './hud-card';

const KIND_LABEL: Record<CallKind, string> = {
  completion: 'finished',
  question: 'asks you',
  request: 'needs a yes or no',
  permission: 'is at a permission prompt',
  attention: 'needs you',
};

/**
 * The call on the line: who is calling, what they said, and how to answer. Picking it up (a tap
 * of the talk key, Answer, or Type) binds what the developer says next to this caller.
 */
export const CallCard = observer(function CallCard() {
  const conductor = getConductorStore();
  const voice = getVoiceStore();
  const current = conductor.calls.current;
  if (!current) return null;
  const { call, state } = current;
  const answering = state === 'picked-up';
  const waiting = conductor.calls.waiting.length;
  // The caller's line leads with the needs-you mark (a phone while answering), what they said
  // follows in reading text, and Answer is the one primary action.
  return (
    <HudCard label={`Call from ${call.agentName}`}>
      <HudCardHeader
        glyph={
          answering ? (
            <PhoneForwarded aria-hidden className="size-3.5 text-foreground-muted" />
          ) : (
            <StateGlyph state="needs-you" />
          )
        }
        title={
          answering ? (
            <>
              Answering <span className="font-semibold">{call.agentName}</span>
            </>
          ) : (
            <>
              {call.agentName} <span className="font-normal">{KIND_LABEL[call.kind]}</span>
            </>
          )
        }
        meta={waiting > 0 ? `${waiting} more waiting` : undefined}
        actions={
          <>
            {/* Always there: a call that was picked up can still be dropped by hand. */}
            <Button type="button" variant="text" size="xs" onClick={() => conductor.skipCall()}>
              Skip
            </Button>
            {!answering && (
              <>
                <Button
                  type="button"
                  variant="text"
                  size="xs"
                  onClick={() => conductor.pickUpCall()}
                >
                  Type
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  title="Answer by voice: tap Right Ctrl, or press Answer"
                  onClick={() => voice.tap()}
                >
                  Answer <Kbd>Right Ctrl</Kbd>
                </Button>
              </>
            )}
          </>
        }
      />
      <p className="mt-1.5 line-clamp-3 text-sm text-foreground-body">{call.text}</p>
      {answering && (
        <p className="mt-1.5 text-xs text-foreground-muted">
          What you say or type next goes to {call.agentName} unless you name another agent.
        </p>
      )}
    </HudCard>
  );
});
