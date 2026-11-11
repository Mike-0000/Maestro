import type { AgentStatus } from '@core/primitives/agents/api/agent-events';

/**
 * The line under "Maestro" at the top of the sidebar: how many tasks wait on the developer and
 * how many are still at work. "Nothing needs you", "One is yours · 3 at work".
 */

const NUMBER_WORDS = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
] as const;

/** A count that starts a sentence: a capitalised word up to twelve, digits above. */
function countWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function wholeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export function ownershipLine(counts: { yours: number; working: number }): string {
  const yours = wholeCount(counts.yours);
  const working = wholeCount(counts.working);
  const lead =
    yours === 0 ? 'Nothing needs you' : `${countWord(yours)} ${yours === 1 ? 'is' : 'are'} yours`;
  return working > 0 ? `${lead} · ${working} at work` : lead;
}

/** An agent as the ownership rule needs it: its status and whether the developer has looked. */
export type OwnedAgent = { readonly status: AgentStatus; readonly seen: boolean };

/**
 * The one rule for what is the developer's, shared by this line and the sidebar rows (glyph,
 * title weight, needs-you-first sort): an agent waiting for input is yours whether or not it has
 * been seen, because looking at it does not answer it; one that finished or failed is yours only
 * until it is seen.
 */
export function isYoursAgent(agent: OwnedAgent): boolean {
  if (agent.status === 'awaiting-input') return true;
  return (agent.status === 'completed' || agent.status === 'error') && !agent.seen;
}

/** True for the task statuses `taskOwnershipStatus` gives a task that is yours. */
export function isYoursTaskStatus(status: AgentStatus | null): boolean {
  return status === 'awaiting-input' || status === 'completed' || status === 'error';
}

/**
 * A task's state from its agents, for its sidebar row. What is yours (see `isYoursAgent`) comes
 * before work going on, so a task the header counts as yours always shows a yours state: waiting
 * for input, then a failure, then a finish; otherwise working; otherwise null (nothing to show).
 */
export function taskOwnershipStatus(agents: Iterable<OwnedAgent>): AgentStatus | null {
  let error = false;
  let completed = false;
  let working = false;
  for (const agent of agents) {
    if (agent.status === 'awaiting-input') return 'awaiting-input';
    if (isYoursAgent(agent)) {
      if (agent.status === 'error') error = true;
      else completed = true;
    } else if (agent.status === 'working') working = true;
  }
  if (error) return 'error';
  if (completed) return 'completed';
  return working ? 'working' : null;
}

/**
 * Counts tasks, not agents. A task is yours when one of its agents is (`isYoursAgent`);
 * otherwise it is at work when one of its agents is working. A task that is yours is not also
 * counted at work.
 */
export function ownershipCounts(agents: readonly (OwnedAgent & { readonly taskId: string })[]): {
  yours: number;
  working: number;
} {
  const yours = new Set<string>();
  const working = new Set<string>();
  for (const agent of agents) {
    if (isYoursAgent(agent)) yours.add(agent.taskId);
    else if (agent.status === 'working') working.add(agent.taskId);
  }
  let atWork = 0;
  for (const taskId of working) if (!yours.has(taskId)) atWork += 1;
  return { yours: yours.size, working: atWork };
}
