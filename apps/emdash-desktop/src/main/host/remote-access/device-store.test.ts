import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('forgets a removed device', async () => {
    const store = new RemoteDeviceStore(filePath);
    await store.load();
    const { device, credential } = await store.addDevice({ name: 'Laptop', kind: 'desktop' });
    expect(await store.removeDevice(device.id)).toBe(true);
    expect(await store.removeDevice(device.id)).toBe(false);
    expect(store.authenticate(credential)).toBeUndefined();
  });
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
