import { ok } from '@emdash/shared';
import { cell, type RemoteModel } from '@emdash/wire/state';
import { describe, expect, it, vi } from 'vitest';
import type { clientSessionContract, ClientSessionStatus } from '../api/client-session-contract';
import { createClientSessionStore, type ClientSessionActions } from './client-session-store';
import { clientStatus } from './fake-client-session';

type StatusRemote = RemoteModel<typeof clientSessionContract.status>;

function harness(initial?: ClientSessionStatus) {
  const source = cell<ClientSessionStatus | undefined>(initial);
  const remoteModel = (() => ({
    states: { state: source },
    mutations: {},
  })) as unknown as StatusRemote;
  const actions = {
    pair: vi.fn(async () => ok(undefined)),
    retryNow: vi.fn(async () => {}),
    takeOver: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
    requestHostUpdate: vi.fn(async () => ok(undefined)),
    createShortcut: vi.fn(async () => ok(undefined)),
  };
  const getStatusRemote = vi.fn(async () => remoteModel);
  const onReconnected = vi.fn();
  const quit = vi.fn(async () => {});
  const store = createClientSessionStore({
    getActions: async () => actions as unknown as ClientSessionActions,
    getStatusRemote,
    onReconnected,
    quit,
  });
  return {
    store,
    source,
    actions,
    getStatusRemote,
    onReconnected,
    quit,
  };
}

describe('client session store', () => {
  it('does nothing until it is started', async () => {
    const { store, getStatusRemote } = harness(clientStatus());
    await Promise.resolve();
    expect(getStatusRemote).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBeUndefined();
  });

  it('follows the status once started, and starts only once', async () => {
    const { store, source, getStatusRemote } = harness(clientStatus({ phase: 'connecting' }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    store.start();
    await store.whenLoaded();
    expect(getStatusRemote).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status?.phase).toBe('connecting');

    source.set(clientStatus());
    await store.whenConnected();
    expect(store.getSnapshot().status?.phase).toBe('connected');
    expect(listener).toHaveBeenCalled();
  });

  it('refreshes cached data only when a dropped link comes back', async () => {
    const { store, source, onReconnected } = harness(clientStatus({ phase: 'connecting' }));
    store.start();
    await store.whenLoaded();

    source.set(clientStatus());
    await store.whenConnected();
    expect(onReconnected).not.toHaveBeenCalled();

    source.set(clientStatus({ phase: 'reconnecting' }));
    await vi.waitFor(() => expect(store.getSnapshot().status?.phase).toBe('reconnecting'));
    source.set(clientStatus());
    await store.whenConnected();
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it('reports a status that cannot be read', async () => {
    const failure = new Error('clientSession is not served');
    const store = createClientSessionStore({
      getActions: async () => ({}) as ClientSessionActions,
      getStatusRemote: async () => {
        throw failure;
      },
    });
    store.start();
    await store.whenLoaded();
    expect(store.getSnapshot().loadError).toBe(failure);
    expect(store.getSnapshot().status).toBeUndefined();
  });

  it('passes every action to the client session domain', async () => {
    const { store, actions, quit } = harness(clientStatus());
    const input = { url: 'https://rig.tailnet.ts.net', code: 'ABCD-EFGH' };
    await expect(store.pair(input)).resolves.toEqual(ok(undefined));
    await store.retryNow();
    await store.takeOver();
    await store.forget();
    await store.relaunch();
    await store.requestHostUpdate('idle');
    await store.createShortcut();
    await store.quit();

    expect(actions.pair).toHaveBeenCalledWith(input);
    expect(actions.retryNow).toHaveBeenCalledOnce();
    expect(actions.takeOver).toHaveBeenCalledOnce();
    expect(actions.forget).toHaveBeenCalledOnce();
    expect(actions.relaunch).toHaveBeenCalledOnce();
    expect(actions.requestHostUpdate).toHaveBeenCalledWith({ when: 'idle' });
    expect(actions.createShortcut).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
