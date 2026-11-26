import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { noopLogger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHostLoopbackProxy, type HostLoopbackProxy } from './host-loopback-proxy';
import {
  connectRaw,
  ipv6Available,
  readUntil,
  startDevServer,
  startTunnelHost,
  TUNNEL_HOST_TOKEN,
  webSocketEcho,
  webSocketHandshake,
  type DevServer,
  type TunnelHost,
} from './testing/tunnel-host';
import { createHostTunnelDialer, ownerTunnelConnector } from './tunnel-dialer';

type Reply = { status: number; headers: IncomingHttpHeaders; rawHeaders: string[]; body: Buffer };

describe('host loopback proxy', () => {
  let host: TunnelHost;
  let dev: DevServer;
  let proxy: HostLoopbackProxy;
  let auth: string;
  const cleanup: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    host = await startTunnelHost();
    dev = await startDevServer();
    proxy = await startHostLoopbackProxy({
      dialTunnel: createHostTunnelDialer({
        connect: ownerTunnelConnector({ url: host.url, token: TUNNEL_HOST_TOKEN }),
      }),
      log: noopLogger,
    });
    auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
  });

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await proxy.close();
    await dev.close();
    await host.close();
  });

  /** A request as Chromium sends it to an HTTP proxy: absolute-form target, proxy credential. */
  function viaProxy(
    target: string,
    options: {
      method?: string;
      body?: Buffer | string;
      headers?: Record<string, string>;
      agent?: Agent;
      proxyAuthorization?: string | null;
    } = {}
  ): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.proxyAuthorization !== null) {
      headers['Proxy-Authorization'] = options.proxyAuthorization ?? auth;
    }
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: options.method ?? 'GET',
          path: target,
          headers: { Host: new URL(target).host, ...headers },
          agent: options.agent ?? false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              rawHeaders: response.rawHeaders,
              body: Buffer.concat(chunks),
            })
          );
        }
      );
      request.on('error', reject);
      request.end(options.body);
    });
  }

  async function connectThroughProxy(authority: string, authorization: string | null = auth) {
    const socket = await connectRaw(proxy.port);
    cleanup.push(() => {
      socket.destroy();
    });
    socket.write(
      [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
        '',
        '',
      ].join('\r\n')
    );
    const { head } = await readUntil(socket);
    return { socket, head, status: Number(head.split(' ')[1]) };
  }

  describe('plain HTTP', () => {
    it('forwards a request to the host loopback through a tunnel, path and Host intact', async () => {
      const path = '/echo/a%2Fb/../c?x=1&y=%20z';
      const reply = await viaProxy(`http://localhost:${dev.port}${path}`, {
        headers: { 'X-Custom': 'kept', 'Proxy-Connection': 'keep-alive' },
      });
      expect(reply.status).toBe(200);
      const seen = JSON.parse(reply.body.toString()) as {
        url: string;
        headers: IncomingHttpHeaders;
      };
      expect(seen.url).toBe(path);
      expect(seen.headers.host).toBe(`localhost:${dev.port}`);
      expect(seen.headers['x-custom']).toBe('kept');
      // The proxy's own credential and hop headers never reach the dev server.
      expect(seen.headers['proxy-authorization']).toBeUndefined();
      expect(seen.headers['proxy-connection']).toBeUndefined();
      expect(host.tunnelCount()).toBe(1);
    });

    it('forwards a request body and the status, and keeps repeated Set-Cookie headers', async () => {
      const upload = await viaProxy(`http://127.0.0.1:${dev.port}/upload`, {
        method: 'POST',
        body: Buffer.alloc(300_000, 1),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      expect(upload.status).toBe(201);
      expect(upload.body.toString()).toBe('300000');

      const cookies = await viaProxy(`http://localhost:${dev.port}/cookies`);
      expect(cookies.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    });

    it('streams a large response intact', async () => {
      const reply = await viaProxy(`http://localhost:${dev.port}/big?bytes=${20 * 1024 * 1024}`);
      expect(reply.body.byteLength).toBe(20 * 1024 * 1024);
      expect(reply.body.every((byte) => byte === 0x78)).toBe(true);
    });

    it('reuses pooled tunnels for keep-alive requests instead of one tunnel per request', async () => {
      const browser = new Agent({ keepAlive: true, maxSockets: 1 });
      cleanup.push(() => browser.destroy());
      for (let index = 0; index < 10; index += 1) {
        const reply = await viaProxy(`http://localhost:${dev.port}/echo?n=${index}`, {
          agent: browser,
        });
        expect(reply.status).toBe(200);
      }
      expect(dev.requests).toHaveLength(10);
      expect(host.tunnelCount()).toBe(1);
    });

    it('answers 502 when the host refuses the tunnel (no attached session)', async () => {
      host.attached.value = false;
      const reply = await viaProxy(`http://localhost:${dev.port}/echo`);
      expect(reply.status).toBe(502);
      expect(dev.requests).toHaveLength(0);
    });

    it('answers 502 when nothing listens on the host port', async () => {
      const closed = await startDevServer();
      await closed.close();
      const reply = await viaProxy(`http://localhost:${closed.port}/`);
      expect(reply.status).toBe(502);
    });

    it('reaches a dev server listening on ::1 only, for localhost', async () => {
      if (!(await ipv6Available())) return;
      const v6 = await startDevServer('::1');
      cleanup.push(() => v6.close());
      const reply = await viaProxy(`http://localhost:${v6.port}/echo`);
      expect(reply.status).toBe(200);
      expect(v6.requests).toHaveLength(1);
    });
  });

  describe('WebSockets', () => {
    it('opens a CONNECT tunnel to the host loopback that carries a WebSocket (HMR)', async () => {
      const { socket, status } = await connectThroughProxy(`localhost:${dev.port}`);
      expect(status).toBe(200);
      expect(await webSocketHandshake(socket, '/ws', `localhost:${dev.port}`)).toBe(
        'HTTP/1.1 101 Switching Protocols'
      );
      expect(await webSocketEcho(socket, 'hot update')).toBe('hot update');
      expect(await webSocketEcho(socket, 'again')).toBe('again');
      expect(host.tunnelCount()).toBe(1);
    });

    it('accepts CONNECT to an IPv4 loopback address', async () => {
      const { status } = await connectThroughProxy(`127.0.0.1:${dev.port}`);
      expect(status).toBe(200);
    });

    it('forwards an absolute-form WebSocket upgrade', async () => {
      const socket = await connectRaw(proxy.port);
      cleanup.push(() => {
        socket.destroy();
      });
      const status = await webSocketHandshake(
        socket,
        `http://localhost:${dev.port}/ws`,
        `localhost:${dev.port}`,
        [`Proxy-Authorization: ${auth}`]
      );
      expect(status).toBe('HTTP/1.1 101 Switching Protocols');
      expect(await webSocketEcho(socket, 'absolute')).toBe('absolute');
    });

    it('answers CONNECT with 502 when the host refuses the tunnel', async () => {
      host.attached.value = false;
      const { status } = await connectThroughProxy(`localhost:${dev.port}`);
      expect(status).toBe(502);
    });

    it('closes the browser side when the host closes the tunnel (revocation)', async () => {
      const { socket } = await connectThroughProxy(`localhost:${dev.port}`);
      await webSocketHandshake(socket, '/ws', `localhost:${dev.port}`);
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.resume();
      host.revoke();
      await closed;
    });
  });

  describe('access', () => {
    it('demands its credential, and opens no tunnel without it', async () => {
      const missing = await viaProxy(`http://localhost:${dev.port}/echo`, {
        proxyAuthorization: null,
      });
      expect(missing.status).toBe(407);
      expect(missing.headers['proxy-authenticate']).toBe('Basic realm="Maestro"');

      const wrongPassword = `Basic ${Buffer.from(`${proxy.username}:nope`).toString('base64')}`;
      const wrong = await viaProxy(`http://localhost:${dev.port}/echo`, {
        proxyAuthorization: wrongPassword,
      });
      expect(wrong.status).toBe(407);

      const connect = await connectThroughProxy(`localhost:${dev.port}`, null);
      expect(connect.status).toBe(407);
      expect(connect.head).toContain('Proxy-Authenticate: Basic realm="Maestro"');

      const socket = await connectRaw(proxy.port);
      cleanup.push(() => {
        socket.destroy();
      });
      const upgrade = await webSocketHandshake(
        socket,
        `http://localhost:${dev.port}/ws`,
        `localhost:${dev.port}`
      );
      expect(upgrade).toContain('407');

      expect(host.tunnelCount()).toBe(0);
      expect(dev.requests).toHaveLength(0);
    });

    it('uses a fresh random credential per start', async () => {
      const other = await startHostLoopbackProxy({
        dialTunnel: () => Promise.reject(new Error('unused')),
        log: noopLogger,
      });
      cleanup.push(() => other.close());
      expect(other.password).not.toBe(proxy.password);
      expect(proxy.password).toMatch(/^[0-9a-f]{64}$/);
      expect(other.port).not.toBe(proxy.port);
    });

    it.each([
      ['a public host', 'http://example.com/'],
      ['a LAN address', 'http://192.168.1.10:5173/'],
      ['a host that only starts like localhost', 'http://localhost.example.com:5173/'],
      ['an IPv4-mapped address', 'http://[::ffff:127.0.0.1]:5173/'],
    ])('refuses %s over plain HTTP', async (_label, target) => {
      const reply = await viaProxy(target);
      expect(reply.status).toBe(403);
      expect(host.tunnelCount()).toBe(0);
    });

    it.each([
      ['a public host', 'example.com:443'],
      ['a LAN address', '10.0.0.1:80'],
      ['an authority without a port', 'localhost'],
      ['an authority with credentials', 'user@localhost:80'],
      ['port 0', 'localhost:0'],
    ])('refuses CONNECT to %s', async (_label, authority) => {
      const { status } = await connectThroughProxy(authority);
      expect(status).toBe(403);
      expect(host.tunnelCount()).toBe(0);
    });

    it('answers 400 to a request that is not addressed to a proxy', async () => {
      const reply = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: proxy.port,
            path: '/',
            headers: { 'Proxy-Authorization': auth },
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          }
        );
        request.on('error', reject);
        request.end();
      });
      expect(reply).toBe(400);
    });

    it('listens on 127.0.0.1 only', () => {
      expect(proxy.proxyRules).toBe(`127.0.0.1:${proxy.port}`);
    });
  });
});
