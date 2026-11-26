import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientShutdown } from './client-shutdown';

function harness() {
  const calls: string[] = [];
  const shutdown = createClientShutdown({
    emit: (event) => calls.push(`emit:${event.type}`),
    closeLink: () => calls.push('close-link'),
    exit: (code) => calls.push(`exit:${code}`),
    log: { info: () => {}, warn: () => {} },
  });
  return { shutdown, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('client shutdown', () => {
  it('exits at once when the renderer cannot flush', async () => {
    const { shutdown, calls } = harness();
    shutdown.requestQuit();
    await vi.runAllTimersAsync();
    expect(calls).toEqual(['close-link', 'exit:0']);
  });

  it('waits for the renderer flush, then closes the link and exits once', async () => {
    const { shutdown, calls } = harness();
    shutdown.markShutdownReady();
    shutdown.requestQuit();
    shutdown.requestQuit();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['emit:shutdown-started']);
    shutdown.ackShutdownFlush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['emit:shutdown-started', 'close-link', 'exit:0']);
    expect(shutdown.shuttingDown).toBe(true);
  });

  it('gives up on a silent renderer after the flush deadline', async () => {
    const { shutdown, calls } = harness();
    shutdown.markShutdownReady();
    shutdown.requestQuit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(['emit:shutdown-started', 'close-link', 'exit:0']);
  });
});
