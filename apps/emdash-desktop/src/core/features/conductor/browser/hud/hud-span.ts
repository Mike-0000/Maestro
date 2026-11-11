import { useLayoutEffect, useState } from 'react';

/**
 * The element the HUD centres on: the workspace's main panel (the content beside the sidebar).
 * `react-resizable-panels` renders a panel's `id` on its element; the workspace layout names the
 * main one `workspace-main`.
 */
export const HUD_SPAN_ELEMENT_ID = 'workspace-main';

/** Where the HUD may stand, as insets from the window's left and right edges, in CSS px. */
export interface HudSpan {
  readonly left: number;
  readonly right: number;
}

/** The whole window: what the HUD uses when there is no content panel to follow. */
export const FULL_WINDOW_SPAN: HudSpan = { left: 0, right: 0 };

/**
 * The insets that put the HUD over `rect` (the content panel's box) in a window `viewportWidth`
 * wide, in whole CSS px. A panel that is not laid out, or one wider than the window, gives the
 * whole window, so the bar is never squeezed to nothing or pushed off screen.
 */
export function hudSpanFor(
  rect: { readonly left: number; readonly right: number; readonly width: number },
  viewportWidth: number
): HudSpan {
  if (!(rect.width > 0) || !(viewportWidth > 0)) return FULL_WINDOW_SPAN;
  const left = Math.max(0, Math.round(rect.left));
  const right = Math.max(0, Math.round(viewportWidth - rect.right));
  if (left + right >= viewportWidth) return FULL_WINDOW_SPAN;
  return { left, right };
}

/**
 * Follows the workspace's content panel, so the HUD sits centred over the content and never over
 * the sidebar. It re-measures when the panel resizes (the sidebar is dragged, opened or closed)
 * and when the window does, and falls back to the whole window while the panel is missing.
 */
export function useHudSpan(): HudSpan {
  const [span, setSpan] = useState<HudSpan>(FULL_WINDOW_SPAN);
  useLayoutEffect(() => {
    let observed: HTMLElement | null = null;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    function measure(): void {
      const panel = document.getElementById(HUD_SPAN_ELEMENT_ID);
      // The panel can be replaced when the layout re-mounts: follow the new one.
      if (panel !== observed) {
        if (observed) observer?.unobserve(observed);
        if (panel) observer?.observe(panel);
        observed = panel;
      }
      const next = panel
        ? hudSpanFor(panel.getBoundingClientRect(), window.innerWidth)
        : FULL_WINDOW_SPAN;
      setSpan((current) =>
        current.left === next.left && current.right === next.right ? current : next
      );
    }
    measure();
    // The panel may mount after the HUD on the first frame.
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);
  return span;
}
