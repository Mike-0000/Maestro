import { LiveJobCancelledError, LiveJobFailedError } from '@emdash/wire/live';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorContract,
  type InvestigationInput,
  type InvestigationResult,
} from '../api/contract';
import { runInvestigation } from './investigation-client';

const mocks = vi.hoisted(() => ({
  createLiveJobReplicaCache: vi.fn(),
  getConductorClient: vi.fn(),
}));

vi.mock('@emdash/wire/live', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLiveJobReplicaCache: mocks.createLiveJobReplicaCache,
}));
vi.mock('../api/browser/client', () => ({ getConductorClient: mocks.getConductorClient }));

const input: InvestigationInput = {
  target: { projectId: 'project-1' },
  questions: ['Is there a retry helper?'],
};
const answers: InvestigationResult = {
  model: 'haiku',
  folderName: 'chorus',
  outcomes: [
    {
      status: 'answered',
      question: 'Is there a retry helper?',
      answer: 'Yes, in src/retry.ts.',
      found: 'yes',
      evidence: [],
      durationMs: 9_000,
      costUsd: 0.002,
      denied: 0,
    },
  ],
};
const investigateHandle = { kind: 'liveJobClientHandle' };

/** The job the main process would run, standing in behind the real live-job helper. */
function job(result: Promise<unknown>) {
  const live = {
    cancel: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn((_listener: (progress: unknown) => void) => () => {}),
    result,
  };
  const lease = {
    ready: vi.fn().mockResolvedValue(live),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const cache = {
    start: vi.fn().mockResolvedValue(lease),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  mocks.createLiveJobReplicaCache.mockReturnValue(cache);
  return { live, cache };
}

beforeEach(() => {
  mocks.createLiveJobReplicaCache.mockReset();
  mocks.getConductorClient.mockReset();
  mocks.getConductorClient.mockResolvedValue({ investigate: investigateHandle });
});

describe('runInvestigation', () => {
  it('runs the investigate live job and returns its answers', async () => {
    const { live, cache } = job(Promise.resolve(answers));
    const onProgress = vi.fn();

    expect(await runInvestigation(input, { onProgress })).toEqual({ success: true, data: answers });
    expect(mocks.createLiveJobReplicaCache).toHaveBeenCalledWith(
      conductorContract.investigate,
      investigateHandle
    );
    expect(cache.start).toHaveBeenCalledWith(input);

    const [listener] = live.onProgress.mock.calls[0] ?? [];
    listener?.({ index: 0, step: 'Reading retry.ts' });
    expect(onProgress).toHaveBeenCalledWith({ index: 0, step: 'Reading retry.ts' });
  });

  it('cancels the job when the signal aborts', async () => {
    let finish: (error: Error) => void = () => {};
    const { live } = job(
      new Promise((_resolve, reject) => {
        finish = reject;
      })
    );
    const controller = new AbortController();
    const listening = vi.spyOn(controller.signal, 'addEventListener');
    const run = runInvestigation(input, { signal: controller.signal });
    await vi.waitFor(() => expect(listening).toHaveBeenCalled());

    controller.abort();
    expect(live.cancel).toHaveBeenCalledTimes(1);
    // The main process ends a cancelled job as cancelled, not as a failure.
    finish(new LiveJobCancelledError());
    expect(await run).toEqual({ cancelled: true });
  });

  it("returns the job's own error", async () => {
    const error = { type: 'daily-limit' as const, message: "Today's limit is reached." };
    job(Promise.reject(new LiveJobFailedError(error)));
    expect(await runInvestigation(input)).toEqual({ success: false, error });
  });

  it('gives a plain failure for a job that failed without saying why', async () => {
    job(Promise.reject(new LiveJobFailedError(undefined)));
    expect(await runInvestigation(input)).toEqual({
      success: false,
      error: { type: 'failed', message: 'The code check could not be run.' },
    });
  });

  it('gives a plain failure when the job cannot be reached at all', async () => {
    mocks.getConductorClient.mockRejectedValue(new Error('wire disconnected'));
    expect(await runInvestigation(input)).toEqual({
      success: false,
      error: { type: 'failed', message: 'The code check could not be run.' },
    });

    mocks.getConductorClient.mockResolvedValue({ investigate: investigateHandle });
    job(Promise.reject(new Error('transport closed')));
    expect(await runInvestigation(input)).toMatchObject({
      success: false,
      error: { type: 'failed' },
    });
  });
});
