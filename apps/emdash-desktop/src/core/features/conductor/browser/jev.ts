import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../api/browser/client';
import type { JevDecision, JevError } from '../api/contract';
import type { JevQuestions } from '../api/jev';

export type JevOutcome =
  | { ok: true; decision: JevDecision }
  | { ok: false; reason: JevError['type'] | 'request-failed'; message: string };

/**
 * Asks Jev a set of typed questions about `state`. A failure says why (for the trace) but never
 * throws: every caller has a non-Jev fallback, so a Jev problem never blocks the user.
 */
export async function jevDecide(state: unknown, questions: JevQuestions): Promise<JevOutcome> {
  try {
    const result = await (await getConductorClient()).decide({ state, questions });
    if (result.success) return { ok: true, decision: result.data };
    if (result.error.type !== 'disabled' && result.error.type !== 'not-configured') {
      log.warn('conductor: Jev unavailable', { error: result.error });
    }
    return { ok: false, reason: result.error.type, message: result.error.message };
  } catch (error) {
    log.warn('conductor: Jev request failed', { error });
    return {
      ok: false,
      reason: 'request-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
