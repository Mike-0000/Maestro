import { err, ok, type Result, type Unsubscribe } from '@emdash/shared';
import { createEventStreamHost } from '@emdash/wire/live';
import {
  createController,
  defineContract,
  serve,
  WireError,
  type Controller,
  type WireTransport,
} from '@emdash/wire/rpc';
import { cell, expose } from '@emdash/wire/state';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import {
  ownerBridgeContract,
  ownerSessionContract,
  type ownerHostWireContract,
  type OwnerAttachData,
  type OwnerAttachError,
  type OwnerAttachInput,
} from '@core/features/client-mode/api/owner-contract';
import { terminalsContract } from '@core/features/terminals/api';
import { desktopHostContract } from '@core/primitives/desktop-host/api/host-contract';
import { mementosWireContract } from '@core/primitives/mementos/api';
import { notificationsContract } from '@core/services/notifications/api';
import type { NotificationList } from '@core/services/notifications/api/schemas';
import { appSettingsContract } from '@core/services/settings/api';
import type { V8MessagePipe } from '@main/owner-link/v8-transport';

// Test support for the client: a stand-in Maestro host serving a small part of the owner contract
// with the real host's rule that nothing outside `session` answers before `session.attach`, and an
// in-memory message pipe pair to connect it without a socket.

/**
 * The slice of the owner contract the stand-in serves. Its endpoint ids are the owner contract's
 * own (`desktop.mementos.deleteAll`, ...), so the client cannot tell the difference.
 */
const fakeHostContract = defineContract({
  session: ownerSessionContract,
  bridge: ownerBridgeContract,
  desktop: defineContract({
    notifications: notificationsContract,
    mementos: defineContract({ deleteAll: mementosWireContract.deleteAll }),
    host: defineContract({
      getPlatform: desktopHostContract.getPlatform,
      persistDroppedBlob: desktopHostContract.persistDroppedBlob,
    }),
    appSettings: appSettingsContract,
    terminals: defineContract({ attachments: terminalsContract.attachments }),
  }),
});

export const TEST_BUILD: BuildIdentity = { version: '1.0.0-test', commit: 'abc1234', dev: false };

export type FakeOwnerHost = {
  readonly controller: Controller;
  readonly attaches: OwnerAttachInput[];
  readonly notifications: ReturnType<typeof cell<NotificationList>>;
  emitDelivery(notificationId: string): void;
  emitSessionEvent(event: Parameters<FakeSessionEvents['emit']>[1]): void;
  emitBridgeNotification(title: string): void;
  /** Serves one connection, gated on its own attach. */
  accept(transport: WireTransport): Unsubscribe;
  /** Overrides the next attach answers (`null` restores the default). */
  attachResponder: ((input: OwnerAttachInput) => Result<OwnerAttachData, OwnerAttachError>) | null;
  bootId: string;
  brainEpoch: number;
  readonly opened: Array<{ notificationId: string }>;
  readonly droppedBlobs: Array<{ name?: string; size: number }>;
  readonly hostPreparedPaths: string[];
  readonly uploads: Array<{ workspaceId: string; name: string; bytes: number }>;
  readonly deletedAttachments: string[];
};

type FakeSessionEvents = ReturnType<
  typeof createEventStreamHost<typeof ownerHostWireContract.session.events>
>;

export function createFakeOwnerHost(): FakeOwnerHost {
  const desktop = fakeHostContract.desktop;
  const sessionEvents = createEventStreamHost(fakeHostContract.session.events);
  const bridgeNotifications = createEventStreamHost(fakeHostContract.bridge.notifications);
  const externalOpenRequests = createEventStreamHost(fakeHostContract.bridge.externalOpenRequests);
  const delivery = createEventStreamHost(desktop.notifications.delivery);
  const list = cell<NotificationList>({});
  const feed = expose(desktop.notifications.feed, { list });

  const host: FakeOwnerHost = {
    controller: undefined as unknown as Controller,
    attaches: [],
    notifications: list,
    attachResponder: null,
    bootId: 'boot-1',
    brainEpoch: 0,
    opened: [],
    droppedBlobs: [],
    hostPreparedPaths: [],
    uploads: [],
    deletedAttachments: [],
    emitDelivery(notificationId) {
      delivery.emit(undefined, {
        type: 'open',
        notificationId,
        target: { kind: 'update' },
      });
    },
    emitSessionEvent(event) {
      sessionEvents.emit(undefined, event);
    },
    emitBridgeNotification(title) {
      bridgeNotifications.emit(undefined, {
        notificationId: `n-${title}`,
        groupKey: 'group',
        title,
        body: 'body',
        target: { kind: 'update' },
      });
    },
    accept(transport) {
      const connection = { attached: false };
      return serve(transport, gate(controller, connection));
    },
  };

  const defaultAttach = (input: OwnerAttachInput): Result<OwnerAttachData, OwnerAttachError> => {
    if (input.build.commit !== TEST_BUILD.commit) {
      return err({ type: 'build-mismatch', host: TEST_BUILD });
    }
    return ok({
      sessionId: `session-${host.attaches.length}`,
      hostBootId: host.bootId,
      brainEpoch: host.brainEpoch,
      build: TEST_BUILD,
      host: { id: 'host-1', name: 'test-vm', platform: 'linux', arch: 'x64', homeDir: '/home/dev' },
    });
  };

  // Partial on purpose: an endpoint this stand-in does not serve answers as missing.
  const impl = {
    session: {
      attach: (input: OwnerAttachInput) => {
        host.attaches.push(input);
        return (host.attachResponder ?? defaultAttach)(input);
      },
      ping: () => ({ at: Date.now() }),
      events: sessionEvents,
      hostUpdateState: () => ({ status: 'idle' as const }),
      requestHostUpdate: () => ok(),
    },
    bridge: {
      notifications: bridgeNotifications,
      notificationOpened: ({ notificationId }: { notificationId: string }) => {
        host.opened.push({ notificationId });
      },
      externalOpenRequests,
    },
    desktop: {
      notifications: { feed, delivery },
      mementos: { deleteAll: () => ok({ deleted: 3 }) },
      host: {
        getPlatform: () => 'linux' as const,
        persistDroppedBlob: ({ bytes, name }: { bytes: Uint8Array; name?: string }) => {
          host.droppedBlobs.push({ name, size: bytes.byteLength });
          return { success: true as const, path: `/home/dev/.drops/${name ?? 'blob'}` };
        },
      },
      appSettings: {
        get: ({ key }: { key: string }) => (key === 'theme' ? 'emdark' : {}),
      },
      terminals: {
        attachments: {
          prepareLocalFiles: ({ sources }: { sources: Array<{ path: string }> }) => {
            host.hostPreparedPaths.push(...sources.map((source) => source.path));
            return ok(
              sources.map((source) => ({
                kind: 'reference' as const,
                targetPath: source.path,
                pathStyle: 'posix' as const,
              }))
            );
          },
          upload: async (
            { workspaceId }: { workspaceId: string },
            file: { name: string; bytes(): Promise<Uint8Array> }
          ) => {
            const bytes = await file.bytes();
            host.uploads.push({ workspaceId, name: file.name, bytes: bytes.byteLength });
            return ok({
              id: `att-${host.uploads.length}`,
              name: file.name,
              mimeType: 'application/octet-stream',
              targetPath: `/home/dev/.attachments/${file.name}`,
              pathStyle: 'posix' as const,
            });
          },
          delete: ({ attachmentId }: { attachmentId: string }) => {
            host.deletedAttachments.push(attachmentId);
            return ok();
          },
        },
      },
    },
  };
  // Outputs are not validated: the stand-in's answers are deliberately minimal.
  const controller = createController(fakeHostContract, impl as never, { validate: 'inputs' });
  (host as { controller: Controller }).controller = controller;
  return host;
}

/** The real host's per-connection rule: only `session.*` answers before a successful attach. */
function gate(inner: Controller, connection: { attached: boolean }): Controller {
  const open = (path: string) => connection.attached || path.startsWith('session.');
  return {
    async call(path, input, meta) {
      if (!open(path)) throw new WireError('NOT_FOUND', `'${path}' needs session.attach first`);
      const result = await inner.call(path, input, meta);
      if (path === 'session.attach' && (result as { success?: boolean }).success) {
        connection.attached = true;
      }
      return result;
    },
    resolveLive: (topic) => (open(topic) ? inner.resolveLive(topic) : null),
    acquireLive: (topic) => (open(topic) ? inner.acquireLive(topic) : null),
  };
}

/** One end of an in-memory pipe; `drop` cuts the connection as a network failure would. */
export type MemoryPipe = V8MessagePipe & { drop(): void };

/** Two connected in-memory message pipes, the shape `v8MessageTransport` expects. */
export function memoryPipePair(): [MemoryPipe, MemoryPipe] {
  type End = {
    closed: boolean;
    messages: Set<(bytes: Uint8Array) => void>;
    closes: Set<() => void>;
  };
  const ends: [End, End] = [
    { closed: false, messages: new Set(), closes: new Set() },
    { closed: false, messages: new Set(), closes: new Set() },
  ];
  const closeBoth = () => {
    for (const end of ends) {
      if (end.closed) continue;
      end.closed = true;
      for (const listener of [...end.closes]) queueMicrotask(listener);
    }
  };
  const pipe = (self: End, peer: End): MemoryPipe => ({
    get closed() {
      return self.closed;
    },
    send(bytes) {
      if (self.closed) throw new Error('pipe closed');
      const copy = bytes.slice();
      queueMicrotask(() => {
        if (peer.closed) return;
        for (const listener of [...peer.messages]) listener(copy);
      });
      return true;
    },
    onMessage(cb) {
      self.messages.add(cb);
      return () => self.messages.delete(cb);
    },
    onClose(cb) {
      if (self.closed) {
        queueMicrotask(cb);
        return () => {};
      }
      self.closes.add(cb);
      return () => self.closes.delete(cb);
    },
    close: closeBoth,
    drop: closeBoth,
  });
  return [pipe(ends[0], ends[1]), pipe(ends[1], ends[0])];
}
