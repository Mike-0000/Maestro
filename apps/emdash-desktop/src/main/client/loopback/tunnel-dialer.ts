import { isIPv4, isIPv6 } from 'node:net';
import type { Duplex } from 'node:stream';
import { connectWebSocketPipe, WebSocketHandshakeError } from '@emdash/wire/node';
import {
  ownerDialOptions,
  ownerTunnelUrl,
  type OwnerTunnelTarget,
} from '@main/owner-link/endpoints';
import { TUNNEL_STATUS, tunnelStream, type TunnelPipe } from '@main/owner-link/tunnel-protocol';
import type { ClientConnection } from '../connection-store';

// Opens tunnels to the host's loopback for this client's embedded browser and loopback mirrors.
// A name like `localhost` may mean either loopback family on the host (a dev server can listen on
// `::1` only), so the dialer tries IPv4 then IPv6 and remembers per port which one answered.

const DIAL_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;

/** Opens one tunnel to `port` on the host's loopback, as `hostname` names it. */
export type HostTunnelDialer = (port: number, hostname: string) => Promise<Duplex>;

/**
 * The host loopback families a hostname can mean, in the order to try them, or null when it is
 * not a loopback name. `localhost` and `*.localhost` are loopback by definition (Chromium resolves
 * them so too), `127.0.0.0/8` is IPv4 loopback and `::1` is IPv6 loopback. Every IPv4 loopback
 * address reaches `127.0.0.1` on the host, the only IPv4 address a tunnel connects to.
 */
export function hostLoopbackFamilies(hostname: string): readonly (4 | 6)[] | null {
  const host = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return [4, 6];
  if (isIPv4(host)) return host.startsWith('127.') ? [4] : null;
  if (isIPv6(host)) return host === '::1' || host === '0:0:0:0:0:0:0:1' ? [6] : null;
  return null;
}

export function createHostTunnelDialer(deps: {
  connect(target: OwnerTunnelTarget): Promise<TunnelPipe>;
  /** Resolves once the owner session is attached; the host refuses tunnels before that. */
  ready?: () => Promise<unknown>;
  readyTimeoutMs?: number;
}): HostTunnelDialer {
  // The family that answered last time for a port, tried first next time.
  const preferred = new Map<number, 4 | 6>();

  return async (port, hostname) => {
    const families = hostLoopbackFamilies(hostname);
    if (!families) throw new Error(`Not a loopback address: ${hostname}`);
    if (deps.ready) await waitAtMost(deps.ready(), deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const remembered = preferred.get(port);
    const order =
      remembered && families.includes(remembered)
        ? [remembered, ...families.filter((family) => family !== remembered)]
        : families;
    let lastError: unknown;
    for (const family of order) {
      try {
        const pipe = await deps.connect({ port, family });
        preferred.set(port, family);
        return tunnelStream(pipe);
      } catch (error) {
        lastError = error;
        // Only "nothing listens there" is worth the other family; any other refusal is final.
        const unreachable =
          error instanceof WebSocketHandshakeError &&
          error.statusCode === TUNNEL_STATUS.unreachable;
        if (!unreachable) break;
      }
    }
    throw lastError;
  };
}

/** Dials `/owner/tunnel` on the paired host with the owner credentials. */
export function ownerTunnelConnector(
  connection: Pick<ClientConnection, 'url' | 'token' | 'cfAccess'>
): (target: OwnerTunnelTarget) => Promise<TunnelPipe> {
  return (target) =>
    connectWebSocketPipe(
      ownerDialOptions(
        ownerTunnelUrl(connection.url, target),
        { token: connection.token, cfAccess: connection.cfAccess },
        { timeoutMs: DIAL_TIMEOUT_MS }
      )
    );
}

function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}
