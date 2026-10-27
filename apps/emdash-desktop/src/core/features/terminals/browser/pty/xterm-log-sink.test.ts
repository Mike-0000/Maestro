import { describe, expect, it } from 'vitest';
import { takeTerminalOutputTally } from '@core/features/terminals/api/browser/pty/terminal-output-tally';
import {
  createXtermLogSink,
  XTERM_WRITE_PIECE_CHARS,
} from '@core/features/terminals/api/browser/pty/xterm-log-sink';

function manualScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule: (flush: () => void) => {
      pending.push(flush);
    },
    runAll() {
      for (const flush of pending.splice(0)) flush();
    },
    get scheduledCount() {
      return pending.length;
    },
  };
}

describe('createXtermLogSink', () => {
  it('coalesces burst appends into one write per scheduled flush', () => {
    const writes: string[] = [];
    const scheduler = manualScheduler();
    const terminal = {
      reset() {},
      write(chunk: string) {
        writes.push(chunk);
      },
    };
    const sink = createXtermLogSink(terminal, { scheduleFlush: scheduler.schedule });
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 128; i++) sink.append(chunk);
    expect(writes).toEqual([]);
    expect(scheduler.scheduledCount).toBe(1);
    scheduler.runAll();
    expect(writes.join('')).toBe(chunk.repeat(128));
    expect(writes.every((write) => write.length <= XTERM_WRITE_PIECE_CHARS)).toBe(true);
  });

  it('replays a large snapshot in pieces xterm can yield between', () => {
    const writes: string[] = [];
    const terminal = { reset() {}, write: (chunk: string) => void writes.push(chunk) };
    const sink = createXtermLogSink(terminal);
    const text = 'y'.repeat(XTERM_WRITE_PIECE_CHARS * 2 + 10);

    sink.reset({ baseOffset: 0, text, truncated: false });

    expect(writes.map((write) => write.length)).toEqual([
      XTERM_WRITE_PIECE_CHARS,
      XTERM_WRITE_PIECE_CHARS,
      10,
    ]);
  });

  it('never splits a surrogate pair across pieces', () => {
    const writes: string[] = [];
    const terminal = { reset() {}, write: (chunk: string) => void writes.push(chunk) };
    const sink = createXtermLogSink(terminal);
    const text = 'a'.repeat(XTERM_WRITE_PIECE_CHARS - 1) + '😀' + 'b';

    sink.reset({ baseOffset: 0, text, truncated: false });

    expect(writes.join('')).toBe(text);
    expect(writes[0]?.endsWith('a')).toBe(true);
    expect(writes[1]?.startsWith('😀')).toBe(true);
  });

  it('tallies the output it receives under its label', () => {
    const scheduler = manualScheduler();
    const sink = createXtermLogSink(new FakeTerminal(), {
      scheduleFlush: scheduler.schedule,
      label: 'conversation c1',
    });
    takeTerminalOutputTally();

    sink.reset({ baseOffset: 0, text: 'abc', truncated: false });
    sink.append('de');

    expect(takeTerminalOutputTally()).toEqual([{ label: 'conversation c1', chars: 5 }]);
  });

  it('resets xterm and writes retained text immediately', () => {
    const terminal = new FakeTerminal();
    const scheduler = manualScheduler();
    const sink = createXtermLogSink(terminal, { scheduleFlush: scheduler.schedule });

    sink.reset({ baseOffset: 0, text: 'hello', truncated: false });
    sink.append('\nworld');
    scheduler.runAll();

    expect(terminal.events).toEqual(['reset', 'write:hello', 'write:\nworld']);
  });

  it('adds a truncation notice before retained text', () => {
    const terminal = new FakeTerminal();
    const sink = createXtermLogSink(terminal);

    sink.reset({ baseOffset: 1024, text: 'tail', truncated: true });

    expect(terminal.events).toEqual(['reset', 'write:\r\n[output truncated]\r\n', 'write:tail']);
  });

  it('drops coalesced writes that were queued before a reset', () => {
    const terminal = new FakeTerminal();
    const scheduler = manualScheduler();
    const sink = createXtermLogSink(terminal, { scheduleFlush: scheduler.schedule });

    sink.append('stale');
    sink.reset({ baseOffset: 0, text: 'fresh', truncated: false });
    scheduler.runAll();

    expect(terminal.events).toEqual(['reset', 'write:fresh']);
  });
});

class FakeTerminal {
  readonly events: string[] = [];

  reset(): void {
    this.events.push('reset');
  }

  write(data: string): void {
    this.events.push(`write:${data}`);
  }
}
