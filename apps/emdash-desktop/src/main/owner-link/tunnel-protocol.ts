import { Duplex } from 'node:stream';
import type { WebSocketPipe } from '@emdash/wire/node';
import { isValidTunnelPort, type OwnerTunnelTarget } from './endpoints';

// `/owner/tunnel`: one WebSocket per TCP connection to a loopback port on the host, carrying raw
// bytes as binary messages (no framing of its own). The host answers the upgrade only once its
// TCP connection to the target is open, so a refused or unreachable target is an HTTP status on
// the handshake, never a half-open tunnel. Both ends pump bytes through `tunnelStream` and
// `joinStreams`, which keep TCP flow control end to end.

/** Statuses the host answers a tunnel upgrade with instead of `101`. */
export const TUNNEL_STATUS = {
  /** `port` or `family` is missing or invalid. */
  badTarget: 400,
  /** The target is a port the host does not tunnel to (its own remote-access listener). */
  forbiddenTarget: 403,
  /** The device has no attached owner session. */
  notAttached: 409,
  /** Nothing accepted the TCP connection on the host's loopback (or it timed out). */
  unreachable: 502,
  /** The host's concurrent tunnel limit is reached. */
  tooManyTunnels: 503,
} as const;

/** Concurrent tunnels a host keeps open at most. */
export const MAX_CONCURRENT_TUNNELS = 256;

/** Largest message a tunnel sends; well under the pipe's cap so one write never closes it. */
const MAX_TUNNEL_MESSAGE_BYTES = 1024 * 1024;

/**
 * Reads the target from a tunnel request's query. Only `port` (1-65535, digits only) and `family`
 * (`4` or `6`) are accepted; there is no host parameter, because the host only ever connects to
 * its own loopback address.
 */
export function parseTunnelTarget(query: URLSearchParams): OwnerTunnelTarget | null {
  const ports = query.getAll('port');
  const families = query.getAll('family');
  if (ports.length !== 1 || families.length !== 1) return null;
  const rawPort = ports[0]!;
  if (!/^[0-9]{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!isValidTunnelPort(port)) return null;
  const family = families[0] === '4' ? 4 : families[0] === '6' ? 6 : null;
  if (family === null) return null;
  return { port, family };
}

/** The only addresses a tunnel connects to. */
export function tunnelLoopbackAddress(family: 4 | 6): '127.0.0.1' | '::1' {
  return family === 4 ? '127.0.0.1' : '::1';
}

/** The pipe surface a tunnel stream uses (a real `WebSocketPipe`, or a test fake). */
export type TunnelPipe = Pick<
  WebSocketPipe,
  'send' | 'onMessage' | 'onClose' | 'onDrain' | 'pause' | 'resume' | 'close' | 'end' | 'closed'
>;

/**
 * A tunnel pipe as a Node `Duplex`. Backpressure goes both ways: a full readable buffer pauses
 * the WebSocket (TCP flow control towards the peer), and a full WebSocket write buffer holds the
 * write callback until it drains. Ending the stream ends the pipe gracefully, so bytes already
 * written are delivered; destroying it closes the pipe at once.
 *
 * It also carries the few `net.Socket` methods Node's HTTP agent calls on its sockets
 * (`setKeepAlive`, `setNoDelay`, `ref`, `unref`, `setTimeout`), so it can serve as a pooled
 * keep-alive connection for `http.request`.
 */
export class TunnelStream extends Duplex {
  /** Idle timeout in milliseconds, 0 when off (read by Node's HTTP agent). */
  timeout = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingWrite: (() => void) | undefined;

  constructor(private readonly channel: TunnelPipe) {
    super({ allowHalfOpen: false });
    channel.onMessage((bytes) => {
      this.touch();
      if (!this.push(bytes)) channel.pause();
    });
    channel.onClose(() => {
      this.releaseWrite();
      // End of the readable side; with `allowHalfOpen: false` the writable side follows.
      this.push(null);
    });
  }

  override _read(): void {
    this.channel.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.touch();
    // The peer is gone: what is written now has nowhere to go, and the stream is ending anyway.
    if (this.channel.closed) {
      callback();
      return;
    }
    let drained = true;
    try {
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_TUNNEL_MESSAGE_BYTES) {
        drained = this.channel.send(chunk.subarray(offset, offset + MAX_TUNNEL_MESSAGE_BYTES));
      }
    } catch {
      // Closed or ending between the check and the send.
      callback();
      return;
    }
    if (drained) {
      callback();
      return;
    }
    const off = this.channel.onDrain(() => this.releaseWrite());
    this.pendingWrite = () => {
      off();
      callback();
    };
  }

  override _final(callback: (error?: Error) => void): void {
    this.channel.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.clearIdleTimer();
    this.releaseWrite();
    this.channel.close();
    callback(error);
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /**
   * Emits `timeout` after `ms` without traffic, like `net.Socket#setTimeout`: 0 turns it off and
   * removes `callback` (Node's HTTP client relies on that to drop its listener).
   */
  setTimeout(ms: number, callback?: () => void): this {
    this.timeout = ms;
    if (callback) {
      if (ms === 0) this.removeListener('timeout', callback);
      else this.once('timeout', callback);
    }
    this.touch();
    return this;
  }

  private touch(): void {
    this.clearIdleTimer();
    if (this.timeout <= 0 || this.destroyed) return;
    this.idleTimer = setTimeout(() => this.emit('timeout'), this.timeout);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private releaseWrite(): void {
    const pending = this.pendingWrite;
    this.pendingWrite = undefined;
    pending?.();
  }
}

export function tunnelStream(pipe: TunnelPipe): TunnelStream {
  return new TunnelStream(pipe);
}

/**
 * Pumps bytes both ways between two streams. A clean end on one side ends the other after its
 * buffered bytes are written; an error or an abrupt close on one side destroys the other.
 * `onClosed` runs once, after both have closed.
 */
export function joinStreams(a: Duplex, b: Duplex, onClosed?: () => void): void {
  a.pipe(b);
  b.pipe(a);
  let open = 2;
  const closedSide = (from: Duplex, to: Duplex) => () => {
    if (!from.readableEnded || from.errored) to.destroy();
    open -= 1;
    if (open === 0) onClosed?.();
  };
  // Errors surface as `close`, handled above; without a listener they would be thrown.
  a.on('error', () => {});
  b.on('error', () => {});
  a.once('close', closedSide(a, b));
  b.once('close', closedSide(b, a));
}
