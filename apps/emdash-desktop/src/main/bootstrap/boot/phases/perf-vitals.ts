import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startVitalsReporting, type ProcessVitals } from '@emdash/shared/perf/node';
import { app } from 'electron';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';

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

const STALL_SAMPLE_MS = 10_000;
const STARTUP_MS = 5 * 60_000;
const STALL_LOG_THRESHOLD_MS = 1_000;

/**
 * Logs main-process event-loop stalls for the life of the app: one warning per 10 s window whose
 * longest delay passed a second. The log keeps warnings only, so this is how a window where wire
 * calls time out together, or where typing into an agent lags, shows whether the main thread
 * itself was blocked. The renderer logs its own stalls with the sessions that were streaming
 * (`renderer/utils/stall-log.ts`). Local only: nothing is sent anywhere.
 */
export function startStallLog(): void {
  // Its own histogram: the shared vitals sampler resets the spawn counters telemetry reports.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const sinceLaunchMs = Date.now() - startedAt;
    const maxDelayMs = Math.round(loopDelay.max / 1e6);
    if (maxDelayMs >= STALL_LOG_THRESHOLD_MS) {
      const during = sinceLaunchMs < STARTUP_MS ? ' during startup' : '';
      log.warn(`main: event loop stalled${during}`, {
        sinceLaunchMs,
        loopDelayMaxMs: maxDelayMs,
        loopDelayP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
      });
    }
    loopDelay.reset();
  }, STALL_SAMPLE_MS);
  timer.unref();
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
