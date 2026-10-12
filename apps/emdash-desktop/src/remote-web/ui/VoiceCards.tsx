import type { RemoteVoicePending, RemoteVoicePlan } from '@emdash/core/services/remote-control/api';
import { CircleCheck, MicOff, Play, TriangleAlert, WifiOff, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { VoiceNotice } from '../state/voice-store';
import { useVoice } from './app-context';
import { Button, IconButton, Spinner } from './controls';

/** Something the conductor will do only on an explicit yes. */
export const PendingCard = observer(function PendingCard({
  pending,
}: {
  pending: RemoteVoicePending;
}) {
  const voice = useVoice();
  return (
    <section
      aria-label="Confirmation needed"
      className="animate-pop-in border-line-strong bg-canvas rounded-2xl border p-3.5"
    >
      <p className="text-fg-muted text-[12.5px] font-semibold tracking-wide uppercase">Confirm</p>
      <p className="mt-1 text-[16px] leading-snug break-words">{pending.label}</p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={voice.responding}
          onClick={() => void voice.respond('no')}
        >
          No
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          disabled={voice.responding}
          onClick={() => void voice.respond('yes')}
        >
          Yes
        </Button>
      </div>
    </section>
  );
});

/** The conductor's plan: approval before anything starts, then a line of progress. */
export const PlanCard = observer(function PlanCard({ plan }: { plan: RemoteVoicePlan }) {
  const voice = useVoice();
  if (plan.status === 'cancelled') return null;
  const count = plan.subtasks.length;
  const agents = `${count} ${count === 1 ? 'agent' : 'agents'}`;

  if (plan.status !== 'proposed') {
    const running = plan.status === 'running';
    return (
      <section
        aria-label={running ? 'Plan running' : 'Plan finished'}
        className="border-line bg-canvas flex items-center gap-3 rounded-2xl border px-3.5 py-3"
      >
        {running ? (
          <Spinner className="text-working size-[18px] shrink-0" />
        ) : (
          <CircleCheck className="text-success size-5 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-fg-muted text-[12.5px] font-semibold tracking-wide uppercase">
            {running ? `Plan running · ${agents}` : 'Plan finished'}
          </p>
          <p className="truncate text-[14.5px]">{plan.goal}</p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Proposed plan"
      className="animate-pop-in border-line-strong bg-canvas rounded-2xl border p-3.5"
    >
      <p className="text-fg-muted text-[12.5px] font-semibold tracking-wide uppercase">
        Plan · {agents}
      </p>
      <p className="mt-1 text-[16px] leading-snug font-semibold break-words">{plan.goal}</p>
      <ol className="border-line mt-3 overflow-hidden rounded-xl border">
        {plan.subtasks.map((subtask, index) => (
          <li
            key={`${subtask.name}:${subtask.detail}`}
            className="border-line flex gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <span className="bg-surface-2 text-fg-muted mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[14.5px] leading-5 font-medium break-words">{subtask.name}</p>
              {subtask.detail ? (
                <p className="text-fg-muted mt-0.5 line-clamp-3 text-[13px] leading-snug break-words">
                  {subtask.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-fg-passive mt-2.5 text-[12.5px] leading-snug">
        Each agent gets its own worktree and branch.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={voice.responding}
          onClick={() => void voice.respond('no')}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          className="flex-[1.4]"
          disabled={voice.responding}
          onClick={() => void voice.respond('yes')}
        >
          <Play className="size-4" aria-hidden="true" />
          Start {agents}
        </Button>
      </div>
    </section>
  );
});

function noticeIcon(kind: VoiceNotice['kind'] | 'host'): ReactNode {
  const className = 'text-attention mt-0.5 size-[18px] shrink-0';
  if (kind.startsWith('mic-') || kind === 'silent') {
    return <MicOff className={className} aria-hidden="true" />;
  }
  if (kind === 'offline') return <WifiOff className={className} aria-hidden="true" />;
  return <TriangleAlert className={className} aria-hidden="true" />;
}

/** A dismissable problem: something on this device, on the way to the host, or on the host. */
export function ProblemCard({
  kind,
  title,
  body,
  onRetry,
  onDismiss,
}: {
  kind: VoiceNotice['kind'] | 'host';
  title: string;
  body: string;
  onRetry?: () => void;
  onDismiss(): void;
}) {
  return (
    <section
      role="alert"
      className="animate-pop-in border-attention-line/60 bg-attention-soft flex items-start gap-2.5 rounded-2xl border py-3 pr-1.5 pl-3.5"
    >
      {noticeIcon(kind)}
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] leading-5 font-semibold">{title}</p>
        <p className="text-fg mt-0.5 text-[13.5px] leading-snug break-words">{body}</p>
        {onRetry ? (
          <Button
            variant="secondary"
            className="bg-raised mt-2.5 h-9 px-3.5 text-[14px]"
            onClick={onRetry}
          >
            Send again
          </Button>
        ) : null}
      </div>
      <IconButton label="Dismiss" className="-mt-1.5 size-9" onClick={onDismiss}>
        <X className="size-4" aria-hidden="true" />
      </IconButton>
    </section>
  );
}
