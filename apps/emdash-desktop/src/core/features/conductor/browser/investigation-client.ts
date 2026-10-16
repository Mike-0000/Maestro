import { err, type Result } from '@emdash/shared';
import { LiveJobCancelledError } from '@emdash/wire/live';
import { runDesktopLiveJob } from '@core/primitives/wire/browser/run-live-job';
import { getConductorClient } from '../api/browser/client';
import {
  conductorContract,
  type InvestigationError,
  type InvestigationInput,
  type InvestigationProgress,
  type InvestigationResult,
  type LookupError,
  type LookupInput,
  type LookupResult,
} from '../api/contract';

/** How a code check ended: answers, a reason it could not run, or the developer's cancel. */
export type InvestigationRun =
  | Result<InvestigationResult, InvestigationError>
  | { readonly cancelled: true };

const FAILED: InvestigationError = { type: 'failed', message: 'The code check could not be run.' };

/**
 * Runs one code check in the main process as a live job and waits for it. Aborting `signal`
 * cancels the job. It never throws: a job that failed without saying why, or could not be
 * reached at all, comes back as a plain failure.
 */
export async function runInvestigation(
  input: InvestigationInput,
  options: { onProgress?: (progress: InvestigationProgress) => void; signal?: AbortSignal } = {}
): Promise<InvestigationRun> {
  try {
    const client = await getConductorClient();
    const result = await runDesktopLiveJob(
      conductorContract.investigate,
      client.investigate,
      input,
      options.onProgress,
      { signal: options.signal }
    );
    // A handler that threw has no error payload.
    return result.success || result.error ? result : err(FAILED);
  } catch (error) {
    if (error instanceof LiveJobCancelledError) return { cancelled: true };
    return err(FAILED);
  }
}

/** How a project lookup ended: names found, a reason it could not run, or a cancel. */
export type LookupRun = Result<LookupResult, LookupError> | { readonly cancelled: true };

const LOOKUP_FAILED: LookupError = {
  type: 'failed',
  message: 'The project could not be searched.',
};

/** Runs one project lookup in the main process and waits for it. It never throws. */
export async function runProjectLookup(
  input: LookupInput,
  options: { signal?: AbortSignal } = {}
): Promise<LookupRun> {
  try {
    const client = await getConductorClient();
    const result = await runDesktopLiveJob(
      conductorContract.findInProject,
      client.findInProject,
      input,
      undefined,
      { signal: options.signal }
    );
    return result.success || result.error ? result : err(LOOKUP_FAILED);
  } catch (error) {
    if (error instanceof LiveJobCancelledError) return { cancelled: true };
    return err(LOOKUP_FAILED);
  }
}
