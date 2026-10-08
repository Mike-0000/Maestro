import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteDeviceStore } from '../device-store';
import { createRemoteAccessHttpServer, type RemoteAccessHttpServer } from '../http-server';
import { PairingCodes } from '../pairing';
import type { PushTestResult } from './push-dispatcher';
import { createPushRoute } from './push-route';
import { PushStore } from './push-store';
import { MemoryPushSecrets, TEST_SUBSCRIPTION } from './testing';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('push route', () => {
  let directory: string;
  let devices: RemoteDeviceStore;
  let secrets: MemoryPushSecrets;
  let store: PushStore;
  let http: RemoteAccessHttpServer;
  let base: string;
  let time: number;
  let hostEnabled: boolean;
  let sendTest: ReturnType<typeof vi.fn<(deviceId: string) => Promise<PushTestResult>>>;
  let phone: { id: string; cookie: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-push-route-'));
    devices = new RemoteDeviceStore(join(directory, 'remote-access.json'));
    await devices.load();
    secrets = new MemoryPushSecrets();
    store = new PushStore(secrets);
    time = 1_000_000;
    hostEnabled = true;
    sendTest = vi.fn(async () => ({ ok: true }) as PushTestResult);
    http = createRemoteAccessHttpServer({
      store: devices,
      pairing: new PairingCodes(),
      staticRoot: join(directory, 'web'),
      hostInfo: () => ({ hostId: 'host-1', hostName: 'studio', protocolVersion: '10.1.0' }),
      openSession: () => {},
      onDevicesChanged: () => {},
      routes: [
        createPushRoute({
          devices,
          store,
          dispatcher: { sendTest },
          notificationsEnabled: async () => hostEnabled,
          now: () => time,
        }),
      ],
      logger: logger as never,
    });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
    phone = await pairDevice('browser');
  });

  afterEach(async () => {
    await http.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function pairDevice(kind: 'browser' | 'desktop') {
    const { device, credential } = await devices.addDevice({ name: kind, kind });
    return { id: device.id, cookie: `maestro_device=${encodeURIComponent(credential)}` };
  }

  function call(
    method: string,
    path: string,
    options: { cookie?: string | null; origin?: string | null; body?: unknown } = {}
  ) {
    const headers: Record<string, string> = {};
    const cookie = options.cookie === undefined ? phone.cookie : options.cookie;
    if (cookie) headers.Cookie = cookie;
    const origin = options.origin === undefined ? base : options.origin;
    if (origin && method !== 'GET') headers.Origin = origin;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  function subscriptionBody(overrides: Record<string, unknown> = {}) {
    return {
      endpoint: TEST_SUBSCRIPTION.endpoint,
      keys: { p256dh: TEST_SUBSCRIPTION.p256dh, auth: TEST_SUBSCRIPTION.auth },
      events: { complete: true, attention: true },
      ...overrides,
    };
  }

  it('answers only a paired browser', async () => {
    expect((await call('GET', '/api/push', { cookie: null })).status).toBe(401);
    expect((await call('GET', '/api/push', { cookie: 'maestro_device=nope.nope' })).status).toBe(
      401
    );
    const desktop = await pairDevice('desktop');
    expect((await call('GET', '/api/push', { cookie: desktop.cookie })).status).toBe(401);
  });

  it('hands out the public key and reports no subscription at first', async () => {
    const response = await call('GET', '/api/push');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      available: true,
      publicKey: (await store.vapid())?.publicKey,
      hostEnabled: true,
      subscription: null,
    });
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it('says so when keys cannot be stored securely', async () => {
    secrets.unavailable = true;
    const body = (await (await call('GET', '/api/push')).json()) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(body.publicKey).toBeNull();
    expect((await call('PUT', '/api/push/subscription', { body: subscriptionBody() })).status).toBe(
      503
    );
  });

  it('stores, replaces and removes this device’s subscription', async () => {
    expect((await call('PUT', '/api/push/subscription', { body: subscriptionBody() })).status).toBe(
      204
    );
    const replaced = await call('PUT', '/api/push/subscription', {
      body: subscriptionBody({ events: { complete: true, attention: false } }),
    });
    expect(replaced.status).toBe(204);
    expect(await store.all()).toHaveLength(1);
    expect((await store.get(phone.id))?.events).toEqual({ complete: true, attention: false });

    const described = (await (await call('GET', '/api/push')).json()) as Record<string, unknown>;
    expect(described.subscription).toEqual({ events: { complete: true, attention: false } });
    expect(JSON.stringify(described)).not.toContain('fcm.googleapis.com');

    expect((await call('DELETE', '/api/push/subscription')).status).toBe(204);
    expect(await store.get(phone.id)).toBeUndefined();
  });

  it('refuses changes that do not come from its own page', async () => {
    for (const origin of [null, 'https://evil.example']) {
      const put = await call('PUT', '/api/push/subscription', { origin, body: subscriptionBody() });
      expect(put.status).toBe(403);
      expect((await call('DELETE', '/api/push/subscription', { origin })).status).toBe(403);
      expect((await call('POST', '/api/push/test', { origin })).status).toBe(403);
    }
    expect(await store.all()).toEqual([]);
    expect(sendTest).not.toHaveBeenCalled();
  });

  it('refuses malformed subscriptions and unknown push services', async () => {
    const put = (body: unknown) => call('PUT', '/api/push/subscription', { body });
    expect((await put({})).status).toBe(400);
    expect((await put(subscriptionBody({ keys: { p256dh: 'AAAA', auth: 'AAAA' } }))).status).toBe(
      400
    );
    expect((await put(subscriptionBody({ events: { complete: 'yes' } }))).status).toBe(400);
    for (const endpoint of ['https://evil.example/push', 'http://127.0.0.1:9/x']) {
      const response = await put(subscriptionBody({ endpoint }));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'unsupported-push-service' });
    }
    expect(await store.all()).toEqual([]);
  });

  it('sends a test, and limits how often', async () => {
    const first = await call('POST', '/api/push/test');
    expect(await first.json()).toEqual({ ok: true });
    expect(sendTest).toHaveBeenCalledWith(phone.id);

    expect((await call('POST', '/api/push/test')).status).toBe(429);
    time += 5_000;
    expect((await call('POST', '/api/push/test')).status).toBe(200);
    expect(sendTest).toHaveBeenCalledTimes(2);
  });

  it('explains that the host has notifications switched off instead of sending a test', async () => {
    hostEnabled = false;
    const response = await call('POST', '/api/push/test');
    expect(await response.json()).toEqual({ ok: false, reason: 'host-disabled' });
    expect(sendTest).not.toHaveBeenCalled();
    expect(
      ((await (await call('GET', '/api/push')).json()) as { hostEnabled: boolean }).hostEnabled
    ).toBe(false);
  });

  it('leaves other paths to the listener', async () => {
    expect((await call('GET', '/api/push/unknown')).status).toBe(404);
    expect((await call('POST', '/api/push')).status).toBe(404);
  });
});
