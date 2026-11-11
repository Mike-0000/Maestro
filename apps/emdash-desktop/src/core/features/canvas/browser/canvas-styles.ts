import type { NoteTileEntry } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { RegionColor } from '../api/canvas-regions';

/**
 * The canvas's shared looks: one family of windows on a sunken board, and the small set of tints
 * a user can give a region or a note.
 *
 * Region and note colours are the user's data (they group by them, and the conductor recolours by
 * name), so every name keeps a recognisable hue. Each hue is a theme ramp step (`--em-<hue>-9`, so
 * it follows dark and light), and everything drawn with it is a low-strength mix of that one value:
 * a faint wash, a hairline edge, a small swatch. No coloured text and no coloured chips.
 */

/** A window on the board: the paper surface, one subtle hairline, the card radius. */
export const WINDOW_FRAME =
  'surface-paper flex h-full w-full flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface';

/** A window's title bar: one step up from the content under it, no rule between them. */
export const WINDOW_HEADER = 'surface-base-emphasis flex shrink-0 items-center gap-2 bg-surface';

/** A floating layer over the board (toolbar, banners, chips): the HUD's elevated layer. */
export const FLOATING_LAYER =
  'surface-elevated border border-border-subtle bg-surface text-foreground shadow-(--em-shadow-md)';

/**
 * Title-bar actions: the kit's quiet icon buttons (passive glyphs, full strength on hover). They
 * stay visible: hovering a window is how it is read and used, so hiding them until hover would
 * either leave a gap at rest or cover the window's state while the pointer is over it.
 */
export const WINDOW_ACTIONS = 'flex shrink-0 items-center gap-0.5';

/**
 * A window's name over its content while the conductor listens, so it can be said. Sized for the
 * board seen from far out, where 48px reads as a label (canvas-space type, outside the UI scale).
 */
export const SPOKEN_NAME_BADGE =
  'surface-elevated rounded-xl border border-border-subtle bg-surface px-6 py-2 text-5xl font-semibold tracking-tight text-foreground';

/**
 * Resize handles on a selected window: small squares in the accent (React Flow reads the colour
 * from `--xy-resize-background-color`, set on the board) with a ring of the board around them.
 * `!` because React Flow's own stylesheet is unlayered and would win over utilities.
 */
export const RESIZE_HANDLE_CLASS = '!size-2 !rounded-xs !border-background';

/**
 * The state mark at the glyph zoom band, where a window is a fraction of its size on screen: the
 * kit's marks drawn several times larger so they still read.
 */
export const LARGE_STATE_GLYPH = 'size-8 [&>span]:size-5 [&>span]:border-[3px]';

/** Sets `--tint` to a region colour's hue; the classes below draw with it. */
export const REGION_TINT: Record<RegionColor, string> = {
  blue: '[--tint:var(--em-blue-9)]',
  violet: '[--tint:var(--em-purple-9)]',
  green: '[--tint:var(--em-green-9)]',
  amber: '[--tint:var(--em-amber-9)]',
  rose: '[--tint:var(--em-red-9)]',
  teal: '[--tint:var(--em-accent-9)]',
  gray: '[--tint:var(--em-neutral-9)]',
};

/** The hue itself, for places that take a CSS value rather than a class (the minimap). */
const REGION_HUE: Record<RegionColor, string> = {
  blue: 'var(--em-blue-9)',
  violet: 'var(--em-purple-9)',
  green: 'var(--em-green-9)',
  amber: 'var(--em-amber-9)',
  rose: 'var(--em-red-9)',
  teal: 'var(--em-accent-9)',
  gray: 'var(--em-neutral-9)',
};

export function regionTint(color: RegionColor | undefined): string {
  return REGION_TINT[color ?? 'gray'];
}

/** A region's footprint on the minimap: its hue, faint. */
export function regionMinimapFill(color: RegionColor | undefined): string {
  return `color-mix(in oklab, ${REGION_HUE[color ?? 'gray']} 30%, transparent)`;
}

/** The region's body: a faint wash of its hue over the board. */
export const TINT_WASH = 'bg-[color-mix(in_oklab,var(--tint)_5%,transparent)]';
/** The region's edge: its hue mixed into the hairline. */
export const TINT_EDGE = 'border-[color-mix(in_oklab,var(--tint)_40%,var(--border))]';
/** A small swatch of the hue before a region's or desk's name. */
export const TINT_SWATCH = 'size-2 shrink-0 rounded-full bg-(--tint)';

/** A note's paper: its colour mixed into the card surface, so text keeps full contrast. */
export const NOTE_SURFACE: Record<NoteTileEntry['color'], string> = {
  yellow: 'bg-[color-mix(in_oklab,var(--em-amber-9)_16%,var(--em-surface-emphasis))]',
  blue: 'bg-[color-mix(in_oklab,var(--em-blue-9)_14%,var(--em-surface-emphasis))]',
  green: 'bg-[color-mix(in_oklab,var(--em-green-9)_14%,var(--em-surface-emphasis))]',
  pink: 'bg-[color-mix(in_oklab,var(--em-red-9)_12%,var(--em-surface-emphasis))]',
  gray: 'bg-surface-emphasis',
};

/** The same colours as solid swatches, for the note's colour picker. */
export const NOTE_SWATCH: Record<NoteTileEntry['color'], string> = {
  yellow: 'bg-(--em-amber-9)',
  blue: 'bg-(--em-blue-9)',
  green: 'bg-(--em-green-9)',
  pink: 'bg-(--em-red-9)',
  gray: 'bg-(--em-neutral-9)',
};
