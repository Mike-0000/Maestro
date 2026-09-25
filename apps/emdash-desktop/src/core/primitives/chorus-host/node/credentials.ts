import { secret, type Secret } from '@emdash/shared';
import type { SecretStore } from '@core/primitives/secrets/api/secret-store';
import { chorusCredentialIds, type ChorusCredentialId } from '../api/credentials';

const SECRET_KEY_PREFIX = 'chorus.credential.';

/** Environment variables honoured when no key is stored in the app. */
const ENV_FALLBACKS: Record<ChorusCredentialId, string> = {
  openai: 'OPENAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * API keys for Chorus's speech and conductor providers. Stored keys live in the OS-encrypted app
 * secret store and never leave the main process; the renderer only learns whether one is set.
 */
export class ChorusCredentials {
  constructor(
    private readonly secrets: SecretStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async get(id: ChorusCredentialId): Promise<Secret<string> | null> {
    const stored = await this.secrets.getSecret(SECRET_KEY_PREFIX + id);
    if (stored && stored.expose().trim()) return stored;
    const fromEnv = this.env[ENV_FALLBACKS[id]]?.trim();
    return fromEnv ? secret(fromEnv, id) : null;
  }

  async set(id: ChorusCredentialId, value: string | null): Promise<void> {
    const trimmed = value?.trim();
    if (trimmed) await this.secrets.setSecret(SECRET_KEY_PREFIX + id, secret(trimmed, id));
    else await this.secrets.deleteSecret(SECRET_KEY_PREFIX + id);
  }

  async presence(): Promise<Record<ChorusCredentialId, boolean>> {
    const entries = await Promise.all(
      chorusCredentialIds.map(async (id) => [id, (await this.get(id)) !== null] as const)
    );
    return Object.fromEntries(entries) as Record<ChorusCredentialId, boolean>;
  }
}
