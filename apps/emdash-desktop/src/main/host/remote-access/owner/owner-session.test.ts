import { client, connect, memoryTransportPair, WireError, type Controller } from '@emdash/wire/rpc';
import type { LiveSource } from '@emdash/wire/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';
import {
  ownerHostWireContract,
  type OwnerAttachInput,
  type OwnerSessionEvent,
} from '@core/features/client-mode/api/owner-contract';
import { createOwnerDesktopFilter } from './owner-desktop-filter';
import {
  OwnerSessions,
  type AttachedOwner,
  type OwnerClock,
  type OwnerSessionDependencies,
} from './owner-session';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const HOST_BUILD: BuildIdentity = { version: '1.4.0', commit: 'abc1234', dev: false };
const TASKS_TOPIC = 'desktop.tasks.taskList.list|{"projectId":"p1"}';

function manualClock() {
  let now = 1_000;
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const clock: OwnerClock = {
    now: () => now,
    setTimeout: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
    },
    runAll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

function fakeDesktop() {
  const source: LiveSource = {
    snapshot: () => ({ generation: 1, sequence: 1, timestamp: 0, data: { tasks: ['t1'] } }),
    subscribe: () => () => {},
  };
  const controller: Controller = {
    call: vi.fn(async (path: string) => (path === 'host.getPlatform' ? 'linux' : `ran ${path}`)),
    resolveLive: vi.fn(() => source),
    acquireLive: vi.fn(() => ({ ready: async () => source, release: async () => {} })),
  };
  return controller;
}

function attachInput(overrides: Partial<OwnerAttachInput> = {}): OwnerAttachInput {
  return {
    build: HOST_BUILD,
    clientName: 'Studio PC',
    clientPlatform: 'win32',
    takeover: false,
    ...overrides,
  };
}

function setup(
  options: {
    enabled?: boolean;
    skipBuildCheck?: boolean;
    hostUpdates?: OwnerSessionDependencies['hostUpdates'];
  } = {}
) {
  let enabled = options.enabled ?? true;
  const desktop = fakeDesktop();
  const bridge: Controller = {
    call: vi.fn(async () => undefined),
    resolveLive: () => null,
    acquireLive: () => null,
  };
  const activeChanges: Array<[AttachedOwner | null, AttachedOwner | null]> = [];
  const time = manualClock();
  const sessions = new OwnerSessions({
    enabled: () => enabled,
    hostBuild: async () => HOST_BUILD,
    skipBuildCheck: options.skipBuildCheck ?? false,
    hostBootId: 'boot-1',
    hostInfo: () => ({
      id: 'host-1',
      name: 'vm',
      platform: 'linux',
      arch: 'x64',
      homeDir: '/home/me',
    }),
    brainEpoch: () => 3,
    bridge,
    desktop: createOwnerDesktopFilter(desktop),
    hostUpdates: options.hostUpdates,
    onActiveChanged: (active, previous) => activeChanges.push([active, previous]),
    logger: logger as never,
    clock: time.clock,
  });

  function open(deviceId: string) {
    const pair = memoryTransportPair();
    const closed = vi.fn();
    pair.right.onDisconnect(closed);
    sessions.open(
      { deviceId, deviceName: deviceId, context: { via: 'loopback', login: null } },
      pair.left
    );
    const connection = connect(pair.right, { callTimeoutMs: 0 });
    const api = client(ownerHostWireContract, connection);
    const events: OwnerSessionEvent[] = [];
    const subscribed = api.session.events.subscribe(undefined, {
      onEvent: (event) => events.push(event),
    });
    return { pair, connection, api, events, closed, subscribed };
  }

  return {
    sessions,
    desktop,
    bridge,
    activeChanges,
    time,
    open,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

async function wireCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  return error instanceof WireError ? error.code : error === undefined ? undefined : String(error);
}

describe('owner sessions', () => {
  afterEach(() => vi.clearAllMocks());

  it('answers nothing under desktop or bridge until attach succeeded', async () => {
    const { open, desktop, bridge } = setup();
    const { connection, api } = open('device-a');

    expect(await api.session.ping()).toEqual({ at: 1_000 });
    expect(await wireCode(connection.call('desktop.host.getPlatform', undefined))).toBe(
      'NOT_FOUND'
    );
    expect(await wireCode(connection.snapshot(TASKS_TOPIC))).toBe('NOT_FOUND');
    expect(await wireCode(connection.call('bridge.notificationOpened', {}))).toBe('NOT_FOUND');
    expect(await wireCode(connection.call('elsewhere.x', undefined))).toBe('NOT_FOUND');
    expect(desktop.call).not.toHaveBeenCalled();
    expect(desktop.acquireLive).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('answers the host-update verbs before attach, even for a mismatched build', async () => {
    const request = vi.fn(async () => ({ success: true as const, data: undefined }));
    const { open, sessions } = setup({
      hostUpdates: {
        state: () => ({ status: 'downloaded', version: '1.4.1' }),
        request,
      },
    });
    const { api } = open('device-a');
    const refused = await api.session.attach(
      attachInput({ build: { version: '1.3.9', commit: 'old0000', dev: false } })
    );
    expect(refused.success).toBe(false);
    expect(sessions.attached()).toBeNull();

    expect(await api.session.hostUpdateState()).toEqual({ status: 'downloaded', version: '1.4.1' });
    expect(await api.session.requestHostUpdate({ when: 'now' })).toEqual({
      success: true,
      data: undefined,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith({ when: 'now' });
  });

  it('reports host updates as unsupported when nothing provides them', async () => {
    const { open } = setup();
    const { api } = open('device-a');
    expect(await api.session.hostUpdateState()).toEqual({ status: 'unsupported' });
    expect(await api.session.requestHostUpdate({ when: 'idle' })).toMatchObject({
      success: false,
      error: { type: 'unsupported' },
    });
  });

  it('attaches, then serves host-served desktop paths only', async () => {
    const { open, desktop, activeChanges, sessions } = setup();
    const { connection, api } = open('device-a');

    const result = await api.session.attach(attachInput());
    expect(result).toEqual({
      success: true,
      data: {
        sessionId: expect.any(String),
        hostBootId: 'boot-1',
        brainEpoch: 3,
        build: HOST_BUILD,
        host: { id: 'host-1', name: 'vm', platform: 'linux', arch: 'x64', homeDir: '/home/me' },
      },
    });
    expect(activeChanges).toHaveLength(1);
    expect(activeChanges[0]?.[0]).toMatchObject({ deviceId: 'device-a', clientName: 'Studio PC' });
    expect(sessions.attached()).toMatchObject({ deviceId: 'device-a', since: 1_000 });

    expect(await connection.call('desktop.host.getPlatform', undefined)).toBe('linux');
    const snapshot = await connection.snapshot(TASKS_TOPIC);
    expect(snapshot.data).toEqual({ tasks: ['t1'] });
    expect(desktop.acquireLive).toHaveBeenCalledWith('tasks.taskList.list|{"projectId":"p1"}');
    expect(await wireCode(connection.call('desktop.host.openExternal', 'https://x'))).toBe(
      'NOT_FOUND'
    );
    expect(await wireCode(connection.call('desktop.browser.registerSession', {}))).toBe(
      'NOT_FOUND'
    );
    expect(await api.session.hostUpdateState()).toEqual({ status: 'unsupported' });

    // A second attach on the same connection returns the same session.
    const again = await api.session.attach(attachInput());
    expect(again.success && result.success && again.data.sessionId).toBe(
      result.success && result.data.sessionId
    );
    expect(activeChanges).toHaveLength(1);
  });

  it('refuses a different build and stays unattached', async () => {
    const { open, sessions } = setup();
    const { connection, api } = open('device-a');
    const result = await api.session.attach(
      attachInput({ build: { version: '1.4.0', commit: 'fff9999', dev: false } })
    );
    expect(result).toEqual({
      success: false,
      error: { type: 'build-mismatch', host: HOST_BUILD },
    });
    expect(sessions.attached()).toBeNull();
    expect(await wireCode(connection.call('desktop.host.getPlatform', undefined))).toBe(
      'NOT_FOUND'
    );
  });

  it('lets a development host skip the build check', async () => {
    const { open } = setup({ skipBuildCheck: true });
    const { api } = open('device-a');
    const result = await api.session.attach(
      attachInput({ build: { version: '9.9.9', commit: null, dev: true } })
    );
    expect(result.success).toBe(true);
  });

  it('answers owner-disabled while owner access is off', async () => {
    const { open } = setup({ enabled: false });
    const { api } = open('device-a');
    expect(await api.session.attach(attachInput())).toEqual({
      success: false,
      error: { type: 'owner-disabled' },
    });
  });

  it('answers busy to a second owner, and hands over on takeover', async () => {
    const { open, sessions, activeChanges, time } = setup();
    const first = open('device-a');
    await first.subscribed;
    await first.api.session.attach(attachInput({ clientName: 'Laptop' }));
    time.advance(500);

    const second = open('device-b');
    expect(await second.api.session.attach(attachInput({ clientName: 'Desk' }))).toEqual({
      success: false,
      error: { type: 'busy', clientName: 'Laptop', since: 1_000 },
    });
    expect(sessions.attached()?.deviceId).toBe('device-a');

    const taken = await second.api.session.attach(
      attachInput({ clientName: 'Desk', takeover: true })
    );
    expect(taken.success).toBe(true);
    expect(sessions.attached()).toMatchObject({ deviceId: 'device-b', clientName: 'Desk' });
    await vi.waitFor(() => expect(first.events).toEqual([{ type: 'superseded', by: 'Desk' }]));
    // The superseded connection loses access at once and is closed shortly after.
    expect(await wireCode(first.connection.call('desktop.host.getPlatform', undefined))).toBe(
      'NOT_FOUND'
    );
    expect(first.closed).not.toHaveBeenCalled();
    time.runAll();
    expect(first.closed).toHaveBeenCalled();
    // No detach in between: the host window stays suspended through a takeover.
    expect(activeChanges.map(([active]) => active?.deviceId ?? null)).toEqual([
      'device-a',
      'device-b',
    ]);
    expect(await second.connection.call('desktop.host.getPlatform', undefined)).toBe('linux');
  });

  it('lets the same device take over its own stale connection', async () => {
    const { open, sessions, time } = setup();
    const stale = open('device-a');
    await stale.api.session.attach(attachInput());
    const fresh = open('device-a');
    const result = await fresh.api.session.attach(attachInput());
    expect(result.success).toBe(true);
    time.runAll();
    expect(stale.closed).toHaveBeenCalled();
    expect(sessions.connectionCount('device-a')).toBe(1);
  });

  it('detaches when the attached connection drops', async () => {
    const { open, sessions, activeChanges } = setup();
    const { api, pair } = open('device-a');
    await api.session.attach(attachInput());
    pair.disconnect();
    await vi.waitFor(() => expect(sessions.attached()).toBeNull());
    expect(activeChanges.at(-1)?.[0]).toBeNull();
    expect(activeChanges.at(-1)?.[1]).toMatchObject({ deviceId: 'device-a' });
    expect(sessions.connectionCount('device-a')).toBe(0);
  });

  it('closes a device on request and detaches it', async () => {
    const { open, sessions } = setup();
    const a = open('device-a');
    const b = open('device-b');
    await a.api.session.attach(attachInput());
    sessions.closeDevice('device-a');
    expect(a.closed).toHaveBeenCalled();
    expect(b.closed).not.toHaveBeenCalled();
    expect(sessions.attached()).toBeNull();
    sessions.closeAll();
    expect(b.closed).toHaveBeenCalled();
  });

  it('tells the attached client the host is quitting', async () => {
    const { open, sessions } = setup();
    const a = open('device-a');
    await a.subscribed;
    await a.api.session.attach(attachInput());
    sessions.notifyHostQuitting('update');
    await vi.waitFor(() => expect(a.events).toEqual([{ type: 'host-quitting', reason: 'update' }]));
  });
});
