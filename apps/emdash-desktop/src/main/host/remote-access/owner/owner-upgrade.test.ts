import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteDeviceStore } from '../device-store';
import { createOwnerUpgradeGate, createOwnerWireRoute } from './owner-upgrade';

// End-to-end upgrades over a real socket are in `owner-access.test.ts`.
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function upgradeRequest(headers: Record<string, string>, remoteAddress = '127.0.0.1') {
  return {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...headers,
    },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function fakeSocket() {
  const written: string[] = [];
  const socket = { end: vi.fn((data: string) => written.push(data)) } as unknown as Duplex;
  return { socket, status: () => /^HTTP\/1\.1 (\d+)/u.exec(written[0] ?? '')?.[1] };
}

describe('owner upgrade gate', () => {
  let directory: string;
  let store: RemoteDeviceStore;
  const settings = { enabled: true, tailscaleOnly: true, allowedLogins: [] as string[] };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-owner-upgrade-'));
    store = new RemoteDeviceStore(join(directory, 'remote-access.json'));
    await store.load();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('checks Origin and the network rule before looking at the credential', async () => {
    const authenticate = vi.spyOn(store, 'authenticate');
    const gate = createOwnerUpgradeGate({
      store,
      settings: () => settings,
      logger: logger as never,
    });

    const page = fakeSocket();
    expect(gate.authorize(upgradeRequest({ origin: 'http://x' }), page.socket)).toBeUndefined();
    expect(page.status()).toBe('403');

    const tunnel = fakeSocket();
    const forwarded = upgradeRequest({ 'x-forwarded-for': '203.0.113.1' });
    expect(gate.authorize(forwarded, tunnel.socket)).toBeUndefined();
    expect(tunnel.status()).toBe('403');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('admits only owner devices', async () => {
    const gate = createOwnerUpgradeGate({
      store,
      settings: () => settings,
      logger: logger as never,
    });
    const { credential: desktop } = await store.addDevice({ name: 'd', kind: 'desktop' });
    const { credential: browser } = await store.addDevice({ name: 'b', kind: 'browser' });
    const { credential: ownerCredential, device } = await store.addDevice({
      name: 'o',
      kind: 'owner',
    });

    for (const credential of [desktop, browser, undefined]) {
      const refused = fakeSocket();
      const headers: Record<string, string> = credential
        ? { authorization: `Bearer ${credential}` }
        : {};
      expect(gate.authorize(upgradeRequest(headers), refused.socket)).toBeUndefined();
      expect(refused.status()).toBe('401');
    }

    const admitted = fakeSocket();
    const result = gate.authorize(
      upgradeRequest({ authorization: `Bearer ${ownerCredential}` }),
      admitted.socket
    );
    expect(result).toEqual({
      device: expect.objectContaining({ id: device.id, kind: 'owner' }),
      context: { via: 'loopback', login: null },
    });
    expect(admitted.socket.end).not.toHaveBeenCalled();
  });

  it('refuses a request that is not a WebSocket upgrade', () => {
    const gate = createOwnerUpgradeGate({
      store,
      settings: () => settings,
      logger: logger as never,
    });
    const plain = fakeSocket();
    const request = upgradeRequest({});
    (request as { method?: string }).method = 'POST';
    expect(gate.authorize(request, plain.socket)).toBeUndefined();
    expect(plain.status()).toBe('400');
  });

  it('leaves the request to the listener while owner access is off or for other paths', () => {
    const gate = { authorize: vi.fn() };
    const onConnection = vi.fn();
    let enabled = false;
    const route = createOwnerWireRoute({ enabled: () => enabled, gate, onConnection });
    const { socket } = fakeSocket();
    const url = (path: string) => new URL(path, 'http://maestro.invalid');

    expect(route(upgradeRequest({}), socket, Buffer.alloc(0), url('/owner/wire'))).toBe(false);
    enabled = true;
    expect(route(upgradeRequest({}), socket, Buffer.alloc(0), url('/wire'))).toBe(false);
    expect(gate.authorize).not.toHaveBeenCalled();
    expect(route(upgradeRequest({}), socket, Buffer.alloc(0), url('/owner/wire'))).toBe(true);
    expect(gate.authorize).toHaveBeenCalledTimes(1);
    expect(onConnection).not.toHaveBeenCalled();
  });
});
