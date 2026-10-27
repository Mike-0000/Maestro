import type { LogSink } from '@emdash/wire/live';
import type { LiveLogSnapshotData } from '@emdash/wire/rpc';
import type { Terminal } from '@xterm/xterm';
import { noteTerminalOutput } from './terminal-output-tally';

type XtermLogTerminal = Pick<Terminal, 'reset' | 'write'>;

const TRUNCATED_NOTICE = '\r\n[output truncated]\r\n';

/**
 * Largest single `terminal.write`. xterm parses each write whole and only yields to the browser
 * between writes, so a 1 MB replay handed over in one piece blocks the renderer until it is
 * parsed; in pieces, xterm's own scheduler keeps the window responsive while it catches up.
 */
export const XTERM_WRITE_PIECE_CHARS = 64 * 1024;

export type XtermLogSinkOptions = {
  /**
   * Scheduler for coalesced writes. Defaults to requestAnimationFrame when
   * available and a 16 ms timeout otherwise. Injectable for tests.
   */
  scheduleFlush?: (flush: () => void) => void;
  /** Names this output in the renderer stall log's per-session output tally. */
  label?: string;
};

/**
 * Writes retained PTY output into xterm, coalescing burst appends to one write
 * per animation frame so TUI redraw storms do not schedule a write per chunk.
 */
export function createXtermLogSink(
  terminal: XtermLogTerminal,
  options: XtermLogSinkOptions = {}
): LogSink {
  const scheduleFlush = options.scheduleFlush ?? defaultScheduleFlush;
  const label = options.label;
  let pending = '';
  let epoch = 0;
  let flushScheduled = false;

  const flush = (scheduledEpoch: number): void => {
    flushScheduled = false;
    if (scheduledEpoch !== epoch || pending.length === 0) return;
    const chunk = pending;
    pending = '';
    writeInPieces(terminal, chunk);
  };

  const queue = (chunk: string): void => {
    if (!chunk) return;
    if (label) noteTerminalOutput(label, chunk.length);
    pending += chunk;
    if (flushScheduled) return;
    flushScheduled = true;
    const scheduledEpoch = epoch;
    scheduleFlush(() => flush(scheduledEpoch));
  };

  return {
    reset(data: LiveLogSnapshotData) {
      epoch += 1;
      pending = '';
      flushScheduled = false;
      terminal.reset();
      if (data.truncated) terminal.write(TRUNCATED_NOTICE);
      if (data.text.length > 0) {
        if (label) noteTerminalOutput(label, data.text.length);
        writeInPieces(terminal, data.text);
      }
    },
    append(chunk) {
      queue(chunk);
    },
  };
}

/** Writes text in pieces of at most {@link XTERM_WRITE_PIECE_CHARS}, never splitting a surrogate pair. */
function writeInPieces(terminal: XtermLogTerminal, text: string): void {
  let start = 0;
  while (text.length - start > XTERM_WRITE_PIECE_CHARS) {
    let end = start + XTERM_WRITE_PIECE_CHARS;
    if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    terminal.write(text.slice(start, end));
    start = end;
  }
  terminal.write(start === 0 ? text : text.slice(start));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function defaultScheduleFlush(flush: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
    .requestAnimationFrame;
  if (typeof raf === 'function') {
    raf(() => flush());
    return;
  }
  setTimeout(flush, 16);
}
