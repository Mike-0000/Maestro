import { secret, type Secret } from '@emdash/shared';
import { z } from 'zod';
import { generateVapidKeys, vapidPublicKey, type VapidKeys } from './web-push';

const VAPID_KEY = 'remote-access.push.vapid';
const SUBSCRIPTIONS_KEY = 'remote-access.push.subscriptions';

const vapidSchema = z.object({
  version: z.literal(1),
  privateJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1),
    d: z.string().min(1),
  }),
});

export const pushEventsSchema = z.object({ complete: z.boolean(), attention: z.boolean() });
export type PushEvents = z.infer<typeof pushEventsSchema>;

const subscriptionSchema = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  events: pushEventsSchema,
  updatedAt: z.number(),
});
export type PushSubscriptionRecord = z.infer<typeof subscriptionSchema>;

const subscriptionsSchema = z.object({
  version: z.literal(1),
  byDevice: z.record(z.string(), subscriptionSchema),
});

/** The part of the encrypted secrets store this needs; anything it throws means "unavailable". */
export type PushSecrets = {
  getSecret(key: string): Promise<Secret<string> | null>;
  setSecret(key: string, value: Secret<string>): Promise<void>;
};

/**
 * This host's push identity and each paired phone's subscription. All of it is secret (a
 * subscription's endpoint is a capability URL), so it lives in the encrypted secrets store
 * rather than beside the device list. One subscription per paired device.
 */
export class PushStore {
  private keys: Promise<VapidKeys | null> | undefined;
  private subscriptions: Promise<Map<string, PushSubscriptionRecord>> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: PushSecrets) {}

  /** The host's key pair, created on first use. Null when it cannot be stored securely. */
  vapid(): Promise<VapidKeys | null> {
    this.keys ??= this.loadVapid().catch(() => {
      // Never fall back to a key that would be gone after a restart.
      this.keys = undefined;
      return null;
    });
    return this.keys;
  }

  async get(deviceId: string): Promise<PushSubscriptionRecord | undefined> {
    return (await this.load()).get(deviceId);
  }

  async all(): Promise<Array<[deviceId: string, record: PushSubscriptionRecord]>> {
    return [...(await this.load())];
  }

  async upsert(deviceId: string, record: PushSubscriptionRecord): Promise<void> {
    (await this.load()).set(deviceId, record);
    await this.persist();
  }

  async remove(deviceId: string): Promise<void> {
    if ((await this.load()).delete(deviceId)) await this.persist();
  }

  private async loadVapid(): Promise<VapidKeys> {
    const stored = await this.secrets.getSecret(VAPID_KEY);
    const parsed = stored ? vapidSchema.safeParse(parseJson(stored.expose())) : undefined;
    if (parsed?.success) {
      const { privateJwk } = parsed.data;
      return { publicKey: vapidPublicKey(privateJwk), privateJwk };
    }
    const keys = generateVapidKeys();
    await this.secrets.setSecret(
      VAPID_KEY,
      secret(JSON.stringify({ version: 1, privateJwk: keys.privateJwk }), VAPID_KEY)
    );
    return keys;
  }

  private load(): Promise<Map<string, PushSubscriptionRecord>> {
    this.subscriptions ??= this.secrets
      .getSecret(SUBSCRIPTIONS_KEY)
      .catch((error: unknown) => {
        // Read again next time: an empty list kept from a failed read would overwrite the
        // real one on the next save.
        this.subscriptions = undefined;
        throw error;
      })
      .then((stored) => {
        const parsed = stored
          ? subscriptionsSchema.safeParse(parseJson(stored.expose()))
          : undefined;
        return new Map(parsed?.success ? Object.entries(parsed.data.byDevice) : []);
      });
    return this.subscriptions;
  }

  private persist(): Promise<void> {
    const write = this.writing.then(async () => {
      const byDevice = Object.fromEntries(await this.load());
      await this.secrets.setSecret(
        SUBSCRIPTIONS_KEY,
        secret(JSON.stringify({ version: 1, byDevice }), SUBSCRIPTIONS_KEY)
      );
    });
    this.writing = write.catch(() => {});
    return write;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
