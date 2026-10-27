import { systemClock, type Clock, type TimerHandle } from '@emdash/shared/scheduling';
import {
  takeTerminalOutputTally,
  type TerminalOutputTallyEntry,
} from '@core/features/terminals/api/browser/pty/terminal-output-tally';
import { log } from '@core/primitives/logging/browser/logger';
import { performanceObserve, type RendererPerfObserve } from './perf-vitals';

export const STALL_LOG_WINDOW_MS = 10_000;
/** A single renderer task this long is a freeze the developer notices. */
export const STALL_LOG_TASK_MS = 1_000;
/** Terminal output this large within one window is a flood worth naming even without a freeze. */
export const STALL_LOG_OUTPUT_CHARS = 4 * 1024 * 1024;
const TOP_SESSIONS = 5;

export type StallLogReport = {
  longestTaskMs: number;
  longTaskTotalMs: number;
  longTasks: number;
  outputChars: number;
  topOutput: TerminalOutputTallyEntry[];
};

export type StartStallLogDeps = {
  observe: RendererPerfObserve;
  takeOutputTally: () => TerminalOutputTallyEntry[];
  warn: (message: string, report: StallLogReport) => void;
  clock?: Clock;
};

/**
 * Logs renderer freezes for the life of the window: one warning per 10 s window with a task
 * longer than a second, or with a terminal output flood, naming the sessions whose output the
 * renderer received in that window. Pairs with the main process's own stall log. Local only:
 * nothing is sent anywhere.
 */
export function startStallLog(deps: StartStallLogDeps): () => void {
  const clock = deps.clock ?? systemClock;
  let longestTaskMs = 0;
  let longTaskTotalMs = 0;
  let longTasks = 0;

  const disposeObserver = deps.observe({ type: 'longtask' }, (entries) => {
    for (const entry of entries) {
      longTasks += 1;
      longTaskTotalMs += entry.duration;
      longestTaskMs = Math.max(longestTaskMs, entry.duration);
    }
  });

  let timer: TimerHandle | null = null;
  let disposed = false;
  const tick = (): void => {
    if (disposed) return;
    const tally = deps.takeOutputTally();
    const outputChars = tally.reduce((total, entry) => total + entry.chars, 0);
    const stalled = longestTaskMs >= STALL_LOG_TASK_MS;
    if (stalled || outputChars >= STALL_LOG_OUTPUT_CHARS) {
      deps.warn(stalled ? 'renderer: main thread stalled' : 'renderer: heavy terminal output', {
        longestTaskMs: Math.round(longestTaskMs),
        longTaskTotalMs: Math.round(longTaskTotalMs),
        longTasks,
        outputChars,
        topOutput: tally.slice(0, TOP_SESSIONS),
      });
    }
    longestTaskMs = 0;
    longTaskTotalMs = 0;
    longTasks = 0;
    timer = clock.schedule(STALL_LOG_WINDOW_MS, tick);
  };
  timer = clock.schedule(STALL_LOG_WINDOW_MS, tick);

  return () => {
    disposed = true;
    void timer?.dispose();
    disposeObserver();
  };
}

/** Production wiring: real PerformanceObserver, the terminal output tally, the app log. */
export function initStallLog(): void {
  try {
    startStallLog({
      observe: performanceObserve,
      takeOutputTally: takeTerminalOutputTally,
      warn: (message, report) => log.warn(message, report),
    });
  } catch {
    // Diagnostics are best-effort; never break renderer bootstrap.
  }
}
