import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitRepositoryFetchService } from './fetch-service';

const runtime = vi.hoisted(() => ({ runGitJob: vi.fn() }));

vi.mock('@main/core/git/runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  runGitJob: runtime.runGitJob,
}));

describe('GitRepositoryFetchService', () => {
  it('attempts background fetches for SSH remotes using system git credentials', async () => {
    const fetch = {};
    const snapshot = vi.fn().mockResolvedValue({
      data: { remotes: [{ name: 'origin', url: 'git@github.com:owner/repo.git' }] },
    });
    const getRemote = vi.fn().mockResolvedValue('origin');
    runtime.runGitJob.mockResolvedValue({ success: true, data: undefined });
    const git = {
      repository: {
        fetch,
        model: { state: vi.fn(() => ({ snapshot })) },
      },
    };
    const repository = { repository: { root: { kind: 'posix' }, segments: ['repo'] } };

    const service = new GitRepositoryFetchService(git as never, repository as never, getRemote);

    service.start();

    await vi.waitFor(() =>
      expect(runtime.runGitJob).toHaveBeenCalledWith(
        expect.anything(),
        fetch,
        expect.objectContaining({ remote: 'origin' })
      )
    );
    service.stop();
  });

  describe('when fetches keep failing', () => {
    afterEach(() => {
      vi.useRealTimers();
      runtime.runGitJob.mockReset();
    });

    function failingService() {
      vi.useFakeTimers();
      runtime.runGitJob.mockReset();
      runtime.runGitJob.mockResolvedValue({
        success: false,
        error: { type: 'git_error', message: 'fatal: index-pack failed' },
      });
      const snapshot = vi.fn().mockResolvedValue({ data: { remotes: [] } });
      const git = { repository: { fetch: {}, model: { state: vi.fn(() => ({ snapshot })) } } };
      const repository = { repository: { root: { kind: 'posix' }, segments: ['repo'] } };
      return new GitRepositoryFetchService(
        git as never,
        repository as never,
        vi.fn().mockResolvedValue('origin')
      );
    }

    it('doubles the wait after each failure, up to 30 minutes', async () => {
      const service = failingService();
      const minutes = async (count: number) => vi.advanceTimersByTimeAsync(count * 60_000);

      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(1);

      // Failure 1 waits one interval (2 min), failure 2 waits 4 min, failure 3 waits 8 min.
      await minutes(2);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(2);
      await minutes(2);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(2);
      await minutes(2);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(3);
      await minutes(8);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(4);

      // Well past the cap the attempts settle at one every 30 minutes.
      await minutes(16 + 30 + 30);
      const settled = runtime.runGitJob.mock.calls.length;
      await minutes(28);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(settled);
      await minutes(2);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(settled + 1);
      service.stop();
    });

    it('returns to the normal interval after a success', async () => {
      const service = failingService();
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(2);

      runtime.runGitJob.mockResolvedValue({ success: true, data: undefined });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runtime.runGitJob).toHaveBeenCalledTimes(5);
      service.stop();
    });
  });
});
