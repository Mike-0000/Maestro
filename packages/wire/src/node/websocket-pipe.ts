import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Unsubscribe } from '@emdash/shared';
import {
  WebSocketHandshakeError,
  type ConnectWebSocketOptions,
  type WebSocketEndpointOptions,
} from './websocket';

// One WebSocket as a pipe of whole binary messages, below the Wire framing. It speaks the same
// RFC 6455 subset as `./websocket` (which carries the Wire transport and is left as it is); the
// handshake and frame helpers are duplicated here on purpose so that transport never changes
// because of this one.

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
/** How long `end()` waits for the peer to acknowledge the close before tearing the socket down. */
const END_GRACE_MS = 10_000;

/**
 * One WebSocket as a pipe of binary messages, below the Wire framing. Each `send` is one
 * WebSocket message and each `onMessage` callback receives one whole message, so a caller can
 * put its own encoding on top (the owner link sends one V8-serialized Wire message per WebSocket
 * message; a tunnel sends raw bytes).
 */
export type WebSocketPipe = {
  /**
   * Sends one binary message. Throws once the pipe is closed, and a `RangeError` for a message
   * larger than {@link WEBSOCKET_MAX_MESSAGE_BYTES}, which the peer would refuse. Returns false
   * when the socket's write buffer is full; `onDrain` fires once it has emptied.
   */
  send(bytes: Uint8Array): boolean;
  /**
   * Receives whole messages. Messages that arrive before the first listener is added are kept
   * and handed to that listener, so nothing is lost between the handshake and the subscription.
   */
  onMessage(cb: (bytes: Uint8Array) => void): Unsubscribe;
  /** Fires once when the pipe closes for any reason; immediately (next microtask) if it has. */
  onClose(cb: () => void): Unsubscribe;
  /** Fires when a full write buffer has drained. */
  onDrain(cb: () => void): Unsubscribe;
  /** Stops reading from the socket (TCP flow control); keepalive does not drop a paused peer. */
  pause(): void;
  resume(): void;
  /** Sends a normal close frame and tears the socket down, dropping anything not yet written. */
  close(): void;
  /**
   * Closes gracefully: the close frame goes out behind every message already sent, and the
   * socket is torn down once the peer acknowledges it (or after a grace period). Sending is
   * refused from here on; messages still arriving are delivered.
   */
  end(): void;
  readonly closed: boolean;
};

/** Largest single message either side accepts; a bigger one closes the connection. */
export const WEBSOCKET_MAX_MESSAGE_BYTES = MAX_MESSAGE_BYTES;

/**
 * Completes a server-side handshake on an `upgrade` event's socket and returns the message pipe.
 * The caller authenticates the request first; this only speaks the protocol.
 */
export function acceptWebSocketPipe(
  request: IncomingMessage,
  socket: Duplex,
  head: Uint8Array,
  options: WebSocketEndpointOptions = {}
): WebSocketPipe {
  writeServerHandshake(request, socket);
  return openFramePipe(socket, head, { mask: false, ...options });
}

/** Dials a WebSocket endpoint and resolves with the message pipe once the upgrade completes. */
export function connectWebSocketPipe(options: ConnectWebSocketOptions): Promise<WebSocketPipe> {
  return dialWebSocket(options).then(({ socket, head }) =>
    openFramePipe(socket, head, { mask: true, pingIntervalMs: options.pingIntervalMs })
  );
}

function writeServerHandshake(request: IncomingMessage, socket: Duplex): void {
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
}

function dialWebSocket(
  options: ConnectWebSocketOptions
): Promise<{ socket: Duplex; head: Buffer }> {
  const url = new URL(options.url);
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const key = randomBytes(16).toString('base64');
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise<{ socket: Duplex; head: Buffer }>((resolve, reject) => {
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
      resolve({ socket, head });
    });
    request.end();
  });
}

function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64');
}

type FramePipeOptions = WebSocketEndpointOptions & {
  /** Clients mask what they send and servers must not (RFC 6455 §5.3). */
  mask: boolean;
};

function openFramePipe(socket: Duplex, head: Uint8Array, options: FramePipeOptions): WebSocketPipe {
  const messageListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  const drainListeners = new Set<() => void>();
  // Messages that arrived before anyone listened; dropped once the first listener takes them.
  let backlog: Buffer[] | undefined = [];
  let pending: Buffer = Buffer.alloc(0);
  // Chunks of an incomplete frame, joined once the whole frame is here rather than on every
  // chunk, so a large message costs one copy instead of one per socket read.
  let queued: Buffer[] = [];
  let queuedBytes = 0;
  let neededBytes = 0;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let fragmented = false;
  let closed = false;
  let ending = false;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let alive = true;

  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer =
    pingIntervalMs > 0
      ? setInterval(() => {
          if (!alive && !paused) {
            shutdown();
            return;
          }
          alive = false;
          send(OP_PING, Buffer.alloc(0));
        }, pingIntervalMs)
      : undefined;
  pingTimer?.unref?.();

  function send(opcode: number, payload: Uint8Array): boolean {
    if (closed || socket.destroyed || socket.writableEnded) return false;
    return socket.write(encodeFrame(opcode, payload, options.mask));
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    clearTimeout(endTimer);
    socket.destroy();
    backlog = undefined;
    const listeners = [...closeListeners];
    closeListeners.clear();
    messageListeners.clear();
    drainListeners.clear();
    for (const listener of listeners) invoke(listener);
  }

  function deliver(message: Buffer): void {
    if (backlog) {
      backlog.push(message);
      return;
    }
    for (const listener of [...messageListeners]) invoke(listener, message);
  }

  function onData(chunk: Buffer): void {
    if (closed) return;
    alive = true;
    if (pending.byteLength + queuedBytes + chunk.byteLength < neededBytes) {
      queued.push(chunk);
      queuedBytes += chunk.byteLength;
      return;
    }
    pending =
      pending.byteLength === 0 && queued.length === 0
        ? chunk
        : Buffer.concat([pending, ...queued, chunk]);
    queued = [];
    queuedBytes = 0;
    neededBytes = 0;
    for (;;) {
      const frame = decodeFrame(pending);
      if (frame === 'invalid') {
        shutdown();
        return;
      }
      if (!frame) {
        neededBytes = frameBytesNeeded(pending);
        return;
      }
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
          deliver(frame.payload);
          return !closed;
        }
        fragments.push(frame.payload);
        fragmented = !frame.fin;
        if (frame.fin) {
          const message = Buffer.concat(fragments);
          fragments = [];
          fragmentBytes = 0;
          deliver(message);
        }
        return !closed;
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
  socket.on('drain', () => {
    for (const listener of [...drainListeners]) invoke(listener);
  });
  if (head.byteLength > 0) queueMicrotask(() => onData(Buffer.from(head)));

  return {
    get closed() {
      return closed;
    },
    send(bytes) {
      if (closed || ending) throw new Error('WebSocket is closed');
      if (bytes.byteLength > MAX_MESSAGE_BYTES) {
        throw new RangeError(
          `WebSocket message of ${bytes.byteLength} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`
        );
      }
      return send(OP_BINARY, bytes);
    },
    onMessage(cb) {
      if (closed) return () => {};
      messageListeners.add(cb);
      if (backlog) {
        const queued = backlog;
        backlog = undefined;
        for (const message of queued) {
          if (closed) break;
          invoke(cb, message);
        }
      }
      return () => messageListeners.delete(cb);
    },
    onClose(cb) {
      if (closed) {
        queueMicrotask(cb);
        return () => {};
      }
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    onDrain(cb) {
      if (closed) return () => {};
      drainListeners.add(cb);
      return () => drainListeners.delete(cb);
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      socket.pause();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      alive = true;
      socket.resume();
    },
    close() {
      send(OP_CLOSE, Buffer.from([0x03, 0xe8]));
      shutdown();
    },
    end() {
      if (closed || ending) return;
      ending = true;
      send(OP_CLOSE, Buffer.from([0x03, 0xe8]));
      // Flushes what is queued, then half-closes; the peer's close reply (or its FIN) shuts down.
      socket.end();
      endTimer = setTimeout(shutdown, END_GRACE_MS);
      endTimer.unref?.();
    },
  };
}

/** Listener errors are contained so one subscriber cannot break the framing loop. */
function invoke<Args extends unknown[]>(listener: (...args: Args) => void, ...args: Args): void {
  try {
    listener(...args);
  } catch {
    // The subscriber owns its errors; the pipe keeps serving the others.
  }
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

/** Bytes the frame at the start of `buffer` occupies, or the header bytes still needed to tell. */
function frameBytesNeeded(buffer: Buffer): number {
  if (buffer.byteLength < 2) return 2;
  const second = buffer[1]!;
  const shortLength = second & 0x7f;
  const headerBytes = 2 + (shortLength === 126 ? 2 : shortLength === 127 ? 8 : 0);
  if (buffer.byteLength < headerBytes) return headerBytes;
  const length =
    shortLength === 126
      ? buffer.readUInt16BE(2)
      : shortLength === 127
        ? Number(buffer.readBigUInt64BE(2))
        : shortLength;
  return headerBytes + ((second & 0x80) !== 0 ? 4 : 0) + length;
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
