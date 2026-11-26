import type { Logger } from '@emdash/shared/logger';
import type { Controller } from '@emdash/wire/rpc';
import { createDevPerfWireController } from '@core/features/dev-perf/node/wire-controller';
import type { DesktopRuntimes } from '@main/gateway/desktop-runtimes';
import { createDevPerfOperations } from '@main/host/dev-perf/controller-operations';

/**
 * `devPerf` in client mode: the process snapshot and trace capture cover this client process;
 * there are no workers, so per-worker spawn logging has nothing to switch.
 */
export function createClientDevPerfController(log: Logger): Controller {
  const noWorkers: Pick<DesktopRuntimes, 'setWorkerSpawnLogging'> = {
    setWorkerSpawnLogging: () => {},
  };
  // Boundary cast: the operations read only `setWorkerSpawnLogging` from the runtimes.
  return createDevPerfWireController(createDevPerfOperations(noWorkers as DesktopRuntimes), log);
}
