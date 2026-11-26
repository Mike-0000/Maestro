import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostWindowSuspension,
  HOST_WINDOW_RESTORE_DELAY_MS,
  type HostWindowPort,
} from './host-window-suspension';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeWindow(initial: { visible: boolean } | null) {
  let state = initial;
  const port: HostWindowPort = {
    current: () => state,
    destroy: vi.fn(() => {
      state = null;
    }),
    restore: vi.fn(({ visible }) => {
      state = { visible };
    }),
  };
  return {
    port,
    open: (visible = true) => {
      state = { visible };
    },
    get state() {
      return state;
    },
  };
}

describe('host window suspension', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('destroys the window on attach and recreates it 60 s after detach', () => {
    const window = fakeWindow({ visible: true });
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });

    suspension.onAttach();
    expect(window.port.destroy).toHaveBeenCalledTimes(1);
    expect(window.state).toBeNull();

    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS - 1);
    expect(window.port.restore).not.toHaveBeenCalled();
    expect(suspension.brainEpoch()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(window.port.restore).toHaveBeenCalledWith({ visible: true });
    expect(suspension.brainEpoch()).toBe(1);
  });

  it('restores a window hidden to the tray as hidden', () => {
    const window = fakeWindow({ visible: false });
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });
    suspension.onAttach();
    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.restore).toHaveBeenCalledWith({ visible: false });
  });

  it('keeps the window down when a client reattaches inside the delay', () => {
    const window = fakeWindow({ visible: true });
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });
    suspension.onAttach();
    suspension.onDetach();
    vi.advanceTimersByTime(30_000);
    suspension.onAttach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS * 2);
    expect(window.port.restore).not.toHaveBeenCalled();
    expect(suspension.brainEpoch()).toBe(0);

    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.restore).toHaveBeenCalledTimes(1);
    expect(suspension.brainEpoch()).toBe(1);
  });

  it('does not create a window that did not exist before the client attached', () => {
    const window = fakeWindow(null);
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });
    suspension.onAttach();
    expect(window.port.destroy).not.toHaveBeenCalled();
    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.restore).not.toHaveBeenCalled();
    expect(suspension.brainEpoch()).toBe(0);
  });

  it('closes a window reopened during the session on the next attach, and restores it later', () => {
    const window = fakeWindow(null);
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });
    suspension.onAttach();
    window.open(true);
    suspension.onAttach();
    expect(window.port.destroy).toHaveBeenCalledTimes(1);
    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.restore).toHaveBeenCalledWith({ visible: true });
  });

  it('does nothing on detach without an attach, and dispose cancels a pending restore', () => {
    const window = fakeWindow({ visible: true });
    const suspension = createHostWindowSuspension({ window: window.port, logger: logger as never });
    suspension.onDetach();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.destroy).not.toHaveBeenCalled();
    expect(window.port.restore).not.toHaveBeenCalled();

    suspension.onAttach();
    suspension.onDetach();
    suspension.dispose();
    vi.advanceTimersByTime(HOST_WINDOW_RESTORE_DELAY_MS);
    expect(window.port.restore).not.toHaveBeenCalled();
  });
});
