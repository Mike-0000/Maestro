import { formatAgo } from './activity-ledger';
import { nameBase, normalizeSpoken } from './resolver';

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
  /** Names it was renamed from a short while ago and still answers to. */
  readonly formerly?: readonly string[];
  /** Epoch ms the agent's task was created; undefined while it is being created. */
  readonly createdAt?: number;
  /** Epoch ms the developer last sent it something. */
  readonly lastMessagedAt?: number;
  /** Epoch ms it started waiting on the developer, when it is waiting. */
  readonly waitingSince?: number;
  /** The region (sub-canvas) its window is in. */
  readonly region?: string;
  /** Canvas Pro: the desk its window is on (`region` is then a region inside that desk). */
  readonly desk?: string;
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
  const former = agent.formerly?.length
    ? `, until just now called ${agent.formerly.map((name) => `"${name}"`).join(' and ')}`
    : '';
  const also = `${agent.title ? `, also titled "${agent.title}"` : ''}${former}`;
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
  if (agent.desk) parts.push(`on desk ${agent.desk}`);
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

/**
 * "Atlas / Atlas 3; Vesper / Vesper 2": names that differ only by their number, which a
 * transcript mixes up most easily. Null when every name stands alone.
 */
export function soundAlikeLine(agents: readonly AgentFact[]): string | null {
  const groups = new Map<string, string[]>();
  for (const agent of agents) {
    const base = nameBase(normalizeSpoken(agent.name));
    if (base) groups.set(base, [...(groups.get(base) ?? []), agent.name]);
  }
  const alike = [...groups.values()].filter((names) => names.length > 1);
  return alike.length > 0 ? alike.map((names) => names.join(' / ')).join('; ') : null;
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

/** What the context says about one desk (Canvas Pro). */
export type DeskFact = {
  readonly name: string;
  /** The desk in view. */
  readonly active: boolean;
  /** Windows that live on it. */
  readonly windowCount: number;
  /** "1 needs you, 2 working"; empty when nothing on it is worth a mention. */
  readonly status: string;
  /** A gathering desk: what it collects ("needs you"), else null. */
  readonly gathers: string | null;
};

/** Desks named in the context line; more than this and the rest are counted. */
export const CONTEXT_MAX_DESKS = 12;

/**
 * "Main (3), Review* (2, 1 needs you), Triage (gathers needs you)": the desks in order, with a
 * star on the one in view. Bounded: past `max` desks the rest are counted, and the one in view is
 * still named.
 */
export function desksLine(desks: readonly DeskFact[], max = CONTEXT_MAX_DESKS): string {
  if (desks.length === 0) return 'none';
  const describe = (desk: DeskFact): string => {
    const parts = [
      ...(desk.gathers ? [`gathers ${desk.gathers}`] : []),
      ...(desk.gathers && desk.windowCount === 0 ? [] : [String(desk.windowCount)]),
      ...(desk.status ? [desk.status] : []),
    ];
    return `${desk.name}${desk.active ? '*' : ''} (${parts.join(', ')})`;
  };
  const shown = desks.slice(0, max);
  const rest = desks.slice(max);
  const inView = rest.find((desk) => desk.active);
  const more = rest.length > 0 ? `, and ${rest.length} more` : '';
  const hidden = inView ? `, including ${describe(inView)}` : '';
  return `${shown.map(describe).join(', ')}${more}${hidden}`;
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

/** A date and time with no zone after it, as SQLite's CURRENT_TIMESTAMP writes it (UTC). */
const ZONELESS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Timestamp to epoch ms; undefined when absent or unreadable. A timestamp with no zone is UTC
 * (the database writes `2026-10-11 16:40:28`), never the developer's local time: read as local,
 * every agent's age was off by the developer's UTC offset.
 */
export function epoch(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const zoneless = ZONELESS.exec(iso.trim());
  const value = Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : iso);
  return Number.isNaN(value) ? undefined : value;
}
