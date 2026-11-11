import { describe, expect, it, vi } from 'vitest';
import { finishTask } from './finish-task';

describe('finishTask', () => {
  it('archives and reports nothing when the archive succeeds', async () => {
    const archive = vi.fn(async () => {});
    const onFailure = vi.fn();
    await finishTask(archive, onFailure);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a failed archive instead of rejecting', async () => {
    const error = new Error('project offline');
    const onFailure = vi.fn();
    await expect(finishTask(() => Promise.reject(error), onFailure)).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith(error);
  });

  it('does nothing without a task manager', async () => {
    const onFailure = vi.fn();
    await finishTask(null, onFailure);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
