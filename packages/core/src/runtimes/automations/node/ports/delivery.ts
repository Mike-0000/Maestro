import { err, type Result } from '@emdash/shared';
import { systemClock, type Clock } from '@emdash/shared/scheduling';
import type { ContractClient } from '@emdash/wire/rpc';
import type {
  AutomationDeliveryContract,
  AutomationPublishInput,
  AutomationPublishResult,
  AutomationSessionRef,
} from '../../api/delivery';
import type { AutomationPortError } from './port-error';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_GRACE_MS = 2 * 60_000;
const DEFAULT_PUBLISH_RETRY_DELAY_MS = 30_000;
const SETTLED_POLLS_REQUIRED = 2;

/**
 * - `clean`: the agent ended its turn normally.
 * - `incomplete`: the agent stopped abnormally, exited, or never reported.
 * - `timeout`: the run's wall-clock budget elapsed.
 * - `aborted`: the run's signal fired (cancel or runtime shutdown).
 */
export type AutomationSessionOutcome = 'clean' | 'incomplete' | 'timeout' | 'aborted';

export interface AutomationDeliveryPort {
  awaitSession(input: {
    session: AutomationSessionRef;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<AutomationSessionOutcome>;
  stopSession(session: AutomationSessionRef): Promise<void>;
  publish(
    input: AutomationPublishInput,
    signal: AbortSignal
  ): Promise<Result<AutomationPublishResult, AutomationPortError>>;
}

export type AutomationDeliveryPortOptions = {
  clock?: Clock;
  pollIntervalMs?: number;
  startupGraceMs?: number;
  publishRetryDelayMs?: number;
};

/**
 * Polls the app-supplied delivery contract instead of holding a live subscription:
 * a run lasts minutes to an hour, so a few seconds of latency is free, and a plain
 * RPC survives session-runtime restarts without resubscription logic.
 */
export function createDeliveryPortFromDependency(
  client: ContractClient<AutomationDeliveryContract>,
  options: AutomationDeliveryPortOptions = {}
): AutomationDeliveryPort {
  const clock = options.clock ?? systemClock;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  const publishRetryDelayMs = options.publishRetryDelayMs ?? DEFAULT_PUBLISH_RETRY_DELAY_MS;

  const publishOnce = async (
    input: AutomationPublishInput,
    signal: AbortSignal
  ): Promise<Result<AutomationPublishResult, AutomationPortError>> => {
    try {
      const result = await client.publish(input, { signal });
      return result.success
        ? result
        : err({ code: result.error.type, message: result.error.message });
    } catch (error) {
      return err({
        code: 'publish_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async awaitSession({ session, timeoutMs, signal }) {
      const startedAt = clock.now();
      const deadline = startedAt + timeoutMs;
      let lastReportedAt = startedAt;
      let sawWorking = false;
      let settledPolls = 0;
      let clean = false;

      for (;;) {
        if (signal.aborted) return 'aborted';
        const now = clock.now();
        if (now >= deadline) return 'timeout';

        const status = await client
          .sessionStatus(session, { signal })
          .then((result) => (result.success ? result.data : null))
          .catch(() => null);
        if (signal.aborted) return 'aborted';

        const state = status?.state ?? 'unknown';
        if (state === 'exited') return 'incomplete';
        if (state === 'working') {
          sawWorking = true;
          settledPolls = 0;
          lastReportedAt = now;
        } else if (state === 'settled') {
          lastReportedAt = now;
          // A TUI agent reports idle before its initial prompt lands; only trust
          // idle once it has worked, or once the startup grace has passed.
          if (session.type === 'acp' || sawWorking || now - startedAt >= startupGraceMs) {
            settledPolls += 1;
            clean = status?.clean ?? false;
            if (settledPolls >= SETTLED_POLLS_REQUIRED) return clean ? 'clean' : 'incomplete';
          }
        } else if (now - lastReportedAt >= startupGraceMs) {
          return 'incomplete';
        }

        try {
          await clock.sleep(Math.min(pollIntervalMs, Math.max(deadline - now, 1)), { signal });
        } catch {
          return 'aborted';
        }
      }
    },

    async stopSession(session) {
      await client.stopSession(session).catch(() => undefined);
    },

    async publish(input, signal) {
      const first = await publishOnce(input, signal);
      if (first.success || signal.aborted) return first;
      try {
        await clock.sleep(publishRetryDelayMs, { signal });
      } catch {
        return first;
      }
      return publishOnce(input, signal);
    },
  };
}
