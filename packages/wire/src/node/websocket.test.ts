import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WireMessage, WireTransport } from '../api/protocol';
import { webSocketTransport } from '../api/transports/websocket';
import {
  acceptWebSocket,
  connectWebSocket,
  isWebSocketUpgrade,
  WebSocketHandshakeError,
} from './websocket';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function listen(
  onTransport: (transport: WireTransport, authorization: string | undefined) => void,
  reject = false
): Promise<string> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (reject || !isWebSocketUpgrade(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    onTransport(acceptWebSocket(request, socket, head), request.headers.authorization);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/wire`;
}

function nextMessage(transport: WireTransport): Promise<WireMessage> {
  return new Promise((resolve) => {
    const off = transport.onMessage((message) => {
      off();
      resolve(message);
    });
  });
}

describe('node websocket transport', () => {
  it('exchanges messages in both directions and forwards request headers', async () => {
    let serverSide: WireTransport | undefined;
    let seenAuthorization: string | undefined;
    const url = await listen((transport, authorization) => {
      serverSide = transport;
      seenAuthorization = authorization;
    });

    const client = await connectWebSocket({ url, headers: { Authorization: 'Bearer token' } });
    expect(seenAuthorization).toBe('Bearer token');

    const received = nextMessage(serverSide!);
    client.post({ kind: 'cancel', id: 'call-1' });
    expect(await received).toEqual({ kind: 'cancel', id: 'call-1' });

    const reply = nextMessage(client);
    serverSide!.post({ kind: 'detach', topic: 'topic' });
    expect(await reply).toEqual({ kind: 'detach', topic: 'topic' });
    client.close?.();
  });

  it('carries large binary blob chunks intact', async () => {
    let serverSide: WireTransport | undefined;
    const url = await listen((transport) => {
      serverSide = transport;
    });
    const client = await connectWebSocket({ url });
    const data = new Uint8Array(300_000).map((_, index) => index % 251);

    const received = nextMessage(serverSide!);
    client.post({ kind: 'blob-chunk', channel: 'c', seq: 1, data });
    const message = await received;
    expect(message.kind).toBe('blob-chunk');
    expect(message.kind === 'blob-chunk' && Buffer.from(message.data).equals(data)).toBe(true);
    client.close?.();
  });

  it('reports a disconnect to the peer when one side closes', async () => {
    let serverSide: WireTransport | undefined;
    const url = await listen((transport) => {
      serverSide = transport;
    });
    const client = await connectWebSocket({ url });
    const disconnected = new Promise<void>((resolve) => serverSide!.onDisconnect(resolve));
    client.close?.();
    await disconnected;
  });

  it('rejects with the status code when the host refuses the upgrade', async () => {
    const url = await listen(() => {}, true);
    const error = await connectWebSocket({ url }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebSocketHandshakeError);
    expect((error as WebSocketHandshakeError).statusCode).toBe(401);
  });

  it('serves a WHATWG WebSocket client through the browser transport', async () => {
    let serverSide: WireTransport | undefined;
    const url = await listen((transport) => {
      serverSide = transport;
    });
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')));
    });
    const browser = webSocketTransport(socket);

    const received = nextMessage(serverSide!);
    browser.post({ kind: 'cancel', id: 'from-browser' });
    expect(await received).toEqual({ kind: 'cancel', id: 'from-browser' });

    const reply = nextMessage(browser);
    serverSide!.post({ kind: 'detach', topic: 'to-browser' });
    expect(await reply).toEqual({ kind: 'detach', topic: 'to-browser' });
    browser.close?.();
  });
});
