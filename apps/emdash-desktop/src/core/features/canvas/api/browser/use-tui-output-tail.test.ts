import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_REFRESH_MS, startTuiOutputTail } from './use-tui-output-tail';

const snapshot = vi.hoisted(() => vi.fn());

vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({
    tui: { output: { handle: () => ({ snapshot }) } },
  }),
}));

describe('startTuiOutputTail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    snapshot.mockReset();
    snapshot.mockResolvedValue({ data: { text: 'line-a\nline-b', truncated: false } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll while idle after the first snapshot', async () => {
    const onLines = vi.fn();
    const stop = startTuiOutputTail('conv-1', true, false, onLines);
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PREVIEW_REFRESH_MS * 4);
    expect(snapshot).toHaveBeenCalledTimes(1);
    stop();
  });

  it('polls at 4 Hz while working', async () => {
    const onLines = vi.fn();
    const stop = startTuiOutputTail('conv-1', true, true, onLines);
    await Promise.resolve();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PREVIEW_REFRESH_MS);
    expect(snapshot).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not snapshot when the session is inactive', async () => {
    startTuiOutputTail('conv-1', false, true, vi.fn());
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();
  });
});
