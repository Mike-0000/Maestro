import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net';
import { noopLogger } from '@emdash/shared/logger';
import {
  connectWebSocketPipe,
  WebSocketHandshakeError,
  type WebSocketPipe,
} from '@emdash/wire/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_PATHS } from '@main/owner-link/endpoints';
import type { RemoteDevice } from '../device-store';
import type { OwnerTunnelAccess } from './owner-access';
import type { OwnerRequestContext } from './owner-auth';
import { rejectUpgrade, type OwnerUpgradeGate } from './owner-upgrade';
import { createOwnerTunnelRoute } from './tunnel-endpoint';

const TOKEN = 'owner-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const CONTEXT: OwnerRequestContext = { via: 'loopback', login: null };

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listenTcp(server: TcpServer, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
    closers.push(
      () =>
        new Promise<void>((done) => {
          server.close(() => done());
        })
    );
  });
}

/** A TCP server on the host's loopback that echoes and records where connections came from. */
async function echoServer(host = '127.0.0.1') {
  const sockets: Socket[] = [];
  const server = createTcpServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  closers.push(() => sockets.forEach((socket) => socket.destroy()));
  const port = await listenTcp(server, host);
  return { port, sockets };
}

function ipv6Available(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

type Harness = {
  base: string;
  listenerPort: number;
  enabled: { value: boolean };
  attached: { value: boolean };
  tracked: Set<() => void>;
  track: ReturnType<typeof vi.fn>;
};

async function startHost(options: { maxTunnels?: number } = {}): Promise<Harness> {
  const enabled = { value: true };
  const attached = { value: true };
  const tracked = new Set<() => void>();
  const gate: OwnerUpgradeGate = {
    authorize(request, socket) {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return undefined;
      }
      return { device: { id: 'device-1', kind: 'owner' } as RemoteDevice, context: CONTEXT };
    },
  };
  const track = vi.fn((_deviceId: string, _context: OwnerRequestContext, close: () => void) => {
    tracked.add(close);
    return () => tracked.delete(close);
  });
  const access: OwnerTunnelAccess = {
    enabled: () => enabled.value,
    gate,
    isAttached: (deviceId) => attached.value && deviceId === 'device-1',
    track,
  };
  const route = createOwnerTunnelRoute({
    access,
    logger: noopLogger,
    maxTunnels: options.maxTunnels,
  });
  const server: Server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://maestro.invalid');
    if (!route(request, socket, head, url)) rejectUpgrade(socket, 404, 'Not Found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const listenerPort = (server.address() as AddressInfo).port;
  return {
    base: `ws://127.0.0.1:${listenerPort}`,
    listenerPort,
    enabled,
    attached,
    tracked,
    track,
  };
}

async function openTunnel(
  host: Harness,
  query: string,
  headers: Record<string, string> = AUTH
): Promise<WebSocketPipe> {
  const pipe = await connectWebSocketPipe({
    url: `${host.base}${OWNER_PATHS.tunnel}?${query}`,
    headers,
  });
  closers.push(() => pipe.close());
  return pipe;
}

async function tunnelStatus(
  host: Harness,
  query: string,
  headers: Record<string, string> = AUTH
): Promise<number> {
  try {
    const pipe = await openTunnel(host, query, headers);
    pipe.close();
    return 101;
  } catch (error) {
    expect(error).toBeInstanceOf(WebSocketHandshakeError);
    return (error as WebSocketHandshakeError).statusCode ?? 0;
  }
}

function collect(pipe: WebSocketPipe): { bytes(): Buffer } {
  const chunks: Buffer[] = [];
  pipe.onMessage((bytes) => chunks.push(Buffer.from(bytes)));
  return { bytes: () => Buffer.concat(chunks) };
}

function closedPromise(pipe: WebSocketPipe): Promise<void> {
  return new Promise((resolve) => pipe.onClose(resolve));
}

describe('owner tunnel route', () => {
  let host: Harness;

  beforeEach(async () => {
    host = await startHost();
  });

  it('is absent while owner access is off', async () => {
    host.enabled.value = false;
    expect(await tunnelStatus(host, 'port=80&family=4')).toBe(404);
  });

  it('answers the gate refusal to a caller without an owner credential', async () => {
    const echo = await echoServer();
    expect(await tunnelStatus(host, `port=${echo.port}&family=4`, {})).toBe(401);
    expect(echo.sockets).toHaveLength(0);
  });

  it('refuses an owner device without an attached session, before touching the target', async () => {
    const echo = await echoServer();
    host.attached.value = false;
    expect(await tunnelStatus(host, `port=${echo.port}&family=4`)).toBe(409);
    expect(echo.sockets).toHaveLength(0);
    expect(host.track).not.toHaveBeenCalled();
  });

  it.each([
    ['no query', ''],
    ['no family', 'port=5173'],
    ['no port', 'family=4'],
    ['port 0', 'port=0&family=4'],
    ['port above 65535', 'port=65536&family=4'],
    ['a signed port', 'port=%2B80&family=4'],
    ['a fractional port', 'port=80.5&family=4'],
    ['a named port', 'port=http&family=4'],
    ['a padded port', 'port=%2080&family=4'],
    ['family 5', 'port=80&family=5'],
    ['a named family', 'port=80&family=ipv4'],
    ['two ports', 'port=80&port=81&family=4'],
    ['two families', 'port=80&family=4&family=6'],
  ])('refuses %s with 400', async (_label, query) => {
    expect(await tunnelStatus(host, query)).toBe(400);
  });

  it('ignores any host the caller names and connects to 127.0.0.1', async () => {
    const echo = await echoServer();
    const pipe = await openTunnel(host, `port=${echo.port}&family=4&host=example.com`);
    const received = collect(pipe);
    pipe.send(Buffer.from('ping'));
    await vi.waitFor(() => expect(received.bytes().toString()).toBe('ping'));
    expect(echo.sockets[0]!.remoteAddress).toBe('127.0.0.1');
  });

  it('refuses a tunnel to the remote-access listener itself', async () => {
    expect(await tunnelStatus(host, `port=${host.listenerPort}&family=4`)).toBe(403);
  });

  it('answers 502 when nothing listens on the target port', async () => {
    const free = createTcpServer();
    const port = await listenTcp(free);
    await new Promise<void>((resolve) => free.close(() => resolve()));
    expect(await tunnelStatus(host, `port=${port}&family=4`)).toBe(502);
    expect(host.tracked.size).toBe(0);
  });

  it('carries bytes both ways and is tracked for the device until it closes', async () => {
    const echo = await echoServer();
    const pipe = await openTunnel(host, `port=${echo.port}&family=4`);
    const received = collect(pipe);
    const payload = randomBytes(3 * 1024 * 1024);
    pipe.send(payload.subarray(0, 1024 * 1024));
    pipe.send(payload.subarray(1024 * 1024));
    await vi.waitFor(() => expect(received.bytes().byteLength).toBe(payload.byteLength), {
      timeout: 10_000,
    });
    expect(received.bytes().equals(payload)).toBe(true);
    expect(host.track).toHaveBeenCalledWith('device-1', CONTEXT, expect.any(Function));
    expect(host.tracked.size).toBe(1);

    pipe.close();
    await vi.waitFor(() => expect(echo.sockets[0]!.destroyed).toBe(true));
    await vi.waitFor(() => expect(host.tracked.size).toBe(0));
  });

  it('reaches ::1 for family 6', async () => {
    if (!(await ipv6Available())) return;
    const echo = await echoServer('::1');
    const pipe = await openTunnel(host, `port=${echo.port}&family=6`);
    const received = collect(pipe);
    pipe.send(Buffer.from('six'));
    await vi.waitFor(() => expect(received.bytes().toString()).toBe('six'));
    expect(echo.sockets[0]!.remoteAddress).toBe('::1');
    // The IPv4 family does not reach a server listening on ::1 only.
    expect(await tunnelStatus(host, `port=${echo.port}&family=4`)).toBe(502);
  });

  it('delivers everything the target sent before it closed, then closes the tunnel', async () => {
    const payload = randomBytes(8 * 1024 * 1024);
    const server = createTcpServer((socket) => socket.end(payload));
    const port = await listenTcp(server);
    const pipe = await openTunnel(host, `port=${port}&family=4`);
    const received = collect(pipe);
    await closedPromise(pipe);
    expect(received.bytes().equals(payload)).toBe(true);
  });

  it('closes the target connection when the client closes', async () => {
    const echo = await echoServer();
    const pipe = await openTunnel(host, `port=${echo.port}&family=4`);
    await vi.waitFor(() => expect(echo.sockets).toHaveLength(1));
    const ended = new Promise<void>((resolve) => echo.sockets[0]!.once('close', () => resolve()));
    pipe.close();
    await ended;
  });

  it('closes the tunnel and the target connection when the owner tier closes it (revocation)', async () => {
    const echo = await echoServer();
    const pipe = await openTunnel(host, `port=${echo.port}&family=4`);
    await vi.waitFor(() => expect(echo.sockets).toHaveLength(1));
    const closed = closedPromise(pipe);
    for (const close of [...host.tracked]) close();
    await closed;
    await vi.waitFor(() => expect(echo.sockets[0]!.destroyed).toBe(true));
  });

  it('stops reading from the target while the client does not read (backpressure)', async () => {
    const total = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024, 7);
    let written = 0;
    let stalledAt = -1;
    let resumeTarget: (() => void) | undefined;
    const server = createTcpServer((socket) => {
      socket.on('error', () => {});
      const pump = (): void => {
        while (written < total) {
          written += chunk.byteLength;
          if (!socket.write(chunk)) {
            if (stalledAt < 0) stalledAt = written;
            resumeTarget = pump;
            socket.once('drain', () => resumeTarget?.());
            return;
          }
        }
        socket.end();
      };
      pump();
    });
    const port = await listenTcp(server);
    const pipe = await openTunnel(host, `port=${port}&family=4`);
    pipe.pause();
    let receivedBytes = 0;
    pipe.onMessage((bytes) => {
      receivedBytes += bytes.byteLength;
    });

    // While the client is paused, the target is held back long before it has written everything.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const writtenWhilePaused = written;
    expect(stalledAt).toBeGreaterThan(0);
    expect(writtenWhilePaused).toBeLessThan(32 * 1024 * 1024);

    pipe.resume();
    await vi.waitFor(() => expect(receivedBytes).toBe(total), { timeout: 20_000 });
  });

  it('caps concurrent tunnels and frees a slot when one closes', async () => {
    const capped = await startHost({ maxTunnels: 2 });
    const echo = await echoServer();
    const first = await openTunnel(capped, `port=${echo.port}&family=4`);
    await openTunnel(capped, `port=${echo.port}&family=4`);
    expect(await tunnelStatus(capped, `port=${echo.port}&family=4`)).toBe(503);

    first.close();
    await vi.waitFor(() => expect(capped.tracked.size).toBe(1));
    expect(await tunnelStatus(capped, `port=${echo.port}&family=4`)).toBe(101);
  });
});
