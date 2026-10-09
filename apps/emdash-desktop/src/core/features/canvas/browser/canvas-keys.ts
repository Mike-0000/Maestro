import type { CanvasStore } from '@core/features/canvas/api/browser/stores/canvas-store';
import type { Direction, LayoutOp } from '../api/canvas-layout';
import { isRegionId } from '../api/canvas-regions';

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Keys typed into a field, a terminal, or a page belong there, not to the canvas. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, webview, [role="dialog"], [role="menu"]'
    ) !== null
  );
}

/** What keyboard layout commands act on: the selection, else the focused window. */
function keyboardTargets(store: CanvasStore): string[] {
  if (store.selection.length > 0) return [...store.selection];
  return store.focusedTileId ? [store.focusedTileId] : [];
}

/**
 * Canvas keyboard shortcuts. Returns true when the key was handled.
 *
 * - Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: undo and redo layout changes.
 * - Ctrl+G: group the selection into a new region; Ctrl+Shift+G: ungroup a selected region.
 * - Alt+Arrow: nudge; Alt+Shift+Arrow: narrower/wider, shorter/taller.
 * - Ctrl+Enter: open the selection (or the region you are in) on the stage; Esc leaves it.
 * - Esc on the board: out of the sub-canvas you are in, one level at a time.
 * - Ctrl+Alt+Left/Right/Up: back, forward, and up a level; Ctrl+Alt+Home: the main canvas.
 * - Ctrl+Alt+PageDown/PageUp: the next or previous sub-canvas.
 * - Ctrl+Alt+1 to 4: that many views of the canvas side by side (1: the single canvas).
 */
export function handleCanvasKey(store: CanvasStore, event: KeyboardEvent): boolean {
  if (event.defaultPrevented || isTypingTarget(event.target)) return false;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;

  if (key === 'Escape' && !mod && !event.altKey) {
    if (store.ghost) {
      store.clearGhost();
      return true;
    }
    if (store.renamingRegionId) {
      store.setRenamingRegion(null);
      return true;
    }
    if (store.leaveStage()) return true;
    return store.focusedRegionId !== null && store.up();
  }

  if (mod && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === 'z') {
      if (event.shiftKey) store.redo();
      else store.undo();
      return true;
    }
    if (lower === 'y') {
      store.redo();
      return true;
    }
    if (lower === 'g' && !store.stageActive) {
      if (event.shiftKey) {
        const regions = store.selection.filter(isRegionId);
        if (regions.length === 0) return false;
        store.runLayout(
          regions.map((region): LayoutOp => ({ op: 'dissolveRegion', region })),
          { source: 'keyboard' }
        );
        return true;
      }
      return store.groupSelection() !== null;
    }
    if (key === 'Enter') {
      return store.stageSelection();
    }
  }

  if (mod && event.altKey) {
    if (key === 'ArrowLeft') return store.back();
    if (key === 'ArrowRight') return store.forward();
    if (key === 'ArrowUp') return store.up();
    if (key === 'Home') {
      store.home();
      return true;
    }
    if (key === 'PageDown') return store.goToAdjacentRegion(1) !== null;
    if (key === 'PageUp') return store.goToAdjacentRegion(-1) !== null;
    // By key position: Alt changes what the digit keys type on some layouts.
    const views = /^Digit([1-4])$/.exec(event.code)?.[1];
    if (views && !event.shiftKey) {
      store.setPaneCount(Number(views));
      return true;
    }
  }

  const direction = ARROWS[key];
  if (direction && event.altKey && !mod && !store.stageActive) {
    const targets = keyboardTargets(store);
    if (targets.length === 0) return false;
    if (event.shiftKey) {
      const horizontal = direction === 'left' || direction === 'right';
      const grow = direction === 'right' || direction === 'down';
      store.runLayout(
        [
          {
            op: 'resize',
            targets: targets.filter((id) => !isRegionId(id)),
            size: {
              kind: 'relative',
              axis: horizontal ? 'width' : 'height',
              factor: 'bit',
              direction: grow ? 'grow' : 'shrink',
            },
          },
        ],
        { source: 'keyboard' }
      );
    } else {
      store.runLayout([{ op: 'move', targets, to: { kind: 'nudge', direction, amount: 'bit' } }], {
        source: 'keyboard',
      });
    }
    return true;
  }
  return false;
}
