import type { DesktopHostControllerOperations } from '@core/features/workbench/node/wire-controller';
import type { ClientShutdown } from '../client-shutdown';
import type { OwnerHostClient } from '../host-link';

// `host` (desktopHost) in client mode. Window, shell, clipboard, dialogs, fonts, menus and the
// quit handshake are this computer's. Two procedures are the host's: `persistDroppedBlob` (a
// dropped blob must land where the agent runs) and `getPlatform` (what the renderer decides from
// it is the host's platform). Opening host paths in this computer's apps is not supported yet.

/** The local procedures, as the local app's `appOperations` provides them. */
export type LocalHostOperations = Omit<
  DesktopHostControllerOperations,
  | 'persistDroppedBlob'
  | 'getPlatform'
  | 'openPath'
  | 'showWorkspaceItemInFolder'
  | 'openIn'
  | 'quit'
  | 'resolveQuitConfirmation'
  | 'ackShutdownFlush'
  | 'shutdownReady'
>;

export const CLIENT_UNSUPPORTED_MESSAGE =
  'Opening files from the host in apps on this computer is not available in client mode yet.';

export function createClientHostOperations(deps: {
  local: LocalHostOperations;
  host: () => Promise<OwnerHostClient>;
  shutdown: ClientShutdown;
}): DesktopHostControllerOperations {
  const unsupported = async () => ({ success: false, error: CLIENT_UNSUPPORTED_MESSAGE });
  return {
    ...deps.local,
    persistDroppedBlob: async (input, meta) =>
      await (await deps.host()).desktop.host.persistDroppedBlob(input, { signal: meta.signal }),
    getPlatform: async (_input, meta) =>
      await (await deps.host()).desktop.host.getPlatform(undefined, { signal: meta.signal }),
    openPath: unsupported,
    showWorkspaceItemInFolder: unsupported,
    openIn: unsupported,
    quit: () => {
      deps.shutdown.requestQuit();
      return { success: true };
    },
    // A client never asks the renderer to confirm a quit: the agents keep running on the host.
    resolveQuitConfirmation: () => {},
    ackShutdownFlush: () => deps.shutdown.ackShutdownFlush(),
    shutdownReady: () => deps.shutdown.markShutdownReady(),
  };
}
