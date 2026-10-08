import { remoteDeviceWireContract } from '@emdash/core/services/remote-control/api';
import {
  client,
  connect,
  reconnectingTransport,
  webSocketTransport,
  type Connection,
  type WireTransport,
} from '@emdash/wire/rpc';
import { createReconnectSchedule } from './backoff';

export type LinkStatus = 'connecting' | 'online' | 'reconnecting';

function createApi(connection: Connection) {
  return client(remoteDeviceWireContract, connection);
}
/** The typed host API: `api.remote.*`. */
export type RemoteApi = ReturnType<typeof createApi>;

export type WireLink = {
  readonly api: RemoteApi;
  /**
   * Checks that the host still answers and drops the socket if it does not. Phones resume from
   * sleep, and move between networks, holding sockets that will never report their own death.
   */
  probe(): void;
  close(): void;
};

export type WireLinkOptions = {
  /** `ws:`/`wss:` URL of the host's Wire endpoint. */
  url: string;
  /**
   * Asked after a failed connection attempt: false means the host no longer recognises this
   * device, which no amount of retrying fixes; undefined means the host could not be asked.
   */
  isSessionValid(): Promise<boolean | undefined>;
  onStatus(status: LinkStatus): void;
  onSessionEnded(): void;
};

class SessionEndedError extends Error {
  constructor() {
    super('This device is no longer paired with the host');
    this.name = 'SessionEndedError';
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

/** `wss://host/wire` for a page served over https, `ws://` otherwise. */
export function wireUrlFor(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/wire`;
}

/**
 * One self-healing Wire connection to the host. The reconnecting transport restores the socket
 * and the Connection on top of it re-attaches every live subscription, so callers hold `api`
 * for the lifetime of the session and never see a reconnect except through `onStatus`.
 */
export function createWireLink(options: WireLinkOptions): WireLink {
  let closed = false;
  let abandonCurrent: (() => void) | null = null;
  let probing = false;

  async function connectOnce(): Promise<WireTransport> {
    let socket: WebSocket;
    try {
      socket = await openSocket(options.url);
    } catch (error) {
      // A rejected upgrade looks like any other failure to a browser; ask the host why.
      if ((await options.isSessionValid()) === false) throw new SessionEndedError();
      throw error;
    }
    const inner = webSocketTransport(socket);
    const abandoned = new Set<() => void>();
    let dead = false;
    const abandon = (): void => {
      if (dead) return;
      dead = true;
      for (const listener of abandoned) listener();
      inner.close?.();
    };
    abandonCurrent = abandon;
    return {
      post: (message) => inner.post(message),
      onMessage: (cb) => inner.onMessage(cb),
      onDisconnect(cb) {
        const fire = (): void => {
          if (dead) return;
          dead = true;
          cb();
        };
        abandoned.add(cb);
        const off = inner.onDisconnect(fire);
        return () => {
          abandoned.delete(cb);
          off();
        };
      },
      close: abandon,
    };
  }

  const transport = reconnectingTransport(connectOnce, {
    retrySchedule: createReconnectSchedule(),
    shouldRetry: (error) => !(error instanceof SessionEndedError),
  });
  const connection = connect(transport);
  const api = createApi(connection);

  let everOnline = false;
  options.onStatus('connecting');
  transport.onReconnect(() => {
    if (closed) return;
    everOnline = true;
    options.onStatus('online');
  });
  transport.onDisconnect(() => {
    if (closed) return;
    options.onStatus(everOnline ? 'reconnecting' : 'connecting');
  });
  transport.onTerminalFailure((error) => {
    if (closed) return;
    if (error instanceof SessionEndedError) options.onSessionEnded();
  });

  return {
    api,
    probe() {
      const abandon = abandonCurrent;
      if (closed || probing || !abandon) return;
      probing = true;
      const timer = setTimeout(() => {
        if (abandonCurrent === abandon) abandon();
      }, PROBE_TIMEOUT_MS);
      api.remote.overview
        .state(undefined, 'snapshot')
        .snapshot()
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          probing = false;
        });
    },
    close() {
      if (closed) return;
      closed = true;
      connection.dispose();
      transport.close();
    },
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const fail = (message: string): void => {
      cleanup();
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Timed out connecting to the host'), CONNECT_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };
    const onFailure = (): void => fail('Could not connect to the host');
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onFailure);
      socket.removeEventListener('close', onFailure);
    }
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onFailure);
    socket.addEventListener('close', onFailure);
  });
}
