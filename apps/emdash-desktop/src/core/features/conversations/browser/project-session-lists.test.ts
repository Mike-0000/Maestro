import { formatHostRef, hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireProjectSessionLists,
  resetProjectSessionListsForTests,
  type ProjectSessionLists,
} from '@core/features/conversations/api/browser/project-session-lists';

type Observed = {
  kind: 'tui' | 'acp';
  host: string;
  emit(value: Record<string, unknown>): void;
  disposed: boolean;
};

const mocks = vi.hoisted(() => ({ observed: [] as Observed[] }));

vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({ tui: { sessions: 'tui' }, acp: { sessions: 'acp' } }),
}));
vi.mock('@emdash/wire/state', () => ({
  remote: (_contract: unknown, kind: 'tui' | 'acp') => (key: { host: string }) => ({
    states: { list: { kind, host: key.host } },
  }),
  observe: (
    cell: { kind: 'tui' | 'acp'; host: string },
    listener: (snapshot: { value: unknown }) => void,
    options: { scope: { disposed: boolean } }
  ) => {
    mocks.observed.push({
      kind: cell.kind,
      host: cell.host,
      emit: (value) => listener({ value }),
      get disposed() {
        return options.scope.disposed;
      },
    });
  },
}));

const LOCAL = formatHostRef(LOCAL_HOST_REF);
const MACHINE = formatHostRef(hostRef('remote', 'machine-1'));

const running = (conversationId: string) => ({ [conversationId]: { status: 'running' } });

/** The live TUI list observation for a host, once its subscription has opened. */
async function tuiList(host: string): Promise<Observed> {
  return vi.waitFor(() => {
    const found = mocks.observed.find(
      (item) => item.kind === 'tui' && item.host === host && !item.disposed
    );
    if (!found) throw new Error(`no TUI list observed for ${host}`);
    return found;
  });
}

beforeEach(() => {
  mocks.observed.length = 0;
  vi.stubGlobal('window', {});
});

afterEach(() => {
  resetProjectSessionListsForTests();
  vi.unstubAllGlobals();
});

describe('acquireProjectSessionLists', () => {
  it('follows each subscriber to its own host, whichever subscribed first', async () => {
    // Tasks learn their host when they are provisioned: both start out local.
    const sleepingHost = observable.box(LOCAL);
    const activeHost = observable.box(LOCAL);
    const sleeping: ProjectSessionLists[] = [];
    const active: ProjectSessionLists[] = [];
    const releaseSleeping = acquireProjectSessionLists(
      'project-1',
      () => sleepingHost.get(),
      undefined,
      (lists) => sleeping.push({ ...lists })
    );
    const releaseActive = acquireProjectSessionLists(
      'project-1',
      () => activeHost.get(),
      undefined,
      (lists) => active.push({ ...lists })
    );

    // Only the second task is provisioned, on another machine.
    runInAction(() => activeHost.set(MACHINE));
    (await tuiList(MACHINE)).emit(running('conv-active'));

    expect(active.at(-1)?.tui).toEqual(running('conv-active'));
    expect(sleeping.at(-1)?.tui).toEqual({});

    releaseSleeping();
    releaseActive();
  });

  it('keeps a subscriber on its host when the first subscriber goes away', async () => {
    const firstHost = observable.box(MACHINE);
    const secondHost = observable.box(MACHINE);
    const second: ProjectSessionLists[] = [];
    const releaseFirst = acquireProjectSessionLists(
      'project-1',
      () => firstHost.get(),
      undefined,
      () => {}
    );
    const releaseSecond = acquireProjectSessionLists(
      'project-1',
      () => secondHost.get(),
      undefined,
      (lists) => second.push({ ...lists })
    );
    const machine = await tuiList(MACHINE);

    // A disposed task forgets its host.
    releaseFirst();
    runInAction(() => firstHost.set(LOCAL));
    machine.emit(running('conv-second'));

    expect(machine.disposed).toBe(false);
    expect(second.at(-1)?.tui).toEqual(running('conv-second'));
    releaseSecond();
  });

  it('shares one subscription between subscribers on the same host', async () => {
    const releases = [1, 2, 3].map(() =>
      acquireProjectSessionLists(
        'project-1',
        () => MACHINE,
        undefined,
        () => {}
      )
    );
    await tuiList(MACHINE);

    expect(mocks.observed.filter((item) => item.kind === 'tui')).toHaveLength(1);

    for (const release of releases) release();
    expect(mocks.observed.every((item) => item.disposed)).toBe(true);
  });
});
