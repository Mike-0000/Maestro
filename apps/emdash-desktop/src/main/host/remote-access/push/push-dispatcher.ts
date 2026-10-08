import type { Logger } from '@emdash/shared/logger';
import type {
  NotificationDeliveryBatch,
  NotificationSink,
} from '@core/services/notifications/api/ports';
import type { AppNotification } from '@core/services/notifications/api/schemas';
import type { PushEvents, PushStore } from './push-store';
import { pushTopic, type PushSender, type PushSendResult } from './web-push';

const MAX_CONCURRENT_SENDS = 4;
const MAX_QUEUED_SENDS = 50;
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 300;

export type PushTestResult =
  | { ok: true }
  | { ok: false; reason: 'not-subscribed' | 'unavailable' | 'expired' | 'failed' };

export type PushDispatcher = {
  /** Registered with the notification service; forwards agent notifications to phones. */
  sink: NotificationSink;
  /** Sends a test notification to one device, whatever events it has chosen. */
  sendTest(deviceId: string): Promise<PushTestResult>;
};

export type PushDispatcherOptions = {
  store: PushStore;
  send: PushSender;
  /** Whether remote access is switched on. */
  enabled(): boolean;
  pairedDeviceIds(): string[];
  logger: Pick<Logger, 'warn'>;
  wait?(ms: number): Promise<void>;
};

type Job = { deviceId: string; payload: string; topic: string };

/** The message a phone shows, as its service worker reads it. */
export type PushPayload = { v: 1; title: string; body: string; tag: string; url: string };

export function createPushDispatcher(options: PushDispatcherOptions): PushDispatcher {
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const queue: Job[] = [];
  let active = 0;

  function pump(): void {
    while (active < MAX_CONCURRENT_SENDS) {
      const job = queue.shift();
      if (!job) return;
      active += 1;
      void deliver(job)
        .catch((error: unknown) => {
          options.logger.warn('Phone notification failed', { error: String(error) });
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  async function deliver(job: Job): Promise<void> {
    const first = await attempt(job);
    if (first?.outcome !== 'retry') return;
    await wait(first.retryAfterMs);
    await attempt(job);
  }

  /** One send, checked against what is true now: switches and pairings change while queued. */
  async function attempt(job: Job): Promise<PushSendResult | undefined> {
    if (!options.enabled()) return undefined;
    if (!options.pairedDeviceIds().includes(job.deviceId)) {
      await options.store.remove(job.deviceId);
      return undefined;
    }
    const subscription = await options.store.get(job.deviceId);
    const vapid = await options.store.vapid();
    if (!subscription || !vapid) return undefined;

    const result = await options.send(vapid, subscription, {
      payload: job.payload,
      topic: job.topic,
    });
    if (result.outcome === 'gone') await options.store.remove(job.deviceId);
    if (result.outcome !== 'sent') {
      options.logger.warn('Phone notification was not accepted', {
        deviceId: job.deviceId,
        outcome: result.outcome,
        status: 'status' in result ? result.status : undefined,
      });
    }
    return result;
  }

  async function enqueueBatch(batch: NotificationDeliveryBatch): Promise<void> {
    if (!options.enabled()) return;
    for (const [deviceId, subscription] of await options.store.all()) {
      const payload = payloadFor(batch, subscription.events);
      if (!payload) continue;
      // A phone that cannot be reached must not hold a growing backlog of stale news.
      if (queue.length >= MAX_QUEUED_SENDS) queue.shift();
      queue.push({ deviceId, payload: JSON.stringify(payload), topic: pushTopic(payload.tag) });
    }
    pump();
  }

  return {
    sink: {
      id: 'mobile-push',
      // Returns at once: a slow push service must not hold up the desktop's own alerts.
      deliver(batch) {
        void enqueueBatch(batch).catch((error: unknown) => {
          options.logger.warn('Phone notification failed', { error: String(error) });
        });
      },
    },
    async sendTest(deviceId) {
      const subscription = await options.store.get(deviceId);
      if (!subscription) return { ok: false, reason: 'not-subscribed' };
      const vapid = await options.store.vapid();
      if (!vapid) return { ok: false, reason: 'unavailable' };
      const payload: PushPayload = {
        v: 1,
        title: 'Maestro',
        body: 'Notifications are working on this phone.',
        tag: 'maestro-test',
        url: '/',
      };
      const result = await options.send(vapid, subscription, { payload: JSON.stringify(payload) });
      if (result.outcome === 'sent') return { ok: true };
      if (result.outcome !== 'gone') return { ok: false, reason: 'failed' };
      await options.store.remove(deviceId);
      return { ok: false, reason: 'expired' };
    },
  };
}

/** What one device should be told about a batch, or null when it asked for none of it. */
export function payloadFor(
  batch: NotificationDeliveryBatch,
  events: PushEvents
): PushPayload | null {
  const wanted = batch.items.filter((item) => wants(events, item));
  const latest = wanted[wanted.length - 1];
  if (!latest) return null;
  const body = wanted.length > 1 ? `${latest.body} (${wanted.length} notifications)` : latest.body;
  const conversationId = latest.target.kind === 'task' ? latest.target.conversationId : undefined;
  return {
    v: 1,
    title: truncate(latest.title, MAX_TITLE_LENGTH),
    body: truncate(body, MAX_BODY_LENGTH),
    tag: latest.groupKey,
    url: conversationId ? `/agent/${encodeURIComponent(conversationId)}` : '/',
  };
}

function wants(events: PushEvents, notification: AppNotification): boolean {
  if (notification.kind === 'agent-complete') return events.complete;
  if (notification.kind === 'agent-attention') return events.attention;
  return false;
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
