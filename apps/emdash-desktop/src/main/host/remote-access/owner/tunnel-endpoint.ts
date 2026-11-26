import { connect as connectTcp, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '@emdash/shared/logger';
import { acceptWebSocketPipe } from '@emdash/wire/node';
import { OWNER_PATHS } from '@main/owner-link/endpoints';
import {
  joinStreams,
  MAX_CONCURRENT_TUNNELS,
  parseTunnelTarget,
  TUNNEL_STATUS,
  tunnelLoopbackAddress,
  tunnelStream,
} from '@main/owner-link/tunnel-protocol';
import type { RemoteAccessUpgradeRoute } from '../http-server';
import type { OwnerTunnelAccess } from './owner-access';
import { rejectUpgrade } from './owner-upgrade';

// `GET /owner/tunnel?port=<1-65535>&family=4|6`: one TCP connection to this computer's loopback
// for the attached owner client (its embedded browser previews dev servers that run here, and
// OAuth redirects come back here). What it may reach is fixed by this file, not by the caller:
//
// - only an owner device that passed the owner gate (no Origin, the owner network rule, its
//   bearer token) and holds the attached owner session;
// - only `127.0.0.1` or `::1`, chosen by `family`; the caller never names a host;
// - never the port the request itself arrived on (this listener), so a tunnel cannot loop back
//   into remote access and present itself as a direct loopback caller;
// - at most `MAX_CONCURRENT_TUNNELS` at a time;
// - every tunnel is tracked by the owner tier and closed when the device is revoked, its session
//   ends, owner access is turned off or narrowed past it, or the tier is disposed.

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type OwnerTunnelRouteOptions = {
  access: OwnerTunnelAccess;
  logger: Logger;
  maxTunnels?: number;
  connectTimeoutMs?: number;
};

export function createOwnerTunnelRoute(options: OwnerTunnelRouteOptions): RemoteAccessUpgradeRoute {
  const maxTunnels = options.maxTunnels ?? MAX_CONCURRENT_TUNNELS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let active = 0;

  return (request, socket, head, url) => {
    if (url.pathname !== OWNER_PATHS.tunnel) return false;
    // Off means absent: the listener's own 404 answers.
    if (!options.access.enabled()) return false;
    const upgrade = options.access.gate.authorize(request, socket);
    if (!upgrade) return true;

    const target = parseTunnelTarget(url.searchParams);
    if (!target) {
      rejectUpgrade(socket, TUNNEL_STATUS.badTarget, 'Bad Request');
      return true;
    }
    if (target.port === request.socket.localPort) {
      options.logger.warn('Owner tunnel refused: the target is the remote-access listener');
      rejectUpgrade(socket, TUNNEL_STATUS.forbiddenTarget, 'Forbidden');
      return true;
    }
    const { device, context } = upgrade;
    if (!options.access.isAttached(device.id)) {
      rejectUpgrade(socket, TUNNEL_STATUS.notAttached, 'Conflict');
      return true;
    }
    if (active >= maxTunnels) {
      options.logger.warn('Owner tunnel refused: too many tunnels', { limit: maxTunnels });
      rejectUpgrade(socket, TUNNEL_STATUS.tooManyTunnels, 'Service Unavailable');
      return true;
    }

    active += 1;
    let released = false;
    let joined: Duplex | undefined;
    const tcp: Socket = connectTcp({
      host: tunnelLoopbackAddress(target.family),
      port: target.port,
    });
    const release = (): void => {
      if (released) return;
      released = true;
      active -= 1;
      untrack();
      clearTimeout(timer);
    };
    // Revocation, session end and narrowed settings close the tunnel at once.
    const untrack = options.access.track(device.id, context, () => {
      tcp.destroy();
      if (joined) joined.destroy();
      else socket.destroy();
      release();
    });
    const timer = setTimeout(() => tcp.destroy(new Error('connect timeout')), connectTimeoutMs);
    timer.unref?.();

    const abandon = (): void => {
      if (joined) return;
      tcp.destroy();
      release();
    };
    socket.once('close', abandon);

    tcp.once('error', () => {
      if (joined) return;
      if (!socket.destroyed) {
        rejectUpgrade(socket, TUNNEL_STATUS.unreachable, 'Bad Gateway');
      }
      release();
    });
    tcp.once('connect', () => {
      clearTimeout(timer);
      if (released || socket.destroyed) {
        tcp.destroy();
        release();
        return;
      }
      socket.off('close', abandon);
      tcp.setNoDelay(true);
      (socket as Partial<Socket>).setNoDelay?.(true);
      const tunnel = tunnelStream(acceptWebSocketPipe(request, socket, head));
      joined = tunnel;
      joinStreams(tcp, tunnel, release);
    });
    return true;
  };
}
