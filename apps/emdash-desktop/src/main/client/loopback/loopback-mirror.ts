import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Logger } from '@emdash/shared/logger';
import { joinStreams } from '@main/owner-link/tunnel-protocol';
import { hostLoopbackFamilies, type HostTunnelDialer } from './tunnel-dialer';

// A loopback port of the host, mirrored on this computer's loopback so this computer's own
// browser can open it: the preview pill's "open in browser" for `http://localhost:5173`, and an
// OAuth sign-in the host started, whose provider sends the browser back to
// `http://127.0.0.1:<port>/callback` on the host. Each accepted connection is one tunnel. A
// mirror listens on 127.0.0.1 (and `::1` where it can) only, and closes after it has had no
// connection for `idleMs`.

const DEFAULT_IDLE_MS = 10 * 60_000;
const RANDOM_PORT_ATTEMPTS = 3;

export type LoopbackMirrorTarget = {
  /** The port on the host's loopback. */
  port: number;
  /** How the host page names its loopback (`localhost`, `127.0.0.1`, `[::1]`). */
  hostname: string;
  /**
   * The local port must equal the host port (an OAuth redirect URI names it). Otherwise a busy
   * local port is replaced by a free one, and the caller opens the URL with that port.
   */
  samePort: boolean;
};

export type LoopbackMirrors = {
  /** Starts (or keeps) a mirror of the host port and resolves with the local port to open. */
  ensure(target: LoopbackMirrorTarget): Promise<number>;
  /** Local ports currently mirrored, by host port. */
  active(): ReadonlyMap<number, number>;
  close(): Promise<void>;
};

type Mirror = {
  localPort: number;
  servers: Server[];
  connections: Set<Socket>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
};

export function createLoopbackMirrors(deps: {
  dialTunnel: HostTunnelDialer;
  log: Pick<Logger, 'info' | 'debug' | 'warn'>;
  idleMs?: number;
}): LoopbackMirrors {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const mirrors = new Map<number, Promise<Mirror>>();
  const settled = new Map<number, Mirror>();
  let closed = false;

  const stop = (hostPort: number, mirror: Mirror): void => {
    if (settled.get(hostPort) !== mirror) return;
    settled.delete(hostPort);
    mirrors.delete(hostPort);
    clearTimeout(mirror.idleTimer);
    for (const server of mirror.servers) server.close();
    for (const socket of mirror.connections) socket.destroy();
    deps.log.info('client mode: closed a host loopback mirror', {
      port: hostPort,
      localPort: mirror.localPort,
    });
  };

  const armIdle = (hostPort: number, mirror: Mirror): void => {
    clearTimeout(mirror.idleTimer);
    mirror.idleTimer = undefined;
    if (mirror.connections.size > 0) return;
    mirror.idleTimer = setTimeout(() => stop(hostPort, mirror), idleMs);
    mirror.idleTimer.unref?.();
  };

  const start = async (target: LoopbackMirrorTarget): Promise<Mirror> => {
    const mirror: Mirror = {
      localPort: 0,
      servers: [],
      connections: new Set(),
      idleTimer: undefined,
    };
    const onConnection = (socket: Socket): void => {
      socket.on('error', () => {});
      mirror.connections.add(socket);
      armIdle(target.port, mirror);
      socket.once('close', () => {
        mirror.connections.delete(socket);
        armIdle(target.port, mirror);
      });
      socket.pause();
      deps.dialTunnel(target.port, target.hostname).then(
        (tunnel) => {
          if (socket.destroyed) {
            tunnel.destroy();
            return;
          }
          joinStreams(socket, tunnel);
          socket.resume();
        },
        (error: unknown) => {
          deps.log.debug('client mode: host loopback mirror could not reach the host', {
            port: target.port,
            error: String(error),
          });
          socket.destroy();
        }
      );
    };
    const bound = await bindMirror(target, onConnection);
    mirror.servers = bound.servers;
    mirror.localPort = bound.port;
    deps.log.info('client mode: mirroring a host loopback port', {
      port: target.port,
      localPort: bound.port,
    });
    return mirror;
  };

  return {
    async ensure(target) {
      if (closed) throw new Error('Loopback mirrors are closed');
      if (!hostLoopbackFamilies(target.hostname)) {
        throw new Error(`Not a loopback address: ${target.hostname}`);
      }
      let pending = mirrors.get(target.port);
      if (!pending) {
        pending = start(target);
        mirrors.set(target.port, pending);
        pending.then(
          (mirror) => {
            if (closed) {
              for (const server of mirror.servers) server.close();
              return;
            }
            settled.set(target.port, mirror);
            armIdle(target.port, mirror);
          },
          () => mirrors.delete(target.port)
        );
      }
      const mirror = await pending;
      if (target.samePort && mirror.localPort !== target.port) {
        throw new Error(`Local port ${target.port} is in use on this computer`);
      }
      armIdle(target.port, mirror);
      return mirror.localPort;
    },
    active() {
      return new Map([...settled].map(([hostPort, mirror]) => [hostPort, mirror.localPort]));
    },
    async close() {
      closed = true;
      for (const [hostPort, mirror] of [...settled]) stop(hostPort, mirror);
      mirrors.clear();
    },
  };
}

/**
 * Listens on 127.0.0.1 and, where IPv6 exists, `::1` (a browser may try `localhost` on either).
 * For a URL to open (not `samePort`), a port held by another program on either address is
 * replaced by a free one, so the browser never reaches that program instead of the host.
 */
async function bindMirror(
  target: LoopbackMirrorTarget,
  onConnection: (socket: Socket) => void
): Promise<{ servers: Server[]; port: number }> {
  const ipv6Required = !target.samePort;
  try {
    return await bindPair(target.port, onConnection, ipv6Required);
  } catch (error) {
    if (target.samePort || !isAddressInUse(error)) throw error;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < RANDOM_PORT_ATTEMPTS; attempt += 1) {
    try {
      return await bindPair(0, onConnection, ipv6Required);
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) break;
    }
  }
  throw lastError;
}

async function bindPair(
  port: number,
  onConnection: (socket: Socket) => void,
  ipv6Required: boolean
): Promise<{ servers: Server[]; port: number }> {
  const v4 = await bind(port, '127.0.0.1', onConnection);
  const actual = (v4.address() as AddressInfo).port;
  try {
    const v6 = await bind(actual, '::1', onConnection);
    return { servers: [v4, v6], port: actual };
  } catch (error) {
    // No IPv6 loopback on this computer is fine; another program on `::1` is not, when the
    // browser might go there first.
    if (isAddressInUse(error) && ipv6Required) {
      v4.close();
      throw error;
    }
    return { servers: [v4], port: actual };
  }
}

function bind(
  port: number,
  address: string,
  onConnection: (socket: Socket) => void
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(onConnection);
    server.once('error', reject);
    server.listen({ port, host: address, exclusive: true }, () => {
      server.off('error', reject);
      server.on('error', () => {});
      resolve(server);
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}
