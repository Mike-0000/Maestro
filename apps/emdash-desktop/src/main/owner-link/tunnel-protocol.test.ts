import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  joinStreams,
  parseTunnelTarget,
  tunnelLoopbackAddress,
  tunnelStream,
  type TunnelPipe,
} from './tunnel-protocol';

/** An in-memory pipe whose write buffer is "full" while `full` is set. */
function fakePipe() {
  const messages = new Set<(bytes: Uint8Array) => void>();
  const closes = new Set<() => void>();
  const drains = new Set<() => void>();
  const sent: Buffer[] = [];
  const state = { full: false, closed: false, paused: false, ended: false };
  const pipe: TunnelPipe = {
    get closed() {
      return state.closed;
    },
    send: (bytes) => {
      if (state.closed || state.ended) throw new Error('WebSocket is closed');
      sent.push(Buffer.from(bytes));
      return !state.full;
    },
    onMessage: (cb) => {
      messages.add(cb);
      return () => messages.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => closes.delete(cb);
    },
    onDrain: (cb) => {
      drains.add(cb);
      return () => drains.delete(cb);
    },
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
    },
    close: vi.fn(() => {
      if (state.closed) return;
      state.closed = true;
      for (const cb of [...closes]) cb();
    }),
    end: vi.fn(() => {
      state.ended = true;
    }),
  };
  return {
    pipe,
    sent,
    state,
    deliver: (text: string | Buffer) => {
      for (const cb of [...messages]) cb(Buffer.from(text));
    },
    drain: () => {
      state.full = false;
      for (const cb of [...drains]) cb();
    },
    peerClose: () => pipe.close(),
  };
}

describe('parseTunnelTarget', () => {
  it('accepts one port and one family', () => {
    expect(parseTunnelTarget(new URLSearchParams('port=5173&family=4'))).toEqual({
      port: 5173,
      family: 4,
    });
    expect(parseTunnelTarget(new URLSearchParams('family=6&port=1'))).toEqual({
      port: 1,
      family: 6,
    });
    expect(parseTunnelTarget(new URLSearchParams('port=65535&family=4'))).toEqual({
      port: 65_535,
      family: 4,
    });
  });

  it.each([
    '',
    'port=0&family=4',
    'port=65536&family=4',
    'port=-1&family=4',
    'port=1e3&family=4',
    'port=0x50&family=4',
    'port=123456&family=4',
    'port=80&family=',
    'port=80&family=4.0',
    'port=80&port=81&family=4',
    'port=80&family=4&family=6',
  ])('refuses %j', (query) => {
    expect(parseTunnelTarget(new URLSearchParams(query))).toBeNull();
  });

  it('maps each family to its loopback address and nothing else', () => {
    expect(tunnelLoopbackAddress(4)).toBe('127.0.0.1');
    expect(tunnelLoopbackAddress(6)).toBe('::1');
  });
});

describe('TunnelStream', () => {
  it('pushes messages as bytes and pauses the pipe when the reader falls behind', () => {
    const fake = fakePipe();
    const stream = tunnelStream(fake.pipe);
    stream.pause();
    const big = Buffer.alloc(64 * 1024);
    fake.deliver(big);
    expect(fake.state.paused).toBe(true);
    stream.read();
    expect(fake.state.paused).toBe(false);
  });

  it('holds the write callback until a full pipe drains', async () => {
    const fake = fakePipe();
    const stream = tunnelStream(fake.pipe);
    fake.state.full = true;
    const done = vi.fn();
    stream.write(Buffer.from('a'), done);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).not.toHaveBeenCalled();
    fake.drain();
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('releases a held write when the pipe closes, so the stream cannot hang', async () => {
    const fake = fakePipe();
    const stream = tunnelStream(fake.pipe);
    stream.on('error', () => {});
    fake.state.full = true;
    const done = vi.fn();
    stream.write(Buffer.from('a'), done);
    fake.peerClose();
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('splits a large write into messages of at most 1 MiB', async () => {
    const fake = fakePipe();
    const stream = tunnelStream(fake.pipe);
    await new Promise<void>((resolve) =>
      stream.write(Buffer.alloc(2.5 * 1024 * 1024), () => resolve())
    );
    expect(fake.sent.map((chunk) => chunk.byteLength)).toEqual([
      1024 * 1024,
      1024 * 1024,
      512 * 1024,
    ]);
  });

  it('ends the pipe gracefully on end() and closes it on destroy()', async () => {
    const ended = fakePipe();
    const stream = tunnelStream(ended.pipe);
    stream.resume();
    stream.end();
    await vi.waitFor(() => expect(ended.pipe.end).toHaveBeenCalled());
    expect(ended.pipe.close).not.toHaveBeenCalled();

    const destroyed = fakePipe();
    tunnelStream(destroyed.pipe).destroy();
    expect(destroyed.pipe.close).toHaveBeenCalled();
  });

  it('ends its readable side when the peer closes', async () => {
    const fake = fakePipe();
    const stream = tunnelStream(fake.pipe);
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const ended = new Promise<void>((resolve) => stream.once('end', () => resolve()));
    fake.deliver('last words');
    fake.peerClose();
    await ended;
    expect(chunks).toEqual(['last words']);
  });

  it('emulates net.Socket#setTimeout, including removing a callback with 0', async () => {
    const stream = tunnelStream(fakePipe().pipe);
    const onTimeout = vi.fn();
    stream.setTimeout(20, onTimeout);
    expect(stream.timeout).toBe(20);
    stream.setTimeout(0, onTimeout);
    expect(stream.listenerCount('timeout')).toBe(0);

    const fired = vi.fn();
    stream.setTimeout(10, fired);
    await vi.waitFor(() => expect(fired).toHaveBeenCalledTimes(1));
    expect(stream.setKeepAlive()).toBe(stream);
    expect(stream.setNoDelay()).toBe(stream);
    expect(stream.ref()).toBe(stream);
    expect(stream.unref()).toBe(stream);
  });
});

/** One end of a connection: what is written to it is recorded, what it "receives" is pushed. */
function endpoint() {
  const written: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  return { stream, written };
}

describe('joinStreams', () => {
  it('pumps both ways and ends the other side after a clean end', async () => {
    const a = endpoint();
    const b = endpoint();
    joinStreams(a.stream, b.stream);
    a.stream.push('from a');
    b.stream.push('from b');
    await vi.waitFor(() => expect(b.written).toEqual(['from a']));
    expect(a.written).toEqual(['from b']);
    a.stream.push(null);
    await vi.waitFor(() => expect(b.stream.writableEnded).toBe(true));
    expect(b.stream.destroyed).toBe(false);
  });

  it('destroys the other side when one side fails, then reports both closed', async () => {
    const a = endpoint();
    const b = endpoint();
    const onClosed = vi.fn();
    joinStreams(a.stream, b.stream, onClosed);
    a.stream.destroy(new Error('reset'));
    await vi.waitFor(() => expect(b.stream.destroyed).toBe(true));
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });
});
