import { PhoneCall, PhoneForwarded } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getVoiceStore } from '@core/features/voice/contributions/browser/app-stores';
import type { CallKind } from '../../api/calls';
import { getConductorStore } from '../../contributions/browser/app-stores';

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
  return (
    <div className="space-y-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-sm">
        {answering ? (
          <PhoneForwarded className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <PhoneCall className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground">
          {answering ? (
            <>
              Answering <span className="font-medium">{call.agentName}</span>
            </>
          ) : (
            <>
              <span className="font-medium">{call.agentName}</span> {KIND_LABEL[call.kind]}
            </>
          )}
          {waiting > 0 && (
            <span className="ml-2 text-xs text-foreground-muted">{waiting} more waiting</span>
          )}
        </span>
        {/* Always there: a call that was picked up can still be dropped by hand. */}
        <button
          type="button"
          onClick={() => conductor.skipCall()}
          className="rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        >
          Skip
        </button>
        {!answering && (
          <>
            <button
              type="button"
              onClick={() => conductor.pickUpCall()}
              className="rounded-md px-2 py-1 text-xs text-foreground-muted hover:bg-background-secondary hover:text-foreground"
            >
              Type
            </button>
            <button
              type="button"
              onClick={() => voice.tap()}
              className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90"
            >
              Answer <span className="opacity-60">tap Right Ctrl</span>
            </button>
          </>
        )}
      </div>
      <p className="line-clamp-3 text-xs text-foreground-muted">{call.text}</p>
      {answering && (
        <p className="text-xs text-foreground-muted">
          What you say or type next goes to {call.agentName} unless you name another agent.
        </p>
      )}
    </div>
  );
});
