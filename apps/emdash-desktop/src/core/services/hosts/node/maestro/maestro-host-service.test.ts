import { hostRef } from '@emdash/core/primitives/host/api';
import { secret } from '@emdash/shared';
import { createScope } from '@emdash/shared/concurrency';
import { WebSocketHandshakeError, type ConnectWebSocketOptions } from '@emdash/wire/node';
import { peek } from '@emdash/wire/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaestroHostUnsupportedError } from '@core/primitives/maestro-host/api/unsupported';
import type { SshConnectionEvent } from '@core/primitives/ssh/api';
import { createHosts } from '../hosts';
import { createFaultPeer } from '../testing/connection-supervisor-fixture';
import type { MaestroHostDialConfig } from '../workspace-server/connect/maestro-websocket-transport';

// The Maestro host variant runs under the real Hosts registry and connection supervisor; only
// the WebSocket dial and the machine's stored address and credentials are substituted.
describe('Maestro host service', () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture = createFixture();
  });
  afterEach(async () => {
    await fixture.scope.dispose();
    await fixture.peer.dispose();
    vi.useRealTimers();
  });

  it('connects by dialing and initializing, without touching SSH', async () => {
    const host = fixture.host();
    await expect(host.connection.pin()).resolves.toMatchObject({ success: true });
    await expect(host.runtime.waitUntilReady()).resolves.toMatchObject({
      success: true,
      data: { host: hostRef('remote', 'maestro-1') },
    });

    expect(peek(host.connection.availability).kind).toBe('ready');
    expect(fixture.dial).toHaveBeenCalledTimes(1);
    expect(fixture.dial).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'wss://my-pc.tailnet.ts.net/wire',
        headers: { Authorization: 'Bearer device-token' },
      })
    );
    expect(fixture.peer.initializations).toBe(1);
    expect(fixture.sshEstablish).not.toHaveBeenCalled();
    expect(fixture.getProxy).not.toHaveBeenCalled();
    const connection = await host.runtime.client({ waitForReady: false });
    expect(connection.target).toEqual({ kind: 'maestro', connectionId: 'maestro-1' });
  });

  it('keeps SSH machines on the SSH service', async () => {
    fixture.setMaestroHost(false);
    void fixture.host().connection.pin();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.sshEstablish).toHaveBeenCalled();
    expect(fixture.dial).not.toHaveBeenCalled();
  });

  it('does not dial until a runtime is wanted', async () => {
    await expect(fixture.service.lifecycle.ensureConnected('maestro-1')).resolves.toBe('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.dial).not.toHaveBeenCalled();

    fixture.service.lease('maestro-1', fixture.scope.child('project'));
    await vi.advanceTimersByTimeAsync(0);
    expect(peek(fixture.service.availability('maestro-1')).kind).toBe('ready');
  });

  it('reports the connected app as the workspace server and refuses to manage it', async () => {
    const host = fixture.host();
    await host.connection.pin();
    await host.runtime.waitUntilReady();

    expect(peek(host.server.state)).toEqual({ status: 'healthy', version: '1.0.0', startedAt: 0 });
    await expect(host.server.refresh()).resolves.toBeUndefined();
    expect(peek(host.server.state)).toMatchObject({ status: 'healthy' });
    for (const refuse of [
      () => host.server.install(),
      () => host.server.update(),
      () => host.server.start(),
      () => host.server.stop(),
      () => host.server.restart(),
    ]) {
      const error = await refuse().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(MaestroHostUnsupportedError);
      expect(error).toMatchObject({ message: 'Managed by the Maestro app on that computer' });
    }
    // Refusing an operation leaves the connection alone.
    expect(peek(host.connection.availability).kind).toBe('ready');
    expect(fixture.dial).toHaveBeenCalledTimes(1);
  });

  it('projects availability into the connection state the machine list reads', async () => {
    const host = fixture.host();
    await host.connection.pin();
    await host.runtime.waitUntilReady();
    expect(fixture.events.map((event) => event.type)).toEqual(['connecting', 'connected']);

    await host.connection.disconnect();
    expect(fixture.events.at(-1)).toEqual({ type: 'disconnected', connectionId: 'maestro-1' });
    expect(peek(host.server.state)).toEqual({ status: 'stopped', version: '1.0.0' });
  });

  it('stops retrying and asks to pair again when the host rejects the device token', async () => {
    fixture.rejectWith(401);
    const host = fixture.host();
    await host.connection.pin();
    await vi.advanceTimersByTimeAsync(0);

    expect(peek(host.connection.availability)).toMatchObject({
      kind: 'unavailable',
      recovery: 'blocked',
      issue: {
        type: 'host-unavailable',
        reason: 'connection-failed',
        message: 'This device is no longer paired with the host. Pair again.',
      },
    });
    expect(peek(host.server.state)).toMatchObject({
      status: 'failed',
      error: { message: 'This device is no longer paired with the host. Pair again.' },
    });
    expect(fixture.events.at(-1)).toMatchObject({ type: 'error' });
    const dials = fixture.dial.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fixture.dial).toHaveBeenCalledTimes(dials);
    await expect(host.runtime.waitUntilReady()).resolves.toMatchObject({
      success: false,
      error: { message: 'This device is no longer paired with the host. Pair again.' },
    });
  });

  it('reports rejected Cloudflare Access credentials as a blocked issue', async () => {
    fixture.rejectWith(403);
    const host = fixture.host();
    await host.connection.pin();
    await vi.advanceTimersByTimeAsync(0);
    expect(peek(host.connection.availability)).toMatchObject({
      kind: 'unavailable',
      recovery: 'blocked',
      issue: { message: expect.stringContaining('Cloudflare Access rejected this device') },
    });
  });

  it('connects with the new token after the machine is paired again', async () => {
    fixture.rejectWith(401);
    fixture.service.lease('maestro-1', fixture.scope.child('project'));
    await vi.advanceTimersByTimeAsync(0);
    expect(peek(fixture.service.availability('maestro-1'))).toMatchObject({ recovery: 'blocked' });

    fixture.rejectWith(undefined);
    fixture.setToken('new-token');
    fixture.mutate();
    await vi.advanceTimersByTimeAsync(0);

    expect(peek(fixture.service.availability('maestro-1')).kind).toBe('ready');
    expect(fixture.dial).toHaveBeenLastCalledWith(
      expect.objectContaining({ headers: { Authorization: 'Bearer new-token' } })
    );
  });

  it('backs off and reconnects while the host is unreachable', async () => {
    const host = fixture.host();
    await host.connection.pin();
    await host.runtime.waitUntilReady();

    fixture.peer.setOffline(true);
    fixture.peer.current.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(peek(host.connection.availability)).toMatchObject({
      kind: 'unavailable',
      recovery: 'waiting',
      issue: { reason: 'connection-failed' },
    });
    // An outage that is still being retried keeps the last observed server state.
    expect(peek(host.server.state)).toMatchObject({ status: 'healthy' });

    fixture.peer.setOffline(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(peek(host.connection.availability).kind).toBe('ready');
    expect(fixture.sshEstablish).not.toHaveBeenCalled();
  });

  it('replaces a silently dead connection found by the health probe', async () => {
    const host = fixture.host();
    await host.connection.pin();
    await host.runtime.waitUntilReady();
    const opens = fixture.peer.opens;

    fixture.peer.current.dropRequests = true;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fixture.peer.opens).toBeGreaterThan(opens);
    expect(peek(host.connection.availability).kind).toBe('ready');
  });
});

function createFixture() {
  const scope = createScope({ label: 'maestro-host-service-test' });
  const peer = createFaultPeer();
  let maestroHost = true;
  let token = 'device-token';
  let rejectStatus: number | undefined;
  let intended = true;
  let mutation: ((event: { connectionId: string }) => void) | undefined;
  const events: SshConnectionEvent[] = [];
  const sshEstablish = vi.fn(async () => {
    throw new Error('A Maestro host must not establish SSH');
  });
  const getProxy = vi.fn(() => undefined);
  const dial = vi.fn(async (_options: ConnectWebSocketOptions) => {
    if (rejectStatus !== undefined) {
      throw new WebSocketHandshakeError(
        `The host refused the connection (HTTP ${rejectStatus})`,
        rejectStatus
      );
    }
    return await peer.openTransport();
  });
  const service = createHosts({
    scope,
    ssh: {
      manager: { on() {}, off() {}, getProxy, dropConnection: async () => {} } as never,
      control: {
        readIntent: async () => intended,
        writeIntent: async (_id, enabled) => {
          intended = enabled;
        },
        establish: sshEstablish,
        reset: () => {},
        probe: async () => {},
      },
    },
    maestro: {
      isMaestroHost: () => maestroHost,
      resolve: async (): Promise<MaestroHostDialConfig> => ({
        url: 'https://my-pc.tailnet.ts.net',
        token: secret(token),
      }),
      dial,
      publishConnectionEvent: (event) => events.push(event),
    },
    machineEvents: {
      on: (_name, listener) => {
        mutation = listener;
        return () => {
          mutation = undefined;
        };
      },
    },
  });
  return {
    scope,
    peer,
    service,
    dial,
    events,
    sshEstablish,
    getProxy,
    host: () => {
      const host = service.get(hostRef('remote', 'maestro-1'));
      if (!host) throw new Error('Missing test Host');
      return host;
    },
    setMaestroHost: (value: boolean) => {
      maestroHost = value;
    },
    setToken: (value: string) => {
      token = value;
    },
    rejectWith: (status: number | undefined) => {
      rejectStatus = status;
    },
    mutate: () => mutation?.({ connectionId: 'maestro-1' }),
  };
}
