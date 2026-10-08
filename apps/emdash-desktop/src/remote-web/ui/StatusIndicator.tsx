import type { RemoteAgent } from '@emdash/core/services/remote-control/api';
import { Check } from 'lucide-react';
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

const TONE_LABEL: Record<AgentTone, string> = {
  attention: 'Needs you',
  working: 'Working',
  error: 'Stopped with an error',
  completed: 'Done',
  idle: 'Idle',
};

export function agentStatusLabel(agent: RemoteAgent): string {
  const tone = agentTone(agent);
  if (tone === 'idle' && !agent.running) return 'Not running';
  return TONE_LABEL[tone];
}

export const TONE_TEXT: Record<AgentTone, string> = {
  attention: 'text-attention',
  working: 'text-working',
  error: 'text-danger',
  completed: 'text-success',
  idle: 'text-fg-passive',
};

/**
 * The state of an agent at a glance. Working agents get the waveform from the Maestro mark,
 * moving; waiting agents pulse; the rest sit still so the eye lands on what needs it.
 */
export function StatusIndicator({ agent, className }: { agent: RemoteAgent; className?: string }) {
  const tone = agentTone(agent);
  return (
    <span
      role="img"
      aria-label={agentStatusLabel(agent)}
      className={cx('relative inline-flex size-5 shrink-0 items-center justify-center', className)}
    >
      {tone === 'working' ? (
        <span className="text-working flex h-3.5 items-center gap-[2px]" aria-hidden="true">
          {[0, 1, 2, 3].map((bar) => (
            <span
              key={bar}
              className="animate-bar h-full w-[2.5px] origin-center rounded-full bg-current"
              style={{ animationDelay: `${bar * -230}ms` }}
            />
          ))}
        </span>
      ) : tone === 'attention' ? (
        <>
          <span className="animate-halo bg-attention absolute size-2.5 rounded-full" />
          <span className="bg-attention relative size-2.5 rounded-full" />
        </>
      ) : tone === 'completed' ? (
        <Check className="text-success size-4" strokeWidth={2.5} aria-hidden="true" />
      ) : tone === 'error' ? (
        <span className="bg-danger size-2.5 rounded-full" />
      ) : (
        <span
          className={cx(
            'size-2.5 rounded-full border-[1.5px] border-fg-passive',
            !agent.running && 'opacity-50'
          )}
        />
      )}
    </span>
  );
}
