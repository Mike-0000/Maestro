/** More sub-agents than this are counted in a "+N" after the last one drawn. */
export const MAX_SUB_AGENT_SLOTS = 8;

/** Up to this many sub-agents show their label beside their orb, where the strip is wide enough. */
export const MAX_LABELED_SUB_AGENTS = 3;

/** A running sub-agent the host named, with what it is doing. */
export interface LabeledSubAgent {
  readonly id: string;
  readonly label: string;
  readonly agentType?: string;
}

/**
 * What the strip shows: the sub-agents by name when the host reports them, else only how many
 * the agent waits on.
 */
export type RunningSubAgents = number | readonly LabeledSubAgent[];

/**
 * One sub-agent's place in the strip. A place is a number, so it keeps its colour and pace while
 * taken; when the host names its sub-agents, the place also holds the one in it.
 */
export interface SubAgentSlot {
  readonly index: number;
  /** Its sub-agent finished: it plays its exit and is dropped on the next settle. */
  readonly leaving: boolean;
  /** The sub-agent in this place, when the host named it; it stays through the exit. */
  readonly agent?: LabeledSubAgent;
}

export interface SubAgentStripState {
  /** The count the caption shows: while the last sub-agents leave, the count before they did. */
  readonly count: number;
  readonly slots: readonly SubAgentSlot[];
  /** Sub-agents past the slots drawn. */
  readonly overflow: number;
  /** None run any more: the caption leaves with the last slots. */
  readonly leaving: boolean;
}

export const EMPTY_SUB_AGENT_STRIP: SubAgentStripState = {
  count: 0,
  slots: [],
  overflow: 0,
  leaving: false,
};

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

/** Equal for the same strip contents, so a re-render with equal data advances nothing. */
export function subAgentsKey(running: RunningSubAgents): string {
  if (typeof running === 'number') return `#${running}`;
  return running.map((agent) => `${agent.id}\u0000${agent.label}`).join('\u0001');
}

/** The strip after what runs changed, named or counted. */
export function advanceSubAgentStripTo(
  previous: SubAgentStripState,
  running: RunningSubAgents
): SubAgentStripState {
  return typeof running === 'number'
    ? advanceSubAgentStrip(previous, running)
    : advanceNamedSubAgentStrip(previous, running);
}

/**
 * The strip after the running count changed. Places below the count stay or come (back) in; the
 * ones above it start leaving, and stay until `settleSubAgentStrip` so their exit can play.
 */
export function advanceSubAgentStrip(
  previous: SubAgentStripState,
  running: number
): SubAgentStripState {
  const shown = Math.min(running, MAX_SUB_AGENT_SLOTS);
  const slots: SubAgentSlot[] = [];
  for (let index = 0; index < shown; index += 1) slots.push({ index, leaving: false });
  for (const slot of previous.slots) {
    if (slot.index >= shown) slots.push({ ...slot, leaving: true });
  }
  if (running === 0) {
    if (slots.length === 0) return EMPTY_SUB_AGENT_STRIP;
    return { count: previous.count, slots, overflow: previous.overflow, leaving: true };
  }
  return { count: running, slots, overflow: running - shown, leaving: false };
}

/**
 * The strip after the named sub-agents changed. Each keeps its place while it runs; one that
 * starts takes a place counted ones held (the host began naming them), else the lowest free
 * place, else one still playing its exit. The ones that stopped start leaving, label and all.
 */
export function advanceNamedSubAgentStrip(
  previous: SubAgentStripState,
  agents: readonly LabeledSubAgent[]
): SubAgentStripState {
  if (agents.length === 0) return advanceSubAgentStrip(previous, 0);
  const running = new Set(agents.map((agent) => agent.id));
  const placed = new Map<string, number>();
  for (const slot of previous.slots) {
    if (!slot.leaving && slot.agent && running.has(slot.agent.id)) {
      placed.set(slot.agent.id, slot.index);
    }
  }
  const unnamed = previous.slots
    .filter((slot) => !slot.leaving && !slot.agent)
    .map((slot) => slot.index);
  const leaving = new Map<number, SubAgentSlot>();
  for (const slot of previous.slots) {
    if (slot.leaving || (slot.agent && !placed.has(slot.agent.id))) {
      leaving.set(slot.index, { ...slot, leaving: true });
    }
  }

  const taken = new Set([...placed.values(), ...unnamed, ...leaving.keys()]);
  const free: number[] = [];
  for (let index = 0; index < MAX_SUB_AGENT_SLOTS; index += 1) {
    if (!taken.has(index)) free.push(index);
  }
  const places = [...unnamed, ...free, ...[...leaving.keys()].sort((a, b) => a - b)];

  const present: SubAgentSlot[] = [];
  for (const agent of agents) {
    const index = placed.get(agent.id);
    if (index !== undefined) present.push({ index, leaving: false, agent });
  }
  for (const agent of agents) {
    if (placed.has(agent.id) || present.length >= MAX_SUB_AGENT_SLOTS) continue;
    // One reported again before its exit settled comes back to its own place.
    const own = [...leaving.values()].find((slot) => slot.agent?.id === agent.id)?.index;
    const index = own ?? places.shift();
    if (index === undefined) break;
    const at = own === undefined ? -1 : places.indexOf(own);
    if (at >= 0) places.splice(at, 1);
    leaving.delete(index);
    present.push({ index, leaving: false, agent });
  }
  // Places counted ones held that no named sub-agent took play their exit too.
  for (const index of places) {
    if (unnamed.includes(index)) leaving.set(index, { index, leaving: true });
  }

  const slots = [...present, ...leaving.values()].sort((a, b) => a.index - b.index);
  return { count: agents.length, slots, overflow: agents.length - present.length, leaving: false };
}

/** Labels fit beside the orbs: every orb shown is named, and there are only a few. */
export function showsSubAgentLabels(state: SubAgentStripState): boolean {
  const present = state.slots.filter((slot) => !slot.leaving);
  return (
    present.length > 0 &&
    present.length <= MAX_LABELED_SUB_AGENTS &&
    state.overflow === 0 &&
    present.every((slot) => slot.agent !== undefined)
  );
}

/** The hover text for one named sub-agent: what it does, and its type when that adds something. */
export function subAgentTitle(agent: LabeledSubAgent): string {
  return agent.agentType && agent.agentType !== agent.label
    ? `${agent.label} (${agent.agentType})`
    : agent.label;
}

/** The strip once the exits have played: the places that were leaving are gone. */
export function settleSubAgentStrip(state: SubAgentStripState): SubAgentStripState {
  if (state.leaving) return EMPTY_SUB_AGENT_STRIP;
  if (!state.slots.some((slot) => slot.leaving)) return state;
  return { ...state, slots: state.slots.filter((slot) => !slot.leaving) };
}

/** Something in the strip is on its way out, so a settle is due. */
export function hasLeavingSubAgents(state: SubAgentStripState): boolean {
  return state.leaving || state.slots.some((slot) => slot.leaving);
}

export interface SubAgentSlotMotion {
  /** Which of `toneCount` colours the place wears; neighbours never share one. */
  readonly tone: number;
  /** One turn of its satellite, in milliseconds. */
  readonly orbitMs: number;
  /** Where on the orbit the satellite starts, in degrees. */
  readonly startDeg: number;
  /** The satellite turns counter-clockwise. */
  readonly reverse: boolean;
  /** How long after its neighbours the place comes in, so a group arrives as a ripple. */
  readonly enterDelayMs: number;
}

/**
 * How a place moves and looks. It depends on the index alone, so a place keeps its colour and
 * pace for as long as it is taken, and no two neighbours turn in step.
 */
export function subAgentSlotMotion(index: number, toneCount: number): SubAgentSlotMotion {
  return {
    tone: toneCount > 0 ? index % toneCount : 0,
    // 3.2s to 5.3s a turn: slow enough to sit in the corner of the eye.
    orbitMs: 3200 + ((index * 7) % 4) * 700,
    // The golden angle spreads the starting points without a visible pattern.
    startDeg: Math.round((index * 137.5) % 360),
    reverse: index % 2 === 1,
    enterDelayMs: index * 45,
  };
}
