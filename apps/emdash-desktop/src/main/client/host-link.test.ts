import { WebSocketHandshakeError } from '@emdash/wire/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { v8MessageTransport } from '@main/owner-link/v8-transport';
import type { ClientConnection } from './connection-store';
import { createHostLink, type HostLink } from './host-link';
import {
  createFakeOwnerHost,
  memoryPipePair,
  TEST_BUILD,
  type MemoryPipe,
} from './testing/fake-owner-host';

const CONNECTION: ClientConnection = {
  url: 'http://127.0.0.1:7462',
  hostId: 'host-1',
  hostName: 'vm',
  deviceId: 'device-1',
  token: 'token-1',
  pairedAt: 0,
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const links: HostLink[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});

function harness(options: { build?: typeof TEST_BUILD } = {}) {
  const host = createFakeOwnerHost();
  const pipes: MemoryPipe[] = [];
  const state = { refuse: null as number | null, dials: 0 };
  const onHostChanged = vi.fn();
  const link = createHostLink({
    build: options.build ?? TEST_BUILD,
    clientName: 'desk-pc',
    clientPlatform: 'win32',
    log: silent,
    backoffMs: [5, 10],
    pingIntervalMs: 0,
    dial: async () => {
      state.dials += 1;
      if (state.refuse !== null) throw new WebSocketHandshakeError('refused', state.refuse);
      const [client, server] = memoryPipePair();
      host.accept(v8MessageTransport(server));
      pipes.push(client);
      return client;
    },
    onHostChanged,
  });
  links.push(link);
  return { host, link, pipes, state, onHostChanged };
}

describe('host link', () => {
  it('reports unpaired without a stored host', () => {
    const { link } = harness();
    link.start(null);
    expect(link.current().phase).toBe('unpaired');
    expect(link.started).toBe(false);
  });

  it('attaches before anything else and then serves calls', async () => {
    const { host, link } = harness();
    link.start(CONNECTION);
    const owner = await link.ready();
    await expect(owner.desktop.mementos.deleteAll(undefined)).resolves.toEqual({
      success: true,
      data: { deleted: 3 },
    });
    expect(host.attaches).toEqual([
      { build: TEST_BUILD, clientName: 'desk-pc', clientPlatform: 'win32', takeover: false },
    ]);
    expect(link.current()).toMatchObject({
      phase: 'connected',
      host: { url: CONNECTION.url, id: 'host-1', name: 'test-vm', platform: 'linux' },
      blocked: null,
      attempt: 0,
      lastError: null,
    });
    expect(link.current().connectedAt).not.toBeNull();
  });

  it('holds calls across a drop and re-attaches without a reload', async () => {
    const { host, link, pipes, state, onHostChanged } = harness();
    link.start(CONNECTION);
    const owner = await link.ready();
    state.refuse = 502;
    pipes[0]!.drop();
    await vi.waitFor(() => expect(link.current().phase).toBe('reconnecting'));
    const held = owner.desktop.mementos.deleteAll(undefined);
    state.refuse = null;
    await expect(held).resolves.toMatchObject({ success: true });
    await vi.waitFor(() => expect(link.current().phase).toBe('connected'));
    expect(host.attaches).toHaveLength(2);
    expect(onHostChanged).not.toHaveBeenCalled();
  });

  it('counts failed dials and reloads the renderer once the host restarted', async () => {
    const { host, link, pipes, state, onHostChanged } = harness();
    link.start(CONNECTION);
    await link.ready();
    state.refuse = 502;
    pipes[0]!.drop();
    await vi.waitFor(() => expect(link.current().attempt).toBeGreaterThan(1));
    expect(link.current()).toMatchObject({ phase: 'reconnecting' });
    expect(link.current().lastError).toContain('502');
    host.bootId = 'boot-2';
    state.refuse = null;
    await vi.waitFor(() => expect(link.current().phase).toBe('connected'));
    expect(onHostChanged).toHaveBeenCalledOnce();
    expect(link.current().attempt).toBe(0);
  });

  it('blocks on a build mismatch with both builds and keeps waiting for the user', async () => {
    const clientBuild = { ...TEST_BUILD, commit: 'other00' };
    const { host, link } = harness({ build: clientBuild });
    link.start(CONNECTION);
    await vi.waitFor(() => expect(link.current().phase).toBe('blocked'));
    expect(link.current().blocked).toEqual({
      reason: 'build-mismatch',
      hostBuild: TEST_BUILD,
      clientBuild,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.attaches).toHaveLength(1);

    link.retryNow();
    await vi.waitFor(() => expect(host.attaches).toHaveLength(2));
    await vi.waitFor(() => expect(link.current().phase).toBe('blocked'));
  });

  it('asks the host to update while blocked on a build mismatch', async () => {
    const { link } = harness({ build: { ...TEST_BUILD, commit: 'other00' } });
    link.start(CONNECTION);
    await vi.waitFor(() => expect(link.current().phase).toBe('blocked'));
    await expect(link.requestHostUpdate({ when: 'now' })).resolves.toEqual({ success: true });
  });

  it('takes over from a busy host', async () => {
    const { host, link } = harness();
    host.attachResponder = (input) =>
      input.takeover
        ? { success: true, data: attachData() }
        : { success: false, error: { type: 'busy', clientName: 'laptop', since: 1 } };
    link.start(CONNECTION);
    await vi.waitFor(() => expect(link.current().phase).toBe('blocked'));
    expect(link.current().blocked).toEqual({ reason: 'busy', busyClientName: 'laptop' });
    link.takeOver();
    await link.ready();
    expect(link.current().phase).toBe('connected');
    expect(host.attaches.map((attach) => attach.takeover)).toEqual([false, true]);
  });

  it('blocks when superseded and re-dials only when asked', async () => {
    const { host, link, state } = harness();
    link.start(CONNECTION);
    await link.ready();
    // Let the session events subscription reach the host.
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.emitSessionEvent({ type: 'superseded', by: 'laptop' });
    await vi.waitFor(() => expect(link.current().phase).toBe('blocked'));
    expect(link.current().blocked).toMatchObject({
      reason: 'superseded',
      busyClientName: 'laptop',
    });
    const dials = state.dials;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.dials).toBe(dials);
    link.takeOver();
    await vi.waitFor(() => expect(link.current().phase).toBe('connected'));
    expect(host.attaches.at(-1)?.takeover).toBe(true);
  });

  it.each([
    [401, 'revoked'],
    [403, 'tailscale-required'],
    [404, 'owner-disabled'],
  ] as const)('blocks on HTTP %i as %s until retried', async (status, reason) => {
    const { link, state } = harness();
    state.refuse = status;
    link.start(CONNECTION);
    await vi.waitFor(() => expect(link.current().blocked?.reason).toBe(reason));
    state.refuse = null;
    link.retryNow();
    await link.ready();
    expect(link.current().phase).toBe('connected');
  });

  it('measures latency with pings', async () => {
    const host = createFakeOwnerHost();
    const link = createHostLink({
      build: TEST_BUILD,
      clientName: 'desk-pc',
      clientPlatform: 'win32',
      log: silent,
      pingIntervalMs: 10,
      dial: async () => {
        const [client, server] = memoryPipePair();
        host.accept(v8MessageTransport(server));
        return client;
      },
    });
    links.push(link);
    link.start(CONNECTION);
    await link.ready();
    await vi.waitFor(() => expect(link.current().latencyMs).not.toBeNull());
  });
});

function attachData() {
  return {
    sessionId: 's',
    hostBootId: 'boot-1',
    brainEpoch: 0,
    build: TEST_BUILD,
    host: { id: 'host-1', name: 'test-vm', platform: 'linux', arch: 'x64', homeDir: '/home/dev' },
  };
}
