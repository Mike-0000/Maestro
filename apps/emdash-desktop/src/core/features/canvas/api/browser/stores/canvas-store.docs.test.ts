import { observable, runInAction } from 'mobx';
import { describe, expect, it } from 'vitest';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { canvasBoardMemento, type CanvasBoardState } from '../../../contributions/mementos';
import { DOC_TILE_SIZE, type TileRect } from '../../canvas-model';
import { defaultSizeOf, windowKindOf } from '../../canvas-regions';
import { CanvasStore, docTileId, noteTileId } from './canvas-store';

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

function project(id: string, name: string, tasks: Record<string, string>) {
  const entries = Object.entries(tasks).map(
    ([taskId, type]) =>
      [
        taskId,
        { state: 'provisioned', data: { id: taskId, type }, displayName: 'Write plan' },
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

/** Two available projects with tasks and no agents: enough for documents to belong to. */
function canvas(): CanvasStore {
  const store = new CanvasStore({
    projects: new Map([
      project('p1', 'Demo', { t1: 'task', run: 'automation-run' }),
      project('p2', 'Other', { t2: 'task' }),
    ]),
  } as unknown as ProjectManagerStore);
  store.attachMemento(memento(canvasBoardMemento.default));
  store.setBoardSize(1600, 900);
  return store;
}

const plan = {
  projectId: 'p1',
  workspaceId: 'ws1',
  taskId: 't1',
  path: '/repo/docs/plan.md',
  title: 'plan.md',
};
const report = { ...plan, path: '/repo/docs/report.md', title: 'report.md' };

function open(store: CanvasStore, input: Parameters<CanvasStore['openDoc']>[0]): string {
  const tileId = store.openDoc(input);
  if (!tileId) throw new Error('Expected the document to open as a window');
  return tileId;
}

function overlap(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('CanvasStore document windows', () => {
  it('opens a Markdown file as a window the layout knows', () => {
    const store = canvas();
    const tileId = open(store, plan);

    expect(tileId).toMatch(/^doc:/);
    expect(store.docEntries).toEqual([
      {
        ...plan,
        tileId,
        docId: tileId.slice('doc:'.length),
        projectName: 'Demo',
        taskName: 'Write plan',
      },
    ]);
    expect(defaultSizeOf(tileId)).toEqual(DOC_TILE_SIZE);
    expect(windowKindOf(tileId)).toBe('doc');
    expect(store.isDocOnScreen(tileId)).toBe(true);
    expect(store.layoutWindows.find((window) => window.tileId === tileId)).toMatchObject({
      kind: 'doc',
      name: 'plan.md',
      taskName: 'Write plan',
      projectId: 'p1',
    });
    expect(store.windowName(tileId)).toBe('plan.md');
    // Presenting brings the window into view.
    expect(store.focusedTileId).toBe(tileId);
    expect(store.viewportCommand).toMatchObject({ kind: 'focus', tileId });
    store.dispose();
  });

  it('joins the project sub-canvas from the main canvas, clear of what is there', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    const tileId = open(store, plan);

    const region = store.regionOf(tileId);
    expect(store.state.regions[region ?? '']?.name).toBe('Demo');
    expect(overlap(store.tileRect(tileId), store.tileRect(note))).toBe(false);
    store.dispose();
  });

  it('opens in the sub-canvas the developer is in', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.runLayout([{ op: 'createRegion', name: 'Review', members: [note] }], {
      source: 'command',
    });
    const review = store.regionOf(note);
    expect(store.goToRegion(review ?? '')).toBe(true);

    const tileId = open(store, plan);
    expect(store.regionOf(tileId)).toBe(review);
    expect(store.isDocOnScreen(tileId)).toBe(true);
    store.dispose();
  });

  it('shows one window per file, and a closed one comes back without covering its neighbour', () => {
    const store = canvas();
    const first = open(store, plan);
    const second = open(store, report);
    store.runLayout([{ op: 'hide', targets: [first] }], { source: 'command' });
    expect(store.isDocOnScreen(first)).toBe(false);

    expect(store.openDoc({ ...plan, title: 'The plan' })).toBe(first);
    expect(store.docEntries).toHaveLength(2);
    expect(store.docEntries.find((entry) => entry.tileId === first)?.title).toBe('The plan');
    expect(store.isDocOnScreen(first)).toBe(true);
    expect(overlap(store.tileRect(first), store.tileRect(second))).toBe(false);

    // The same path in another workspace is another file.
    expect(store.openDoc({ ...plan, workspaceId: 'ws2' })).not.toBe(first);
    expect(store.docEntries).toHaveLength(3);
    store.dispose();
  });

  it('lifts a project filter and expands a collapsed sub-canvas that would hide the file', () => {
    const store = canvas();
    const tileId = open(store, plan);
    const region = store.regionOf(tileId) ?? '';
    store.runLayout([{ op: 'collapseRegion', region, collapsed: true }], { source: 'command' });
    store.setProjectFilter('p2');
    expect(store.isDocOnScreen(tileId)).toBe(false);

    expect(store.openDoc(plan)).toBe(tileId);
    expect(store.projectFilter).toBeNull();
    expect(store.state.regions[region]?.collapsed).toBe(false);
    expect(store.isDocOnScreen(tileId)).toBe(true);
    store.dispose();
  });

  it('opens without taking the view when focus is off', () => {
    const store = canvas();
    const tileId = open(store, { ...plan, focus: false });
    expect(store.focusedTileId).not.toBe(tileId);
    expect(store.viewportCommand).toBeNull();
    store.dispose();
  });

  it('joins a stage of picked windows in place, keeping its arrangement', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    expect(store.enterStage({ kind: 'selection', tileIds: [one, two], label: '2 windows' })).toBe(
      true
    );
    store.updateStage('Reordered', (saved) => ({ ...saved, order: [two, one], soloTileId: two }));

    const tileId = open(store, plan);
    expect(store.stageTarget).toEqual({
      kind: 'selection',
      tileIds: [one, two, tileId],
      label: '3 windows',
    });
    expect(store.stageOrderNow()).toEqual([two, one, tileId]);
    // A pane shown alone gives way, so the file is seen.
    expect(store.stageSaved.soloTileId).toBeNull();
    expect(store.isDocOnScreen(tileId)).toBe(true);
    // Leaving the stage goes back to the board, not to an earlier stage.
    expect(store.back()).toBe(true);
    expect(store.location.kind).toBe('board');
    store.dispose();
  });

  it("moves a file already open elsewhere onto the staged region's stage", () => {
    const store = canvas();
    const tileId = open(store, plan);
    const note = noteTileId(store.addNote('one'));
    store.runLayout([{ op: 'createRegion', name: 'Review', members: [note] }], {
      source: 'command',
    });
    const review = store.regionOf(note) ?? '';
    expect(store.regionOf(tileId)).not.toBe(review);
    expect(store.enterStage({ kind: 'region', regionId: review })).toBe(true);

    expect(store.openDoc(plan)).toBe(tileId);
    expect(store.regionOf(tileId)).toBe(review);
    expect(store.stageTarget).toEqual({ kind: 'region', regionId: review });
    expect(store.isDocOnScreen(tileId)).toBe(true);
    store.dispose();
  });

  it('stays on the stage in Canvas Pro, with the file on the desk the stage came from', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = store.activeDeskId;
    expect(store.enterStage({ kind: 'solo', tileId: note })).toBe(true);

    const tileId = open(store, plan);
    expect(store.location.kind).toBe('stage');
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main']);
    expect(store.deskOf(tileId)).toBe(main);
    expect(store.stageTileIds).toEqual([note, tileId]);
    store.dispose();
  });

  it('closes a document for good and gives its space back in a tiled sub-canvas', () => {
    const store = canvas();
    const first = open(store, plan);
    const alone = store.tileRect(first).w;
    const second = open(store, report);
    expect(store.tileRect(first).w).toBeLessThan(alone);

    store.closeDoc(second.slice('doc:'.length));
    expect(docTileId(second.slice('doc:'.length))).toBe(second);
    expect(store.docEntries.map((entry) => entry.tileId)).toEqual([first]);
    expect(store.state.tiles[second]).toBeUndefined();
    expect(store.state.membership[second]).toBeUndefined();
    expect(store.state.hiddenTiles).not.toContain(second);
    expect(store.focusedTileId).toBeNull();
    expect(store.tileRect(first).w).toBe(alone);
    store.dispose();
  });

  it('opens nothing for a task that has no place on the board', () => {
    const store = canvas();
    expect(store.openDoc({ ...plan, taskId: 'gone' })).toBeNull();
    expect(store.openDoc({ ...plan, taskId: 'run' })).toBeNull();
    expect(store.state.docs ?? {}).toEqual({});
    expect(Object.keys(store.state.tiles)).toEqual([]);
    store.dispose();
  });
});
