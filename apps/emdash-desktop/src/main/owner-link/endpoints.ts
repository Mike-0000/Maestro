import { ok, type Result } from '@emdash/shared';
import type { ConnectWebSocketOptions } from '@emdash/wire/node';
import {
  maestroHostHeaders,
  normalizeMaestroHostUrl,
  type MaestroHostRequestCredentials,
  type MaestroHostUrlError,
} from '@core/primitives/maestro-host/api/endpoint';

// Addresses of the owner tier on a Maestro host: pairing, the owner Wire link, and loopback
// tunnels. The client dials them and the host routes them, so both import the paths from here.

/** Request paths of the owner tier, relative to the host's base URL. */
export const OWNER_PATHS = {
  pair: '/api/owner/pair',
  pairingCode: '/api/owner/pairing-code',
  wire: '/owner/wire',
  tunnel: '/owner/tunnel',
} as const;

/** A loopback port on the host that a tunnel connects to. */
export type OwnerTunnelTarget = { port: number; family: 4 | 6 };

export type OwnerEndpoints = {
  /** Canonical base URL, as `normalizeMaestroHostUrl` returns it. */
  baseUrl: string;
  pairUrl: string;
  pairingCodeUrl: string;
  wireUrl: string;
  tunnelUrl(target: OwnerTunnelTarget): string;
};

/** Normalizes what the user typed and builds every owner endpoint from it. */
export function ownerEndpoints(input: string): Result<OwnerEndpoints, MaestroHostUrlError> {
  const normalized = normalizeMaestroHostUrl(input);
  if (!normalized.success) return normalized;
  const baseUrl = normalized.data;
  return ok({
    baseUrl,
    pairUrl: ownerPairUrl(baseUrl),
    pairingCodeUrl: ownerPairingCodeUrl(baseUrl),
    wireUrl: ownerWireUrl(baseUrl),
    tunnelUrl: (target: OwnerTunnelTarget) => ownerTunnelUrl(baseUrl, target),
  });
}

/** `POST` target that redeems an owner pairing code. `baseUrl` must already be normalized. */
export function ownerPairUrl(baseUrl: string): string {
  return `${baseUrl}${OWNER_PATHS.pair}`;
}

/** `POST` target that issues an owner pairing code (direct loopback with the setup token only). */
export function ownerPairingCodeUrl(baseUrl: string): string {
  return `${baseUrl}${OWNER_PATHS.pairingCode}`;
}

/** The owner Wire link: the same origin and path prefix, over `ws://` or `wss://`. */
export function ownerWireUrl(baseUrl: string): string {
  return `${webSocketBase(baseUrl)}${OWNER_PATHS.wire}`;
}

/** One tunnel to a loopback port on the host. Throws a `RangeError` for an invalid target. */
export function ownerTunnelUrl(baseUrl: string, target: OwnerTunnelTarget): string {
  if (!isValidTunnelPort(target.port)) {
    throw new RangeError(`Invalid tunnel port: ${target.port}`);
  }
  if (target.family !== 4 && target.family !== 6) {
    throw new RangeError(`Invalid tunnel address family: ${String(target.family)}`);
  }
  const query = new URLSearchParams({ port: String(target.port), family: String(target.family) });
  return `${webSocketBase(baseUrl)}${OWNER_PATHS.tunnel}?${query.toString()}`;
}

/** A TCP port a tunnel may name: an integer from 1 to 65535. */
export function isValidTunnelPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Dial options for an owner WebSocket (the Wire link or a tunnel): the bearer token and any
 * Cloudflare Access headers. No `Origin` header is ever sent; the host refuses upgrades with one.
 */
export function ownerDialOptions(
  url: string,
  credentials: MaestroHostRequestCredentials & { token: string },
  options: Pick<ConnectWebSocketOptions, 'signal' | 'timeoutMs' | 'pingIntervalMs'> = {}
): ConnectWebSocketOptions {
  return { ...options, url, headers: maestroHostHeaders(credentials) };
}

function webSocketBase(baseUrl: string): string {
  return baseUrl.replace(/^http/i, 'ws');
}
