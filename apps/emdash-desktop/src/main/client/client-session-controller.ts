import { err, ok, type Result } from '@emdash/shared';
import type { Scope } from '@emdash/shared/concurrency';
import { createController, type Controller } from '@emdash/wire/rpc';
import { expose } from '@emdash/wire/state';
import {
  clientSessionContract,
  type ClientSessionError,
  type ClientSessionPairInput,
} from '@core/features/client-mode/api/client-session-contract';
import { ownerEndpoints } from '@main/owner-link/endpoints';
import type { ConnectionStore } from './connection-store';
import type { HostLink } from './host-link';
import { pairWithOwnerHost, type OwnerPairFetch } from './owner-pairing';

export type ClientSessionControllerDeps = {
  link: HostLink;
  store: ConnectionStore;
  /** How this client names itself to the host when pairing. */
  deviceName: string;
  /** Restarts the client process (same profile). */
  relaunch(): void;
  createShortcut(): Promise<Result<void, ClientSessionError>>;
  scope: Scope;
  log: { info(message: string, context?: Record<string, unknown>): void };
  fetch?: OwnerPairFetch;
  now?: () => number;
};

/** Serves `clientSession`, the client process's own domain (client mode only). */
export function createClientSessionController(deps: ClientSessionControllerDeps): Controller {
  const now = deps.now ?? Date.now;
  return createController(clientSessionContract, {
    status: expose(
      clientSessionContract.status,
      { state: deps.link.status },
      { scope: deps.scope }
    ),
    pair: (input) => pair(deps, input, now),
    retryNow: () => deps.link.retryNow(),
    takeOver: () => deps.link.takeOver(),
    forget: async () => {
      await deps.store.clear();
      deps.log.info('client session: forgot the paired host; relaunching');
      deps.relaunch();
    },
    relaunch: () => deps.relaunch(),
    requestHostUpdate: (input) => deps.link.requestHostUpdate(input),
    createShortcut: () => deps.createShortcut(),
  });
}

async function pair(
  deps: ClientSessionControllerDeps,
  input: ClientSessionPairInput,
  now: () => number
): Promise<Result<void, ClientSessionError>> {
  const endpoints = ownerEndpoints(input.url);
  if (!endpoints.success) return err({ type: 'invalid', message: endpoints.error.message });
  const clientId = input.cfAccessClientId?.trim() ?? '';
  const clientSecret = input.cfAccessClientSecret?.trim() ?? '';
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    return err({
      type: 'invalid',
      message: 'Enter both the Cloudflare Access client ID and the client secret, or neither.',
    });
  }
  const cfAccess = clientId ? { clientId, clientSecret } : undefined;
  const code = input.code.trim();
  if (!code) return err({ type: 'invalid', message: 'Enter the pairing code from the host.' });

  const paired = await pairWithOwnerHost({
    baseUrl: endpoints.data.baseUrl,
    code,
    deviceName: deps.deviceName,
    cfAccess,
    fetch: deps.fetch,
  });
  if (!paired.success) return paired;

  const connection = {
    url: endpoints.data.baseUrl,
    hostId: paired.data.hostId,
    hostName: paired.data.hostName,
    deviceId: paired.data.deviceId,
    token: paired.data.token,
    ...(cfAccess && { cfAccess }),
    pairedAt: now(),
  };
  const saved = await deps.store.save(connection);
  if (saved) return err({ type: 'failed', message: saved.message });
  deps.log.info('client session: paired', {
    host: connection.hostName,
    deviceId: connection.deviceId,
  });

  // The forwarders are bound to the link that exists: a first pairing starts it, a re-pairing
  // restarts the process so nothing keeps talking to the old credential.
  if (deps.link.started) deps.relaunch();
  else deps.link.start(connection);
  return ok();
}
