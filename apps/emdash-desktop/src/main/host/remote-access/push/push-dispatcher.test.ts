import { describe, expect, it, vi } from 'vitest';
import type { NotificationDeliveryBatch } from '@core/services/notifications/api/ports';
import type { AppNotification } from '@core/services/notifications/api/schemas';
import { createPushDispatcher, payloadFor, type PushPayload } from './push-dispatcher';
import { PushStore, type PushEvents } from './push-store';
import { MemoryPushSecrets, TEST_SUBSCRIPTION } from './testing';
import type { PushSender, PushSendResult } from './web-push';

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n-1',
    kind: 'agent-complete',
    groupKey: 'conversation:conv-1',
    title: 'Claude - fix login',
    body: 'Your agent has finished working',
    target: { kind: 'task', projectId: 'project-1', taskId: 'task-1', conversationId: 'conv-1' },
    source: {
      kind: 'conversation',
      projectId: 'project-1',
      taskId: 'task-1',
      conversationId: 'conv-1',
    },
    sound: 'task_complete',
    count: 1,
    createdAt: 1,
    readAt: null,
    ...overrides,
  };
}

function batch(...items: AppNotification[]): NotificationDeliveryBatch {
  const latest = items[items.length - 1] ?? notification();
  return { notification: latest, items, summary: { title: latest.title, body: latest.body } };
}

const BOTH: PushEvents = { complete: true, attention: true };

async function setup(results: PushSendResult[] = [{ outcome: 'sent' }], events: PushEvents = BOTH) {
  const store = new PushStore(new MemoryPushSecrets());
  await store.upsert('phone', { ...TEST_SUBSCRIPTION, events, updatedAt: 1 });
  const state = { enabled: true, paired: ['phone'] };
  const send = vi.fn<PushSender>(async () => results.shift() ?? { outcome: 'sent' });
  const waits: number[] = [];
  const dispatcher = createPushDispatcher({
    store,
    send,
    enabled: () => state.enabled,
    pairedDeviceIds: () => state.paired,
    logger: { warn: vi.fn() },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  const sent = (): PushPayload[] =>
    send.mock.calls.map(([, , message]) => JSON.parse(message.payload) as PushPayload);
  return { store, state, send, sent, waits, dispatcher };
}

describe('payloadFor', () => {
  it('links to the agent and keeps the desktop wording', () => {
    expect(payloadFor(batch(notification()), BOTH)).toEqual({
      v: 1,
      title: 'Claude - fix login',
      body: 'Your agent has finished working',
      tag: 'conversation:conv-1',
      url: '/agent/conv-1',
    });
  });

  it('tells a device only about the events it chose', () => {
    const mixed = batch(
      notification({ id: 'a', kind: 'agent-complete', body: 'done' }),
      notification({ id: 'b', kind: 'agent-attention', body: 'waiting' })
    );
    expect(payloadFor(mixed, { complete: true, attention: false })?.body).toBe('done');
    expect(payloadFor(mixed, BOTH)?.body).toBe('waiting (2 notifications)');
    expect(payloadFor(mixed, { complete: false, attention: false })).toBeNull();
    expect(payloadFor(batch(notification({ kind: 'update-downloaded' })), BOTH)).toBeNull();
  });

  it('shortens a long body and falls back to the home screen without a conversation', () => {
    const payload = payloadFor(
      batch(
        notification({
          body: 'x'.repeat(500),
          target: { kind: 'task', projectId: 'project-1', taskId: 'task-1' },
        })
      ),
      BOTH
    );
    expect(payload?.body).toHaveLength(300);
    expect(payload?.url).toBe('/');
  });
});

describe('createPushDispatcher', () => {
  it('sends a flushed batch to a subscribed phone', async () => {
    const { dispatcher, send, sent } = await setup();
    void dispatcher.sink.deliver(batch(notification()));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent()[0]?.url).toBe('/agent/conv-1');
    expect(send.mock.calls[0]?.[2].topic).toHaveLength(32);
  });

  it('sends nothing while remote access is off', async () => {
    const { dispatcher, send, state } = await setup();
    state.enabled = false;
    void dispatcher.sink.deliver(batch(notification()));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it('forgets a device that is no longer paired instead of notifying it', async () => {
    const { dispatcher, send, state, store } = await setup();
    state.paired = [];
    void dispatcher.sink.deliver(batch(notification()));

    await vi.waitFor(async () => expect(await store.get('phone')).toBeUndefined());
    expect(send).not.toHaveBeenCalled();
  });

  it('drops a subscription the push service says is gone', async () => {
    const { dispatcher, store } = await setup([{ outcome: 'gone', status: 410 }]);
    void dispatcher.sink.deliver(batch(notification()));

    await vi.waitFor(async () => expect(await store.get('phone')).toBeUndefined());
  });

  it('retries a refused message once, after the wait it was given', async () => {
    const { dispatcher, send, waits } = await setup([
      { outcome: 'retry', status: 429, retryAfterMs: 7000 },
      { outcome: 'retry', status: 429, retryAfterMs: 7000 },
    ]);
    void dispatcher.sink.deliver(batch(notification()));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7000]);
  });

  it('does not retry a send whose outcome is unknown', async () => {
    const { dispatcher, send } = await setup([{ outcome: 'failed' }]);
    void dispatcher.sink.deliver(batch(notification()));

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a test whatever events the device chose', async () => {
    const { dispatcher, sent } = await setup(undefined, { complete: false, attention: false });
    expect(await dispatcher.sendTest('phone')).toEqual({ ok: true });
    expect(sent()[0]?.tag).toBe('maestro-test');
    expect(await dispatcher.sendTest('stranger')).toEqual({ ok: false, reason: 'not-subscribed' });
  });

  it('reports an expired subscription from a test and forgets it', async () => {
    const { dispatcher, store } = await setup([{ outcome: 'gone', status: 410 }]);
    expect(await dispatcher.sendTest('phone')).toEqual({ ok: false, reason: 'expired' });
    expect(await store.get('phone')).toBeUndefined();
  });
});
