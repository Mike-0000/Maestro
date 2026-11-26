import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import { ownerBridgeContract } from '@core/features/client-mode/api/owner-contract';
import type { NotificationSink } from '@core/services/notifications/api/ports';
import type {
  AppNotification,
  NotificationDeliveryEvent,
} from '@core/services/notifications/api/schemas';
import type { ExternalOpener } from '@main/host/external-opener';
import { createOwnerBridge } from './owner-bridge';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * Shaped like `NotificationService`: `emitDelivery` is a prototype method that reads `this`, so
 * passing it unbound fails here the way it would in the app.
 */
class FakeNotifications {
  readonly sinks = new Map<string, NotificationSink>();
  readonly delivered: NotificationDeliveryEvent[] = [];
  readonly registerSink = vi.fn((sink: NotificationSink) => {
    this.sinks.set(sink.id, sink);
    return () => this.sinks.delete(sink.id);
  });

  emitDelivery(event: NotificationDeliveryEvent): void {
    this.delivered.push(event);
  }
}

function fakeNotifications() {
  return new FakeNotifications();
}

const notification = {
  id: 'n1',
  groupKey: 'g1',
  title: 'raw title',
  body: 'raw body',
  target: { kind: 'task', projectId: 'p', taskId: 't' },
} as unknown as AppNotification;

function setup() {
  const notifications = fakeNotifications();
  const hostSink: NotificationSink = { id: 'system', deliver: vi.fn() };
  notifications.sinks.set('system', hostSink);
  let opener: ExternalOpener | undefined;
  const createSystemSink = vi.fn(() => hostSink);
  const bridge = createOwnerBridge({
    notifications,
    createSystemSink,
    setExternalOpener: (next) => {
      opener = next;
    },
    logger: logger as never,
  });
  const pair = memoryTransportPair();
  serve(pair.left, bridge.controller);
  const api = client(ownerBridgeContract, connect(pair.right));
  return { bridge, notifications, hostSink, createSystemSink, api, opener: () => opener };
}

describe('owner bridge', () => {
  it('touches nothing until installed', () => {
    const { notifications, opener, createSystemSink } = setup();
    expect(notifications.registerSink).not.toHaveBeenCalled();
    expect(opener()).toBeUndefined();
    expect(createSystemSink).not.toHaveBeenCalled();
  });

  it('sends banners to the client while installed and gives them back after', async () => {
    const { bridge, notifications, hostSink, createSystemSink, api } = setup();
    const received: unknown[] = [];
    await api.notifications.subscribe(undefined, { onEvent: (event) => received.push(event) });

    bridge.install();
    bridge.install();
    expect(notifications.registerSink).toHaveBeenCalledTimes(1);
    await notifications.sinks.get('system')!.deliver({
      notification,
      items: [notification],
      summary: { title: 'Agent done', body: 'All good (2 notifications)' },
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      notificationId: 'n1',
      groupKey: 'g1',
      title: 'Agent done',
      body: 'All good (2 notifications)',
      target: { kind: 'task', projectId: 'p', taskId: 't' },
    });
    expect(hostSink.deliver).not.toHaveBeenCalled();

    bridge.uninstall();
    bridge.uninstall();
    expect(createSystemSink).toHaveBeenCalledTimes(1);
    expect(notifications.sinks.get('system')).toBe(hostSink);
  });

  it('re-emits the open delivery when the client reports a click', async () => {
    const { notifications, api } = setup();
    const target = { kind: 'task' as const, projectId: 'p', taskId: 't' };
    await api.notificationOpened({ notificationId: 'n1', target });
    expect(notifications.delivered).toEqual([{ type: 'open', notificationId: 'n1', target }]);
  });

  it('gives the rebuilt host banner sink a working delivery callback', () => {
    const notifications = fakeNotifications();
    let emitFromBanner: ((event: NotificationDeliveryEvent) => void) | undefined;
    const bridge = createOwnerBridge({
      notifications,
      createSystemSink: (emitDelivery) => {
        emitFromBanner = emitDelivery;
        return { id: 'system', deliver: vi.fn() };
      },
      setExternalOpener: () => {},
      logger: logger as never,
    });
    bridge.install();
    bridge.uninstall();

    // A click on a banner after the owner left: the callback runs detached from its object.
    const click = emitFromBanner!;
    const target = { kind: 'none' as const };
    expect(() => click({ type: 'open', notificationId: 'n2', target })).not.toThrow();
    expect(notifications.delivered).toEqual([{ type: 'open', notificationId: 'n2', target }]);
  });

  it('routes browser opens to the client while installed, with the loopback port', async () => {
    const { bridge, api, opener } = setup();
    const received: unknown[] = [];
    await api.externalOpenRequests.subscribe(undefined, {
      onEvent: (event) => received.push(event),
    });

    bridge.install();
    const open = opener()!;
    await open('https://auth.example.com/authorize?x=1', { loopbackPort: 51234 });
    await open('http://localhost:5173/');
    await open('https://example.com/');
    await expect(open('file:///etc/passwd')).rejects.toThrow();
    await expect(open('not a url')).rejects.toThrow();
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual([
      { url: 'https://auth.example.com/authorize?x=1', loopbackPort: 51234 },
      { url: 'http://localhost:5173/', loopbackPort: 5173 },
      { url: 'https://example.com/' },
    ]);

    bridge.uninstall();
    expect(opener()).toBeUndefined();
  });
});
