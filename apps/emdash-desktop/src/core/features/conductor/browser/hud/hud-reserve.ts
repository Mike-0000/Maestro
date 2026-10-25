import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * CSS custom property on the document root: how much of the window's bottom edge the resting
 * (collapsed) HUD bar covers. The workspace layout pads its main content area by it, so
 * terminals fit fewer rows instead of losing their bottom lines under the bar. Unset while the
 * HUD is not mounted, so consumers must fall back to `0px`.
 */
export const HUD_RESERVE_PROPERTY = '--conductor-hud-reserve';

/** The collapsed bar's `p-1.5`, top plus bottom, in rem. */
const COLLAPSED_PADDING_REM = 0.375 * 2;
/** The bar's 1px `border`, top plus bottom. */
const BAR_BORDER_PX = 2;
/** Breathing room between the content's bottom edge and the bar's top edge, in rem. */
const GAP_REM = 0.5;

export interface HudReserveInput {
  /** Height of the bar's control row, in CSS px. */
  rowHeight: number;
  /** The HUD root's distance from the window's bottom edge (`bottom-4`), in CSS px. */
  bottomOffset: number;
  /** The root font size, in CSS px. */
  remPx: number;
}

/** Height to reserve for the collapsed bar, in whole CSS px (0 when the row is not laid out). */
export function hudReservePx({ rowHeight, bottomOffset, remPx }: HudReserveInput): number {
  if (!(rowHeight > 0)) return 0;
  const chrome = BAR_BORDER_PX + (COLLAPSED_PADDING_REM + GAP_REM) * remPx;
  return Math.ceil(rowHeight + chrome + Math.max(0, bottomOffset));
}

/**
 * Publishes the collapsed bar's footprint as {@link HUD_RESERVE_PROPERTY}. It measures only the
 * control row (never the panels stacked above it) and only while the HUD is collapsed, so
 * listening, replies, confirmations, and plans overlay content briefly without resizing every
 * terminal. The value is held while expanded and re-measured on collapse.
 */
export function useHudLayoutReserve(
  rootRef: RefObject<HTMLElement | null>,
  rowRef: RefObject<HTMLElement | null>,
  expanded: boolean
): void {
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const row = rowRef.current;
    if (!root || !row) return;
    const rootStyle = document.documentElement.style;
    let reserved: number | null = null;
    const measure = () => {
      // The first measurement always lands, even if the HUD mounts expanded; after that the
      // reserve only follows the resting bar.
      if (reserved !== null && expandedRef.current) return;
      const next = hudReservePx({
        rowHeight: row.offsetHeight,
        bottomOffset: parseFloat(getComputedStyle(root).bottom) || 0,
        remPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
      });
      if (next === reserved) return;
      reserved = next;
      rootStyle.setProperty(HUD_RESERVE_PROPERTY, `${next}px`);
    };
    measureRef.current = measure;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    return () => {
      observer?.disconnect();
      measureRef.current = null;
      rootStyle.removeProperty(HUD_RESERVE_PROPERTY);
    };
  }, [rootRef, rowRef]);

  // Collapsing again picks up any resting-size change the observer skipped while expanded.
  useLayoutEffect(() => {
    if (!expanded) measureRef.current?.();
  }, [expanded]);
}
