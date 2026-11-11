/** A running sub-agent the host named, with what it is doing. */
export interface LabeledSubAgent {
  readonly id: string;
  readonly label: string;
  readonly agentType?: string;
  /** The chat it runs in, by name. Set only in a task with several chats, where it tells them apart. */
  readonly chat?: string;
  /** The host did not name it: it stands for one of the sub-agents its chat's agent waits on. */
  readonly counted?: boolean;
}

/**
 * What the strip shows: the sub-agents by name when the host reports them, else only how many
 * the agent waits on.
 */
export type RunningSubAgents = number | readonly LabeledSubAgent[];

/** The count as the store reports it (null for none), as a whole number that is never negative. */
export function runningSubAgents(reported: number | null | undefined): number {
  if (reported === null || reported === undefined || !Number.isFinite(reported)) return 0;
  return Math.max(0, Math.floor(reported));
}

/**
 * What a chat's strip shows: its named sub-agents when the host reports any, else the count of
 * those the agent waits on (a host that names none, or a session started before it could).
 */
export function chatSubAgents(
  named: readonly LabeledSubAgent[] | undefined,
  waitingOn: number | null | undefined
): RunningSubAgents {
  return named && named.length > 0 ? named : runningSubAgents(waitingOn);
}

/** One of a task's chats, with what its agent reports. */
export interface ChatSubAgentSource {
  /** The chat's conversation id. */
  readonly id: string;
  /** The name the chat goes by in the task view. */
  readonly name: string;
  readonly named?: readonly LabeledSubAgent[];
  readonly waitingOn?: number | null;
}

/**
 * What a task's strip shows: the sub-agents of all its chats, chat by chat in tab order. With one
 * chat that is the chat's own list or count. With several, every sub-agent carries its chat's
 * name, and a chat whose host names none adds one unnamed entry per sub-agent it waits on, so
 * each entry still belongs to a chat. Ids are prefixed with the chat's, so they stay apart across
 * chats and stay the same when the task gains or loses a chat.
 */
export function taskSubAgents(chats: readonly ChatSubAgentSource[]): RunningSubAgents {
  const several = chats.length > 1;
  const [only] = chats;
  if (!several && (!only || !only.named || only.named.length === 0)) {
    return runningSubAgents(only?.waitingOn);
  }
  const agents: LabeledSubAgent[] = [];
  for (const chat of chats) {
    const running = chatSubAgents(chat.named, chat.waitingOn);
    const chatName = several && chat.name ? { chat: chat.name } : {};
    if (typeof running === 'number') {
      for (let index = 0; index < running; index += 1) {
        agents.push({
          id: `${chat.id}/#${index}`,
          label: 'sub-agent',
          counted: true,
          ...chatName,
        });
      }
      continue;
    }
    for (const agent of running) {
      agents.push({
        id: `${chat.id}/${agent.id}`,
        label: agent.label,
        ...(agent.agentType ? { agentType: agent.agentType } : {}),
        ...chatName,
      });
    }
  }
  return agents;
}

/** "2 in Atlas, 1 in Bravo": how the running sub-agents split over the task's chats, if they do. */
export function subAgentChatSummary(running: RunningSubAgents): string | null {
  if (typeof running === 'number') return null;
  const counts = new Map<string, number>();
  for (const agent of running) {
    if (agent.chat) counts.set(agent.chat, (counts.get(agent.chat) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts].map(([chat, count]) => `${count} in ${chat}`).join(', ');
}
