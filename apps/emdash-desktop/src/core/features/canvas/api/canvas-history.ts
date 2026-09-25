/**
 * Layout undo and redo. An entry stores only the fields a transaction touched (per tile, region,
 * membership, and visibility), so undo is conflict-aware: a field is restored only while it still
 * holds the value the transaction wrote. Anything the user changed since is left alone.
 */

import type { TileRect } from './canvas-model';
import type { LayoutState, RegionState } from './canvas-regions';

export type LayoutPatch = {
  readonly tiles: Readonly<Record<string, TileRect | null>>;
  readonly regions: Readonly<Record<string, RegionState | null>>;
  readonly membership: Readonly<Record<string, string | null>>;
  readonly hidden: Readonly<Record<string, boolean>>;
};

export type LayoutSource = 'voice' | 'typed' | 'pointer' | 'keyboard' | 'command';

export type LayoutHistoryEntry = {
  readonly id: number;
  /** "Moved Atlas into Review", shown for undo and spoken when asked. */
  readonly label: string;
  readonly source: LayoutSource;
  readonly before: LayoutPatch;
  readonly after: LayoutPatch;
  readonly at: number;
  /** Ids to flash and bring into view after undo/redo. */
  readonly targets: readonly string[];
};

export const MAX_HISTORY = 100;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

/** The touched fields of `from → to`, or null when nothing changed. */
export function diffLayout(
  from: LayoutState,
  to: LayoutState
): { before: LayoutPatch; after: LayoutPatch } | null {
  const before = { tiles: {}, regions: {}, membership: {}, hidden: {} } as {
    tiles: Record<string, TileRect | null>;
    regions: Record<string, RegionState | null>;
    membership: Record<string, string | null>;
    hidden: Record<string, boolean>;
  };
  const after = { tiles: {}, regions: {}, membership: {}, hidden: {} } as typeof before;
  let changed = false;
  for (const id of new Set([...Object.keys(from.tiles), ...Object.keys(to.tiles)])) {
    const a = from.tiles[id] ?? null;
    const b = to.tiles[id] ?? null;
    if (!same(a, b)) {
      before.tiles[id] = a;
      after.tiles[id] = b;
      changed = true;
    }
  }
  for (const id of new Set([...Object.keys(from.regions), ...Object.keys(to.regions)])) {
    const a = from.regions[id] ?? null;
    const b = to.regions[id] ?? null;
    if (!same(a, b)) {
      before.regions[id] = a;
      after.regions[id] = b;
      changed = true;
    }
  }
  for (const id of new Set([...Object.keys(from.membership), ...Object.keys(to.membership)])) {
    const a = from.membership[id] ?? null;
    const b = to.membership[id] ?? null;
    if (a !== b) {
      before.membership[id] = a;
      after.membership[id] = b;
      changed = true;
    }
  }
  const hiddenFrom = new Set(from.hidden);
  const hiddenTo = new Set(to.hidden);
  for (const id of new Set([...hiddenFrom, ...hiddenTo])) {
    if (hiddenFrom.has(id) !== hiddenTo.has(id)) {
      before.hidden[id] = hiddenFrom.has(id);
      after.hidden[id] = hiddenTo.has(id);
      changed = true;
    }
  }
  return changed ? { before, after } : null;
}

/**
 * Applies `target` for every field whose current value still equals `expected`. Returns the new
 * state and how many touched fields had been changed since (and were left alone).
 */
function applyGuarded(
  state: LayoutState,
  expected: LayoutPatch,
  target: LayoutPatch
): { state: LayoutState; conflicts: number; applied: number } {
  let conflicts = 0;
  let applied = 0;
  const tiles = { ...state.tiles };
  for (const [id, value] of Object.entries(target.tiles)) {
    if (!same(state.tiles[id] ?? null, expected.tiles[id] ?? null)) {
      conflicts++;
      continue;
    }
    applied++;
    if (value) tiles[id] = value;
    else delete tiles[id];
  }
  const regions = { ...state.regions };
  for (const [id, value] of Object.entries(target.regions)) {
    if (!same(state.regions[id] ?? null, expected.regions[id] ?? null)) {
      conflicts++;
      continue;
    }
    applied++;
    if (value) regions[id] = value;
    else delete regions[id];
  }
  const membership = { ...state.membership };
  for (const [id, value] of Object.entries(target.membership)) {
    if ((state.membership[id] ?? null) !== (expected.membership[id] ?? null)) {
      conflicts++;
      continue;
    }
    applied++;
    if (value) membership[id] = value;
    else delete membership[id];
  }
  const hidden = new Set(state.hidden);
  for (const [id, value] of Object.entries(target.hidden)) {
    if (hidden.has(id) !== (expected.hidden[id] ?? false)) {
      conflicts++;
      continue;
    }
    applied++;
    if (value) hidden.add(id);
    else hidden.delete(id);
  }
  return {
    state: { tiles, regions, membership, hidden: [...hidden] },
    conflicts,
    applied,
  };
}

export function undoEntry(
  state: LayoutState,
  entry: LayoutHistoryEntry
): { state: LayoutState; conflicts: number; applied: number } {
  return applyGuarded(state, entry.after, entry.before);
}

export function redoEntry(
  state: LayoutState,
  entry: LayoutHistoryEntry
): { state: LayoutState; conflicts: number; applied: number } {
  return applyGuarded(state, entry.before, entry.after);
}

/** Pushes an entry, dropping the oldest past the cap. */
export function pushHistory(
  stack: readonly LayoutHistoryEntry[],
  entry: LayoutHistoryEntry
): LayoutHistoryEntry[] {
  const next = [...stack, entry];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}
