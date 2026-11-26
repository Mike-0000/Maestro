import { DefaultDeserializer, serialize } from 'node:v8';
import type { Unsubscribe } from '@emdash/shared';
import { WEBSOCKET_MAX_MESSAGE_BYTES, type WebSocketPipe } from '@emdash/wire/node';
import { isWireMessage, type WireMessage, type WireTransport } from '@emdash/wire/rpc';

// The owner link between a Maestro client and its host. The desktop Wire contract was written for
// Electron's MessagePort, which structured-clones every message (`Uint8Array`, `Date`, `Map`,
// `undefined`, errors). `v8.serialize` between two Node processes of the same build has the same
// semantics, so every desktop procedure crosses the network unchanged, one message per WebSocket
// message. Frames are only ever decoded on a connection the host has already authenticated.

/** The part of a {@link WebSocketPipe} the transport uses; tests pass an in-memory fake. */
export type V8MessagePipe = Pick<WebSocketPipe, 'send' | 'onMessage' | 'onClose' | 'close'> & {
  readonly closed: boolean;
};

export type V8MessageTransportOptions = {
  /** Largest serialized message accepted in either direction: the WebSocket cap or less. */
  maxMessageBytes?: number;
};

/**
 * A Wire transport over a message pipe, one V8-serialized Wire message per pipe message.
 *
 * - A message that cannot be serialized, or serializes larger than the cap, throws a
 *   `DataCloneError` from `post`, so Wire fails that one call with `SERIALIZATION` (as it does on
 *   a MessagePort) and the link stays up.
 * - A received message over the cap, or one that does not deserialize, closes the pipe: the peer
 *   is the same build, so either means the stream is not what it claims to be.
 * - Typed arrays arrive with their own `ArrayBuffer`, as after a structured clone; a Node `Buffer`
 *   arrives as a plain `Uint8Array`.
 */
export function v8MessageTransport(
  pipe: V8MessagePipe,
  options: V8MessageTransportOptions = {}
): WireTransport {
  // Never above the WebSocket cap: the pipe would refuse the send with a different error.
  const maxMessageBytes = Math.min(
    options.maxMessageBytes ?? WEBSOCKET_MAX_MESSAGE_BYTES,
    WEBSOCKET_MAX_MESSAGE_BYTES
  );
  const messageListeners = new Set<(message: WireMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  let disconnected = false;

  const notifyDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    const listeners = [...disconnectListeners];
    disconnectListeners.clear();
    for (const listener of listeners) listener();
  };

  pipe.onMessage((bytes) => {
    if (disconnected) return;
    if (bytes.byteLength > maxMessageBytes) {
      pipe.close();
      return;
    }
    let message: unknown;
    try {
      message = deserializeWireValue(bytes);
    } catch {
      pipe.close();
      return;
    }
    if (!isWireMessage(message)) return;
    for (const listener of [...messageListeners]) listener(message);
  });
  pipe.onClose(notifyDisconnect);

  return {
    post(message) {
      if (disconnected || pipe.closed) throw new Error('Owner link is closed');
      let bytes: Uint8Array;
      try {
        bytes = serialize(message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw dataCloneError(`Wire message could not be serialized: ${reason}`, error);
      }
      if (bytes.byteLength > maxMessageBytes) {
        throw dataCloneError(
          `Wire message of ${bytes.byteLength} bytes is over the ${maxMessageBytes} byte limit`
        );
      }
      pipe.send(bytes);
    },
    onMessage(cb): Unsubscribe {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    onDisconnect(cb): Unsubscribe {
      if (disconnected) {
        queueMicrotask(cb);
        return () => {};
      }
      disconnectListeners.add(cb);
      return () => disconnectListeners.delete(cb);
    },
    close() {
      notifyDisconnect();
      messageListeners.clear();
      pipe.close();
    },
  };
}

/** Decodes one message the way a structured clone would hand it over. */
export function deserializeWireValue(bytes: Uint8Array): unknown {
  // No input copy is needed: every typed array is copied out as it is read.
  const deserializer = new OwnedViewDeserializer(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  );
  deserializer.readHeader();
  return deserializer.readValue();
}

type HostObjectReader = { _readHostObject(this: DefaultDeserializer): unknown };

/**
 * Node's default deserializer returns typed arrays as views into the message buffer, so a view's
 * `.buffer` would expose the whole message. Copy each one into a buffer of its own instead.
 */
class OwnedViewDeserializer extends DefaultDeserializer {
  // Node's documented hook; @types/node does not declare it, hence the local cast.
  _readHostObject(): unknown {
    const view = (
      DefaultDeserializer.prototype as unknown as HostObjectReader
    )._readHostObject.call(this);
    return ownedCopy(view);
  }
}

function ownedCopy(view: unknown): unknown {
  if (view instanceof DataView) {
    return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (Buffer.isBuffer(view)) return new Uint8Array(view);
  if (ArrayBuffer.isView(view)) return (view as Uint8Array).slice();
  return view;
}

/** Wire recognises clone failures by this name and fails the call instead of the link. */
function dataCloneError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'DataCloneError';
  return error;
}
