import type { Logger } from '@emdash/shared/logger';
import { createEventStreamHost } from '@emdash/wire/live';
import { createController, type Controller } from '@emdash/wire/rpc';
import { ownerBridgeContract } from '@core/features/client-mode/api/owner-contract';
import type {
  EmitNotificationDelivery,
  NotificationSink,
} from '@core/services/notifications/api/ports';
import type { ExternalOpener, ExternalOpenHint } from '@main/host/external-opener';

// Effects the host would have had on its own screen that belong on the owner client's screen
// while one is attached: OS notification banners and "open this in a browser" (OAuth sign-in).
// Nothing here is installed until an owner session attaches, and everything is put back when
// the last one detaches.

/** The sink id the notification service delivers OS banners to. */
const SYSTEM_SINK_ID = 'system';

export type OwnerBridgeDependencies = {
  notifications: {
    registerSink(sink: NotificationSink): () => void;
    emitDelivery: EmitNotificationDelivery;
  };
  /**
   * Builds the host's own banner sink again, to put back when the owner detaches (registering the
   * owner sink under the same id replaced it).
   */
  createSystemSink?: (emitDelivery: EmitNotificationDelivery) => NotificationSink;
  setExternalOpener(opener: ExternalOpener | undefined): void;
  logger: Logger;
};

export type OwnerBridge = {
  /** The `bridge.*` mount of the owner link; callers gate it on an attached session. */
  readonly controller: Controller;
  /** Routes banners and browser opens to the owner client. Idempotent. */
  install(): void;
  /** Puts the host's own banner sink and opener back. Idempotent. */
  uninstall(): void;
  dispose(): Promise<void>;
};

export function createOwnerBridge(deps: OwnerBridgeDependencies): OwnerBridge {
  const notifications = createEventStreamHost(ownerBridgeContract.notifications);
  const externalOpenRequests = createEventStreamHost(ownerBridgeContract.externalOpenRequests);
  let removeSink: (() => void) | undefined;

  const ownerSink: NotificationSink = {
    id: SYSTEM_SINK_ID,
    deliver({ notification, summary }) {
      notifications.emit(undefined, {
        notificationId: notification.id,
        groupKey: notification.groupKey,
        title: summary.title,
        body: summary.body,
        target: notification.target,
      });
    },
  };

  const opener: ExternalOpener = async (url: string, hint?: ExternalOpenHint) => {
    const parsed = parseBrowserUrl(url);
    if (!parsed) throw new Error('Only http and https addresses are opened on the client');
    const loopbackPort = hint?.loopbackPort ?? loopbackPortOf(parsed);
    externalOpenRequests.emit(undefined, {
      url,
      ...(loopbackPort !== undefined ? { loopbackPort } : {}),
    });
  };

  const controller = createController(ownerBridgeContract, {
    notifications,
    notificationOpened: ({ notificationId, target }) => {
      // The click happened on the client; the host's window logic reacts to the same delivery
      // event a banner click on this computer would have raised.
      deps.notifications.emitDelivery({ type: 'open', notificationId, target });
    },
    externalOpenRequests,
  });

  function uninstall(): void {
    if (!removeSink) return;
    removeSink();
    removeSink = undefined;
    if (deps.createSystemSink) {
      // Bound: the service's `emitDelivery` is a method that reads `this`.
      const emitDelivery: EmitNotificationDelivery = (event) =>
        deps.notifications.emitDelivery(event);
      deps.notifications.registerSink(deps.createSystemSink(emitDelivery));
    }
    deps.setExternalOpener(undefined);
    deps.logger.info('Owner bridge removed');
  }

  return {
    controller,
    install() {
      if (removeSink) return;
      removeSink = deps.notifications.registerSink(ownerSink);
      deps.setExternalOpener(opener);
      deps.logger.info('Owner bridge installed');
    },
    uninstall,
    async dispose() {
      uninstall();
      notifications.dispose();
      externalOpenRequests.dispose();
      await controller.dispose?.();
    },
  };
}

function parseBrowserUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
}

function loopbackPortOf(url: URL): number | undefined {
  if (!isLoopbackHostname(url.hostname)) return undefined;
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}
