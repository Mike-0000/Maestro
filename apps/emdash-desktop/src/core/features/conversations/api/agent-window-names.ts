/**
 * Fixed, ordered roster of default agent window names. The Nth window in a task always gets the
 * Nth name, independent of provider. Names are one or two syllables with distinct leading sounds
 * so they are easy to tell apart when spoken. Order is part of the contract: do not reorder.
 */
export const AGENT_WINDOW_NAMES = [
  'Atlas',
  'Bravo',
  'Cedar',
  'Delta',
  'Echo',
  'Falcon',
  'Ginger',
  'Harbor',
  'Iris',
  'Jasper',
  'Kilo',
  'Lima',
  'Maple',
  'Nova',
  'Oscar',
  'Pilot',
  'Quartz',
  'Robin',
  'Sparrow',
  'Tango',
  'Umber',
  'Vesper',
  'Willow',
  'Xenon',
  'Yankee',
  'Zulu',
] as const;

const NAME_INDEX = new Map<string, number>(
  AGENT_WINDOW_NAMES.map((name, index) => [name.toLowerCase(), index])
);

/** Zero-based slot → name. Slots past the roster cycle with a numeric suffix: "Atlas 2". */
export function agentWindowName(slot: number): string {
  const base = AGENT_WINDOW_NAMES[slot % AGENT_WINDOW_NAMES.length];
  const cycle = Math.floor(slot / AGENT_WINDOW_NAMES.length);
  return cycle === 0 ? base : `${base} ${cycle + 1}`;
}

/** Inverse of `agentWindowName`; returns null for titles that are not a default window name. */
export function parseAgentWindowNameSlot(title: string): number | null {
  const match = title.trim().match(/^([a-z]+)(?: ([2-9]|[1-9]\d+))?$/i);
  if (!match) return null;
  const base = NAME_INDEX.get(match[1].toLowerCase());
  if (base === undefined) return null;
  const cycle = match[2] ? Number(match[2]) - 1 : 0;
  return cycle * AGENT_WINDOW_NAMES.length + base;
}
