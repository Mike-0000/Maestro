import type { ClientSessionStatus } from '../api/client-session-contract';
import type {
  ClientSession,
  ClientSessionSnapshot,
  CreateShortcutResult,
  HostUpdateResult,
  PairResult,
} from './client-session-store';

/** Tests only: a `ClientSession` whose status is set by hand and whose actions are recorded. */
export type FakeClientSession = ClientSession & {
  setStatus(status: ClientSessionStatus): void;
  failToLoad(error: unknown): void;
  calls: Array<{ action: string; input?: unknown }>;
  results: {
    pair: PairResult;
    requestHostUpdate: HostUpdateResult;
    createShortcut: CreateShortcutResult;
  };
  /** Set to make the next void action reject with this error. */
  rejectWith: Error | undefined;
};

export function clientStatus(patch: Partial<ClientSessionStatus> = {}): ClientSessionStatus {
  return {
    phase: 'connected',
    host: { url: 'https://rig.tailnet.ts.net', id: 'host-1', name: 'rig-vm', platform: 'linux' },
    blocked: null,
    attempt: 0,
    lastError: null,
    connectedAt: 1_700_000_000_000,
    latencyMs: 24,
    ...patch,
  };
}

export function createFakeClientSession(initial?: ClientSessionStatus): FakeClientSession {
  const listeners = new Set<() => void>();
  let snapshot: ClientSessionSnapshot = { status: initial, loadError: undefined };

  const publish = (next: ClientSessionSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const when = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      if (done()) return resolve();
      const unsubscribe = subscribe(() => {
        if (!done()) return;
        unsubscribe();
        resolve();
      });
    });

  const session: FakeClientSession = {
    calls: [],
    results: {
      pair: { success: true, data: undefined },
      requestHostUpdate: { success: true, data: undefined },
      createShortcut: { success: true, data: undefined },
    },
    rejectWith: undefined,
    setStatus: (status) => publish({ status, loadError: undefined }),
    failToLoad: (error) => publish({ ...snapshot, loadError: error }),
    start: () => {},
    getSnapshot: () => snapshot,
    subscribe,
    whenConnected: () => when(() => snapshot.status?.phase === 'connected'),
    whenLoaded: () => when(() => snapshot.status !== undefined || snapshot.loadError !== undefined),
    pair: async (input) => {
      session.calls.push({ action: 'pair', input });
      return session.results.pair;
    },
    retryNow: () => record('retryNow'),
    takeOver: () => record('takeOver'),
    forget: () => record('forget'),
    relaunch: () => record('relaunch'),
    quit: () => record('quit'),
    requestHostUpdate: async (when) => {
      session.calls.push({ action: 'requestHostUpdate', input: when });
      return session.results.requestHostUpdate;
    },
    createShortcut: async () => {
      session.calls.push({ action: 'createShortcut' });
      return session.results.createShortcut;
    },
  };

  async function record(action: string): Promise<void> {
    session.calls.push({ action });
    if (session.rejectWith) throw session.rejectWith;
  }

  return session;
}
