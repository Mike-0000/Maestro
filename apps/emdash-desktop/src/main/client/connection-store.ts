import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLIENT_CONNECTION_FILE,
  storedClientConnectionSchema,
  type StoredClientConnection,
} from '@core/primitives/client-mode/api/client-profile';

// The one host a client profile is paired with, in `<userData>/client-connection.json`. The device
// token and the Cloudflare Access secret are encrypted with the OS keychain (Electron
// `safeStorage`); when encryption is unavailable nothing is stored at all, so a credential never
// lands on disk in the clear.

/** The part of Electron's `safeStorage` the store uses; tests pass a fake. */
export type SecretCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/** A paired host, with its credentials in the clear (in memory only). */
export type ClientConnection = {
  /** Canonical base URL, as `normalizeMaestroHostUrl` returns it. */
  url: string;
  hostId: string;
  hostName: string;
  deviceId: string;
  token: string;
  cfAccess?: { clientId: string; clientSecret: string };
  pairedAt: number;
};

export type ConnectionStoreError =
  | { type: 'encryption-unavailable'; message: string }
  | { type: 'io'; message: string };

export type ConnectionStore = {
  /** The stored connection, or null when there is none or it cannot be read or decrypted. */
  load(): Promise<ClientConnection | null>;
  save(connection: ClientConnection): Promise<ConnectionStoreError | null>;
  clear(): Promise<void>;
};

export function createConnectionStore(options: {
  userDataDir: string;
  cipher: SecretCipher;
  log?: { warn(message: string, context?: Record<string, unknown>): void };
}): ConnectionStore {
  const path = join(options.userDataDir, CLIENT_CONNECTION_FILE);
  const { cipher } = options;

  const encrypt = (plain: string): string => cipher.encryptString(plain).toString('base64');
  const decrypt = (stored: string): string => cipher.decryptString(Buffer.from(stored, 'base64'));

  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        return null;
      }
      try {
        const parsed = storedClientConnectionSchema.safeParse(JSON.parse(text));
        if (!parsed.success) {
          options.log?.warn('client connection file is not valid; ignoring it');
          return null;
        }
        if (!cipher.isEncryptionAvailable()) {
          options.log?.warn('client connection cannot be decrypted: OS encryption unavailable');
          return null;
        }
        const stored = parsed.data;
        return {
          url: stored.url,
          hostId: stored.hostId,
          hostName: stored.hostName,
          deviceId: stored.deviceId,
          token: decrypt(stored.token),
          ...(stored.cfAccess && {
            cfAccess: {
              clientId: stored.cfAccess.clientId,
              clientSecret: decrypt(stored.cfAccess.clientSecret),
            },
          }),
          pairedAt: stored.pairedAt,
        };
      } catch (error) {
        options.log?.warn('client connection could not be read', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    async save(connection) {
      if (!cipher.isEncryptionAvailable()) {
        return {
          type: 'encryption-unavailable',
          message:
            'This computer cannot encrypt the host credential (the OS keychain is unavailable), so it was not saved.',
        };
      }
      try {
        const stored: StoredClientConnection = {
          version: 1,
          url: connection.url,
          hostId: connection.hostId,
          hostName: connection.hostName,
          deviceId: connection.deviceId,
          token: encrypt(connection.token),
          ...(connection.cfAccess && {
            cfAccess: {
              clientId: connection.cfAccess.clientId,
              clientSecret: encrypt(connection.cfAccess.clientSecret),
            },
          }),
          pairedAt: connection.pairedAt,
        };
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 });
        await rename(temporary, path);
        return null;
      } catch (error) {
        return { type: 'io', message: error instanceof Error ? error.message : String(error) };
      }
    },

    async clear() {
      await rm(path, { force: true });
    },
  };
}
