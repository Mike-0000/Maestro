import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { WireTransport } from '../api/protocol';
import { streamTransport } from '../api/transports/stream';

// A small RFC 6455 endpoint, both sides, carrying binary messages only. Wire needs nothing a
// general WebSocket library adds, and owning the handshake lets a client send the request
// headers (bearer token, proxy credentials) that the WHATWG constructor cannot.

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export type WebSocketEndpointOptions = {
  /** Interval between keepalive pings; a peer silent for two intervals is dropped. 0 disables. */
  pingIntervalMs?: number;
};

export type ConnectWebSocketOptions = WebSocketEndpointOptions & {
  /** `ws://`, `wss://`, `http://`, or `https://` URL of the endpoint. */
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** The handshake was answered with something other than `101 Switching Protocols`. */
export class WebSocketHandshakeError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = 'WebSocketHandshakeError';
  }
}

/** True when the request asks to upgrade to a version 13 WebSocket. */
export function isWebSocketUpgrade(request: IncomingMessage): boolean {
  return (
    request.method === 'GET' &&
    String(request.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    typeof request.headers['sec-websocket-key'] === 'string' &&
    request.headers['sec-websocket-version'] === '13'
  );
}

/**
 * Completes a server-side handshake on an `upgrade` event's socket and returns the Wire
 * transport. The caller authenticates the request first; this only speaks the protocol.
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Uint8Array,
  options: WebSocketEndpointOptions = {}
): WireTransport {
  const key = String(request.headers['sec-websocket-key']);
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n')
  );
  return frameTransport(socket, head, { mask: false, ...options });
}

/** Dials a WebSocket endpoint and resolves once the upgrade completes. */
export function connectWebSocket(options: ConnectWebSocketOptions): Promise<WireTransport> {
  const url = new URL(options.url);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const key = randomBytes(16).toString('base64');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise<WireTransport>((resolve, reject) => {
    let settled = false;
    const request = (secure ? httpsRequest : httpRequest)({
      host: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        ...options.headers,
        Host: url.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    const timer = setTimeout(
      () => fail(new WebSocketHandshakeError('Timed out connecting to the host')),
      timeoutMs
    );
    const onAbort = (): void => fail(new Error('Connection attempt cancelled'));

    function finish(): void {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: Error): void {
      if (settled) return;
      finish();
      request.destroy();
      reject(error);
    }

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    request.on('error', (error) => fail(error));
    request.on('response', (response) => {
      response.resume();
      fail(
        new WebSocketHandshakeError(
          `The host refused the connection (HTTP ${response.statusCode ?? 'unknown'})`,
          response.statusCode
        )
      );
    });
    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        fail(new WebSocketHandshakeError('The host sent an invalid WebSocket handshake'));
        return;
      }
      finish();
      resolve(frameTransport(socket, head, { mask: true, pingIntervalMs: options.pingIntervalMs }));
    });
    request.end();
  });
}

function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64');
}

type FrameTransportOptions = WebSocketEndpointOptions & {
  /** Clients mask what they send and servers must not (RFC 6455 §5.3). */
  mask: boolean;
};

function frameTransport(
  socket: Duplex,
  head: Uint8Array,
  options: FrameTransportOptions
): WireTransport {
  const messages = new EventEmitter();
  let pending: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let fragmented = false;
  let closed = false;
  let alive = true;

  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer =
    pingIntervalMs > 0
      ? setInterval(() => {
          if (!alive) {
            shutdown();
            return;
          }
          alive = false;
          send(OP_PING, Buffer.alloc(0));
        }, pingIntervalMs)
      : undefined;
  pingTimer?.unref?.();

  function send(opcode: number, payload: Uint8Array): void {
    if (closed || socket.destroyed) return;
    socket.write(encodeFrame(opcode, payload, options.mask));
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    socket.destroy();
    messages.emit('close');
  }

  function onData(chunk: Buffer): void {
    if (closed) return;
    alive = true;
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const frame = decodeFrame(pending);
      if (frame === 'invalid') {
        shutdown();
        return;
      }
      if (!frame) return;
      pending = pending.subarray(frame.consumed);
      if (!handleFrame(frame)) return;
    }
  }

  function handleFrame(frame: DecodedFrame): boolean {
    switch (frame.opcode) {
      case OP_PING:
        send(OP_PONG, frame.payload);
        return true;
      case OP_PONG:
        return true;
      case OP_CLOSE:
        send(OP_CLOSE, frame.payload.subarray(0, 2));
        shutdown();
        return false;
      case OP_TEXT:
      case OP_BINARY:
      case OP_CONTINUATION: {
        if (frame.opcode === OP_CONTINUATION ? !fragmented : fragmented) {
          shutdown();
          return false;
        }
        fragmentBytes += frame.payload.byteLength;
        if (fragmentBytes > MAX_MESSAGE_BYTES) {
          shutdown();
          return false;
        }
        if (frame.fin && !fragmented) {
          fragmentBytes = 0;
          messages.emit('data', frame.payload);
          return true;
        }
        fragments.push(frame.payload);
        fragmented = !frame.fin;
        if (frame.fin) {
          const message = Buffer.concat(fragments);
          fragments = [];
          fragmentBytes = 0;
          messages.emit('data', message);
        }
        return true;
      }
      default:
        shutdown();
        return false;
    }
  }

  socket.on('data', onData);
  socket.on('close', shutdown);
  socket.on('end', shutdown);
  socket.on('error', shutdown);

  const transport = streamTransport(messages, {
    write(chunk) {
      if (closed) throw new Error('WebSocket is closed');
      send(OP_BINARY, typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
  });
  if (head.byteLength > 0) queueMicrotask(() => onData(Buffer.from(head)));

  return {
    ...transport,
    close() {
      send(OP_CLOSE, Buffer.from([0x03, 0xe8]));
      transport.close?.();
      shutdown();
    },
  };
}

type DecodedFrame = {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  consumed: number;
};

function decodeFrame(buffer: Buffer): DecodedFrame | 'invalid' | undefined {
  if (buffer.byteLength < 2) return undefined;
  const first = buffer[0]!;
  const second = buffer[1]!;
  // Reserved bits are only meaningful with a negotiated extension, and none is offered.
  if ((first & 0x70) !== 0) return 'invalid';
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.byteLength < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.byteLength < 10) return undefined;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(MAX_MESSAGE_BYTES)) return 'invalid';
    length = Number(wide);
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES) return 'invalid';
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.byteLength < offset + length) return undefined;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = payload[index]! ^ buffer[maskOffset + (index & 3)]!;
    }
  }
  return {
    fin: (first & 0x80) !== 0,
    opcode: first & 0x0f,
    payload,
    consumed: offset + length,
  };
}

function encodeFrame(opcode: number, payload: Uint8Array, mask: boolean): Buffer {
  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length < 0x10000 ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + lengthBytes + (mask ? 4 : 0) + length);
  frame[0] = 0x80 | opcode;
  const maskBit = mask ? 0x80 : 0;
  if (lengthBytes === 0) {
    frame[1] = maskBit | length;
  } else if (lengthBytes === 2) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  let offset = 2 + lengthBytes;
  if (mask) {
    const key = randomBytes(4);
    key.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < length; index += 1) {
      frame[offset + index] = payload[index]! ^ key[index & 3]!;
    }
  } else {
    frame.set(payload, offset);
  }
  return frame;
}
