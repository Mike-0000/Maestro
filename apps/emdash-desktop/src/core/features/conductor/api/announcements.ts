import type { AgentStatus, NotificationType } from '@core/primitives/agents/api/agent-events';
import { spokenAppUrl } from '@core/primitives/agents/api/completion-report';
import { completionSentence } from '@core/primitives/agents/api/completion-summary';

/** One agent in a batch of attention events, already resolved to its spoken name. */
export type AnnouncedAgent = {
  readonly name: string;
  readonly status: AgentStatus;
  readonly notificationType: NotificationType | null;
  readonly taskName: string;
  readonly completionSummary: string | null;
  /** A local app URL the finished agent reported in its final reply. */
  readonly appUrl?: string | null;
  readonly riskLevel?: 'low' | 'moderate' | 'elevated' | 'high' | null;
};

/**
 * Which finished agents are announced. all: every finished agent is spoken and sounds. attention_only:
 * only those that need the developer are; one that finished with nothing for them shows on the HUD,
 * with no speech and no notification sound. Waiting agents are always announced.
 */
export const completionAnnouncementModes = ['all', 'attention_only'] as const;
export type CompletionAnnouncementMode = (typeof completionAnnouncementModes)[number];

/** More agents than this at once collapse into a count. */
export const MAX_NAMED_ANNOUNCEMENTS = 3;

/**
 * The spoken text for a batch of agents that need the user. Waiting agents share one short
 * sentence ("Atlas needs permission, Bravo needs you."); each finished agent gets its own
 * sentence saying what it finished ("Kilo researched TTS models…").
 */
export function announcementText(agents: readonly AnnouncedAgent[]): string | null {
  if (agents.length === 0) return null;
  if (agents.length > MAX_NAMED_ANNOUNCEMENTS) return `${agents.length} agents need you.`;
  const waiting = agents
    .filter((agent) => agent.status !== 'completed')
    .map((agent) => {
      const suffix =
        agent.riskLevel === 'high'
          ? ' for something risky'
          : agent.riskLevel === 'low'
            ? ', low risk'
            : '';
      return `${agent.name} ${attentionPhrase(agent)}${suffix}`;
    });
  const finished = agents
    .filter((agent) => agent.status === 'completed')
    .map((agent) => {
      const sentence = completionSentence(agent.name, agent.completionSummary, agent.taskName);
      return agent.appUrl
        ? `${sentence} It reported the app at ${spokenAppUrl(agent.appUrl)}.`
        : sentence;
    });
  return (waiting.length > 0 ? [`${waiting.join(', ')}.`, ...finished] : finished).join(' ');
}

export function attentionPhrase(entry: {
  readonly status: AgentStatus;
  readonly notificationType: NotificationType | null;
}): string {
  switch (entry.status) {
    case 'awaiting-input':
      return entry.notificationType === 'permission_prompt' ? 'needs permission' : 'needs you';
    case 'completed':
      return 'is done';
    case 'error':
      return 'hit an error';
    default:
      return 'is ready';
  }
}
