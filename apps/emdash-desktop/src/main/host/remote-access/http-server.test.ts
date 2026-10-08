import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWebSocket, WebSocketHandshakeError } from '@emdash/wire/node';
import { createController, client, connect, defineContract, procedure } from '@emdash/wire/rpc';
import { serve, type WireTransport } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RemoteDeviceStore, type RemoteDevice } from './device-store';
import {
  createRemoteAccessHttpServer,
  resolveStaticFile,
  type RemoteAccessHttpServer,
} from './http-server';
import { PairingCodes } from './pairing';

const echoContract = defineContract({
  whoAmI: procedure({ input: z.void(), output: z.string() }),
});

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('remote access http server', () => {
  let directory: string;
  let store: RemoteDeviceStore;
  let pairing: PairingCodes;
  let http: RemoteAccessHttpServer;
  let base: string;
  let opened: Array<{ device: RemoteDevice; transport: WireTransport }>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-remote-access-'));
    await mkdir(join(directory, 'web', 'assets'), { recursive: true });
    await writeFile(join(directory, 'web', 'index.html'), '<!doctype html><title>shell</title>');
    await writeFile(join(directory, 'web', 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(directory, 'secret.txt'), 'outside the web root');
    store = new RemoteDeviceStore(join(directory, 'remote-access.json'));
    await store.load();
    pairing = new PairingCodes();
    opened = [];
    http = createRemoteAccessHttpServer({
      store,
      pairing,
      staticRoot: join(directory, 'web'),
      hostInfo: () => ({ hostId: 'host-1', hostName: 'studio', protocolVersion: '10.1.0' }),
      openSession: (device, transport) => {
        opened.push({ device, transport });
        serve(transport, createController(echoContract, { whoAmI: () => device.name }));
      },
      onDevicesChanged: () => {},
      logger: logger as never,
    });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await http.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function pair(kind: 'desktop' | 'browser', headers: Record<string, string> = {}) {
    const { code } = pairing.issue();
    return fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ code, deviceName: `my ${kind}`, kind }),
    });
  }

  it('describes the host without authentication', async () => {
    const response = await fetch(`${base}/api/info`);
    expect(await response.json()).toEqual({
      app: 'maestro',
      hostId: 'host-1',
      hostName: 'studio',
      protocolVersion: '10.1.0',
    });
  });

  it('pairs a desktop with a one-time code and serves it over an authenticated websocket', async () => {
    const response = await pair('desktop');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; deviceId: string };
    expect(body.token).toContain(body.deviceId);

    const transport = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Authorization: `Bearer ${body.token}` },
    });
    const api = client(echoContract, connect(transport));
    expect(await api.whoAmI()).toBe('my desktop');
    expect(opened[0]?.device.kind).toBe('desktop');
    transport.close?.();
  });

  it('refuses a code twice and a wrong code', async () => {
    const { code } = pairing.issue();
    const send = (value: string) =>
      fetch(`${base}/api/pair`, {
        method: 'POST',
        body: JSON.stringify({ code: value, deviceName: 'phone', kind: 'browser' }),
      });
    expect((await send('WRONG-CODE')).status).toBe(401);
    expect((await send(code.toLowerCase().replace('-', ''))).status).toBe(200);
    expect((await send(code)).status).toBe(401);
  });

  it('rate limits repeated wrong codes', async () => {
    pairing.issue();
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await fetch(`${base}/api/pair`, {
        method: 'POST',
        body: JSON.stringify({ code: 'AAAA-AAAA', deviceName: 'phone', kind: 'browser' }),
      });
      last = response.status;
    }
    expect(last).toBe(429);
  });

  it('keeps a browser credential in an HttpOnly cookie and never in the response body', async () => {
    const response = await pair('browser');
    const body = (await response.json()) as Record<string, unknown>;
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(body.token).toBeUndefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const session = await fetch(`${base}/api/session`, {
      headers: { Cookie: cookie.split(';')[0]! },
    });
    expect(await session.json()).toMatchObject({
      authenticated: true,
      device: { name: 'my browser' },
    });
  });

  it('rejects a cookie-authenticated websocket from another origin', async () => {
    const response = await pair('browser');
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
    const host = new URL(base).host;

    const crossSite = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
    }).catch((error: unknown) => error);
    expect((crossSite as WebSocketHandshakeError).statusCode).toBe(403);

    const sameSite = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Cookie: cookie, Origin: `http://${host}` },
    });
    sameSite.close?.();
    expect(opened).toHaveLength(1);
  });

  it('rejects a websocket without a valid credential', async () => {
    const error = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Authorization: 'Bearer nope.nope' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebSocketHandshakeError);
    expect((error as WebSocketHandshakeError).statusCode).toBe(401);
  });

  it('drops a revoked device and refuses it afterwards', async () => {
    const body = (await (await pair('desktop')).json()) as { token: string; deviceId: string };
    const transport = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Authorization: `Bearer ${body.token}` },
    });
    const disconnected = new Promise<void>((resolve) => transport.onDisconnect(resolve));

    await store.removeDevice(body.deviceId);
    http.closeDeviceSessions(body.deviceId);
    await disconnected;

    const error = await connectWebSocket({
      url: `${base}/wire`,
      headers: { Authorization: `Bearer ${body.token}` },
    }).catch((caught: unknown) => caught);
    expect((error as WebSocketHandshakeError).statusCode).toBe(401);
  });

  it('signs a browser out by revoking its device', async () => {
    const response = await pair('browser');
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
    const signedOut = await fetch(`${base}/api/signout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(signedOut.status).toBe(204);
    expect(store.devices()).toHaveLength(0);
  });

  it('serves the app shell for client routes and files only from inside the web root', async () => {
    const shell = await fetch(`${base}/agent/123`);
    expect(await shell.text()).toContain('shell');
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/..%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });
});

describe('resolveStaticFile', () => {
  it('reports an unbuilt web app instead of a shell', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'maestro-remote-web-'));
    try {
      expect(await resolveStaticFile(empty, '/')).toEqual({ kind: 'unbuilt' });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
