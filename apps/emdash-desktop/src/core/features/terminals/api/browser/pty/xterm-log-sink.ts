import type { LogSink } from '@emdash/wire/live';
import type { LiveLogSnapshotData } from '@emdash/wire/rpc';
import type { Terminal } from '@xterm/xterm';

type XtermLogTerminal = Pick<Terminal, 'reset' | 'write'>;

const TRUNCATED_NOTICE = '\r\n[output truncated]\r\n';

export type XtermLogSinkOptions = {
  /**
   * Scheduler for coalesced writes. Defaults to requestAnimationFrame when
   * available and a 16 ms timeout otherwise. Injectable for tests.
   */
  scheduleFlush?: (flush: () => void) => void;
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
  let pending = '';
  let epoch = 0;
  let flushScheduled = false;

  const flush = (scheduledEpoch: number): void => {
    flushScheduled = false;
    if (scheduledEpoch !== epoch || pending.length === 0) return;
    const chunk = pending;
    pending = '';
    terminal.write(chunk);
  };

  const queue = (chunk: string): void => {
    if (!chunk) return;
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
      if (data.text.length > 0) terminal.write(data.text);
    },
    append(chunk) {
      queue(chunk);
    },
  };
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
