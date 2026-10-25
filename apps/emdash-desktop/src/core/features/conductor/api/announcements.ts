import type { AgentStatus, NotificationType } from '@core/primitives/agents/api/agent-events';
import { spokenAppUrl } from '@core/primitives/agents/api/completion-report';
import { completionSentence } from '@core/primitives/agents/api/completion-summary';
import type { AnnounceSource } from './calls';

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

/** What an announced agent looked like, enough to tell whether that still holds. */
type AnnouncedState = {
  readonly conversationId: string;
  readonly status: AgentStatus;
  readonly notificationType: NotificationType | null;
  readonly seen: boolean;
};

/**
 * The announced agents that still need the developer as they did when they were announced: not
 * looked at since, in the same state, and waiting on the same kind of prompt. An agent that no
 * longer "needs permission" is not said to.
 */
export function stillAnnounced<Entry extends AnnouncedState>(
  announced: readonly Entry[],
  current: readonly AnnouncedState[]
): Entry[] {
  return announced.filter((entry) => {
    const now = current.find((other) => other.conversationId === entry.conversationId);
    return (
      now !== undefined &&
      // Looked at since it was announced (one already seen then stays as it was).
      (!now.seen || entry.seen) &&
      now.status === entry.status &&
      now.notificationType === entry.notificationType
    );
  });
}

/** What a batch of attention events is, for the trace. */
export function batchSource(
  agents: readonly Pick<AnnouncedState, 'status' | 'notificationType'>[]
): AnnounceSource {
  if (agents.length > 0 && agents.every((agent) => agent.status === 'completed')) {
    return 'completion';
  }
  if (
    agents.length > 0 &&
    agents.every(
      (agent) => agent.status === 'awaiting-input' && agent.notificationType === 'idle_prompt'
    )
  ) {
    return 'idle';
  }
  return 'attention';
}

/** Words that make what became of an agent's request worth saying aloud, whatever its kind. */
const CONSEQUENTIAL =
  /\b(?:publish\w*|upload\w*|push\w*|releas\w*|delet\w*|pay|pays|paid|paying|payments?|purchas\w*|buy|buys|buying|bought)\b/i;

/**
 * Whether the conductor says aloud how it settled an agent's request, or only shows it. Said:
 * a new agent, a denial, a failure, no decision, and anything that publishes, uploads, pushes,
 * releases, deletes or pays, which can arrive as a plain question to the conductor. Shown: a
 * routine message passed between agents, and a routine answer.
 */
export function speaksRequestOutcome(outcome: {
  readonly kind: string;
  /** How it ended; null when it closed without a verdict. */
  readonly status: string | null;
  /** The request and what was said about it. */
  readonly words: string;
}): boolean {
  if (outcome.status !== 'approved' && outcome.status !== 'answered') return true;
  if (outcome.kind === 'spawn_agent') return true;
  return CONSEQUENTIAL.test(outcome.words);
}

/** A plan's notice that something did not start or did not arrive (`plan-store`'s wording). */
const PLAN_FAILURE = /\b(?:failed to start|didn't start|did not get its|failed)\b/i;

/** What a plan's notice is, for the queue: a failure is told even while calls are held. */
export function planNoticeSource(text: string): AnnounceSource {
  return PLAN_FAILURE.test(text) ? 'failure' : 'other';
}
