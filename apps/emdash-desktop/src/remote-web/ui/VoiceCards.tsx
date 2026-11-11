import type { RemoteVoicePending, RemoteVoicePlan } from '@emdash/core/services/remote-control/api';
import { MicOff, Play, TriangleAlert, WifiOff, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { VoiceNotice } from '../state/voice-store';
import { useVoice } from './app-context';
import { Button, IconButton, TextAction } from './controls';
import { StateMark, type StateMarkState } from './StatusIndicator';

/**
 * One card in the voice panel, the phone's HudCard: the panel's emphasis step, one hairline,
 * the same radius and padding for every kind, so the stack reads as one family.
 */
function VoiceCard({
  label,
  role,
  children,
}: {
  label?: string;
  role?: 'alert';
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      role={role}
      className="animate-pop-in rounded-lg border border-border-subtle bg-surface-emphasis px-4 py-3"
    >
      {children}
    </section>
  );
}

/** The card's first line: a state mark or a quiet icon, the title, quiet facts. */
function CardHeader({
  glyph,
  title,
  meta,
  action,
}: {
  glyph: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-[1.375rem] w-4 shrink-0 items-center justify-center">{glyph}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <h3 className="text-body min-w-0 font-semibold break-words text-foreground">{title}</h3>
        {meta ? (
          <span className="text-caption shrink-0 text-foreground-passive tabular-nums">{meta}</span>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Something the conductor will do only on an explicit yes. */
export const PendingCard = observer(function PendingCard({
  pending,
}: {
  pending: RemoteVoicePending;
}) {
  const voice = useVoice();
  return (
    <VoiceCard label="Confirmation needed">
      <CardHeader glyph={<StateMark state="needs-you" />} title={pending.label} />
      <p className="text-detail mt-1 pl-[1.625rem] text-foreground-muted">
        Nothing runs until you answer.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="ghost"
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
    </VoiceCard>
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
    const mark: StateMarkState = running ? 'working' : 'done';
    return (
      <VoiceCard label={running ? 'Plan running' : 'Plan finished'}>
        <CardHeader
          glyph={<StateMark state={mark} />}
          title={running ? 'Plan running' : 'Plan finished'}
          meta={running ? agents : undefined}
        />
        <p className="text-detail mt-0.5 truncate pl-[1.625rem] text-foreground-muted">
          {plan.goal}
        </p>
      </VoiceCard>
    );
  }

  return (
    <VoiceCard label="Proposed plan">
      <CardHeader glyph={<StateMark state="needs-you" />} title="Plan to approve" meta={agents} />
      <p className="text-body mt-0.5 pl-[1.625rem] break-words text-foreground-body">{plan.goal}</p>
      <ol className="mt-3 flex flex-col gap-2.5 pl-[1.625rem]">
        {plan.subtasks.map((subtask, index) => (
          <li key={`${subtask.name}:${subtask.detail}`} className="flex gap-2.5">
            <span className="text-caption w-3 shrink-0 text-right leading-[1.375rem] text-foreground-passive tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-body break-words text-foreground">{subtask.name}</p>
              {subtask.detail ? (
                <p className="text-detail line-clamp-3 break-words text-foreground-muted">
                  {subtask.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-detail mt-3 pl-[1.625rem] text-foreground-muted">
        Each agent gets its own worktree and branch.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="ghost"
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
    </VoiceCard>
  );
});

function noticeIcon(kind: VoiceNotice['kind'] | 'host'): ReactNode {
  // A warning glyph, never a fill: the words carry the rest.
  const className = 'size-4 shrink-0 text-foreground-warning';
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
    <VoiceCard role="alert">
      <CardHeader
        glyph={noticeIcon(kind)}
        title={title}
        action={
          // Out of the line's height, so the body sits under the title as in the other cards.
          <IconButton label="Dismiss" className="-my-2.5 -mr-2.5" onClick={onDismiss}>
            <X className="size-4" aria-hidden="true" />
          </IconButton>
        }
      />
      <p className="text-detail mt-0.5 pl-[1.625rem] break-words text-foreground-muted">{body}</p>
      {onRetry ? (
        <div className="pl-[1.625rem]">
          <TextAction className="text-detail" onClick={onRetry}>
            Send again
          </TextAction>
        </div>
      ) : null}
    </VoiceCard>
  );
}
