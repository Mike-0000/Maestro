import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../scheduling';
import {
  startLoopStallLog,
  startProcessHeartbeat,
  STALL_ASSUME_SLEEP_MS,
  type LoopStallReport,
} from './stall-log';

const WINDOW = 10_000;

const clock: Clock = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return { dispose: () => clearTimeout(timer) } as never;
  },
  sleep: async () => {},
};

function start() {
  const histogram = {
    max: 0,
    percentile: vi.fn(() => 33e6),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(function (this: { max: number }) {
      this.max = 0;
    }),
  };
  const stalls: LoopStallReport[] = [];
  const log = startLoopStallLog({
    onStall: (report) => stalls.push(report),
    clock,
    histogram,
  });
  const windowWith = (delayMs: number) => {
    histogram.max = delayMs * 1e6;
    vi.advanceTimersByTime(WINDOW);
  };
  return { histogram, log, stalls, windowWith };
}

describe('startLoopStallLog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a window whose longest delay passed a second, then starts clean', () => {
    const { stalls, windowWith, histogram } = start();

    windowWith(999);
    expect(stalls).toEqual([]);
    windowWith(2_500);
    expect(stalls).toEqual([
      { sinceStartMs: 2 * WINDOW, loopDelayMaxMs: 2_500, loopDelayP99Ms: 33 },
    ]);
    expect(histogram.reset).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(WINDOW);
    expect(stalls).toHaveLength(1);
  });

  it('ignores everything measured while the machine sleeps and the window it wakes into', () => {
    const { log, stalls, windowWith } = start();

    log.markSuspended();
    windowWith(60_000);
    log.markResumed();
    windowWith(60_000);
    expect(stalls).toEqual([]);

    windowWith(3_000);
    expect(stalls).toHaveLength(1);
  });

  it('takes a delay too long to be a stall for a sleep nothing announced', () => {
    const { stalls, windowWith } = start();

    windowWith(STALL_ASSUME_SLEEP_MS);
    expect(stalls).toEqual([]);
    windowWith(STALL_ASSUME_SLEEP_MS - 1);
    expect(stalls).toHaveLength(1);
  });

  it('stops measuring when disposed', () => {
    const { log, stalls, windowWith, histogram } = start();

    log.dispose();
    windowWith(5_000);

    expect(stalls).toEqual([]);
    expect(histogram.disable).toHaveBeenCalledOnce();
  });
});

describe('startProcessHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports numbers on its cadence until disposed', () => {
    const report = vi.fn();
    const dispose = startProcessHeartbeat({ intervalMs: 60_000, report, clock });

    vi.advanceTimersByTime(120_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.lastCall?.[0]).toMatchObject({
      uptimeMin: 2,
      rssMb: expect.any(Number),
      heapUsedMb: expect.any(Number),
      childProcesses: expect.any(Number),
      spawns: expect.any(Object),
    });

    dispose();
    vi.advanceTimersByTime(120_000);
    expect(report).toHaveBeenCalledTimes(2);
  });
});
