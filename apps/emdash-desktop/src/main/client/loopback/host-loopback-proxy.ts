import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Agent,
  createServer,
  request as httpRequest,
  type AgentOptions,
  type ClientRequestArgs,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '@emdash/shared/logger';
import { joinStreams } from '@main/owner-link/tunnel-protocol';
import { hostLoopbackFamilies, type HostTunnelDialer } from './tunnel-dialer';

// The client's embedded browser reaches the host's loopback through this proxy: in client mode
// every browser session sends loopback requests here (see `session-proxy.ts`), and each one
// travels to the host over `/owner/tunnel`, so `http://localhost:5173` in a browser tab is the
// dev server on the host, HMR WebSocket included.
//
// - It listens on 127.0.0.1 only, on a random port, and requires a per-launch Basic credential
//   that only this process knows (it answers the browser's challenge in `session-proxy.ts`), so
//   no other program on this computer can use it to reach the host.
// - It serves loopback targets only; anything else is refused (the browser sessions send only
//   loopback here; everything else goes direct).
// - `CONNECT` (HTTPS and every WebSocket through a proxy) is one tunnel per connection; plain HTTP
//   requests use a keep-alive pool of tunnels per host port, so a page with hundreds of module
//   requests does not pay a tunnel handshake for each.

const PROXY_USERNAME = 'maestro';
const POOL_SOCKETS_PER_PORT = 32;
const POOL_IDLE_TIMEOUT_MS = 30_000;

// Headers that describe one hop, never forwarded (RFC 9110 §7.6.1, plus the proxy's own).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type HostLoopbackProxy = {
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** Chromium `proxyRules` naming this proxy. */
  readonly proxyRules: string;
  close(): Promise<void>;
};

type LoopbackTarget = { hostname: string; port: number };

export async function startHostLoopbackProxy(deps: {
  dialTunnel: HostTunnelDialer;
  log: Pick<Logger, 'debug' | 'warn'>;
  poolIdleTimeoutMs?: number;
}): Promise<HostLoopbackProxy> {
  const password = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(
    `Basic ${Buffer.from(`${PROXY_USERNAME}:${password}`).toString('base64')}`
  );
  const agents = new Map<string, Agent>();
  const sockets = new Set<Duplex>();

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers['proxy-authorization'];
    if (typeof header !== 'string') return false;
    const given = Buffer.from(header);
    return (
      given.length === expectedAuthorization.length && timingSafeEqual(given, expectedAuthorization)
    );
  };

  const agentFor = (target: LoopbackTarget): Agent => {
    // Families differ by name (`127.0.0.1` is IPv4 only, `localhost` either), so is the pool.
    const key = `${hostLoopbackFamilies(target.hostname)?.join('') ?? ''}:${target.port}`;
    let agent = agents.get(key);
    if (!agent) {
      agent = new TunnelAgent(() => deps.dialTunnel(target.port, target.hostname), {
        keepAlive: true,
        maxSockets: POOL_SOCKETS_PER_PORT,
        timeout: deps.poolIdleTimeoutMs ?? POOL_IDLE_TIMEOUT_MS,
      });
      agents.set(key, agent);
    }
    return agent;
  };

  const server = createServer((request, response) => forwardRequest(request, response));
  server.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    openConnectTunnel(request, socket, head)
  );
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    forwardUpgrade(request, socket, head)
  );
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket: Duplex) => socket.destroy());

  function forwardRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!authorized(request)) {
      response.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="Maestro"',
        'Content-Length': '0',
      });
      response.end();
      return;
    }
    const absolute = absoluteHttpTarget(request.url ?? '');
    if (!absolute) {
      response.writeHead(absolute === null ? 403 : 400, { 'Content-Length': '0' });
      response.end();
      return;
    }
    const upstream = httpRequest({
      agent: agentFor(absolute.target),
      host: absolute.target.hostname,
      port: absolute.target.port,
      method: request.method,
      path: absolute.path,
      headers: forwardedRequestHeaders(request),
    });
    upstream.on('response', (reply) => {
      response.writeHead(
        reply.statusCode ?? 502,
        reply.statusMessage,
        forwardedResponseHeaders(reply.rawHeaders)
      );
      reply.pipe(response);
      reply.on('error', () => response.destroy());
    });
    upstream.on('error', (error) => {
      deps.log.debug('client loopback proxy: request failed', {
        port: absolute.target.port,
        error: String(error),
      });
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Length': '0' });
        response.end();
      } else {
        response.destroy();
      }
    });
    // The browser went away mid-request: stop the upstream side too.
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  }

  function openConnectTunnel(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (!authorized(request)) {
      replyRaw(socket, 407, 'Proxy Authentication Required', [
        'Proxy-Authenticate: Basic realm="Maestro"',
      ]);
      return;
    }
    const target = parseAuthority(request.url ?? '');
    if (!target) {
      replyRaw(socket, 403, 'Forbidden');
      return;
    }
    deps.dialTunnel(target.port, target.hostname).then(
      (tunnel) => {
        if (socket.destroyed) {
          tunnel.destroy();
          return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.byteLength > 0) tunnel.write(head);
        joinStreams(socket, tunnel);
      },
      (error: unknown) => {
        deps.log.debug('client loopback proxy: tunnel failed', {
          port: target.port,
          error: String(error),
        });
        replyRaw(socket, 502, 'Bad Gateway');
      }
    );
  }

  /** An absolute-form upgrade (a WebSocket client that does not use CONNECT). */
  function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    if (!authorized(request)) {
      replyRaw(socket, 407, 'Proxy Authentication Required', [
        'Proxy-Authenticate: Basic realm="Maestro"',
      ]);
      return;
    }
    const absolute = absoluteHttpTarget(request.url ?? '');
    if (!absolute) {
      replyRaw(
        socket,
        absolute === null ? 403 : 400,
        absolute === null ? 'Forbidden' : 'Bad Request'
      );
      return;
    }
    deps.dialTunnel(absolute.target.port, absolute.target.hostname).then(
      (tunnel) => {
        if (socket.destroyed) {
          tunnel.destroy();
          return;
        }
        const lines = [`${request.method ?? 'GET'} ${absolute.path} HTTP/1.1`];
        const raw = request.rawHeaders;
        for (let index = 0; index + 1 < raw.length; index += 2) {
          const name = raw[index]!.toLowerCase();
          if (name === 'proxy-authorization' || name === 'proxy-connection') continue;
          lines.push(`${raw[index]}: ${raw[index + 1]}`);
        }
        tunnel.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.byteLength > 0) tunnel.write(head);
        joinStreams(socket, tunnel);
      },
      () => replyRaw(socket, 502, 'Bad Gateway')
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    username: PROXY_USERNAME,
    password,
    proxyRules: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const agent of agents.values()) agent.destroy();
        agents.clear();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** An HTTP agent whose connections are tunnels to one host loopback port. */
class TunnelAgent extends Agent {
  constructor(
    private readonly dial: () => Promise<Duplex>,
    options: AgentOptions
  ) {
    super(options);
  }

  // Node's agent accepts an asynchronous connection through the callback when this returns
  // nothing (`Agent#createSocket`).
  override createConnection(
    _options: ClientRequestArgs,
    callback?: (error: Error | null, socket: Duplex) => void
  ): Duplex | null | undefined {
    this.dial().then(
      (socket) => callback?.(null, socket),
      (error: unknown) =>
        callback?.(error instanceof Error ? error : new Error(String(error)), undefined as never)
    );
    return undefined;
  }
}

/**
 * The target and origin-form path of an absolute-form proxy request. Undefined when the request
 * line is not an absolute `http:` URL, null when its host is not a loopback name.
 */
function absoluteHttpTarget(
  requestUrl: string
): { target: LoopbackTarget; path: string } | null | undefined {
  // The path is cut from the raw request line, so it reaches the server byte for byte.
  const match = /^http:\/\/([^/?#]+)([^#]*)/i.exec(requestUrl);
  if (!match) return undefined;
  let url: URL;
  try {
    url = new URL(`http://${match[1]}`);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (!hostLoopbackFamilies(url.hostname)) return null;
  const rest = match[2] ?? '';
  const path = rest === '' ? '/' : rest.startsWith('/') ? rest : `/${rest}`;
  return { target: { hostname: url.hostname, port: Number(url.port || 80) }, path };
}

/** The `host:port` of a CONNECT request, when it names a loopback target. */
function parseAuthority(authority: string): LoopbackTarget | null {
  if (!/^[^/?#@\s]+:[0-9]{1,5}$/.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  // `URL` drops a port that is the scheme's default; the authority always carries one.
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!hostLoopbackFamilies(url.hostname)) return null;
  return { hostname: url.hostname, port };
}

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

function forwardedRequestHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const named = connectionTokens(request.headers.connection);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

/** Response headers as a flat `[name, value, ...]` list, so repeated `Set-Cookie` survives. */
function forwardedResponseHeaders(rawHeaders: readonly string[]): string[] {
  const connection: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === 'connection') connection.push(rawHeaders[index + 1]!);
  }
  const named = connectionTokens(connection);
  const headers: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    headers.push(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return headers;
}

function replyRaw(socket: Duplex, status: number, reason: string, extra: string[] = []): void {
  if (socket.destroyed) return;
  socket.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      ...extra,
      'Content-Length: 0',
      'Connection: close',
      '',
      '',
    ].join('\r\n')
  );
}
