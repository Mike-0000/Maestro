import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { acceptWebSocketPipe, connectWebSocketPipe } from '@emdash/wire/node';
import type { LiveUpdate } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerDialOptions, ownerWireUrl, OWNER_PATHS } from '@main/owner-link/endpoints';
import { v8MessageTransport } from '@main/owner-link/v8-transport';
import type { ClientConnection } from './connection-store';
import { createHostLink, type HostLink } from './host-link';
import { createFakeOwnerHost, TEST_BUILD, type FakeOwnerHost } from './testing/fake-owner-host';

// The client's link against a stand-in host over a real WebSocket on loopback: the bearer token,
// the V8 framing, a procedure, a live model, an event stream, a network drop, and a revoked token.

const TOKEN = 'owner-token';

let server: Server;
let host: FakeOwnerHost;
let sockets: Set<Socket>;
let acceptedToken = TOKEN;
let link: HostLink | undefined;
let baseUrl: string;

beforeEach(async () => {
  host = createFakeOwnerHost();
  sockets = new Set();
  acceptedToken = TOKEN;
  server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket: Socket, head) => {
    if (request.url !== OWNER_PATHS.wire) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (request.headers.authorization !== `Bearer ${acceptedToken}` || request.headers.origin) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    host.accept(v8MessageTransport(acceptWebSocketPipe(request, socket, head)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  link?.close();
  link = undefined;
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function startLink(token = TOKEN): HostLink {
  const connection: ClientConnection = {
    url: baseUrl,
    hostId: 'host-1',
    hostName: 'vm',
    deviceId: 'device-1',
    token,
    pairedAt: 0,
  };
  link = createHostLink({
    build: TEST_BUILD,
    clientName: 'desk-pc',
    clientPlatform: 'win32',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    backoffMs: [20, 50],
    pingIntervalMs: 0,
    dial: (target, signal) =>
      connectWebSocketPipe(
        ownerDialOptions(
          ownerWireUrl(target.url),
          { token: target.token },
          { signal, timeoutMs: 2_000, pingIntervalMs: 1_000 }
        )
      ),
  });
  link.start(connection);
  return link;
}

describe('owner link over a WebSocket', () => {
  it('forwards a procedure, a live model and an event, and survives a drop', async () => {
    const owner = await startLink().ready();
    await expect(owner.desktop.mementos.deleteAll(undefined)).resolves.toEqual({
      success: true,
      data: { deleted: 3 },
    });
    await expect(
      owner.desktop.host.persistDroppedBlob({ bytes: new Uint8Array([1, 2, 3]), name: 'a.png' })
    ).resolves.toEqual({ success: true, path: '/home/dev/.drops/a.png' });
    expect(host.droppedBlobs).toEqual([{ name: 'a.png', size: 3 }]);

    const feed = owner.desktop.notifications.feed.state(undefined, 'list');
    const updates: LiveUpdate[] = [];
    await feed.attach((update) => updates.push(update));
    const events: string[] = [];
    await owner.desktop.notifications.delivery.subscribe(undefined, {
      onEvent: (event) => {
        if (event.type === 'open') events.push(event.notificationId);
      },
    });
    host.emitDelivery('first');
    await vi.waitFor(() => expect(events).toEqual(['first']));

    // The network drops: every socket dies. The link re-dials, re-attaches, and the
    // subscriptions follow it to the new connection.
    for (const socket of sockets) socket.destroy();
    await vi.waitFor(() => expect(host.attaches).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(link!.current().phase).toBe('connected'));
    host.emitDelivery('second');
    await vi.waitFor(() => expect(events).toEqual(['first', 'second']), { timeout: 3_000 });
    const before = updates.length;
    host.notifications.set({});
    host.notifications.set({
      n: {
        id: 'n',
        kind: 'k',
        groupKey: 'g',
        title: 't',
        body: 'b',
        target: { kind: 'update' },
        source: { kind: 'app' },
        sound: null,
        count: 1,
        createdAt: 1,
        readAt: null,
      },
    });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(before), { timeout: 3_000 });
  });

  it('blocks as revoked when the host refuses the token', async () => {
    const revoked = startLink('stale-token');
    await vi.waitFor(() => expect(revoked.current().blocked?.reason).toBe('revoked'));
    acceptedToken = 'stale-token';
    revoked.retryNow();
    await revoked.ready();
    expect(revoked.current().phase).toBe('connected');
  });
});
