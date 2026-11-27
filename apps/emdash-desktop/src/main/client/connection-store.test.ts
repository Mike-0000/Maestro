import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_CONNECTION_FILE } from '@core/primitives/client-mode/api/client-profile';
import {
  createConnectionStore,
  type ClientConnection,
  type SecretCipher,
} from './connection-store';

/** Reversible stand-in for the OS keychain. */
function fakeCipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString();
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return text.slice(4);
    },
  };
}

const CONNECTION: ClientConnection = {
  url: 'https://vm.tailnet.ts.net',
  hostId: 'host-1',
  hostName: 'vm',
  deviceId: 'device-1',
  token: 'secret-token',
  cfAccess: { clientId: 'id', clientSecret: 'cf-secret' },
  pairedAt: 123,
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'client-connection-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('connection store', () => {
  it('round-trips a connection without writing credentials in the clear', async () => {
    const store = createConnectionStore({ userDataDir: directory, cipher: fakeCipher() });
    expect(await store.save(CONNECTION)).toBeNull();
    const raw = await readFile(join(directory, CLIENT_CONNECTION_FILE), 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('cf-secret');
    expect(await store.load()).toEqual(CONNECTION);
  });

  it('refuses to store when OS encryption is unavailable', async () => {
    const store = createConnectionStore({ userDataDir: directory, cipher: fakeCipher(false) });
    expect(await store.save(CONNECTION)).toMatchObject({ type: 'encryption-unavailable' });
    expect(await store.load()).toBeNull();
  });

  it('treats a missing, corrupt or undecryptable file as no connection', async () => {
    const store = createConnectionStore({ userDataDir: directory, cipher: fakeCipher() });
    expect(await store.load()).toBeNull();
    await writeFile(join(directory, CLIENT_CONNECTION_FILE), '{nope');
    expect(await store.load()).toBeNull();
    await writeFile(
      join(directory, CLIENT_CONNECTION_FILE),
      JSON.stringify({ ...CONNECTION, version: 1, token: 'Zm9v', cfAccess: undefined })
    );
    expect(await store.load()).toBeNull();
  });

  it('clears the stored connection', async () => {
    const store = createConnectionStore({ userDataDir: directory, cipher: fakeCipher() });
    await store.save(CONNECTION);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
