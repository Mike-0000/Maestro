import type { Secret } from '@emdash/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';

/**
 * Secret-store keys for a Maestro host's credentials. They share the machine-credential key
 * space (`ssh:<connection id>:<kind>`) with SSH passwords and passphrases, under kinds of their
 * own, so they live in the same encrypted store and never in connection metadata.
 */
export function maestroHostCredentialKeys(connectionId: string) {
  return {
    deviceToken: `ssh:${connectionId}:maestro-device-token`,
    cfAccessClientSecret: `ssh:${connectionId}:cf-access-client-secret`,
  };
}

/** A value replaces the stored secret, null deletes it, and undefined leaves it untouched. */
export type MaestroHostCredentialUpdate = {
  deviceToken?: Secret<string> | null;
  cfAccessClientSecret?: Secret<string> | null;
};

/** The secret-store writes for an update, to commit atomically with the machine row. */
export function maestroHostCredentialChanges(
  connectionId: string,
  update: MaestroHostCredentialUpdate
): Map<string, Secret<string> | null> {
  const keys = maestroHostCredentialKeys(connectionId);
  const changes = new Map<string, Secret<string> | null>();
  if (update.deviceToken !== undefined) changes.set(keys.deviceToken, update.deviceToken);
  if (update.cfAccessClientSecret !== undefined) {
    changes.set(keys.cfAccessClientSecret, update.cfAccessClientSecret);
  }
  return changes;
}

/**
 * Reads and removes a Maestro host's device token and Cloudflare Access client secret. Values
 * stay wrapped in `Secret`; they are disclosed only where a request's headers are assembled.
 */
export class MaestroHostCredentialService {
  constructor(private readonly secrets: SecretStore) {}

  getDeviceToken(connectionId: string): Promise<Secret<string> | null> {
    return this.secrets.getSecret(maestroHostCredentialKeys(connectionId).deviceToken);
  }

  getCfAccessClientSecret(connectionId: string): Promise<Secret<string> | null> {
    return this.secrets.getSecret(maestroHostCredentialKeys(connectionId).cfAccessClientSecret);
  }

  async deleteAllCredentials(connectionId: string): Promise<void> {
    const keys = maestroHostCredentialKeys(connectionId);
    await Promise.all([
      this.secrets.deleteSecret(keys.deviceToken).catch(() => {}),
      this.secrets.deleteSecret(keys.cfAccessClientSecret).catch(() => {}),
    ]);
  }
}
