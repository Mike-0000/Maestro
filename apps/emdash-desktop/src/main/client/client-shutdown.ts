import type { DesktopHostEvent } from '@core/primitives/desktop-host/api/host-contract';

// Quitting a client. The agents keep running on the host, so there is nothing to confirm: the
// renderer gets the usual `shutdown-started` so it can flush drafts and layout to the host, the
// link closes, and the process exits. Closing the window quits too; a client has no tray.

export const CLIENT_FLUSH_DEADLINE_MS = 2_000;
const HARD_DEADLINE_MS = 6_000;

export type ClientShutdown = {
  /** Starts quitting; later calls are ignored. */
  requestQuit(): void;
  /** The renderer finished its flush. */
  ackShutdownFlush(): void;
  /** The renderer can flush on shutdown (it subscribed to the host events). */
  markShutdownReady(): void;
  readonly shuttingDown: boolean;
};

export function createClientShutdown(deps: {
  emit(event: DesktopHostEvent): void;
  closeLink(): void;
  exit(code: number): void;
  log: {
    info(message: string): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  flushDeadlineMs?: number;
}): ClientShutdown {
  const flushDeadlineMs = deps.flushDeadlineMs ?? CLIENT_FLUSH_DEADLINE_MS;
  let shuttingDown = false;
  let rendererReady = false;
  let settleFlush: (() => void) | undefined;

  const flushRenderer = (): Promise<void> => {
    if (!rendererReady) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        settleFlush = undefined;
        resolve();
      }, flushDeadlineMs);
      settleFlush = () => {
        clearTimeout(timer);
        settleFlush = undefined;
        resolve();
      };
      deps.emit({ type: 'shutdown-started' });
    });
  };

  const run = async (): Promise<void> => {
    let exited = false;
    const exit = (): void => {
      if (exited) return;
      exited = true;
      deps.exit(0);
    };
    const hardDeadline = setTimeout(() => {
      deps.log.warn('client quit: hard deadline reached, forcing exit');
      exit();
    }, HARD_DEADLINE_MS);
    try {
      deps.log.info('client quit: flushing the renderer');
      await flushRenderer();
      deps.closeLink();
    } catch (error) {
      deps.log.warn('client quit: shutdown sequence failed', { error });
    } finally {
      clearTimeout(hardDeadline);
      exit();
    }
  };

  return {
    requestQuit() {
      if (shuttingDown) return;
      shuttingDown = true;
      void run();
    },
    ackShutdownFlush() {
      settleFlush?.();
    },
    markShutdownReady() {
      rendererReady = true;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  };
}
