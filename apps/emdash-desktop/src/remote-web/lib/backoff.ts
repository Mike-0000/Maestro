import type { RetrySchedule } from '@emdash/shared/scheduling';

const BASE_DELAYS_MS = [300, 600, 1_200, 2_500, 5_000];
const JITTER_RATIO = 0.2;

/**
 * Delay before reconnect attempt `attempt` (zero-based): quick at first, so a brief blip is
 * invisible, then settling at a few seconds. Jitter keeps several devices from retrying a
 * restarted host in step.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), BASE_DELAYS_MS.length - 1);
  const base = BASE_DELAYS_MS[index]!;
  const jitter = (random() * 2 - 1) * JITTER_RATIO;
  return Math.round(base * (1 + jitter));
}

/** A schedule that never gives up: a phone can be out of reach of its host for hours. */
export function createReconnectSchedule(random: () => number = Math.random): RetrySchedule {
  return { delayFor: (attempt) => reconnectDelayMs(attempt, random) };
}
