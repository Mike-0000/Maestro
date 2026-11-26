import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_REMOTE_ACCESS_PORT, RemoteDeviceStore } from './device-store';
import { normalizePairingCode, PairingCodes } from './pairing';

describe('RemoteDeviceStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maestro-device-store-'));
    filePath = join(directory, 'nested', 'remote-access.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts disabled on loopback with a stable host id', async () => {
    const store = new RemoteDeviceStore(filePath);
    const state = await store.load();
    expect(state).toMatchObject({
      enabled: false,
      port: DEFAULT_REMOTE_ACCESS_PORT,
      bindAddress: '127.0.0.1',
      devices: [],
    });
    await store.update({ enabled: true });

    const reloaded = await new RemoteDeviceStore(filePath).load();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.hostId).toBe(state.hostId);
  });

  it('authenticates only the credential it issued and never stores the token', async () => {
    const store = new RemoteDeviceStore(filePath);
    await store.load();
    const { device, credential } = await store.addDevice({ name: 'Phone', kind: 'browser' });
    const token = credential.slice(credential.indexOf('.') + 1);

    expect(store.authenticate(credential)?.id).toBe(device.id);
    expect(store.authenticate(`${device.id}.${token}x`)).toBeUndefined();
    expect(store.authenticate(`other.${token}`)).toBeUndefined();
    expect(store.authenticate(undefined)).toBeUndefined();
    expect(await readFile(filePath, 'utf8')).not.toContain(token);

    const reloaded = new RemoteDeviceStore(filePath);
    await reloaded.load();
    expect(reloaded.authenticate(credential)?.name).toBe('Phone');
  });

  it('loads a settings file from before owner access with owner access off', async () => {
    const existing = {
      version: 1,
      enabled: true,
      port: 7462,
      bindAddress: '127.0.0.1',
      hostId: 'host-1',
      devices: [
        {
          id: 'd1',
          name: 'Laptop',
          kind: 'desktop',
          tokenHash: 'ab',
          createdAt: 1,
          lastSeenAt: null,
        },
      ],
      triggers: { tokenDigest: null, routes: {}, maxQueued: 20 },
    };
    await mkdir(join(directory, 'nested'), { recursive: true });
    await writeFile(filePath, JSON.stringify(existing));

    const state = await new RemoteDeviceStore(filePath).load();
    expect(state).toMatchObject({ enabled: true, hostId: 'host-1' });
    expect(state.devices).toHaveLength(1);
    expect(state.ownerAccess).toEqual({ enabled: false, tailscaleOnly: true, allowedLogins: [] });
    expect(state.hostUpdates).toEqual({ mode: 'manual' });
  });

  it('fills in owner access fields a person left out of the file', async () => {
    await mkdir(join(directory, 'nested'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: true,
        port: 7462,
        bindAddress: '127.0.0.1',
        hostId: 'host-1',
        devices: [],
        ownerAccess: { enabled: true },
        hostUpdates: {},
      })
    );
    const state = await new RemoteDeviceStore(filePath).load();
    expect(state.hostId).toBe('host-1');
    expect(state.ownerAccess).toEqual({ enabled: true, tailscaleOnly: true, allowedLogins: [] });
    expect(state.hostUpdates).toEqual({ mode: 'manual' });
  });

  it('updates owner access settings and keeps them', async () => {
    const store = new RemoteDeviceStore(filePath);
    expect((await store.load()).ownerAccess.enabled).toBe(false);
    await store.updateOwnerAccess({ enabled: true, allowedLogins: ['me@example.com'] });
    await store.updateOwnerAccess({ tailscaleOnly: undefined });

    const reloaded = await new RemoteDeviceStore(filePath).load();
    expect(reloaded.ownerAccess).toEqual({
      enabled: true,
      tailscaleOnly: true,
      allowedLogins: ['me@example.com'],
    });
  });

  it('forgets a removed device', async () => {
    const store = new RemoteDeviceStore(filePath);
    await store.load();
    const { device, credential } = await store.addDevice({ name: 'Laptop', kind: 'desktop' });
    expect(await store.removeDevice(device.id)).toBe(true);
    expect(await store.removeDevice(device.id)).toBe(false);
    expect(store.authenticate(credential)).toBeUndefined();
  });

  it('keeps owners apart from ordinary devices, and authenticates and revokes them', async () => {
    const store = new RemoteDeviceStore(filePath);
    await store.load();
    const desktop = await store.addDevice({ name: 'Laptop', kind: 'desktop' });
    const owner = await store.addDevice({ name: 'Studio PC', kind: 'owner' });
    expect(owner.device.kind).toBe('owner');

    const file = JSON.parse(await readFile(filePath, 'utf8')) as {
      devices: Array<{ id: string; kind: string }>;
      ownerDevices: Array<{ id: string; kind?: string }>;
    };
    expect(file.devices.map((device) => device.kind)).toEqual(['desktop']);
    expect(file.ownerDevices.map((device) => device.id)).toEqual([owner.device.id]);
    expect(file.ownerDevices[0]?.kind).toBeUndefined();

    expect(store.devices().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'Laptop', kind: 'desktop' },
      { name: 'Studio PC', kind: 'owner' },
    ]);
    expect(store.authenticate(owner.credential)).toMatchObject({
      id: owner.device.id,
      kind: 'owner',
    });
    expect(store.devices().find((device) => device.kind === 'owner')?.lastSeenAt).toEqual(
      expect.any(Number)
    );
    expect(store.authenticate(desktop.credential)?.kind).toBe('desktop');
    // A token is bound to its own device id, across the two lists.
    const swapped = `${desktop.device.id}.${owner.credential.split('.')[1]}`;
    expect(store.authenticate(swapped)).toBeUndefined();

    // Waits for the last-seen writes, so the two stores never write the file at once.
    await store.update({});
    const reloaded = new RemoteDeviceStore(filePath);
    await reloaded.load();
    expect(reloaded.authenticate(owner.credential)?.kind).toBe('owner');
    await reloaded.update({});
    expect(await reloaded.removeDevice(owner.device.id)).toBe(true);
    expect(reloaded.authenticate(owner.credential)).toBeUndefined();
    expect(reloaded.devices().map((device) => device.kind)).toEqual(['desktop']);
  });

  it('writes a file that a build from before owner access still reads, devices intact', async () => {
    const store = new RemoteDeviceStore(filePath);
    await store.load();
    await store.update({ enabled: true });
    await store.addDevice({ name: 'Phone', kind: 'browser' });
    await store.addDevice({ name: 'Studio PC', kind: 'owner' });
    await store.updateOwnerAccess({ enabled: true });

    const parsed = headStateSchema.safeParse(JSON.parse(await readFile(filePath, 'utf8')));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      enabled: true,
      hostId: store.current().hostId,
      devices: [expect.objectContaining({ name: 'Phone', kind: 'browser' })],
    });
  });
});

/** `stateSchema` exactly as the build before owner access shipped it. */
const headDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['desktop', 'browser']),
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});
const headStateSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  bindAddress: z.string(),
  hostId: z.string(),
  devices: z.array(headDeviceSchema),
  triggers: z
    .object({
      tokenDigest: z.string().nullable(),
      routes: z.record(
        z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u),
        z.object({ automationId: z.string() })
      ),
      maxQueued: z.number().int().positive(),
    })
    .default({ tokenDigest: null, routes: {}, maxQueued: 20 }),
});

describe('PairingCodes', () => {
  it('accepts its code once, in any spelling, and expires it', () => {
    let now = 1_000;
    const codes = new PairingCodes(() => now);
    const issued = codes.issue();
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    expect(codes.current()).toEqual(issued);

    expect(codes.redeem(` ${issued.code.toLowerCase()} `)).toBe('accepted');
    expect(codes.redeem(issued.code)).toBe('invalid');
    expect(codes.current()).toBeUndefined();

    const second = codes.issue();
    now = second.expiresAt + 1;
    expect(codes.redeem(second.code)).toBe('invalid');
  });

  it('stops answering after too many failures, then recovers', () => {
    let now = 0;
    const codes = new PairingCodes(() => now);
    const issued = codes.issue();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(codes.redeem('ZZZZ-ZZZZ')).toBe('invalid');
    }
    expect(codes.redeem(issued.code)).toBe('rate-limited');
    now += 5 * 60_000 + 1;
    expect(codes.redeem(issued.code)).toBe('accepted');
  });

  it('normalises typed codes', () => {
    expect(normalizePairingCode('ab cd-ef_gh')).toBe('ABCDEFGH');
  });
});
