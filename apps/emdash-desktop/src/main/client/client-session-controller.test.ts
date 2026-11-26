import { createScope } from '@emdash/shared/concurrency';
import { client, connect, memoryTransportPair, serve } from '@emdash/wire/rpc';
import { describe, expect, it, vi } from 'vitest';
import {
  clientSessionContract,
  type ClientSessionStatus,
} from '@core/features/client-mode/api/client-session-contract';
import { createClientSessionController } from './client-session-controller';
import type { ClientConnection, ConnectionStore } from './connection-store';
import { createHostLink } from './host-link';
import type { OwnerPairFetch } from './owner-pairing';
import { TEST_BUILD } from './testing/fake-owner-host';

function harness(options: { fetchStatus?: number; fetchBody?: unknown; started?: boolean } = {}) {
  const saved: ClientConnection[] = [];
  const store: ConnectionStore = {
    load: async () => null,
    save: async (connection) => {
      saved.push(connection);
      return null;
    },
    clear: vi.fn(async () => {}),
  };
  const link = createHostLink({
    build: TEST_BUILD,
    clientName: 'desk-pc',
    clientPlatform: 'win32',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pingIntervalMs: 0,
    // Never answers: these tests stop at the point the link starts dialing.
    dial: () => new Promise(() => {}),
  });
  if (options.started) {
    link.start({
      url: 'http://old',
      hostId: 'h',
      hostName: 'old',
      deviceId: 'd',
      token: 't',
      pairedAt: 0,
    });
  } else {
    link.start(null);
  }
  const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetch: OwnerPairFetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      status: options.fetchStatus ?? 200,
      json: async () =>
        options.fetchBody ?? {
          deviceId: 'dev-9',
          token: 'tok-9',
          hostId: 'host-9',
          hostName: 'vm',
        },
    };
  };
  const relaunch = vi.fn();
  const controller = createClientSessionController({
    link,
    store,
    deviceName: 'desk-pc',
    relaunch,
    createShortcut: async () => ({ success: true, data: undefined }),
    scope: createScope({ label: 'test' }),
    log: { info: () => {} },
    fetch,
    now: () => 42,
  });
  const pair = memoryTransportPair();
  serve(pair.right, controller);
  const session = client(clientSessionContract, connect(pair.left));
  return { session, link, saved, requests, relaunch, store };
}

describe('client session controller', () => {
  it('serves the status before any host is attached', async () => {
    const { session } = harness();
    const snapshot = await session.status.state(undefined, 'state').snapshot();
    expect((snapshot.data as ClientSessionStatus).phase).toBe('unpaired');
  });

  it('pairs, stores the credential and starts the link', async () => {
    const { session, link, saved, requests, relaunch } = harness();
    const result = await session.pair({
      url: 'vm.tailnet.ts.net',
      code: ' 123456 ',
      cfAccessClientId: 'cid',
      cfAccessClientSecret: 'csecret',
    });
    expect(result).toEqual({ success: true, data: undefined });
    expect(requests).toEqual([
      {
        url: 'https://vm.tailnet.ts.net/api/owner/pair',
        body: { code: '123456', deviceName: 'desk-pc' },
        headers: expect.objectContaining({
          'CF-Access-Client-Id': 'cid',
          'CF-Access-Client-Secret': 'csecret',
        }),
      },
    ]);
    expect(saved).toEqual([
      {
        url: 'https://vm.tailnet.ts.net',
        hostId: 'host-9',
        hostName: 'vm',
        deviceId: 'dev-9',
        token: 'tok-9',
        cfAccess: { clientId: 'cid', clientSecret: 'csecret' },
        pairedAt: 42,
      },
    ]);
    expect(link.started).toBe(true);
    expect(link.current().phase).toBe('connecting');
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches after re-pairing a link that already ran', async () => {
    const { session, relaunch } = harness({ started: true });
    await session.pair({ url: 'http://127.0.0.1:7462', code: '1' });
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('rejects half a Cloudflare credential and a bad address', async () => {
    const { session, requests } = harness();
    await expect(
      session.pair({ url: 'https://vm', code: '1', cfAccessClientId: 'only-id' })
    ).resolves.toMatchObject({ success: false, error: { type: 'invalid' } });
    await expect(session.pair({ url: 'ftp://vm', code: '1' })).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid' },
    });
    expect(requests).toEqual([]);
  });

  it.each([
    [401, { error: 'invalid-code' }, 'rejected'],
    [404, undefined, 'unsupported'],
    [403, { error: 'tailscale-required' }, 'rejected'],
    [500, undefined, 'failed'],
  ] as const)('maps HTTP %i to %s', async (status, body, type) => {
    const { session, saved } = harness({ fetchStatus: status, fetchBody: body ?? {} });
    await expect(session.pair({ url: 'https://vm', code: '1' })).resolves.toMatchObject({
      success: false,
      error: { type },
    });
    expect(saved).toEqual([]);
  });

  it('forgets the host and relaunches', async () => {
    const { session, store, relaunch } = harness();
    await session.forget(undefined);
    expect(store.clear).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
