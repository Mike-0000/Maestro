import { log } from '@core/primitives/logging/browser/logger';
import { getConductorClient } from '../api/browser/client';
import type { JevDecision } from '../api/contract';
import type { JevQuestions } from '../api/jev';

/**
 * Asks Jev a set of typed questions about `state`. Returns null when Jev is off, unconfigured, or
 * fails: every caller has a non-Jev fallback, so a Jev problem never blocks the user.
 */
export async function jevDecide(
  state: unknown,
  questions: JevQuestions
): Promise<JevDecision | null> {
  try {
    const result = await (await getConductorClient()).decide({ state, questions });
    if (result.success) return result.data;
    if (result.error.type !== 'disabled' && result.error.type !== 'not-configured') {
      log.warn('conductor: Jev unavailable', { error: result.error });
    }
    return null;
  } catch (error) {
    log.warn('conductor: Jev request failed', { error });
    return null;
  }
}
