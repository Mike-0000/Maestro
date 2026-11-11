import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * One piece of the HUD as it stands on screen: the bar (with whatever is open inside it) or a
 * card raised above it. `rise` is how far up from the window's bottom edge its top reaches, so
 * it holds while the window grows or shrinks vertically.
 */
export interface HudBox {
  readonly left: number;
  readonly right: number;
  readonly rise: number;
}

/** A view that wants its bottom edge kept clear, in the same terms. */
export interface HudClearanceTarget {
  readonly left: number;
  readonly right: number;
  /** Distance from the view's bottom edge down to the window's bottom edge. */
  readonly bottomGap: number;
}

/** Breathing room between the view's content and the HUD piece above which it stops, in rem. */
const GAP_REM = 0.5;

/**
 * How much of the view's bottom the HUD covers right now, plus the gap, in whole CSS px. Pieces
 * that do not reach the view (beside it, or wholly below it) count for nothing, so a view that
 * ends above the HUD, or a resting bar the layout already reserved for, gives 0.
 */
export function hudClearancePx(
  target: HudClearanceTarget,
  boxes: readonly HudBox[],
  gapPx: number
): number {
  if (!(target.right > target.left)) return 0;
  let covered = 0;
  for (const box of boxes) {
    if (box.right <= target.left || box.left >= target.right) continue;
    covered = Math.max(covered, box.rise - target.bottomGap);
  }
  // Under a pixel is rounding between the layout's reserve and the bar it was measured from.
  return covered < 1 ? 0 : Math.ceil(covered + gapPx);
}

let published: readonly HudBox[] = [];
const listeners = new Set<() => void>();

function sameBoxes(a: readonly HudBox[], b: readonly HudBox[]): boolean {
  return (
    a.length === b.length &&
    a.every((box, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        box.left === other.left &&
        box.right === other.right &&
        box.rise === other.rise
      );
    })
  );
}

function publish(next: readonly HudBox[]): void {
  if (sameBoxes(published, next)) return;
  published = next;
  for (const listener of listeners) listener();
}

/**
 * The HUD's side: publishes where its pieces stand (each child of the root that is laid out), so
 * a view can keep its own controls clear of them. Unlike the layout reserve this follows
 * everything raised from the bar, and it resizes nothing by itself: only views that ask do.
 */
export function useHudFootprint(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const boxes: HudBox[] = [];
      for (const child of root.children) {
        const rect = child.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) {
          boxes.push({ left: rect.left, right: rect.right, rise: window.innerHeight - rect.top });
        }
      }
      publish(boxes);
    };
    measure();
    // The root is as tall as its pieces stacked and as wide as the window, so its size changes
    // whenever a piece comes, goes or grows, and whenever the pieces move sideways.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      observer?.disconnect();
      publish([]);
    };
  }, [rootRef]);
}

/**
 * A view's side: the bottom padding (CSS px) that keeps what is in `target` clear of the HUD and
 * of any card raised from it. 0 while nothing reaches the view. `target`'s own box must not
 * depend on the padding (pad inside it), or the measurement would chase itself.
 */
export function useHudClearance(target: HTMLElement | null): number {
  const [clearance, setClearance] = useState(0);
  useLayoutEffect(() => {
    if (!target) return;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setClearance(
        hudClearancePx(
          { left: rect.left, right: rect.right, bottomGap: window.innerHeight - rect.bottom },
          published,
          GAP_REM * remPx
        )
      );
    };
    measure();
    listeners.add(measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      listeners.delete(measure);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      setClearance(0);
    };
  }, [target]);
  return clearance;
}
