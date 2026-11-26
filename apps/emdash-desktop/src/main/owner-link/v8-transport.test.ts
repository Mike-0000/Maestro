import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serialize } from 'node:v8';
import { ok, type Unsubscribe } from '@emdash/shared';
import { waitFor } from '@emdash/shared/testing';
import { createEventStreamHost } from '@emdash/wire/live';
import {
  acceptWebSocketPipe,
  connectWebSocketPipe,
  isWebSocketUpgrade,
  type WebSocketPipe,
} from '@emdash/wire/node';
import {
  client,
  connect,
  createController,
  defineContract,
  eventStream,
  liveModel,
  liveState,
  mutation,
  procedure,
  serve,
  uploadFile,
  WireError,
  type WireMessage,
  type WireTransport,
} from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deserializeWireValue, v8MessageTransport, type V8MessagePipe } from './v8-transport';

/** Two in-memory pipes wired back to back, delivering asynchronously like a socket. */
function pipePair(): { left: FakePipe; right: FakePipe } {
  const left = new FakePipe();
  const right = new FakePipe();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

class FakePipe implements V8MessagePipe {
  peer: FakePipe | undefined;
  closed = false;
  sent: Uint8Array[] = [];
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();

  send(bytes: Uint8Array): boolean {
    if (this.closed) throw new Error('closed');
    this.sent.push(bytes);
    const peer = this.peer;
    const copy = new Uint8Array(bytes);
    queueMicrotask(() => peer?.receive(copy));
    return true;
  }
  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const listener of [...this.messageListeners]) listener(bytes);
  }
  onMessage(cb: (bytes: Uint8Array) => void): Unsubscribe {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onClose(cb: () => void): Unsubscribe {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
    this.peer?.close();
  }
}

function nextMessage(transport: WireTransport): Promise<WireMessage> {
  return new Promise((resolve) => {
    const off = transport.onMessage((message) => {
      off();
      resolve(message);
    });
  });
}

describe('v8MessageTransport', () => {
  it('round-trips structured-clone values that JSON would lose', async () => {
    const { left, right } = pipePair();
    const sender = v8MessageTransport(left);
    const receiver = v8MessageTransport(right);

    const when = new Date('2026-11-25T10:00:00.000Z');
    const bytes = Uint8Array.of(1, 2, 3, 250);
    const received = nextMessage(receiver);
    sender.post({
      kind: 'result',
      id: 'call-1',
      ok: true,
      value: {
        bytes,
        buffer: Buffer.from('node buffer'),
        when,
        map: new Map<string, unknown>([
          ['a', 1],
          ['b', { nested: undefined }],
        ]),
        set: new Set(['x']),
        missing: undefined,
        big: 12n,
        error: new TypeError('boom'),
      },
    });
    const message = await received;
    expect(message.kind).toBe('result');
    const value = (message as { value: Record<string, unknown> }).value;

    expect(value.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(value.bytes as Uint8Array)).toEqual([1, 2, 3, 250]);
    // Each typed array owns its buffer, as after a structured clone.
    expect((value.bytes as Uint8Array).buffer.byteLength).toBe(4);
    expect(Buffer.isBuffer(value.buffer)).toBe(false);
    expect(new TextDecoder().decode(value.buffer as Uint8Array)).toBe('node buffer');
    expect(value.when).toBeInstanceOf(Date);
    expect((value.when as Date).toISOString()).toBe(when.toISOString());
    expect(value.map).toEqual(
      new Map<string, unknown>([
        ['a', 1],
        ['b', { nested: undefined }],
      ])
    );
    expect(value.set).toEqual(new Set(['x']));
    expect('missing' in value).toBe(true);
    expect(value.missing).toBeUndefined();
    expect(value.big).toBe(12n);
    expect(value.error).toBeInstanceOf(Error);
    expect((value.error as Error).message).toBe('boom');
  });

  it('carries a blob chunk', async () => {
    const { left, right } = pipePair();
    const sender = v8MessageTransport(left);
    const receiver = v8MessageTransport(right);
    const data = new Uint8Array(100_000).map((_, index) => index % 251);

    const received = nextMessage(receiver);
    sender.post({ kind: 'blob-chunk', channel: 'upload-1', seq: 3, data });
    const message = await received;
    expect(message).toMatchObject({ kind: 'blob-chunk', channel: 'upload-1', seq: 3 });
    expect(message.kind === 'blob-chunk' && Buffer.from(message.data).equals(data)).toBe(true);
  });

  it('copies typed arrays of every kind out of the message buffer', () => {
    const value = deserializeWireValue(
      serialize({
        floats: Float64Array.of(1.5, -2),
        view: new DataView(Uint8Array.of(9, 8).buffer),
        slice: new Uint8Array(Uint8Array.of(0, 1, 2, 3).buffer, 1, 2),
      })
    ) as { floats: Float64Array; view: DataView; slice: Uint8Array };
    expect(value.floats).toBeInstanceOf(Float64Array);
    expect(Array.from(value.floats)).toEqual([1.5, -2]);
    expect(value.view.getUint8(1)).toBe(8);
    expect(value.view.buffer.byteLength).toBe(2);
    expect(Array.from(value.slice)).toEqual([1, 2]);
    expect(value.slice.buffer.byteLength).toBe(2);
  });

  it('throws a DataCloneError for a value that cannot be serialized, keeping the link', () => {
    const { left } = pipePair();
    const transport = v8MessageTransport(left);
    let caught: unknown;
    try {
      transport.post({ kind: 'result', id: 'x', ok: true, value: { fn: () => 1 } });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe('DataCloneError');
    expect(left.closed).toBe(false);
    expect(left.sent).toHaveLength(0);
  });

  it('throws a DataCloneError for an oversize message instead of sending it', () => {
    const { left } = pipePair();
    const transport = v8MessageTransport(left, { maxMessageBytes: 1024 });
    let caught: unknown;
    try {
      transport.post({ kind: 'blob-chunk', channel: 'c', seq: 1, data: new Uint8Array(2048) });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe('DataCloneError');
    expect((caught as Error).message).toContain('1024 byte limit');
    expect(left.closed).toBe(false);
    expect(left.sent).toHaveLength(0);
  });

  it('closes the pipe when an oversize message arrives', async () => {
    const { left, right } = pipePair();
    v8MessageTransport(left);
    const receiver = v8MessageTransport(right, { maxMessageBytes: 1024 });
    const disconnected = new Promise<void>((resolve) => receiver.onDisconnect(resolve));
    left.send(serialize({ kind: 'cancel', id: 'x'.repeat(2048) }));
    await disconnected;
    expect(right.closed).toBe(true);
  });

  it('closes the pipe when a message does not deserialize, and ignores non-Wire values', async () => {
    const { left, right } = pipePair();
    const receiver = v8MessageTransport(right);
    const seen: WireMessage[] = [];
    receiver.onMessage((message) => seen.push(message));

    left.send(serialize({ kind: 'nonsense' }));
    left.send(serialize({ kind: 'cancel', id: 'ok' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([{ kind: 'cancel', id: 'ok' }]);
    expect(right.closed).toBe(false);

    const disconnected = new Promise<void>((resolve) => receiver.onDisconnect(resolve));
    left.send(Uint8Array.of(0xff, 0x0f, 0x99, 0x01));
    await disconnected;
    expect(right.closed).toBe(true);
  });

  it('reports a disconnect once and refuses to post afterwards', async () => {
    const { left, right } = pipePair();
    const transport = v8MessageTransport(left);
    v8MessageTransport(right);
    let disconnects = 0;
    transport.onDisconnect(() => (disconnects += 1));
    right.close();
    expect(disconnects).toBe(1);
    expect(() => transport.post({ kind: 'cancel', id: 'late' })).toThrow('Owner link is closed');
    transport.close?.();
    expect(disconnects).toBe(1);
    await new Promise<void>((resolve) => transport.onDisconnect(resolve));
  });
});

// End to end over a real WebSocket: the transport under Wire's own connect/serve.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const errorSchema = z.object({ type: z.string() });

const contract = defineContract({
  echo: procedure({
    input: z.object({ when: z.date(), bytes: z.instanceof(Uint8Array) }),
    output: z.object({ when: z.date(), size: z.number(), extra: z.undefined() }),
  }),
  unclonable: procedure({ input: z.void(), output: z.unknown() }),
  upload: uploadFile({
    input: z.object({ id: z.string() }),
    result: z.object({ id: z.string(), text: z.string() }),
    error: errorSchema,
  }),
  events: eventStream({
    key: z.object({ id: z.string() }),
    event: z.object({ message: z.string() }),
  }),
  model: liveModel({
    key: z.object({ id: z.string() }),
    states: { state: liveState({ data: z.object({ count: z.number() }) }) },
    mutations: {
      bump: mutation({
        input: z.object({ amount: z.number() }),
        data: z.object({ count: z.number() }),
        error: errorSchema,
      }),
    },
  }),
});

const servers: Server[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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

function counterModel() {
  const state = cell({ count: 1 });
  return expose(
    contract.model,
    { state: () => state },
    {
      mutations: {
        async bump(context) {
          let count = 0;
          const revision = state.update(
            (previous) => {
              count = previous.count + context.input.amount;
              return { count };
            },
            { mutationIds: [context.mutationId] }
          );
          await context.observed('state', revision);
          return ok({ count });
        },
      },
    }
  );
}

async function serveOverWebSocket(): Promise<{
  url: string;
  events: ReturnType<typeof createEventStreamHost<typeof contract.events>>;
}> {
  const events = createEventStreamHost(contract.events);
  const controller = createController(
    contract,
    {
      echo: ({ when, bytes }) => ({ when, size: bytes.byteLength, extra: undefined }),
      unclonable: () => ({ fn: () => 1 }),
      upload: async ({ id }, file) => ok({ id, text: textDecoder.decode(await file.bytes()) }),
      events,
      model: counterModel(),
    },
    { validate: 'full' }
  );
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }
    const pipe: WebSocketPipe = acceptWebSocketPipe(request, socket, head);
    const stop = serve(v8MessageTransport(pipe), controller);
    cleanups.push(() => {
      stop();
      pipe.close();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/owner/wire`, events };
}

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe('v8MessageTransport end to end', () => {
  it('runs a procedure, an upload, an event stream and a live model over a WebSocket', async () => {
    const { url, events } = await serveOverWebSocket();
    const transport = v8MessageTransport(await connectWebSocketPipe({ url }));
    const connection = connect(transport, { callTimeoutMs: 0 });
    cleanups.push(() => {
      connection.dispose();
      transport.close?.();
    });
    const api = client(contract, connection);

    const when = new Date('2026-01-02T03:04:05.000Z');
    const echoed = await api.echo({ when, bytes: new Uint8Array(70_000) });
    expect(echoed.when).toBeInstanceOf(Date);
    expect(echoed.when.getTime()).toBe(when.getTime());
    expect(echoed.size).toBe(70_000);
    expect('extra' in echoed).toBe(true);

    await expect(
      api.upload(
        { id: 'u1' },
        {
          name: 'note.txt',
          mimeType: 'text/plain',
          size: 7,
          source: chunks(textEncoder.encode('payload')),
        }
      )
    ).resolves.toEqual(ok({ id: 'u1', text: 'payload' }));

    const key = { id: 'k' };
    const streamed: string[] = [];
    const unsubscribe = await api.events.subscribe(key, {
      onEvent: (event) => streamed.push(event.message),
    });
    await waitFor(() => events.resolve(key).subscriberCount === 1);
    events.emit(key, { message: 'one' });
    events.emit(key, { message: 'two' });
    await waitFor(() => streamed.length === 2);
    unsubscribe();
    expect(streamed).toEqual(['one', 'two']);

    const modelKey = { id: 'm' };
    await expect(api.model.state(modelKey, 'state').snapshot()).resolves.toMatchObject({
      data: { count: 1 },
    });
    await expect(
      api.model.mutate('bump', { key: modelKey, input: { amount: 4 } })
    ).resolves.toMatchObject({ success: true, data: { data: { count: 5 } } });
    await expect(api.model.state(modelKey, 'state').snapshot()).resolves.toMatchObject({
      data: { count: 5 },
    });
  });

  it('fails one call with SERIALIZATION when its result cannot cross, and keeps serving', async () => {
    const { url } = await serveOverWebSocket();
    const transport = v8MessageTransport(await connectWebSocketPipe({ url }));
    const connection = connect(transport, { callTimeoutMs: 0 });
    cleanups.push(() => {
      connection.dispose();
      transport.close?.();
    });
    const api = client(contract, connection);

    const failure = await api.unclonable().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WireError);
    expect((failure as WireError).code).toBe('SERIALIZATION');

    const echoed = await api.echo({ when: new Date(0), bytes: new Uint8Array(1) });
    expect(echoed.size).toBe(1);
  });
});
