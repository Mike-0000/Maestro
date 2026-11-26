import type { Logger } from '@emdash/shared/logger';

// "The brain follows the client" (D7). Much of the conductor runs in the renderer and reacts to
// live models, so two renderers on one host would act twice. While an owner client is attached
// the host's own window is destroyed; a while after the last client detaches it is brought back,
// so the host's own conductor looks after its agents while the client's computer is off.

/** Electron-free view of the host's window, implemented in `electron-host-ports.ts`. */
export type HostWindowPort = {
  /** The main window exists (shown or hidden to the tray); null when there is none. */
  current(): { visible: boolean } | null;
  /** Destroys the main window and the task windows it opened, skipping close handlers. */
  destroy(): void;
  /** Creates the main window again, shown or hidden as it was. */
  restore(options: { visible: boolean }): void;
};

export type SuspensionClock = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const HOST_WINDOW_RESTORE_DELAY_MS = 60_000;

export type HostWindowSuspension = {
  /** An owner client attached (or another took over): no host renderer may run now. */
  onAttach(): void;
  /** The last owner client detached: bring the window back after the delay. */
  onDetach(): void;
  /**
   * Bumped each time the host's window comes back, so a client attaching afterwards knows the
   * host's renderer ran in between and reloads its own.
   */
  brainEpoch(): number;
  /** Cancels a pending restore. Never recreates a window (the app may be quitting). */
  dispose(): void;
};

const systemClock: SuspensionClock = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createHostWindowSuspension(options: {
  window: HostWindowPort;
  logger: Logger;
  clock?: SuspensionClock;
  restoreDelayMs?: number;
}): HostWindowSuspension {
  const clock = options.clock ?? systemClock;
  const restoreDelayMs = options.restoreDelayMs ?? HOST_WINDOW_RESTORE_DELAY_MS;
  /** Set while suspended: what to bring back, or null when there was no window to begin with. */
  let suspended: { restore: { visible: boolean } | null } | undefined;
  let restoreTimer: unknown;
  let epoch = 0;

  function cancelRestore(): void {
    if (restoreTimer === undefined) return;
    clock.clearTimeout(restoreTimer);
    restoreTimer = undefined;
  }

  function destroyWindow(): { visible: boolean } | null {
    const current = options.window.current();
    if (!current) return null;
    try {
      options.window.destroy();
      options.logger.info('Host window closed while a full-access client is attached');
    } catch (error) {
      options.logger.warn('Could not close the host window', { error: String(error) });
    }
    return current;
  }

  return {
    onAttach() {
      cancelRestore();
      if (!suspended) {
        suspended = { restore: destroyWindow() };
        return;
      }
      // Already suspended (a takeover, or a reattach inside the delay). A window someone opened
      // meanwhile (tray, second launch) is a second renderer too: close it and restore it later.
      const reopened = destroyWindow();
      if (reopened && !suspended.restore) suspended.restore = reopened;
    },
    onDetach() {
      if (!suspended) return;
      cancelRestore();
      restoreTimer = clock.setTimeout(() => {
        restoreTimer = undefined;
        const restore = suspended?.restore;
        suspended = undefined;
        if (!restore) return;
        epoch += 1;
        try {
          if (!options.window.current()) options.window.restore(restore);
          options.logger.info('Host window restored after the full-access client left', {
            brainEpoch: epoch,
          });
        } catch (error) {
          options.logger.warn('Could not restore the host window', { error: String(error) });
        }
      }, restoreDelayMs);
    },
    brainEpoch: () => epoch,
    dispose() {
      cancelRestore();
    },
  };
}
