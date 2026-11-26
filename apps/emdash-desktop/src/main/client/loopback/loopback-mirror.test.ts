import { get as httpGet } from 'node:http';
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
} from 'node:net';
import type { Duplex } from 'node:stream';
import { noopLogger } from '@emdash/shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackMirrors, type LoopbackMirrors } from './loopback-mirror';
import {
  ipv6Available,
  startDevServer,
  startTunnelHost,
  TUNNEL_HOST_TOKEN,
  type DevServer,
  type TunnelHost,
} from './testing/tunnel-host';
import { createHostTunnelDialer, ownerTunnelConnector } from './tunnel-dialer';

function getStatus(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

function refused(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, host);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function occupy(port: number, host: string): Promise<Server> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

describe('loopback mirrors', () => {
  let dev: DevServer;
  let mirrors: LoopbackMirrors;
  const cleanup: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    dev = await startDevServer();
  });

  afterEach(async () => {
    await mirrors?.close();
    for (const close of cleanup.splice(0).reverse()) await close();
    await dev.close();
  });

  /** A dialer that reaches the dev server directly and records what it was asked for. */
  function directDialer() {
    const calls: Array<{ port: number; hostname: string }> = [];
    const dial = vi.fn(async (port: number, hostname: string): Promise<Duplex> => {
      calls.push({ port, hostname });
      const socket = connectTcp(dev.port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      return socket;
    });
    return { dial, calls };
  }

  describe('through a real tunnel', () => {
    let host: TunnelHost;

    beforeEach(async () => {
      host = await startTunnelHost();
      cleanup.push(() => host.close());
      mirrors = createLoopbackMirrors({
        dialTunnel: createHostTunnelDialer({
          connect: ownerTunnelConnector({ url: host.url, token: TUNNEL_HOST_TOKEN }),
        }),
        log: noopLogger,
      });
    });

    it('serves a host port on a free local port when the same port is taken here', async () => {
      // The dev server runs on this machine too, so its port is taken locally.
      const local = await mirrors.ensure({
        port: dev.port,
        hostname: 'localhost',
        samePort: false,
      });
      expect(local).not.toBe(dev.port);
      const reply = await getStatus(`http://127.0.0.1:${local}/echo?via=mirror`);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body).url).toBe('/echo?via=mirror');
      expect(host.tunnelCount()).toBe(1);

      // The same host port keeps its mirror.
      expect(await mirrors.ensure({ port: dev.port, hostname: 'localhost', samePort: false })).toBe(
        local
      );
      expect(mirrors.active()).toEqual(new Map([[dev.port, local]]));
    });

    it('refuses an OAuth mirror whose exact port is taken here', async () => {
      await expect(
        mirrors.ensure({ port: dev.port, hostname: '127.0.0.1', samePort: true })
      ).rejects.toThrow();
      expect(mirrors.active().size).toBe(0);
    });

    it('drops the local connection when the host refuses the tunnel', async () => {
      host.attached.value = false;
      const local = await mirrors.ensure({
        port: dev.port,
        hostname: 'localhost',
        samePort: false,
      });
      await expect(getStatus(`http://127.0.0.1:${local}/echo`)).rejects.toThrow();
      expect(dev.requests).toHaveLength(0);
    });
  });

  it('mirrors the exact port for an OAuth redirect', async () => {
    const { dial, calls } = directDialer();
    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger });
    const port = await freePort();
    expect(await mirrors.ensure({ port, hostname: '127.0.0.1', samePort: true })).toBe(port);
    const reply = await getStatus(`http://127.0.0.1:${port}/callback?code=abc`);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).url).toBe('/callback?code=abc');
    expect(calls).toEqual([{ port, hostname: '127.0.0.1' }]);
  });

  it('closes a mirror after it has been idle, and not while a connection is open', async () => {
    const { dial } = directDialer();
    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger, idleMs: 80 });
    const port = await freePort();
    await mirrors.ensure({ port, hostname: 'localhost', samePort: false });

    const held = connectTcp(port, '127.0.0.1');
    held.on('error', () => {});
    await new Promise<void>((resolve) => held.once('connect', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mirrors.active().get(port)).toBe(port);

    held.destroy();
    await vi.waitFor(() => expect(mirrors.active().size).toBe(0), { timeout: 2_000 });
    expect(await refused(port)).toBe(true);
  });

  it('avoids a port another program holds on ::1, unless the exact port is required', async () => {
    if (!(await ipv6Available())) return;
    const { dial } = directDialer();
    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger });
    const port = await freePort();
    const other = await occupy(port, '::1');
    cleanup.push(() => new Promise<void>((resolve) => other.close(() => resolve())));

    const opened = await mirrors.ensure({ port, hostname: 'localhost', samePort: false });
    expect(opened).not.toBe(port);
    await mirrors.close();

    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger });
    expect(await mirrors.ensure({ port, hostname: '127.0.0.1', samePort: true })).toBe(port);
  });

  it('listens on loopback only and refuses a target that is not loopback', async () => {
    const { dial } = directDialer();
    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger });
    await expect(
      mirrors.ensure({ port: 80, hostname: 'example.com', samePort: false })
    ).rejects.toThrow('Not a loopback address');
    const port = await freePort();
    await mirrors.ensure({ port, hostname: 'localhost', samePort: false });
    const { networkInterfaces } = await import('node:os');
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (lan) expect(await refused(port, lan.address)).toBe(true);
  });

  it('closes every mirror on close()', async () => {
    const { dial } = directDialer();
    mirrors = createLoopbackMirrors({ dialTunnel: dial, log: noopLogger });
    const port = await freePort();
    await mirrors.ensure({ port, hostname: 'localhost', samePort: false });
    await mirrors.close();
    await vi.waitFor(async () => expect(await refused(port)).toBe(true));
    await expect(mirrors.ensure({ port, hostname: 'localhost', samePort: false })).rejects.toThrow(
      'closed'
    );
  });
});
