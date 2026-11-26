import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { noopLogger } from '@emdash/shared/logger';
import { acceptWebSocketPipe, isWebSocketUpgrade } from '@emdash/wire/node';
import { vi } from 'vitest';
import type { RemoteDevice } from '@main/host/remote-access/device-store';
import type { OwnerTunnelAccess } from '@main/host/remote-access/owner/owner-access';
import { rejectUpgrade } from '@main/host/remote-access/owner/owner-upgrade';
import { createOwnerTunnelRoute } from '@main/host/remote-access/owner/tunnel-endpoint';

// Test fixtures for the client's loopback bridges: a "host" serving the real `/owner/tunnel`
// route over a real loopback WebSocket, and a "dev server" with HTTP and WebSocket endpoints.
// In tests the host's loopback and this computer's are the same machine, so tests count the
// tunnels the host opened to prove traffic went through one.

export const TUNNEL_HOST_TOKEN = 'owner-token';

export type TunnelHost = {
  /** Base URL as the client stores it. */
  url: string;
  attached: { value: boolean };
  /** Tunnels the host has opened so far. */
  tunnelCount(): number;
  /** Tunnels open right now. */
  openTunnels(): number;
  /** Closes every open tunnel, as revoking the device does. */
  revoke(): void;
  close(): Promise<void>;
};

export async function startTunnelHost(): Promise<TunnelHost> {
  const attached = { value: true };
  const tracked = new Set<() => void>();
  let opened = 0;
  const access: OwnerTunnelAccess = {
    enabled: () => true,
    gate: {
      authorize(request, socket) {
        if (request.headers.authorization !== `Bearer ${TUNNEL_HOST_TOKEN}`) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return undefined;
        }
        return {
          device: { id: 'device-1', kind: 'owner' } as RemoteDevice,
          context: { via: 'loopback', login: null },
        };
      },
    },
    isAttached: () => attached.value,
    track: vi.fn((_deviceId: string, _context: unknown, close: () => void) => {
      opened += 1;
      tracked.add(close);
      return () => tracked.delete(close);
    }),
  };
  const route = createOwnerTunnelRoute({ access, logger: noopLogger });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://maestro.invalid');
    if (!route(request, socket, head, url)) rejectUpgrade(socket, 404, 'Not Found');
  });
  const port = await listen(server, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}`,
    attached,
    tunnelCount: () => opened,
    openTunnels: () => tracked.size,
    revoke: () => {
      for (const close of [...tracked]) close();
    },
    close: () => closeServer(server),
  };
}

export type DevServer = {
  port: number;
  /** Requests the server saw, with their headers. */
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }>;
  close(): Promise<void>;
};

/**
 * A dev server: `/echo` answers the request as JSON, `/cookies` sets two cookies, `/big` sends
 * `?bytes=` bytes, `POST /upload` answers 201 with the body length, and `/ws` is a WebSocket
 * that echoes each message.
 */
export async function startDevServer(host = '127.0.0.1'): Promise<DevServer> {
  const requests: DevServer['requests'] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    const url = new URL(request.url ?? '/', 'http://dev.invalid');
    if (url.pathname === '/cookies') {
      response.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
      response.end('cookies');
      return;
    }
    if (url.pathname === '/big') {
      response.end(Buffer.alloc(Number(url.searchParams.get('bytes') ?? 0), 'x'));
      return;
    }
    if (url.pathname === '/upload' && request.method === 'POST') {
      let length = 0;
      request.on('data', (chunk: Buffer) => (length += chunk.byteLength));
      request.on('end', () => {
        response.statusCode = 201;
        response.end(String(length));
      });
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({ method: request.method, url: request.url, headers: request.headers })
    );
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws' || !isWebSocketUpgrade(request)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const pipe = acceptWebSocketPipe(request, socket, head);
    pipe.onMessage((bytes) => pipe.send(bytes));
  });
  const port = await listen(server, host);
  return { port, requests, close: () => closeServer(server) };
}

/** Reads from `socket` until `delimiter`, returning what came before it and what came after. */
export function readUntil(
  socket: Socket,
  delimiter = '\r\n\r\n'
): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const index = buffered.indexOf(delimiter);
      if (index < 0) return;
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      resolve({
        head: buffered.subarray(0, index).toString('latin1'),
        rest: buffered.subarray(index + delimiter.length),
      });
    };
    const onClose = (): void => reject(new Error(`closed before ${JSON.stringify(delimiter)}`));
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.resume();
  });
}

export async function connectRaw(port: number): Promise<Socket> {
  const socket = connectTcp(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Sends a WebSocket upgrade request over an open socket and returns the status line. */
export async function webSocketHandshake(
  socket: Socket,
  requestTarget: string,
  hostHeader: string,
  extraHeaders: string[] = []
): Promise<string> {
  socket.write(
    [
      `GET ${requestTarget} HTTP/1.1`,
      `Host: ${hostHeader}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      ...extraHeaders,
      '',
      '',
    ].join('\r\n')
  );
  const { head } = await readUntil(socket);
  return head.split('\r\n')[0]!;
}

/** Sends one short masked binary frame and resolves with the payload of the reply frame. */
export async function webSocketEcho(socket: Socket, text: string): Promise<string> {
  const payload = Buffer.from(text);
  if (payload.byteLength > 125) throw new Error('short frames only');
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.byteLength);
  frame[0] = 0x82;
  frame[1] = 0x80 | payload.byteLength;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[6 + index] = payload[index]! ^ mask[index & 3]!;
  }
  const reply = new Promise<string>((resolve) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 2) return;
      const length = buffered[1]! & 0x7f;
      if (buffered.byteLength < 2 + length) return;
      socket.off('data', onData);
      resolve(buffered.subarray(2, 2 + length).toString());
    };
    socket.on('data', onData);
    socket.resume();
  });
  socket.write(frame);
  return await reply;
}

export function ipv6Available(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

function listen(server: Server, host: string): Promise<number> {
  const sockets = new Set<Socket>();
  serverSockets.set(server, sockets);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Upgraded sockets are no longer the HTTP server's to close.
    for (const socket of serverSockets.get(server) ?? []) socket.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
