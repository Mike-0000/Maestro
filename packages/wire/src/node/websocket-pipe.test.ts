import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebSocketUpgrade, type WebSocketEndpointOptions } from './websocket';
import {
  acceptWebSocketPipe,
  connectWebSocketPipe,
  WEBSOCKET_MAX_MESSAGE_BYTES,
  type WebSocketPipe,
} from './websocket-pipe';

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

async function listenPipe(
  onPipe: (pipe: WebSocketPipe, authorization: string | undefined) => void,
  options: WebSocketEndpointOptions = {}
): Promise<string> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketUpgrade(request)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    onPipe(acceptWebSocketPipe(request, socket, head, options), request.headers.authorization);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/owner/wire`;
}

function nextBytes(pipe: WebSocketPipe): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const off = pipe.onMessage((bytes) => {
      off();
      resolve(bytes);
    });
  });
}

function closed(pipe: WebSocketPipe): Promise<void> {
  return new Promise((resolve) => pipe.onClose(resolve));
}

/** A hand-rolled client that completes the handshake and then sends only what the test writes. */
async function rawClient(url: string): Promise<Socket> {
  const { hostname, port, pathname } = new URL(url);
  const socket = connectTcp(Number(port), hostname);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(
    [
      `GET ${pathname} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      '',
      '',
    ].join('\r\n')
  );
  await new Promise<void>((resolve) => {
    let received = '';
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('latin1');
      if (!received.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve();
    };
    socket.on('data', onData);
  });
  return socket;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('node websocket pipe', () => {
  it('carries whole binary messages in both directions and forwards request headers', async () => {
    let serverSide: WebSocketPipe | undefined;
    let seenAuthorization: string | undefined;
    const url = await listenPipe((pipe, authorization) => {
      serverSide = pipe;
      seenAuthorization = authorization;
    });

    const client = await connectWebSocketPipe({ url, headers: { Authorization: 'Bearer owner' } });
    expect(seenAuthorization).toBe('Bearer owner');

    const received: Uint8Array[] = [];
    const three = new Promise<void>((resolve) => {
      serverSide!.onMessage((bytes) => {
        received.push(bytes);
        if (received.length === 3) resolve();
      });
    });
    client.send(Uint8Array.of(1));
    client.send(new Uint8Array(0));
    client.send(new Uint8Array(200_000).map((_, index) => index % 253));
    await three;
    expect(received.map((bytes) => bytes.byteLength)).toEqual([1, 0, 200_000]);
    expect(received[2]![199_999]).toBe(199_999 % 253);

    const reply = nextBytes(client);
    expect(serverSide!.send(Uint8Array.of(9, 8, 7))).toBe(true);
    expect(Array.from(await reply)).toEqual([9, 8, 7]);
    client.close();
  });

  it('keeps messages that arrive before the first listener', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
      pipe.send(Uint8Array.of(1));
      pipe.send(Uint8Array.of(2));
    });
    const client = await connectWebSocketPipe({ url });
    await delay(50);

    const received: number[] = [];
    client.onMessage((bytes) => received.push(bytes[0]!));
    expect(received).toEqual([1, 2]);
    serverSide!.send(Uint8Array.of(3));
    await delay(30);
    expect(received).toEqual([1, 2, 3]);
    client.close();
  });

  it('closes both ends when one side closes and refuses to send afterwards', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
    });
    const client = await connectWebSocketPipe({ url });
    const serverClosed = closed(serverSide!);
    const clientClosed = closed(client);

    client.close();
    await Promise.all([serverClosed, clientClosed]);
    expect(client.closed).toBe(true);
    expect(serverSide!.closed).toBe(true);
    expect(() => client.send(Uint8Array.of(1))).toThrow('WebSocket is closed');
    // A late subscriber still learns about the close.
    await closed(client);
  });

  it('end() delivers everything sent before it, then closes both ends', async () => {
    const received: number[] = [];
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
      pipe.onMessage((bytes) => received.push(bytes.byteLength));
    });
    const client = await connectWebSocketPipe({ url });
    await vi.waitFor(() => expect(serverSide).toBeDefined());
    const serverClosed = closed(serverSide!);
    const clientClosed = closed(client);

    // Far more than a socket buffer holds, so most of it is still queued when end() is called.
    const chunk = randomBytes(4 * 1024 * 1024);
    for (let index = 0; index < 8; index += 1) client.send(chunk);
    client.end();
    expect(() => client.send(Uint8Array.of(1))).toThrow('WebSocket is closed');

    await Promise.all([serverClosed, clientClosed]);
    expect(received).toEqual(Array.from({ length: 8 }, () => chunk.byteLength));
  });

  it('drops a peer that stops answering keepalive pings', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe(
      (pipe) => {
        serverSide = pipe;
      },
      { pingIntervalMs: 30 }
    );
    const silent = await rawClient(url);
    await delay(5);
    const start = Date.now();
    await closed(serverSide!);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    silent.destroy();
  });

  it('keeps a responsive peer, and a paused one, past several ping intervals', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe(
      (pipe) => {
        serverSide = pipe;
      },
      { pingIntervalMs: 20 }
    );
    const client = await connectWebSocketPipe({ url, pingIntervalMs: 20 });
    await delay(150);
    expect(serverSide!.closed).toBe(false);
    expect(client.closed).toBe(false);

    const received: number[] = [];
    client.onMessage((bytes) => received.push(bytes[0]!));
    client.pause();
    serverSide!.send(Uint8Array.of(5));
    await delay(150);
    expect(client.closed).toBe(false);
    expect(received).toEqual([]);
    client.resume();
    await delay(30);
    expect(received).toEqual([5]);
    client.close();
  });

  it('refuses to send a message over the cap without closing', async () => {
    const url = await listenPipe(() => {});
    const client = await connectWebSocketPipe({ url });
    expect(() => client.send(new Uint8Array(WEBSOCKET_MAX_MESSAGE_BYTES + 1))).toThrow(RangeError);
    expect(client.closed).toBe(false);
    client.close();
  });

  it('closes when a peer announces a message over the cap', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
    });
    const raw = await rawClient(url);
    await delay(5);
    const header = Buffer.alloc(14);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(WEBSOCKET_MAX_MESSAGE_BYTES + 1), 2);
    randomBytes(4).copy(header, 10);
    raw.write(header);
    await closed(serverSide!);
    raw.destroy();
  });

  it('closes when fragments add up to more than the cap', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
    });
    const raw = await rawClient(url);
    await delay(5);
    const half = WEBSOCKET_MAX_MESSAGE_BYTES / 2;
    // Unmasked, FIN clear: each frame says more fragments follow.
    const fragment = (opcode: number, length: number): Buffer => {
      const frame = Buffer.alloc(10 + length);
      frame[0] = opcode;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
      return frame;
    };
    raw.write(fragment(0x02, half));
    raw.write(fragment(0x00, half));
    raw.write(fragment(0x00, 1));
    await closed(serverSide!);
    raw.destroy();
  }, 30_000);

  it('reassembles frames that arrive a few bytes at a time', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
    });
    const raw = await rawClient(url);
    await delay(5);
    const masked = (opcode: number, payload: Buffer): Buffer => {
      const lengthBytes = payload.byteLength < 126 ? 0 : 2;
      const frame = Buffer.alloc(2 + lengthBytes + 4 + payload.byteLength);
      frame[0] = 0x80 | opcode;
      frame[1] = 0x80 | (lengthBytes === 0 ? payload.byteLength : 126);
      if (lengthBytes === 2) frame.writeUInt16BE(payload.byteLength, 2);
      const key = randomBytes(4);
      key.copy(frame, 2 + lengthBytes);
      for (let index = 0; index < payload.byteLength; index += 1) {
        frame[2 + lengthBytes + 4 + index] = payload[index]! ^ key[index & 3]!;
      }
      return frame;
    };
    const first = Buffer.alloc(300, 7);
    const second = Buffer.from('second');
    const bytes = Buffer.concat([
      masked(0x2, first),
      masked(0x9, Buffer.alloc(0)),
      masked(0x2, second),
    ]);

    const received: Uint8Array[] = [];
    const both = new Promise<void>((resolve) => {
      serverSide!.onMessage((message) => {
        received.push(message);
        if (received.length === 2) resolve();
      });
    });
    for (let offset = 0; offset < bytes.byteLength; offset += 3) {
      raw.write(bytes.subarray(offset, offset + 3));
      await delay(0);
    }
    await both;
    expect(Buffer.from(received[0]!).equals(first)).toBe(true);
    expect(Buffer.from(received[1]!).toString()).toBe('second');
    raw.destroy();
  });

  it('delivers a message of exactly the cap', async () => {
    let serverSide: WebSocketPipe | undefined;
    const url = await listenPipe((pipe) => {
      serverSide = pipe;
    });
    const client = await connectWebSocketPipe({ url });
    const data = new Uint8Array(WEBSOCKET_MAX_MESSAGE_BYTES);
    data[0] = 1;
    data[data.byteLength - 1] = 2;
    const received = nextBytes(serverSide!);
    client.send(data);
    const message = await received;
    expect(message.byteLength).toBe(WEBSOCKET_MAX_MESSAGE_BYTES);
    expect([message[0], message[message.byteLength - 1]]).toEqual([1, 2]);
    client.close();
  }, 30_000);
});
