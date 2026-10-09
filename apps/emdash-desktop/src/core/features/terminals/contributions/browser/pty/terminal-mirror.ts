import { Terminal } from '@xterm/xterm';
import {
  TERMINAL_PADDING_PX,
  type FrontendPty,
} from '@core/features/terminals/api/browser/pty/pty';
import { log } from '@core/primitives/logging/browser/logger';

/** Scrollback a mirror keeps; the real terminal holds the full history. */
const MIRROR_SCROLLBACK_LINES = 2_000;

/**
 * Opens a read-only copy of a session's terminal in `target`: a second xterm fed by its own
 * stream of the session's output, kept at the real terminal's grid size and scroll position.
 * The real xterm can be mounted in one place only; mirrors show the same session elsewhere at the
 * same time. Returns a disposer.
 */
export function mountTerminalMirror(pty: FrontendPty, target: HTMLElement): () => void {
  const source = pty.terminal;
  const mirror = new Terminal({
    cols: source.cols,
    rows: source.rows,
    scrollback: MIRROR_SCROLLBACK_LINES,
    fontFamily: source.options.fontFamily,
    fontSize: source.options.fontSize,
    lineHeight: source.options.lineHeight,
    letterSpacing: source.options.letterSpacing,
    theme: source.options.theme,
    allowProposedApi: true,
    // Never answers the queries it replays, and never takes input.
    disableStdin: true,
    cursorBlink: false,
  });
  mirror.open(target);
  const element = mirror.element;
  if (element) {
    // Same box as the real terminal, so both show the same cells at the same place.
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.boxSizing = 'border-box';
    element.style.padding = `${TERMINAL_PADDING_PX}px`;
    element.style.backgroundColor = source.element?.style.backgroundColor ?? 'var(--xterm-bg)';
  }

  // Follow how far the real terminal is scrolled back, measured from the bottom.
  const syncScroll = () => {
    const back = source.buffer.active.baseY - source.buffer.active.viewportY;
    mirror.scrollToLine(Math.max(0, mirror.buffer.active.baseY - back));
  };
  const subscriptions = [
    source.onResize(({ cols, rows }) => mirror.resize(cols, rows)),
    source.onScroll(syncScroll),
  ];

  let disposed = false;
  let disconnect: (() => void) | null = null;
  void pty
    .connectMirror(mirror)
    .then((off) => {
      if (disposed) off();
      else disconnect = off;
    })
    .catch((error: unknown) => log.warn('terminal mirror: could not follow output', { error }));

  return () => {
    disposed = true;
    disconnect?.();
    disconnect = null;
    for (const subscription of subscriptions) subscription.dispose();
    try {
      mirror.dispose();
    } catch {
      // Already torn down with its container.
    }
  };
}
