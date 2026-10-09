import { createContext, useContext } from 'react';
import { getCanvasStore } from '../contributions/browser/app-stores';

/** Index of the multi-canvas view a board node renders in (0 on the single canvas). */
export const CanvasPaneContext = createContext(0);

export function useCanvasPane(): number {
  return useContext(CanvasPaneContext);
}

/**
 * Whether this view is the one a window is live in. Call from an observer: a window showing in
 * several views mounts its terminal, chat, or page in one and a placeholder in the others.
 */
export function useIsLivePane(tileId: string): boolean {
  const pane = useCanvasPane();
  return getCanvasStore().livePaneOf(tileId) === pane;
}
