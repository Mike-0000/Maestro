import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '@emdash/shared/logger';
import { acceptWebSocketPipe, isWebSocketUpgrade } from '@emdash/wire/node';
import type { WireTransport } from '@emdash/wire/rpc';
import { OWNER_PATHS } from '@main/owner-link/endpoints';
import { v8MessageTransport } from '@main/owner-link/v8-transport';
import type { RemoteDevice, RemoteDeviceStore, RemoteOwnerAccessSettings } from '../device-store';
import type { RemoteAccessUpgradeRoute } from '../http-server';
import {
  authorizeOwnerRequest,
  ownerBearerCredential,
  type OwnerRequestContext,
} from './owner-auth';

// WebSocket upgrades of the owner tier. Both owner sockets (the Wire link here, and loopback
// tunnels in `tunnel-endpoint.ts`) are admitted by the same gate: no Origin, the owner network rule, then an owner
// device's bearer token. Frames are only decoded once the gate has let the request through.
//
// Status codes the client maps to its blocked states: 404 owner access is off, 403 the network
// rule refused the request (Tailscale required, or a login not on the allowlist), 401 the
// credential is unknown or revoked, or does not belong to an owner device.

export type AuthorizedOwnerUpgrade = { device: RemoteDevice; context: OwnerRequestContext };

export type OwnerUpgradeGate = {
  /**
   * Admits an owner upgrade, or answers the socket with the refusal and returns undefined. Call
   * only once owner access is known to be enabled.
   */
  authorize(request: IncomingMessage, socket: Duplex): AuthorizedOwnerUpgrade | undefined;
};

export function createOwnerUpgradeGate(options: {
  store: RemoteDeviceStore;
  settings(): RemoteOwnerAccessSettings;
  logger: Logger;
}): OwnerUpgradeGate {
  return {
    authorize(request, socket) {
      if (!isWebSocketUpgrade(request)) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return undefined;
      }
      const decision = authorizeOwnerRequest(request, options.settings());
      if (!decision.ok) {
        options.logger.warn('Owner connection refused', { reason: decision.reason });
        rejectUpgrade(socket, 403, 'Forbidden');
        return undefined;
      }
      const device = options.store.authenticate(ownerBearerCredential(request));
      // A desktop or browser credential is not an owner credential, whatever else it may reach.
      if (!device || device.kind !== 'owner') {
        options.logger.warn('Owner connection refused: unknown credential', {
          via: decision.context.via,
        });
        rejectUpgrade(socket, 401, 'Unauthorized');
        return undefined;
      }
      return { device, context: decision.context };
    },
  };
}

/** `GET /owner/wire`: the owner link, one V8-serialized Wire message per WebSocket message. */
export function createOwnerWireRoute(options: {
  enabled(): boolean;
  gate: OwnerUpgradeGate;
  onConnection(upgrade: AuthorizedOwnerUpgrade, transport: WireTransport): void;
}): RemoteAccessUpgradeRoute {
  return (request, socket, head, url) => {
    if (url.pathname !== OWNER_PATHS.wire) return false;
    // Off means absent: the listener's own 404 answers.
    if (!options.enabled()) return false;
    const upgrade = options.gate.authorize(request, socket);
    if (!upgrade) return true;
    const transport = v8MessageTransport(acceptWebSocketPipe(request, socket, head));
    options.onConnection(upgrade, transport);
    return true;
  };
}

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
