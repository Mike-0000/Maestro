import { observable, runInAction } from 'mobx';
import { describe, expect, it } from 'vitest';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { canvasBoardMemento, type CanvasBoardState } from '../../../contributions/mementos';
import { CanvasStore, noteTileId } from './canvas-store';

/** An in-memory memento, so the store runs with its layout tracking as it does in the app. */
function memento(initial: CanvasBoardState): MementoHandle<CanvasBoardState> {
  const box = observable.box(initial, { deep: false });
  return {
    get value() {
      return box.get();
    },
    update(next: CanvasBoardState | ((current: CanvasBoardState) => CanvasBoardState)) {
      runInAction(() => box.set(typeof next === 'function' ? next(box.get()) : next));
    },
  } as unknown as MementoHandle<CanvasBoardState>;
}

function project(id: string, name: string, taskIds: readonly string[]) {
  const entries = taskIds.map(
    (taskId) =>
      [
        taskId,
        { state: 'provisioned', data: { id: taskId, type: 'task' }, displayName: taskId },
      ] as const
  );
  return [
    id,
    {
      id,
      name,
      context: { kind: 'available', context: { get: () => ({ tasks: new Map(entries) }) } },
    },
  ] as const;
}

/** Two projects whose tasks have app browsers: windows that belong to a project, without agents. */
function canvas(): CanvasStore {
  const store = new CanvasStore({
    projects: new Map([project('p1', 'Demo', ['t1', 't2']), project('p2', 'Other', ['t3'])]),
  } as unknown as ProjectManagerStore);
  store.attachMemento(memento(canvasBoardMemento.default));
  store.setBoardSize(1600, 900);
  return store;
}

function openApp(store: CanvasStore, projectId: string, taskId: string): string {
  return store.openBrowser({ projectId, workspaceId: `ws-${taskId}`, taskId, focus: false });
}

function deskNamed(store: CanvasStore, name: string): string {
  const desk = store.desks.find((candidate) => candidate.name === name);
  if (!desk) throw new Error(`No desk called ${name}`);
  return desk.regionId;
}

describe('CanvasStore: one desk per project (Canvas Pro)', () => {
  it("puts new windows on their project's desk, not the desk in view", () => {
    const store = canvas();
    store.setMode('pro');
    const review = store.createDesk({ name: 'Review' }) as string;

    const first = openApp(store, 'p1', 't1');
    const demo = deskNamed(store, 'Demo');
    expect(store.deskOf(first)).toBe(demo);
    expect(store.state.regions[demo]?.projectId).toBe('p1');
    // The developer stays where they were.
    expect(store.activeDeskId).toBe(review);

    expect(store.deskOf(openApp(store, 'p1', 't2'))).toBe(demo);
    expect(store.deskOf(openApp(store, 'p2', 't3'))).toBe(deskNamed(store, 'Other'));
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main', 'Review', 'Demo', 'Other']);
    store.dispose();
  });

  it("uses a desk the developer named after the project, and tags it as the project's", () => {
    const store = canvas();
    store.setMode('pro');
    const mine = store.createDesk({ name: 'demo' }) as string;
    store.createDesk({ name: 'Review' });

    expect(store.deskOf(openApp(store, 'p1', 't1'))).toBe(mine);
    expect(store.state.regions[mine]?.projectId).toBe('p1');
    store.dispose();
  });

  it('opens them on the desk in view when the setting is off', () => {
    const store = canvas();
    store.setLayoutSettings({ placeNewWindowsOnProjectDesk: false });
    store.setMode('pro');
    const review = store.createDesk({ name: 'Review' }) as string;

    expect(store.deskOf(openApp(store, 'p1', 't1'))).toBe(review);
    store.dispose();
  });

  it('sorts loose windows onto project desks when entering Pro; the rest go to Main', () => {
    const store = canvas();
    store.setLayoutSettings({ placeNewWindowsInProjectRegion: false });
    const app = openApp(store, 'p1', 't1');
    const note = noteTileId(store.addNote('todo'));
    expect(store.regionOf(app)).toBeNull();

    expect(store.setMode('pro')).toEqual({ changed: true, desks: 2, gathered: 1, sorted: 1 });
    expect(store.deskOf(app)).toBe(deskNamed(store, 'Demo'));
    expect(store.deskOf(note)).toBe(deskNamed(store, 'Main'));
    store.dispose();
  });
});
