import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Logger } from '@emdash/shared/logger';
import { acceptWebSocket, isWebSocketUpgrade } from '@emdash/wire/node';
import type { WireTransport } from '@emdash/wire/rpc';
import { z } from 'zod';
import { remoteDeviceKindSchema, type RemoteDevice, type RemoteDeviceStore } from './device-store';
import type { PairingCodes } from './pairing';

const SESSION_COOKIE = 'maestro_device';
const SESSION_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const MAX_JSON_BODY_BYTES = 16 * 1024;

const pairRequestSchema = z.object({
  code: z.string().min(1).max(64),
  deviceName: z.string().trim().min(1).max(80),
  kind: remoteDeviceKindSchema,
});

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// The page only ever talks to its own origin; nothing it loads may come from anywhere else.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' ws: wss:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export type RemoteAccessHostInfo = {
  hostId: string;
  hostName: string;
  protocolVersion: string;
};

/** An extra authenticated-by-itself HTTP surface mounted on the listener (see `routes`). */
export type RemoteAccessRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export type RemoteAccessHttpOptions = {
  store: RemoteDeviceStore;
  pairing: PairingCodes;
  /** Directory holding the built web app (`index.html` and its assets). */
  staticRoot: string;
  hostInfo(): RemoteAccessHostInfo;
  /** Hands an authenticated device's Wire connection to the host. */
  openSession(device: RemoteDevice, transport: WireTransport): void;
  onDevicesChanged(): void;
  /** Routes tried before the built-in ones; each returns true once it has answered. */
  routes?: readonly RemoteAccessRoute[];
  logger: Logger;
};

export type RemoteAccessHttpServer = {
  server: Server;
  /** Drops every live connection belonging to the device. */
  closeDeviceSessions(deviceId: string): void;
  close(): Promise<void>;
};

export function createRemoteAccessHttpServer(
  options: RemoteAccessHttpOptions
): RemoteAccessHttpServer {
  const sessions = new Map<string, Set<WireTransport>>();

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      options.logger.warn('Remote access request failed', { error: String(error) });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
      else response.end();
    });
  });
  server.on('upgrade', (request, socket, head) => handleUpgrade(request, socket, head));
  // A browser that keeps a socket open must not hold the listener's shutdown hostage.
  server.keepAliveTimeout = 30_000;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://maestro.invalid');
    for (const route of options.routes ?? []) {
      if (await route(request, response, url)) return;
    }

    if (url.pathname === '/api/info' && request.method === 'GET') {
      sendJson(response, 200, { app: 'maestro', ...options.hostInfo() });
      return;
    }
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const device = authenticate(request);
      const info = options.hostInfo();
      sendJson(response, 200, {
        authenticated: device !== undefined,
        hostId: info.hostId,
        hostName: info.hostName,
        ...(device ? { device: { id: device.id, name: device.name } } : {}),
      });
      return;
    }
    if (url.pathname === '/api/pair' && request.method === 'POST') {
      await handlePair(request, response);
      return;
    }
    if (url.pathname === '/api/signout' && request.method === 'POST') {
      await handleSignOut(request, response);
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/wire') {
      sendJson(response, 404, { error: 'not-found' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method-not-allowed' });
      return;
    }
    await serveStatic(url.pathname, request, response);
  }

  async function handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOriginOrNonBrowser(request)) {
      sendJson(response, 403, { error: 'cross-origin' });
      return;
    }
    const body = pairRequestSchema.safeParse(await readJsonBody(request));
    if (!body.success) {
      sendJson(response, 400, { error: 'invalid-request' });
      return;
    }
    const attempt = options.pairing.redeem(body.data.code);
    if (attempt === 'rate-limited') {
      sendJson(response, 429, { error: 'rate-limited' });
      return;
    }
    if (attempt === 'invalid') {
      sendJson(response, 401, { error: 'invalid-code' });
      return;
    }

    const { device, credential } = await options.store.addDevice({
      name: body.data.deviceName,
      kind: body.data.kind,
    });
    options.onDevicesChanged();
    options.logger.info('Remote access device paired', {
      deviceId: device.id,
      kind: device.kind,
    });
    const info = options.hostInfo();
    const result = { deviceId: device.id, hostId: info.hostId, hostName: info.hostName };
    if (device.kind === 'browser') {
      // A page must never be able to read its own credential: it lives in an HttpOnly cookie.
      response.setHeader('Set-Cookie', sessionCookie(credential, request));
      sendJson(response, 200, result);
      return;
    }
    sendJson(response, 200, { ...result, token: credential });
  }

  async function handleSignOut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOriginOrNonBrowser(request)) {
      sendJson(response, 403, { error: 'cross-origin' });
      return;
    }
    const device = authenticate(request);
    if (device) {
      await options.store.removeDevice(device.id);
      closeDeviceSessions(device.id);
      options.onDevicesChanged();
    }
    response.setHeader('Set-Cookie', sessionCookie('', request, 0));
    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    const url = new URL(request.url ?? '/', 'http://maestro.invalid');
    if (url.pathname !== '/wire' || !isWebSocketUpgrade(request)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const bearer = bearerCredential(request);
    // Cookies are attached by the browser on its own, so a cookie-authenticated upgrade must
    // prove it came from this origin's page. A bearer token is only ever sent deliberately.
    if (!bearer && !sameOrigin(request)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const device = authenticate(request);
    if (!device) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const transport = acceptWebSocket(request, socket, head);
    const deviceSessions = sessions.get(device.id) ?? new Set<WireTransport>();
    sessions.set(device.id, deviceSessions);
    deviceSessions.add(transport);
    transport.onDisconnect(() => {
      deviceSessions.delete(transport);
      if (deviceSessions.size === 0) sessions.delete(device.id);
    });
    options.openSession(device, transport);
  }

  function authenticate(request: IncomingMessage): RemoteDevice | undefined {
    return options.store.authenticate(
      bearerCredential(request) ?? readCookie(request, SESSION_COOKIE)
    );
  }

  async function serveStatic(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const resolved = await resolveStaticFile(options.staticRoot, pathname);
    if (resolved.kind !== 'file') {
      response.statusCode = resolved.kind === 'missing' ? 404 : 503;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(
        resolved.kind === 'missing'
          ? 'Not found'
          : 'The Maestro web app is not included in this build.'
      );
      return;
    }
    const filePath = resolved.path;
    const body = await readFile(filePath);
    const hashedAsset = pathname.startsWith('/assets/');
    response.statusCode = 200;
    response.setHeader(
      'Content-Type',
      CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    );
    response.setHeader(
      'Cache-Control',
      hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
    );
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  function closeDeviceSessions(deviceId: string): void {
    for (const transport of sessions.get(deviceId) ?? []) transport.close?.();
    sessions.delete(deviceId);
  }

  return {
    server,
    closeDeviceSessions,
    async close() {
      for (const deviceId of [...sessions.keys()]) closeDeviceSessions(deviceId);
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type StaticResolution =
  | { kind: 'file'; path: string }
  /** An asset-shaped path with nothing behind it. */
  | { kind: 'missing' }
  /** The web app is not part of this build. */
  | { kind: 'unbuilt' };

/**
 * The file a path should serve: the file itself when it exists inside the root, otherwise the
 * app shell, so client-side routes survive a reload. A missing asset stays a miss rather than
 * coming back as the shell.
 */
export async function resolveStaticFile(root: string, pathname: string): Promise<StaticResolution> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'missing' };
  }
  if (decoded.includes('\0')) return { kind: 'missing' };
  const relative = normalize(decoded).replace(/^[\\/]+/u, '');
  const candidate = join(root, relative);
  const insideRoot = candidate.startsWith(root.endsWith(sep) ? root : root + sep);
  if (insideRoot && (await isFile(candidate))) return { kind: 'file', path: candidate };
  if (extname(relative) !== '') return { kind: 'missing' };
  const shell = join(root, 'index.html');
  return (await isFile(shell)) ? { kind: 'file', path: shell } : { kind: 'unbuilt' };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  return match?.[1]?.trim();
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function sessionCookie(
  credential: string,
  request: IncomingMessage,
  maxAgeSeconds = SESSION_COOKIE_MAX_AGE_SECONDS
): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(credential)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (forwardedProtocol(request) === 'https') attributes.push('Secure');
  return attributes.join('; ');
}

function forwardedProtocol(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-proto'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ?? 'http';
}

/** The request's `Origin` names the same host the request was addressed to. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** Browsers always send `Origin` on a cross-site POST; a request without one is not a page. */
function sameOriginOrNonBrowser(request: IncomingMessage): boolean {
  return request.headers.origin === undefined || sameOrigin(request);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
