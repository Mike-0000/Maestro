import { createScope } from '@emdash/shared/concurrency';
import { observe, remote, type RemoteModel } from '@emdash/wire/state';
import { useSyncExternalStore } from 'react';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { queryClient } from '@core/primitives/query/browser/query-client';
import { getClientSessionClient, type ClientSessionClient } from '../api/browser/client';
import { clientSessionContract, type ClientSessionStatus } from '../api/client-session-contract';

export type ClientSessionSnapshot = {
  /** Undefined until the client's main process has reported once. */
  readonly status: ClientSessionStatus | undefined;
  /** Set when the status could not be read at all. */
  readonly loadError: unknown;
};

/** The procedures of `clientSession`, without its live status. */
export type ClientSessionActions = Pick<
  ClientSessionClient,
  'pair' | 'retryNow' | 'takeOver' | 'forget' | 'relaunch' | 'requestHostUpdate' | 'createShortcut'
>;

export type PairResult = Awaited<ReturnType<ClientSessionActions['pair']>>;
export type HostUpdateResult = Awaited<ReturnType<ClientSessionActions['requestHostUpdate']>>;
export type CreateShortcutResult = Awaited<ReturnType<ClientSessionActions['createShortcut']>>;

/** What the client-mode screens need from the link to the host. */
export type ClientSession = {
  /** Starts following the status; safe to call more than once. */
  start(): void;
  getSnapshot(): ClientSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Settles once the link is attached; never rejects. */
  whenConnected(): Promise<void>;
  /** Settles once there is a status to show or reading it failed; never rejects. */
  whenLoaded(): Promise<void>;
  pair(input: Parameters<ClientSessionActions['pair']>[0]): Promise<PairResult>;
  retryNow(): Promise<void>;
  takeOver(): Promise<void>;
  forget(): Promise<void>;
  relaunch(): Promise<void>;
  requestHostUpdate(when: 'idle' | 'now'): Promise<HostUpdateResult>;
  createShortcut(): Promise<CreateShortcutResult>;
  /** Quits this client. The host and its agents keep running. */
  quit(): Promise<void>;
};

type StatusRemote = RemoteModel<typeof clientSessionContract.status>;

export type ClientSessionStoreDeps = {
  getActions: () => Promise<ClientSessionActions>;
  getStatusRemote: () => Promise<StatusRemote>;
  /** The link came back after a drop: anything cached while it was down may be stale. */
  onReconnected?: () => void;
  quit?: () => Promise<void>;
};

export function createClientSessionStore(deps: ClientSessionStoreDeps): ClientSession {
  const listeners = new Set<() => void>();
  const scope = createScope({ label: 'client-session-store' });
  let snapshot: ClientSessionSnapshot = { status: undefined, loadError: undefined };
  let started = false;

  const publish = (next: ClientSessionSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const accept = (status: ClientSessionStatus) => {
    const previous = snapshot.status?.phase;
    publish({ status, loadError: undefined });
    if (previous === 'reconnecting' && status.phase === 'connected') deps.onReconnected?.();
  };

  const fail = (error: unknown) => {
    // A status that was already shown stays; only a link that never reported is an error.
    if (snapshot.status === undefined) publish({ ...snapshot, loadError: error });
  };

  const start = () => {
    if (started) return;
    started = true;
    void deps
      .getStatusRemote()
      .then((model) => {
        observe(
          model(undefined).states.state,
          (current) => {
            if (current.status === 'error') fail(current.error);
            else if (current.value !== undefined) accept(current.value);
          },
          { scope }
        );
      })
      .catch(fail);
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const when = (done: (current: ClientSessionSnapshot) => boolean): Promise<void> =>
    new Promise((resolve) => {
      if (done(snapshot)) return resolve();
      const unsubscribe = subscribe(() => {
        if (!done(snapshot)) return;
        unsubscribe();
        resolve();
      });
    });

  return {
    start,
    getSnapshot: () => snapshot,
    subscribe,
    whenConnected: () => when((current) => current.status?.phase === 'connected'),
    whenLoaded: () =>
      when((current) => current.status !== undefined || current.loadError !== undefined),
    pair: async (input) => (await deps.getActions()).pair(input),
    retryNow: async () => (await deps.getActions()).retryNow(undefined),
    takeOver: async () => (await deps.getActions()).takeOver(undefined),
    forget: async () => (await deps.getActions()).forget(undefined),
    relaunch: async () => (await deps.getActions()).relaunch(undefined),
    requestHostUpdate: async (timing) =>
      (await deps.getActions()).requestHostUpdate({ when: timing }),
    createShortcut: async () => (await deps.getActions()).createShortcut(undefined),
    quit: async () => {
      await deps.quit?.();
    },
  };
}

let shared: ClientSession | undefined;
let statusRemote: Promise<StatusRemote> | undefined;

/**
 * This window's link to its host. Only for client mode: creating it is free, but `start()` and
 * every action reach the `clientSession` domain, which only a client process serves.
 */
export function getClientSessionStore(): ClientSession {
  shared ??= createClientSessionStore({
    getActions: getClientSessionClient,
    getStatusRemote: () => {
      statusRemote ??= getClientSessionClient().then((client) =>
        remote(clientSessionContract.status, client.status, { lingerMs: 15_000 })
      );
      return statusRemote;
    },
    // Live models resubscribe by themselves; request/response data is refetched here.
    onReconnected: () => void queryClient.invalidateQueries(),
    quit: async () => {
      await (await getHostClient()).quit(undefined);
    },
  });
  return shared;
}

/** The link's state, live. Starts following it on first use. */
export function useClientSession(session: ClientSession): ClientSessionSnapshot {
  return useSyncExternalStore(
    (listener) => {
      session.start();
      return session.subscribe(listener);
    },
    () => session.getSnapshot()
  );
}
