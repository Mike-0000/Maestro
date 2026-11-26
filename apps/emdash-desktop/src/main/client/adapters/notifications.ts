import type { Logger } from '@emdash/shared/logger';
import type { OwnerNotification } from '@core/features/client-mode/api/owner-contract';
import type {
  EmitNotificationDelivery,
  NotificationDeliveryBatch,
  NotificationSink,
} from '@core/services/notifications/api/ports';
import type { AppNotification } from '@core/services/notifications/api/schemas';
import type { OwnerHostClient } from '../host-link';

// OS banners in client mode. The host's notification feed is forwarded like any other domain;
// the banners the host would have shown come over `bridge.notifications` and are shown here, on
// the computer the developer sits at. A click tells the host, which emits the `open` delivery the
// renderer already handles.

export function startOwnerNotificationBridge(options: {
  host: () => Promise<OwnerHostClient>;
  /** The system banner sink (`createSystemNotificationSink`). */
  createSink(emitDelivery: EmitNotificationDelivery): NotificationSink;
  signal: AbortSignal;
  log: Pick<Logger, 'warn'>;
}): void {
  void options
    .host()
    .then(async (owner) => {
      const sink = options.createSink((event) => {
        if (event.type !== 'open') return;
        owner.bridge
          .notificationOpened({ notificationId: event.notificationId, target: event.target })
          .catch((error: unknown) =>
            options.log.warn('client notifications: could not report a click', { error })
          );
      });
      await owner.bridge.notifications.subscribe(undefined, {
        onEvent: (notification) => {
          void Promise.resolve(sink.deliver(bannerBatch(notification))).catch((error: unknown) =>
            options.log.warn('client notifications: banner failed', { error })
          );
        },
        signal: options.signal,
      });
    })
    .catch((error: unknown) => {
      if (options.signal.aborted) return;
      options.log.warn('client notifications: bridge unavailable', { error });
    });
}

/**
 * The batch a banner sink needs for one host notification. The system sink reads only the
 * notification's id, group key and target and the summary, which is all the bridge carries.
 */
export function bannerBatch(notification: OwnerNotification): NotificationDeliveryBatch {
  const partial: Pick<AppNotification, 'id' | 'groupKey' | 'target'> = {
    id: notification.notificationId,
    groupKey: notification.groupKey,
    target: notification.target,
  };
  return {
    // Boundary cast: see above; the remaining feed fields stay on the host.
    notification: partial as AppNotification,
    items: [],
    summary: { title: notification.title, body: notification.body },
  };
}
