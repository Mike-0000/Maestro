import { redactSecrets } from '@emdash/shared/logger';
import type { TuiSubAgent } from '#runtimes/tui-agents/api';
import type { ReportedSubAgent } from '#services/agent-plugins/api/plugins';

/** Longest label a sub-agent gets, ellipsis included. */
export const SUB_AGENT_LABEL_MAX_CHARS = 80;
const SUB_AGENT_TYPE_MAX_CHARS = 40;
/** Longer provider text is cut before redaction runs, so a pathological description stays cheap. */
const MAX_LABEL_INPUT_CHARS = 2_000;
/** Sub-agents past this many in one session are not tracked: the strip counts, it does not list. */
export const MAX_TRACKED_SUB_AGENTS = 32;

type TrackedSubAgent = {
  id: string;
  agentType?: string;
  description?: string;
  startedAt: number;
  /** Seen in the provider's list of background work: it outlives the turn that started it. */
  background: boolean;
};

/**
 * The sub-agents running inside one agent session, from the provider's start and stop hooks.
 * Agent-derived text is redacted and bounded here, before it leaves the runtime.
 */
export class SubAgentSet {
  private readonly agents = new Map<string, TrackedSubAgent>();

  get size(): number {
    return this.agents.size;
  }

  /** A sub-agent started. Returns whether the set changed. */
  started(reported: ReportedSubAgent, now: number): boolean {
    const known = this.agents.get(reported.agentId);
    if (known) return this.merge(known, reported, known.background);
    if (this.agents.size >= MAX_TRACKED_SUB_AGENTS) return false;
    this.agents.set(reported.agentId, {
      id: reported.agentId,
      agentType: cleanAgentType(reported.agentType),
      description: cleanLabel(reported.description),
      startedAt: now,
      background: false,
    });
    return true;
  }

  /**
   * A sub-agent stopped. `running` is what the provider still lists as in flight: it can only
   * describe sub-agents already known, never add one (the list may still hold the one stopping).
   */
  stopped(agentId: string, running: readonly ReportedSubAgent[] = []): boolean {
    let changed = this.agents.delete(agentId);
    for (const reported of running) {
      const known = this.agents.get(reported.agentId);
      if (known && this.merge(known, reported, true)) changed = true;
    }
    return changed;
  }

  /**
   * The agent's own turn ended: sub-agents it ran in the foreground are done, and what still
   * runs is exactly the background work the provider listed. Missed stops are dropped here, and
   * background sub-agents started before the hooks were heard are picked up.
   */
  turnEnded(running: readonly ReportedSubAgent[], now: number): boolean {
    const before = this.signature();
    const next = new Map<string, TrackedSubAgent>();
    for (const reported of running) {
      if (next.size >= MAX_TRACKED_SUB_AGENTS) break;
      const known = this.agents.get(reported.agentId);
      const entry: TrackedSubAgent = known ?? {
        id: reported.agentId,
        startedAt: now,
        background: true,
      };
      this.merge(entry, reported, true);
      next.set(entry.id, entry);
    }
    this.agents.clear();
    for (const [id, entry] of next) this.agents.set(id, entry);
    return this.signature() !== before;
  }

  /** The agent's turn was cut short: its foreground sub-agents went with it. */
  interrupted(): boolean {
    let changed = false;
    for (const [id, entry] of this.agents) {
      if (entry.background) continue;
      this.agents.delete(id);
      changed = true;
    }
    return changed;
  }

  /** Oldest first; undefined for none. */
  list(): TuiSubAgent[] | undefined {
    if (this.agents.size === 0) return undefined;
    return [...this.agents.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => ({
        id: entry.id,
        label: entry.description ?? entry.agentType ?? 'sub-agent',
        ...(entry.agentType ? { agentType: entry.agentType } : {}),
        startedAt: entry.startedAt,
      }));
  }

  private merge(entry: TrackedSubAgent, reported: ReportedSubAgent, background: boolean): boolean {
    const agentType = cleanAgentType(reported.agentType) ?? entry.agentType;
    const description = cleanLabel(reported.description) ?? entry.description;
    const changed =
      agentType !== entry.agentType ||
      description !== entry.description ||
      background !== entry.background;
    entry.agentType = agentType;
    entry.description = description;
    entry.background = background;
    return changed;
  }

  private signature(): string {
    return JSON.stringify(this.list() ?? []);
  }
}

/** Two sub-agent lists show the same thing. */
export function sameSubAgents(
  a: readonly TuiSubAgent[] | undefined,
  b: readonly TuiSubAgent[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return (
      item.id === other.id &&
      item.label === other.label &&
      item.agentType === other.agentType &&
      item.startedAt === other.startedAt
    );
  });
}

/**
 * Provider text made fit to show: redacted, without control characters or line breaks, and
 * bounded with an ellipsis. Undefined when nothing is left.
 */
export function cleanLabel(
  text: string | undefined,
  maxChars = SUB_AGENT_LABEL_MAX_CHARS
): string | undefined {
  if (typeof text !== 'string') return undefined;
  const clean = redactSecrets(text.slice(0, MAX_LABEL_INPUT_CHARS))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length <= maxChars ? clean : `${cutAt(clean, maxChars - 1).trimEnd()}…`;
}

/** The first `length` UTF-16 units, without half of a character cut in two. */
function cutAt(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
}

function cleanAgentType(text: string | undefined): string | undefined {
  return cleanLabel(text, SUB_AGENT_TYPE_MAX_CHARS);
}
