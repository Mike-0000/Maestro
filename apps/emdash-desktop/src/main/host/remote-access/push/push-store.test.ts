import { describe, expect, it } from 'vitest';
import { PushStore, type PushSubscriptionRecord } from './push-store';
import { MemoryPushSecrets, TEST_SUBSCRIPTION } from './testing';

function record(overrides: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    ...TEST_SUBSCRIPTION,
    events: { complete: true, attention: true },
    updatedAt: 1,
    ...overrides,
  };
}

describe('PushStore', () => {
  it('creates the key pair once and keeps it across restarts', async () => {
    const secrets = new MemoryPushSecrets();
    const first = await new PushStore(secrets).vapid();
    const second = await new PushStore(secrets).vapid();

    expect(first?.publicKey).toBeTruthy();
    expect(second).toEqual(first);
  });

  it('reports push unavailable rather than using a key it cannot keep', async () => {
    const secrets = new MemoryPushSecrets();
    secrets.unavailable = true;
    const store = new PushStore(secrets);
    expect(await store.vapid()).toBeNull();

    secrets.unavailable = false;
    expect(await store.vapid()).not.toBeNull();
  });

  it('keeps one subscription per device across restarts', async () => {
    const secrets = new MemoryPushSecrets();
    const store = new PushStore(secrets);
    await store.upsert('phone', record());
    await store.upsert('phone', record({ events: { complete: true, attention: false } }));
    await store.upsert('tablet', record({ endpoint: 'https://fcm.googleapis.com/fcm/send/def' }));

    const reopened = new PushStore(secrets);
    expect((await reopened.all()).map(([deviceId]) => deviceId)).toEqual(['phone', 'tablet']);
    expect((await reopened.get('phone'))?.events).toEqual({ complete: true, attention: false });

    await reopened.remove('phone');
    expect(await new PushStore(secrets).get('phone')).toBeUndefined();
  });

  it('does not forget subscriptions after a read that failed', async () => {
    const secrets = new MemoryPushSecrets();
    await new PushStore(secrets).upsert('phone', record());

    const store = new PushStore(secrets);
    secrets.unavailable = true;
    await expect(store.all()).rejects.toThrow();
    secrets.unavailable = false;
    await store.upsert('tablet', record());
    expect((await store.all()).map(([deviceId]) => deviceId)).toEqual(['phone', 'tablet']);
  });

  it('treats unreadable stored subscriptions as none', async () => {
    const secrets = new MemoryPushSecrets();
    secrets.values.set('remote-access.push.subscriptions', '{not json');
    expect(await new PushStore(secrets).all()).toEqual([]);
  });
});
