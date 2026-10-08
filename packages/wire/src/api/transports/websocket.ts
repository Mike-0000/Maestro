import type { WireTransport } from '../protocol';
import { streamTransport } from './stream';

/** The slice of the WHATWG `WebSocket` this transport needs; browsers and Node both satisfy it. */
export type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: 'message', cb: (event: { data: unknown }) => void): void;
  addEventListener(event: 'close' | 'error', cb: () => void): void;
};

const SOCKET_OPEN = 1;

/**
 * Carries Wire over an already-open WebSocket. Every WebSocket message holds stream-transport
 * frames, so both ends share one framing with the socket and stdio transports and binary blob
 * chunks need no separate encoding.
 */
export function webSocketTransport(socket: WebSocketLike): WireTransport {
  socket.binaryType = 'arraybuffer';
  const transport = streamTransport(
    {
      on(event: 'data' | 'close' | 'end' | 'error', cb: (chunk: Uint8Array) => void): void {
        if (event === 'data') {
          socket.addEventListener('message', ({ data }) => {
            if (data instanceof ArrayBuffer) cb(new Uint8Array(data));
            else if (ArrayBuffer.isView(data)) {
              cb(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            }
          });
        } else if (event !== 'end') {
          socket.addEventListener(event, cb as () => void);
        }
      },
    },
    {
      write(chunk) {
        if (socket.readyState !== SOCKET_OPEN) throw new Error('WebSocket is not open');
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
        socket.send(new Uint8Array(bytes));
      },
    }
  );
  return {
    ...transport,
    close() {
      transport.close?.();
      socket.close();
    },
  };
}
