/**
 * One palette row, shared by every provider's renderer: a compact menu row (32px at one line,
 * taller with a subtitle) that is muted at rest and comes to full strength, one surface step up,
 * when selected by keyboard or pointer.
 */
export const PALETTE_ITEM_CLASS =
  'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground-muted transition-colors aria-selected:bg-surface-hover aria-selected:text-foreground data-[disabled=true]:cursor-not-allowed';
