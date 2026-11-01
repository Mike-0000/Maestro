import path from 'node:path';
import {
  startLoopStallLog,
  startProcessHeartbeat,
  startVitalsReporting,
  type ProcessVitals,
} from '@emdash/shared/perf/node';
import { app, powerMonitor } from 'electron';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { createStallProfiler } from './stall-profiler';

/** Slow steady cadence: 12 reports/hour per process in sampled sessions. */
export const PERF_VITALS_INTERVAL_MS = 5 * 60_000;

/**
 * Production performance-vitals telemetry (the regression signal of record
 * for the footprint effort). Strictly behind the telemetry opt-in and the
 * per-session sampling roll: when `isPerfSampledSession()` is false — the
 * default, and always the case when telemetry is disabled — this function
 * returns without creating any timer, observer, or worker activation.
 */
export function startPerfVitalsTelemetry(runtimes: DesktopRuntimes): void {
  if (!telemetryService.isPerfSampledSession()) return;

  runtimes.startWorkerVitalsSampling(PERF_VITALS_INTERVAL_MS);
  startVitalsReporting({
    intervalMs: PERF_VITALS_INTERVAL_MS,
    report(vitals) {
      telemetryService.capture('perf_vitals', {
        process_name: 'main',
        ...vitals,
        ...appMetricsSummary(),
      });
    },
  });
}

const STARTUP_MS = 5 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;

/**
 * Logs main-process event-loop stalls for the life of the app: one warning per 10 s window whose
 * longest delay passed a second. The log keeps warnings only, so this is how a window where wire
 * calls time out together, or where typing into an agent lags, shows whether the main thread
 * itself was blocked. The renderer logs its own stalls with the sessions that were streaming
 * (`renderer/utils/stall-log.ts`), and each worker logs its own. A stall also starts a CPU profile
 * that catches the next one. A periodic heartbeat puts memory and process counts next to all of
 * this, and sleep and wake are logged so a gap in the log reads as what it is. Local only: nothing
 * is sent anywhere.
 */
export function startStallLog(): void {
  const profiler = createStallProfiler({
    dir: path.join(app.getPath('userData'), 'logs', 'stall-profiles'),
    warn: (message, details) => log.warn(message, details),
  });
  const stalls = startLoopStallLog({
    onStall: (report) => {
      const during = report.sinceStartMs < STARTUP_MS ? ' during startup' : '';
      log.warn(`main: event loop stalled${during}`, {
        sinceLaunchMs: report.sinceStartMs,
        loopDelayMaxMs: report.loopDelayMaxMs,
        loopDelayP99Ms: report.loopDelayP99Ms,
      });
      profiler.noteStall(report.loopDelayMaxMs);
    },
  });
  powerMonitor.on('suspend', () => {
    stalls.markSuspended();
    log.warn('main: system suspending');
  });
  powerMonitor.on('resume', () => {
    stalls.markResumed();
    log.warn('main: system resumed');
  });
  startProcessHeartbeat({
    intervalMs: HEARTBEAT_MS,
    report: (heartbeat) => {
      log.warn('main: heartbeat', { ...heartbeat, ...appProcessSummary() });
    },
  });
}

/** Electron's own processes, including the renderer and GPU that cannot report for themselves. */
function appProcessSummary(): { appProcesses?: number; appWorkingSetMb?: number } {
  try {
    const metrics = app.getAppMetrics();
    const workingSetKb = metrics.reduce(
      (total, metric) => total + (metric.memory?.workingSetSize ?? 0),
      0
    );
    return { appProcesses: metrics.length, appWorkingSetMb: Math.round(workingSetKb / 1024) };
  } catch {
    return {};
  }
}

/**
 * Cross-process summary from Electron's own bookkeeping: covers the renderer
 * and GPU processes that cannot self-sample over worker IPC.
 */
function appMetricsSummary(): Partial<ProcessVitals> {
  try {
    const metrics = app.getAppMetrics();
    let totalKb = 0;
    let rendererKb = 0;
    let gpuKb = 0;
    for (const metric of metrics) {
      const workingSetKb = metric.memory?.workingSetSize ?? 0;
      totalKb += workingSetKb;
      if (metric.type === 'Tab') rendererKb = Math.max(rendererKb, workingSetKb);
      if (metric.type === 'GPU') gpuKb = Math.max(gpuKb, workingSetKb);
    }
    return {
      app_process_count: metrics.length,
      app_total_rss_mb: Math.round(totalKb / 1024),
      renderer_rss_mb: Math.round(rendererKb / 1024),
      gpu_rss_mb: Math.round(gpuKb / 1024),
    };
  } catch {
    return {};
  }
}
