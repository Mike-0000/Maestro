import { monitorEventLoopDelay } from 'node:perf_hooks';
import { systemClock, type Clock } from '../../scheduling';
import type { TimerHandle } from '../../scheduling/timer-handle';
import { snapshotSpawnCounts } from '../spawn-metrics';

const STALL_WINDOW_MS = 10_000;
const STALL_THRESHOLD_MS = 1_000;
/**
 * A delay this long is the machine having slept, not a stall: nothing here would still be running
 * to report it otherwise. The backstop for a sleep no suspend event announced, and the only check
 * in a process that cannot hear those events.
 */
export const STALL_ASSUME_SLEEP_MS = 10 * 60_000;

export type LoopStallReport = {
  sinceStartMs: number;
  loopDelayMaxMs: number;
  loopDelayP99Ms: number;
};

type LoopDelayHistogram = {
  readonly max: number;
  percentile(percentile: number): number;
  enable(): unknown;
  disable(): unknown;
  reset(): void;
};

export type StartLoopStallLogOptions = {
  onStall(report: LoopStallReport): void;
  clock?: Clock;
  histogram?: LoopDelayHistogram;
};

export type LoopStallLog = {
  /** The machine is going to sleep: nothing measured until it wakes is a stall. */
  markSuspended(): void;
  /** The machine woke: the window it woke into holds the sleep and says nothing. */
  markResumed(): void;
  dispose(): void;
};

/**
 * Reports each 10 s window in which this process's event loop was blocked for over a second. A
 * blocked loop is what makes every wire call through the process time out together. Local only.
 */
export function startLoopStallLog(options: StartLoopStallLogOptions): LoopStallLog {
  const clock = options.clock ?? systemClock;
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const startedAt = clock.now();
  let suspended = false;
  let skipNextWindow = false;
  let disposed = false;
  let timer: TimerHandle | null = null;

  const tick = (): void => {
    if (disposed) return;
    const maxMs = Math.round(histogram.max / 1e6);
    const measurable = !suspended && !skipNextWindow;
    if (measurable && maxMs >= STALL_THRESHOLD_MS && maxMs < STALL_ASSUME_SLEEP_MS) {
      options.onStall({
        sinceStartMs: clock.now() - startedAt,
        loopDelayMaxMs: maxMs,
        loopDelayP99Ms: Math.round(histogram.percentile(99) / 1e6),
      });
    }
    skipNextWindow = false;
    histogram.reset();
    schedule();
  };
  const schedule = (): void => {
    timer = clock.schedule(STALL_WINDOW_MS, tick, { unref: true });
  };
  schedule();

  return {
    markSuspended() {
      suspended = true;
    },
    markResumed() {
      suspended = false;
      skipNextWindow = true;
    },
    dispose() {
      disposed = true;
      timer?.dispose();
      histogram.disable();
    },
  };
}

export type ProcessHeartbeat = {
  uptimeMin: number;
  rssMb: number;
  heapUsedMb: number;
  /** Live child processes this process holds handles to; the signal for a process leak. */
  childProcesses: number;
  pipes: number;
  sockets: number;
  /** Programs started, by purpose, since the telemetry sampler (if any) last took the counts. */
  spawns: Record<string, number>;
};

export type StartProcessHeartbeatOptions = {
  intervalMs: number;
  report(heartbeat: ProcessHeartbeat): void;
  clock?: Clock;
};

/**
 * Logs what a long session would show if something built up over time. The log keeps warnings
 * only, so without this a freeze has no memory or process counts to read next to it. Local only.
 */
export function startProcessHeartbeat(options: StartProcessHeartbeatOptions): () => void {
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();
  let disposed = false;
  let timer: TimerHandle | null = null;

  const tick = (): void => {
    if (disposed) return;
    options.report(sampleHeartbeat(clock.now() - startedAt));
    schedule();
  };
  const schedule = (): void => {
    timer = clock.schedule(options.intervalMs, tick, { unref: true });
  };
  schedule();

  return () => {
    disposed = true;
    timer?.dispose();
  };
}

function sampleHeartbeat(uptimeMs: number): ProcessHeartbeat {
  const resources = process.getActiveResourcesInfo();
  const count = (type: string): number => resources.filter((name) => name === type).length;
  return {
    uptimeMin: Math.round(uptimeMs / 60_000),
    rssMb: bytesToMb(process.memoryUsage.rss()),
    heapUsedMb: bytesToMb(process.memoryUsage().heapUsed),
    childProcesses: count('ProcessWrap'),
    pipes: count('PipeWrap'),
    sockets: count('TCPSocketWrap'),
    spawns: snapshotSpawnCounts(),
  };
}

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
