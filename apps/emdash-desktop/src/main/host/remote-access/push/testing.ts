import { secret, type Secret } from '@emdash/shared';
import type { PushSecrets } from './push-store';

/** An in-memory stand-in for the encrypted secrets store. */
export class MemoryPushSecrets implements PushSecrets {
  readonly values = new Map<string, string>();
  /** When set, every call throws, as it does when the OS keychain is unavailable. */
  unavailable = false;

  async getSecret(key: string): Promise<Secret<string> | null> {
    this.assertAvailable();
    const value = this.values.get(key);
    if (value === undefined) return null;
    return secret(value, key);
  }

  async setSecret(key: string, value: Secret<string>): Promise<void> {
    this.assertAvailable();
    this.values.set(key, value.expose());
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new Error('Secure secret storage is unavailable on this system.');
  }
}

export const TEST_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
