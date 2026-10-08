import type { HostRef } from '@emdash/core/primitives/host/api';
import { runtimeHostUnavailable } from '@emdash/core/primitives/runtime-resolution/api';
import { err, ok } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { peek } from '@emdash/wire/state';
import type { HostRuntimeAccess } from '../api/node/host-runtime';
import type { ManagedHostConnection } from './managed-host-connection';
import { translateHostPreparationError } from './runtime-resolution';

/** Runtime access over one Host identity's supervised connection, whatever its transport. */
export function createHostRuntimeAccess(
  host: HostRef,
  scope: Scope,
  managed: ManagedHostConnection
): HostRuntimeAccess {
  return {
    waitUntilReady: async (signal) => {
      try {
        return ok({
          host,
          generation: await managed.supervisor.awaitUsable(signal),
        });
      } catch (error) {
        return err(translateHostPreparationError(host, 'handshaking', error));
      }
    },
    client: async (request) => {
      scope.signal.throwIfAborted();
      if (request?.waitForReady === false) {
        const availability = peek(managed.availability);
        if (availability.kind !== 'ready')
          throw availability.kind === 'unavailable' && availability.issue
            ? availability.issue
            : runtimeHostUnavailable(
                host,
                'runtime-unavailable',
                'Host runtime is not currently usable'
              );
      } else await managed.supervisor.awaitUsable(request?.signal);
      return managed.supervisor.attachment;
    },
  };
}
