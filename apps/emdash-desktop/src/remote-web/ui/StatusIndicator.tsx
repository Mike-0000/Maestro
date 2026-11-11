import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { agentGroupOf } from '../lib/agent-groups';
import { cx } from './hooks';

export type AgentTone = 'attention' | 'working' | 'error' | 'completed' | 'idle';

export function agentTone(agent: RemoteAgent): AgentTone {
  const group = agentGroupOf(agent);
  if (group === 'attention') return 'attention';
  if (group === 'working') return 'working';
  if (agent.status === 'error') return 'error';
  if (agent.status === 'completed') return 'completed';
  return 'idle';
}

/** The words for each state, as the desktop app says them. */
const TONE_LABEL: Record<AgentTone, string> = {
  attention: 'Needs you',
  working: 'Working',
  error: 'Stopped on an error',
  completed: 'Finished',
  idle: 'Idle',
};

export function agentStatusLabel(agent: RemoteAgent): string {
  const tone = agentTone(agent);
  if (tone === 'idle' && !agent.running) return 'Not running';
  return TONE_LABEL[tone];
}

/**
 * Text tone for the state words. Only an error is coloured; a waiting agent reads at full
 * strength and the rest stay muted, so the eye lands on what needs it.
 */
export const TONE_TEXT: Record<AgentTone, string> = {
  attention: 'text-foreground',
  working: 'text-foreground-muted',
  error: 'text-foreground-error',
  completed: 'text-foreground-muted',
  idle: 'text-foreground-muted',
};

/** The state glyphs of the desktop kit (styles.css `.state-glyph`). */
export type StateMarkState = 'needs-you' | 'working' | 'unread' | 'done' | 'idle' | 'error';

const MARK_FOR_TONE: Record<AgentTone, StateMarkState> = {
  attention: 'needs-you',
  working: 'working',
  error: 'error',
  completed: 'done',
  idle: 'idle',
};

/** The mark for an agent's state. */
export function agentMark(agent: RemoteAgent): StateMarkState {
  return MARK_FOR_TONE[agentTone(agent)];
}

/**
 * One state mark: a filled near-white dot when a person is needed, a softly pulsing accent dot
 * while working, a ring once finished (dimmer when idle), the error dot. With a label it is
 * announced; without one it is decoration beside words that already say it.
 */
export function StateMark({
  state,
  label,
  className,
}: {
  state: StateMarkState;
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={cx('state-glyph', className)}
    />
  );
}

/** The state of an agent at a glance, with its words for screen readers. */
export function StatusIndicator({ agent, className }: { agent: RemoteAgent; className?: string }) {
  return (
    <StateMark state={agentMark(agent)} label={agentStatusLabel(agent)} className={className} />
  );
}
