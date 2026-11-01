import type { Logger } from '@emdash/shared/logger';
import { initProcessLogging } from '@emdash/shared/logger/node';
import { startDevPerfInstruments } from '@emdash/shared/perf';
import { startLoopStallLog, startProcessHeartbeat } from '@emdash/shared/perf/node';
import { WORKER_NAME_ENV_VAR } from '../types';
import { installWorkerVitals } from './vitals';

const WORKER_HEARTBEAT_MS = 30 * 60_000;

export function initWorkerProcessLogging(fallbackName: string): Logger {
  const logger = initProcessLogging({
    name: process.env[WORKER_NAME_ENV_VAR] ?? fallbackName,
  });
  // Dev-only spawn/RSS reporting; a no-op unless debug logging is enabled.
  startDevPerfInstruments({ logger });
  // Telemetry vitals + verbose spawn logging: inert until the host sends a
  // control message; no timers or instruments are created before then.
  installWorkerVitals({ logger });
  // The main process has its own. A worker's loop blocking looks the same from outside as main's:
  // the calls it serves time out. Warnings reach the main log, so this is how to tell them apart.
  startLoopStallLog({
    onStall: (report) => logger.warn('worker: event loop stalled', report),
  });
  startProcessHeartbeat({
    intervalMs: WORKER_HEARTBEAT_MS,
    report: (heartbeat) => logger.warn('worker: heartbeat', heartbeat),
  });
  return logger;
}
