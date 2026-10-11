/**
 * Portable canvas model: tile geometry, placement, level of detail, and spoken names.
 *
 * Everything here is pure so the placement and detail rules can be tested without React Flow.
 */

import {
  AGENT_WINDOW_NAMES,
  agentWindowName,
  parseAgentWindowNameSlot,
} from '@core/features/conversations/api/agent-window-names';

export type TileRect = { x: number; y: number; w: number; h: number };

export type CanvasViewport = { x: number; y: number; zoom: number };

/** Default agent tile size in canvas units (1 unit = 1 CSS px at zoom 1). */
export const AGENT_TILE_SIZE = { w: 720, h: 460 } as const;
export const NOTE_TILE_SIZE = { w: 320, h: 200 } as const;
/** Document windows (a rendered Markdown file): a readable column, as tall as an agent and a half. */
export const DOC_TILE_SIZE = { w: 640, h: 720 } as const;
/** App browser tiles: a laptop-ish viewport so screenshots read like the real app. */
export const BROWSER_TILE_SIZE = { w: 960, h: 640 } as const;
/** Height of a browser tile's header strip (the rest is the page). */
export const BROWSER_TILE_HEADER = 32;
export const TILE_GAP = 48;
export const MIN_TILE_SIZE = { w: 360, h: 220 } as const;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 1.5;

/**
 * xterm.js computes pointer positions from unscaled cell metrics, so a terminal under a CSS
 * `scale()` mis-targets clicks and selections. Terminals only accept pointer input when the
 * canvas zoom is (effectively) 1.
 */
const INTERACTIVE_ZOOM_TOLERANCE = 0.02;

export function isInteractiveZoom(zoom: number): boolean {
  return Math.abs(zoom - 1) <= INTERACTIVE_ZOOM_TOLERANCE;
}

/** Below this zoom a tile's header switches to its large, readable-from-afar form. */
export const GLYPH_ZOOM_THRESHOLD = 0.35;

export type ZoomBand = 'glyph' | 'scaled' | 'interactive';

export function zoomBand(zoom: number): ZoomBand {
  if (zoom < GLYPH_ZOOM_THRESHOLD) return 'glyph';
  return isInteractiveZoom(zoom) ? 'interactive' : 'scaled';
}

// ── App browsers ─────────────────────────────────────────────────────────────

/**
 * How an app browser tile shows its page. `live`: the real webview sits over the tile and takes
 * input. `snapshot`: the tile shows the last capture (zoomed out, partly off-screen, or the
 * browser is suspended). `glyph`: far zoom, header only.
 *
 * A webview cannot be scaled or clipped by the canvas without breaking input, so it is live only
 * at interactive zoom and fully inside the canvas viewport.
 */
export type BrowserTileMode = 'live' | 'snapshot' | 'glyph';

export function resolveBrowserTileMode(input: {
  zoom: number;
  /** The tile's page area lies entirely inside the canvas viewport. */
  fullyVisible: boolean;
  /** The webview is alive (within the live-browser budget, or leased by a model). */
  alive: boolean;
}): BrowserTileMode {
  if (input.zoom < GLYPH_ZOOM_THRESHOLD) return 'glyph';
  if (!input.alive || !input.fullyVisible || !isInteractiveZoom(input.zoom)) return 'snapshot';
  return 'live';
}

/** True when `inner` lies entirely inside `outer`. */
export function rectContains(outer: TileRect, inner: TileRect, tolerance = 1): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.w <= outer.x + outer.w + tolerance &&
    inner.y + inner.h <= outer.y + outer.h + tolerance
  );
}

/**
 * Which browsers stay alive: every leased or pinned one (a model is driving it, or it is in the
 * sub-canvas the user is in), then the most recently used up to `budget`. Returns the ids to
 * suspend.
 */
export function browsersToSuspend(input: {
  alive: readonly string[];
  lastUsed: ReadonlyMap<string, number>;
  leased: ReadonlySet<string>;
  pinned?: ReadonlySet<string>;
  budget: number;
}): string[] {
  const idle = input.alive
    .filter((id) => !input.leased.has(id) && !input.pinned?.has(id))
    .sort((a, b) => (input.lastUsed.get(b) ?? 0) - (input.lastUsed.get(a) ?? 0));
  const room = Math.max(0, input.budget - (input.alive.length - idle.length));
  return idle.slice(room);
}

export function rectsOverlap(a: TileRect, b: TileRect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
  );
}

export function viewportRect(
  viewport: CanvasViewport,
  screen: { width: number; height: number }
): TileRect {
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    w: screen.width / viewport.zoom,
    h: screen.height / viewport.zoom,
  };
}

/**
 * Places `count` new tiles of `size` in a left-to-right grid starting at `anchor`, skipping any
 * slot that would overlap an existing tile. Columns wrap after `columns` tiles.
 */
export function placeTiles(
  existing: readonly TileRect[],
  count: number,
  size: { w: number; h: number } = AGENT_TILE_SIZE,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
  columns = 3
): TileRect[] {
  const placed: TileRect[] = [];
  const occupied = [...existing];
  let slot = 0;
  // Bounded search: each placement skips at most `existing.length + count` occupied slots.
  const maxSlots = (existing.length + count + 1) * columns * 4;
  while (placed.length < count && slot < maxSlots) {
    const col = slot % columns;
    const row = Math.floor(slot / columns);
    const candidate: TileRect = {
      x: anchor.x + col * (size.w + TILE_GAP),
      y: anchor.y + row * (size.h + TILE_GAP),
      w: size.w,
      h: size.h,
    };
    slot++;
    if (occupied.some((rect) => rectsOverlap(rect, candidate, TILE_GAP / 2))) continue;
    placed.push(candidate);
    occupied.push(candidate);
  }
  return placed;
}

/** Bounding box of a set of rects, or null when empty. */
export function boundsOf(rects: readonly TileRect[]): TileRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Space between a task frame and its tiles; fits inside TILE_GAP with the header. */
export const FRAME_PADDING = 10;
/** Height of a task frame's header strip above its tiles. */
export const FRAME_HEADER = 26;

/** A task frame around the given tile rects (header on top), or null when there are none. */
export function frameRect(rects: readonly TileRect[]): TileRect | null {
  const bounds = boundsOf(rects);
  if (!bounds) return null;
  return {
    x: bounds.x - FRAME_PADDING,
    y: bounds.y - FRAME_PADDING - FRAME_HEADER,
    w: bounds.w + FRAME_PADDING * 2,
    h: bounds.h + FRAME_PADDING * 2 + FRAME_HEADER,
  };
}

/** Anchor for new tiles: to the right of everything already on the board. */
export function nextFreeAnchor(existing: readonly TileRect[]): { x: number; y: number } {
  const bounds = boundsOf(existing);
  if (!bounds) return { x: 0, y: 0 };
  return { x: bounds.x + bounds.w + TILE_GAP * 2, y: bounds.y };
}

// ── Spoken names ──────────────────────────────────────────────────────────────

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/**
 * Assigns a short, speakable name from the fixed agent window roster ("Atlas", "Bravo", ...) that
 * none of `taken` (the names of the agents that exist now) holds. A word no agent uses comes
 * first, so two agents differ only by a number ("Atlas", "Atlas 2") once all 26 words are in
 * use, never before: those are the names speech-to-text mixes up. `preferred` (usually the
 * conversation title) wins when it is such a name, so the canvas and the task view agree.
 */
export function assignSpokenName(preferred: string | undefined, taken: Iterable<string>): string {
  const used = new Set<number>();
  for (const name of taken) {
    const slot = parseAgentWindowNameSlot(name);
    if (slot !== null) used.add(slot);
  }
  const words = AGENT_WINDOW_NAMES.length;
  const usedWords = new Set([...used].map((slot) => slot % words));
  const preferredSlot = preferred ? parseAgentWindowNameSlot(preferred) : null;
  const preferredFree = preferredSlot !== null && !used.has(preferredSlot);
  if (preferredFree && !usedWords.has(preferredSlot % words)) return agentWindowName(preferredSlot);
  for (let word = 0; word < words; word++) {
    if (!usedWords.has(word)) return agentWindowName(word);
  }
  if (preferredFree) return agentWindowName(preferredSlot);
  let slot = 0;
  while (used.has(slot)) slot++;
  return agentWindowName(slot);
}

/**
 * A spoken name reduced to what tells two names apart: letters and digits of any script, in any
 * case or spacing.
 */
export function spokenNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export type SpokenNameHolder = {
  id: string;
  name: string;
  /** When the agent's task was created; null while it is being created. */
  createdAt: string | null;
  /** Already on the roster under this name before now, as opposed to just arriving with it. */
  settled: boolean;
};

/**
 * The agents that must give up a spoken name because another agent holds the same one. An agent
 * already on the roster keeps it over one arriving with it (an agent back from the archive whose
 * name was handed on meanwhile); between two of a kind the newer task keeps it, and one still
 * being created counts as newest.
 */
export function duplicateSpokenNames(holders: readonly SpokenNameHolder[]): string[] {
  const keepers = new Map<string, SpokenNameHolder>();
  const rank = (holder: SpokenNameHolder) => `${holder.settled ? 1 : 0}${holder.createdAt ?? '￿'}`;
  for (const holder of holders) {
    const key = spokenNameKey(holder.name);
    const keeper = keepers.get(key);
    if (!keeper || rank(holder) > rank(keeper)) keepers.set(key, holder);
  }
  return holders
    .filter((holder) => keepers.get(spokenNameKey(holder.name))?.id !== holder.id)
    .map((holder) => holder.id);
}

/**
 * True for names the canvas generated before roster names ("Claude 2" for a Claude agent). These
 * are replaced with roster names; names the user typed are kept.
 */
export function isLegacySpokenName(name: string, providerLabel: string): boolean {
  // "Kilo 2" is both a roster name and Kilo Code's legacy name; the roster reading wins.
  if (parseAgentWindowNameSlot(name) !== null) return false;
  const prefix = `${providerLabel.trim().toLowerCase()} `;
  const lower = name.trim().toLowerCase();
  return lower.startsWith(prefix) && /^[1-9]\d*$/.test(lower.slice(prefix.length));
}
