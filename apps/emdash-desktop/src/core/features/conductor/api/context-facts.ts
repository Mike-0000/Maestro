import { formatAgo } from './activity-ledger';

/**
 * The facts about each agent that the conductor's per-turn context states by default, so "the
 * latest agent in this project", "the one that has waited longest", or "the Vesper window" can be
 * answered from the context instead of with a guess or a refusal. Pure: the roster builds these
 * from the canvas, and this file turns them into lines.
 */
export type AgentFact = {
  readonly name: string;
  readonly providerLabel: string;
  /** Ready-made status phrase: "working", "waiting for input", "idle, not running". */
  readonly status: string;
  readonly taskName: string;
  readonly projectName: string;
  /** The conversation's own title, when it differs from the spoken name. */
  readonly title?: string;
  /** Epoch ms the agent's task was created; undefined while it is being created. */
  readonly createdAt?: number;
  /** Epoch ms the developer last sent it something. */
  readonly lastMessagedAt?: number;
  /** Epoch ms it started waiting on the developer, when it is waiting. */
  readonly waitingSince?: number;
  /** The region (sub-canvas) its window is in. */
  readonly region?: string;
  readonly focused?: boolean;
  readonly diff?: string;
};

/** Newest first; an agent still being created has no date yet and is the newest of all. */
export function newestFirst<T extends { readonly createdAt?: number }>(agents: readonly T[]): T[] {
  return [...agents].sort(
    (a, b) => (b.createdAt ?? Number.MAX_SAFE_INTEGER) - (a.createdAt ?? Number.MAX_SAFE_INTEGER)
  );
}

function minutes(since: number, now: number): string {
  const total = Math.max(0, Math.round((now - since) / 60_000));
  if (total < 1) return 'under a minute';
  if (total < 90) return `${total} min`;
  return `${Math.round(total / 60)} h`;
}

/** One roster line: everything the conductor knows about an agent without a tool call. */
export function agentLine(agent: AgentFact, now: number): string {
  const also = agent.title ? `, also titled "${agent.title}"` : '';
  const focus = agent.focused ? ', focused' : '';
  const waited = agent.waitingSince !== undefined ? ` for ${minutes(agent.waitingSince, now)}` : '';
  const parts = [
    `${agent.status}${waited}`,
    `task "${agent.taskName}" in project ${agent.projectName}`,
    agent.createdAt !== undefined ? `started ${formatAgo(agent.createdAt, now)}` : 'starting now',
  ];
  if (agent.lastMessagedAt !== undefined) {
    parts.push(`last messaged ${formatAgo(agent.lastMessagedAt, now)}`);
  }
  if (agent.region) parts.push(`in region ${agent.region}`);
  if (agent.diff) parts.push(agent.diff);
  return `- ${agent.name} (${agent.providerLabel}${also}${focus}): ${parts.join('; ')}`;
}

/** "chorus: Umber 3; ACE COMBAT 8: Robin 3": the newest agent of each project. */
export function newestPerProject(agents: readonly AgentFact[]): string | null {
  const newest = new Map<string, string>();
  for (const agent of newestFirst(agents)) {
    if (!newest.has(agent.projectName)) newest.set(agent.projectName, agent.name);
  }
  // With one agent per project the roster already says it.
  if (newest.size === 0 || agents.length === newest.size) return null;
  return [...newest].map(([project, name]) => `${project}: ${name}`).join('; ');
}

/** Agents waiting on the developer, longest first. */
export function waitingLine(agents: readonly AgentFact[], now: number): string | null {
  const waiting = agents
    .filter(
      (agent): agent is AgentFact & { waitingSince: number } => agent.waitingSince !== undefined
    )
    .sort((a, b) => a.waitingSince - b.waitingSince);
  if (waiting.length < 2) return null;
  return waiting.map((agent) => `${agent.name} (${minutes(agent.waitingSince, now)})`).join(', ');
}

/** "Thursday, October 8, 2026, 5:42 PM": the developer's local date and time. */
export function nowLine(now: number): string {
  const text = new Date(now).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Now: ${text} (the developer's local time).`;
}

/** ISO timestamp to epoch ms; undefined when absent or unreadable. */
export function epoch(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
}
