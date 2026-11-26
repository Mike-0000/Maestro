import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWebSocketPipe, WebSocketHandshakeError } from '@emdash/wire/node';
import { client, connect, WireError, type Controller } from '@emdash/wire/rpc';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import { ownerHostWireContract } from '@core/features/client-mode/api/owner-contract';
import type { NotificationSink } from '@core/services/notifications/api/ports';
import type { ExternalOpener } from '@main/host/external-opener';
import { OWNER_PATHS } from '@main/owner-link/endpoints';
import { v8MessageTransport } from '@main/owner-link/v8-transport';
import { RemoteDeviceStore } from '../device-store';
import { createRemoteAccessHttpServer, type RemoteAccessHttpServer } from '../http-server';
import { PairingCodes } from '../pairing';
import type { HostWindowPort } from './host-window-suspension';
import { createOwnerAccess, type OwnerAccess } from './owner-access';
import { OWNER_SETUP_TOKEN_FILE } from './owner-pairing-route';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const BUILD: BuildIdentity = { version: '2.0.0', commit: 'c0ffee1', dev: false };
const RESTORE_DELAY_MS = 40;

/** Headers `tailscale serve` adds for a tailnet user. */
const TAILSCALE_HEADERS = {
  'Tailscale-User-Login': 'me@example.com',
  'X-Forwarded-For': '100.90.1.2',
  'X-Forwarded-Proto': 'https',
};
/** What another tunnel (here an ngrok-like relay) looks like. */
const FORWARDED_HEADERS = { 'X-Forwarded-For': '203.0.113.7' };

describe('owner access', () => {
  let directory: string;
  let store: RemoteDeviceStore;
  let ordinaryPairing: PairingCodes;
  let owner: OwnerAccess;
  let http: RemoteAccessHttpServer;
  let base: string;
  let windowState: { visible: boolean } | null;
  let windowPort: HostWindowPort & {
    destroy: Mock<() => void>;
    restore: Mock<(options: { visible: boolean }) => void>;
  };
  let sinks: Map<string, NotificationSink>;
  let registerSink: Mock<(sink: NotificationSink) => () => void>;
  let opener: ExternalOpener | undefined;
  let setExternalOpener: Mock<(next: ExternalOpener | undefined) => void>;
  let desktop: Controller & { call: Mock<Controller['call']> };
  let changes: number;
  const openLinks: Array<{ close(): void }> = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-owner-access-'));
    store = new RemoteDeviceStore(join(directory, 'remote-access.json'));
    await store.load();
    ordinaryPairing = new PairingCodes();
    windowState = { visible: true };
    windowPort = {
      current: () => windowState,
      destroy: vi.fn(() => {
        windowState = null;
      }),
      restore: vi.fn(({ visible }: { visible: boolean }) => {
        windowState = { visible };
      }),
    };
    sinks = new Map([['system', { id: 'system', deliver: vi.fn() }]]);
    registerSink = vi.fn((sink: NotificationSink) => {
      sinks.set(sink.id, sink);
      return () => sinks.delete(sink.id);
    });
    opener = undefined;
    setExternalOpener = vi.fn((next: ExternalOpener | undefined) => {
      opener = next;
    });
    desktop = {
      call: vi.fn(async (path: string) => {
        if (path === 'host.getPlatform') return 'linux';
        throw new WireError('UNKNOWN_PROCEDURE', path);
      }),
      resolveLive: () => null,
      acquireLive: () => null,
    };
    changes = 0;
    owner = createOwnerAccess({
      store,
      dataDirectory: directory,
      hostInfo: () => ({
        id: store.current().hostId,
        name: 'vm',
        platform: 'linux',
        arch: 'x64',
        homeDir: '/home/me',
      }),
      hostBuild: async () => BUILD,
      skipBuildCheck: false,
      desktopController: desktop,
      notifications: { registerSink, emitDelivery: vi.fn() },
      createSystemSink: () => ({ id: 'system', deliver: vi.fn() }),
      window: windowPort,
      setExternalOpener,
      onChanged: () => {
        changes += 1;
      },
      logger: logger as never,
      restoreDelayMs: RESTORE_DELAY_MS,
    });
    http = createRemoteAccessHttpServer({
      store,
      pairing: ordinaryPairing,
      staticRoot: join(directory, 'web'),
      hostInfo: () => ({ hostId: 'host-1', hostName: 'vm', protocolVersion: '1' }),
      openSession: () => {
        throw new Error('no ordinary sessions in this test');
      },
      onDevicesChanged: () => {},
      routes: owner.routes,
      upgradeRoutes: owner.upgradeRoutes,
      logger: logger as never,
    });
    await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const link of openLinks.splice(0)) link.close();
    await owner.dispose();
    await http.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    vi.clearAllMocks();
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function enable(patch: { tailscaleOnly?: boolean; allowedLogins?: string[] } = {}) {
    expect((await owner.operations.setOwnerAccess({ enabled: true, ...patch })).success).toBe(true);
  }

  async function pairOwner(headers: Record<string, string> = {}): Promise<string> {
    const issued = await owner.operations.createOwnerPairingCode();
    if (!issued.success) throw new Error('no code');
    const response = await post(
      OWNER_PATHS.pair,
      { code: issued.data.code, deviceName: 'Studio PC' },
      headers
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  }

  async function dialStatus(path: string, headers: Record<string, string>): Promise<number> {
    const error = await connectWebSocketPipe({ url: `${base}${path}`, headers }).then(
      (pipe) => {
        pipe.close();
        return undefined;
      },
      (caught: unknown) => caught
    );
    if (error === undefined) return 101;
    expect(error).toBeInstanceOf(WebSocketHandshakeError);
    return (error as WebSocketHandshakeError).statusCode ?? 0;
  }

  async function openLink(token: string, headers: Record<string, string> = {}) {
    const pipe = await connectWebSocketPipe({
      url: `${base}${OWNER_PATHS.wire}`,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    const transport = v8MessageTransport(pipe);
    openLinks.push({ close: () => transport.close?.() });
    const disconnected = vi.fn();
    transport.onDisconnect(disconnected);
    const connection = connect(transport, { callTimeoutMs: 0 });
    return { connection, api: client(ownerHostWireContract, connection), disconnected };
  }

  const attachInput = {
    build: BUILD,
    clientName: 'Studio PC',
    clientPlatform: 'win32',
    takeover: false,
  };

  describe('while owner access is off', () => {
    it('is absent: every owner route answers 404 and nothing is touched', async () => {
      expect(owner.status()).toEqual({
        enabled: false,
        tailscaleOnly: true,
        allowedLogins: [],
        pairing: null,
        attachedClient: null,
      });
      expect((await post(OWNER_PATHS.pair, { code: 'X', deviceName: 'a' })).status).toBe(404);
      expect((await post(OWNER_PATHS.pairingCode, {})).status).toBe(404);
      expect(await dialStatus(OWNER_PATHS.wire, {})).toBe(404);
      expect(await dialStatus(OWNER_PATHS.tunnel, {})).toBe(404);
      expect((await owner.operations.createOwnerPairingCode()).success).toBe(false);

      const { credential } = await store.addDevice({ name: 'old owner', kind: 'owner' });
      expect(await dialStatus(OWNER_PATHS.wire, { Authorization: `Bearer ${credential}` })).toBe(
        404
      );

      expect(existsSync(join(directory, OWNER_SETUP_TOKEN_FILE))).toBe(false);
      expect(windowPort.destroy).not.toHaveBeenCalled();
      expect(registerSink).not.toHaveBeenCalled();
      expect(setExternalOpener).not.toHaveBeenCalled();
    });
  });

  describe('pairing', () => {
    it('pairs an owner once with an owner code', async () => {
      await enable();
      expect(existsSync(join(directory, OWNER_SETUP_TOKEN_FILE))).toBe(true);
      const issued = await owner.operations.createOwnerPairingCode();
      if (!issued.success) throw new Error('no code');
      expect(owner.status().pairing).toEqual(issued.data);

      const response = await post(OWNER_PATHS.pair, {
        code: issued.data.code,
        deviceName: 'Studio PC',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, string>;
      expect(body).toEqual({
        deviceId: expect.any(String),
        token: expect.stringMatching(new RegExp(`^${body.deviceId}\\.`)),
        hostId: store.current().hostId,
        hostName: 'vm',
      });
      expect(store.devices()).toEqual([
        expect.objectContaining({ kind: 'owner', name: 'Studio PC' }),
      ]);
      // Only the digest is stored.
      expect(await readFile(join(directory, 'remote-access.json'), 'utf8')).not.toContain(
        body.token!.split('.')[1]
      );
      expect(owner.status().pairing).toBeNull();

      const reused = await post(OWNER_PATHS.pair, { code: issued.data.code, deviceName: 'again' });
      expect(reused.status).toBe(401);
      expect(store.devices()).toHaveLength(1);
    });

    it('never accepts an ordinary pairing code as an owner code', async () => {
      await enable();
      // Both books hold a live code; only the owner book is consulted.
      expect((await owner.operations.createOwnerPairingCode()).success).toBe(true);
      const { code } = ordinaryPairing.issue();
      const response = await post(OWNER_PATHS.pair, { code, deviceName: 'sneaky' });
      expect(response.status).toBe(401);
      expect(store.devices()).toHaveLength(0);
    });

    it('applies the owner network rule before spending the code', async () => {
      await enable();
      const issued = await owner.operations.createOwnerPairingCode();
      if (!issued.success) throw new Error('no code');
      const body = { code: issued.data.code, deviceName: 'x' };

      const viaTunnel = await post(OWNER_PATHS.pair, body, FORWARDED_HEADERS);
      expect(viaTunnel.status).toBe(403);
      expect(await viaTunnel.json()).toEqual({ error: 'tailscale-required' });
      const fromPage = await post(OWNER_PATHS.pair, body, { Origin: base });
      expect(fromPage.status).toBe(403);
      expect(owner.status().pairing).toEqual(issued.data);

      const viaTailscale = await post(OWNER_PATHS.pair, body, TAILSCALE_HEADERS);
      expect(viaTailscale.status).toBe(200);
    });

    it('issues a code over direct loopback with the setup token only', async () => {
      await enable();
      const token = (await readFile(join(directory, OWNER_SETUP_TOKEN_FILE), 'utf8')).trim();
      expect(token.length).toBeGreaterThanOrEqual(40);

      expect((await post(OWNER_PATHS.pairingCode, {})).status).toBe(401);
      expect(
        (await post(OWNER_PATHS.pairingCode, {}, { Authorization: 'Bearer wrong-token-value' }))
          .status
      ).toBe(401);
      const auth = { Authorization: `Bearer ${token}` };
      expect(
        (await post(OWNER_PATHS.pairingCode, {}, { ...auth, ...TAILSCALE_HEADERS })).status
      ).toBe(403);
      expect((await post(OWNER_PATHS.pairingCode, {}, { ...auth, Origin: base })).status).toBe(403);
      const ownerCredential = { Authorization: `Bearer ${await pairOwner()}` };
      expect((await post(OWNER_PATHS.pairingCode, {}, ownerCredential)).status).toBe(401);

      const response = await post(OWNER_PATHS.pairingCode, {}, auth);
      expect(response.status).toBe(200);
      const issued = (await response.json()) as { code: string; expiresAt: number };
      expect(owner.status().pairing).toEqual(issued);
      expect((await post(OWNER_PATHS.pair, { code: issued.code, deviceName: 'vm' })).status).toBe(
        200
      );
    });

    it('keeps an existing setup token when owner access is turned on again', async () => {
      await enable();
      const first = await readFile(join(directory, OWNER_SETUP_TOKEN_FILE), 'utf8');
      await owner.operations.setOwnerAccess({ enabled: false });
      await enable();
      expect(await readFile(join(directory, OWNER_SETUP_TOKEN_FILE), 'utf8')).toBe(first);
    });
  });

  describe('the owner link', () => {
    it('admits only an owner credential, without Origin, under the network rule', async () => {
      await enable();
      const token = await pairOwner();
      const auth = { Authorization: `Bearer ${token}` };
      const { credential: desktopCredential } = await store.addDevice({
        name: 'other maestro',
        kind: 'desktop',
      });

      expect(await dialStatus(OWNER_PATHS.wire, {})).toBe(401);
      expect(await dialStatus(OWNER_PATHS.wire, { Authorization: 'Bearer nope.nope' })).toBe(401);
      expect(
        await dialStatus(OWNER_PATHS.wire, { Authorization: `Bearer ${desktopCredential}` })
      ).toBe(401);
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, Origin: base })).toBe(403);
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, ...FORWARDED_HEADERS })).toBe(403);
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, ...TAILSCALE_HEADERS })).toBe(101);
      expect(await dialStatus(OWNER_PATHS.wire, auth)).toBe(101);
    });

    it('admits other tunnels once tailscale-only is off', async () => {
      await enable({ tailscaleOnly: false });
      const auth = { Authorization: `Bearer ${await pairOwner(FORWARDED_HEADERS)}` };
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, ...FORWARDED_HEADERS })).toBe(101);
    });

    it('honours the login allowlist for tailnet users', async () => {
      await enable({ allowedLogins: ['someone-else@example.com'] });
      const auth = { Authorization: `Bearer ${await pairOwner()}` };
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, ...TAILSCALE_HEADERS })).toBe(403);
      await owner.operations.setOwnerAccess({ allowedLogins: [' ME@example.com '] });
      expect(store.current().ownerAccess.allowedLogins).toEqual(['ME@example.com']);
      expect(await dialStatus(OWNER_PATHS.wire, { ...auth, ...TAILSCALE_HEADERS })).toBe(101);
    });

    it('serves the host after attach, suspends the window and installs the bridge', async () => {
      await enable();
      const { connection, api } = await openLink(await pairOwner());

      const refused = await connection
        .call('desktop.host.getPlatform', undefined)
        .catch((error: unknown) => error);
      expect((refused as WireError).code).toBe('NOT_FOUND');
      expect(windowPort.destroy).not.toHaveBeenCalled();

      const attached = await api.session.attach(attachInput);
      expect(attached.success).toBe(true);
      expect(await connection.call('desktop.host.getPlatform', undefined)).toBe('linux');
      const external = await connection
        .call('desktop.host.openExternal', 'https://example.com')
        .catch((error: unknown) => error);
      expect((external as WireError).code).toBe('NOT_FOUND');
      expect(desktop.call).toHaveBeenCalledTimes(1);

      expect(windowPort.destroy).toHaveBeenCalledTimes(1);
      expect(registerSink).toHaveBeenCalledTimes(1);
      expect(opener).toBeTypeOf('function');
      expect(owner.status().attachedClient).toMatchObject({
        clientName: 'Studio PC',
        clientPlatform: 'win32',
      });
      expect(changes).toBeGreaterThan(0);
    });

    it('answers build-mismatch with the host build', async () => {
      await enable();
      const { api } = await openLink(await pairOwner());
      const result = await api.session.attach({
        ...attachInput,
        build: { version: '2.0.1', commit: 'beef000', dev: false },
      });
      expect(result).toEqual({ success: false, error: { type: 'build-mismatch', host: BUILD } });
      expect(windowPort.destroy).not.toHaveBeenCalled();
    });

    it('restores the window and the host banners after the client leaves', async () => {
      await enable();
      const { api } = await openLink(await pairOwner());
      await api.session.attach(attachInput);
      expect(windowState).toBeNull();

      owner.closeAll();
      await vi.waitFor(() => expect(windowPort.restore).toHaveBeenCalledWith({ visible: true }));
      expect(setExternalOpener).toHaveBeenLastCalledWith(undefined);
      expect(sinks.get('system')).toBeDefined();
      expect(owner.status().attachedClient).toBeNull();
      // The next client learns the host's renderer ran in between.
      const next = await openLink(await pairOwner());
      const result = await next.api.session.attach(attachInput);
      expect(result.success && result.data.brainEpoch).toBe(1);
    });

    it('closes the session when the device is revoked', async () => {
      await enable();
      const token = await pairOwner();
      const { api, disconnected } = await openLink(token);
      await api.session.attach(attachInput);
      const deviceId = token.split('.')[0]!;

      await store.removeDevice(deviceId);
      owner.closeDevice(deviceId);
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
      expect(owner.status().attachedClient).toBeNull();
      expect(await dialStatus(OWNER_PATHS.wire, { Authorization: `Bearer ${token}` })).toBe(401);
    });

    it('closes the session and refuses new ones when owner access is turned off', async () => {
      await enable();
      const token = await pairOwner();
      const { api, disconnected } = await openLink(token);
      await api.session.attach(attachInput);
      await owner.operations.createOwnerPairingCode();

      await owner.operations.setOwnerAccess({ enabled: false });
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());
      expect(owner.status().pairing).toBeNull();
      expect(await dialStatus(OWNER_PATHS.wire, { Authorization: `Bearer ${token}` })).toBe(404);
    });

    it('closes a tailnet session the narrowed allowlist no longer admits', async () => {
      await enable();
      const token = await pairOwner();
      const viaTailscale = await openLink(token, TAILSCALE_HEADERS);
      const viaLoopback = await openLink(token);
      await owner.operations.setOwnerAccess({ allowedLogins: ['someone-else@example.com'] });
      await vi.waitFor(() => expect(viaTailscale.disconnected).toHaveBeenCalled());
      expect(viaLoopback.disconnected).not.toHaveBeenCalled();
    });

    it('closes tunnels tracked for a device with its revocation', async () => {
      await enable();
      const token = await pairOwner();
      const deviceId = token.split('.')[0]!;
      const close = vi.fn();
      owner.tunnels.track(deviceId, { via: 'loopback', login: null }, close);
      expect(owner.connectionCount(deviceId)).toBe(1);
      owner.closeDevice(deviceId);
      expect(close).toHaveBeenCalledTimes(1);
      expect(owner.connectionCount(deviceId)).toBe(0);
    });

    it('serves loopback tunnels to the attached owner only, and closes them on revocation', async () => {
      const echo = createTcpServer((socket) => {
        socket.on('error', () => {});
        socket.pipe(socket);
      });
      await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
      const query = `?port=${(echo.address() as AddressInfo).port}&family=4`;
      try {
        await enable();
        const token = await pairOwner();
        const auth = { Authorization: `Bearer ${token}` };
        expect(await dialStatus(`${OWNER_PATHS.tunnel}${query}`, {})).toBe(401);
        expect(
          await dialStatus(`${OWNER_PATHS.tunnel}${query}`, { ...auth, ...FORWARDED_HEADERS })
        ).toBe(403);
        // Paired but not attached.
        expect(await dialStatus(`${OWNER_PATHS.tunnel}${query}`, auth)).toBe(409);

        const { api } = await openLink(token);
        expect((await api.session.attach(attachInput)).success).toBe(true);
        const tunnel = await connectWebSocketPipe({
          url: `${base}${OWNER_PATHS.tunnel}${query}`,
          headers: auth,
        });
        const echoed = new Promise<string>((resolve) =>
          tunnel.onMessage((bytes) => resolve(Buffer.from(bytes).toString()))
        );
        tunnel.send(Buffer.from('through the tunnel'));
        expect(await echoed).toBe('through the tunnel');
        expect(owner.connectionCount(token.split('.')[0]!)).toBe(2);

        const closed = new Promise<void>((resolve) => tunnel.onClose(resolve));
        owner.closeDevice(token.split('.')[0]!);
        await closed;
      } finally {
        echo.close();
      }
    });
  });
});
