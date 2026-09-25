/**
 * Portable canvas model: tile geometry, placement, level of detail, and spoken names.
 *
 * Everything here is pure so the placement and detail rules can be tested without React Flow.
 */

export type TileRect = { x: number; y: number; w: number; h: number };

export type CanvasViewport = { x: number; y: number; zoom: number };

/** Default agent tile size in canvas units (1 unit = 1 CSS px at zoom 1). */
export const AGENT_TILE_SIZE = { w: 720, h: 460 } as const;
export const NOTE_TILE_SIZE = { w: 320, h: 200 } as const;
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

/** Below this zoom a tile renders only its header glyph. */
export const GLYPH_ZOOM_THRESHOLD = 0.35;

/** Default cap on simultaneously mounted xterm instances on the canvas. */
export const DEFAULT_LIVE_TILE_BUDGET = 6;

export type TileDetail = 'live' | 'preview' | 'glyph';

export type TileDetailInput = {
  zoom: number;
  /** Whether the tile intersects the viewport. */
  visible: boolean;
  /** 0-based rank among visible tiles by recency of focus (0 = most recent). */
  focusRank: number;
  liveBudget: number;
  /** Whether a terminal session exists to render live. */
  hasSession: boolean;
};

export function resolveTileDetail(input: TileDetailInput): TileDetail {
  if (input.zoom < GLYPH_ZOOM_THRESHOLD) return 'glyph';
  if (!input.visible || !input.hasSession) return 'preview';
  return input.focusRank < input.liveBudget ? 'live' : 'preview';
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
 * Assigns a short, speakable, unique name such as "Claude 2" for a new agent of `providerLabel`,
 * reusing the lowest free number.
 */
export function assignSpokenName(providerLabel: string, taken: Iterable<string>): string {
  const base = providerLabel.trim() || 'Agent';
  const used = new Set<number>();
  const prefix = `${base.toLowerCase()} `;
  for (const name of taken) {
    const lower = name.toLowerCase();
    if (!lower.startsWith(prefix)) continue;
    const n = Number(lower.slice(prefix.length));
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${base} ${n}`;
}
