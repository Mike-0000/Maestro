import { describe, expect, it } from 'vitest';
import { createXtermLogSink } from '@core/features/terminals/api/browser/pty/xterm-log-sink';

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
    expect(writes).toHaveLength(1);
    expect(writes[0]?.length).toBe(chunk.length * 128);
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
