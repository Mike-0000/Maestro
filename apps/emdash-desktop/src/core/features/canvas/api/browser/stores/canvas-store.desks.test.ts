import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { canvasBoardMemento, type CanvasBoardState } from '../../../contributions/mementos';
import { rectContains } from '../../canvas-model';
import { DESK_INSETS, deskPageBox, deskRectSize } from '../../desk-layout';
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

/** A canvas with no agents: notes stand in for windows (they are windows to the layout). */
function canvas(): CanvasStore {
  const store = new CanvasStore({ projects: new Map() } as unknown as ProjectManagerStore);
  store.attachMemento(memento(canvasBoardMemento.default));
  store.setBoardSize(1600, 900);
  return store;
}

function deskNamed(store: CanvasStore, name: string): string {
  const desk = store.desks.find((candidate) => candidate.name === name);
  if (!desk) throw new Error(`No desk called ${name}`);
  return desk.regionId;
}

describe('CanvasStore desks (Canvas Pro)', () => {
  it('classic: Fit still re-tiles a sub-canvas whose size has not changed', () => {
    const store = canvas();
    const notes = ['one', 'two', 'three'].map((text) => store.addNote(text));
    const tiles = notes.map(noteTileId);
    store.runLayout([{ op: 'createRegion', name: 'Review', members: tiles }], {
      source: 'command',
    });
    store.goToRegion(Object.keys(store.state.regions)[0] as string);
    // Removing a note leaves the other two where the three-way tiling put them.
    store.removeNote(notes[2] as string);
    store.refitScope();
    const [first, second] = tiles.slice(0, 2).map((id) => store.layoutState.tiles[id]);
    expect(first?.h).toBe(second?.h);
    expect(first?.h).toBeGreaterThan(600);
    store.dispose();
  });

  it('has no desks on the classic canvas', () => {
    const store = canvas();
    store.addNote('one');
    expect(store.proMode).toBe(false);
    expect(store.desks).toEqual([]);
    expect(store.activeDeskId).toBeNull();
    store.dispose();
  });

  it('entering Pro puts loose windows on Main as one undoable change and shows that desk', () => {
    const store = canvas();
    const first = noteTileId(store.addNote('one'));
    const second = noteTileId(store.addNote('two'));
    const undoBefore = store.undoStack.length;

    expect(store.setMode('pro')).toEqual({ changed: true, desks: 1, gathered: 2, sorted: 0 });

    expect(store.desks.map((desk) => desk.name)).toEqual(['Main']);
    const main = deskNamed(store, 'Main');
    expect(store.activeDeskId).toBe(main);
    expect(store.location).toEqual({ kind: 'board', regionScope: main });
    expect(store.deskOf(first)).toBe(main);
    expect(store.deskOf(second)).toBe(main);
    expect(store.desks[0]?.windowCount).toBe(2);
    expect(store.undoStack.length).toBe(undoBefore + 1);
    // The desk fills the screen, so the camera stays put on it.
    expect(store.deskLocked).toBe(true);
    expect(store.setMode('pro').changed).toBe(false);
    store.dispose();
  });

  it('makes an empty Main when there is nothing on the canvas', () => {
    const store = canvas();
    store.setMode('pro');
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main']);
    expect(store.activeDeskId).toBe(deskNamed(store, 'Main'));
    store.dispose();
  });

  it('keeps regions as desks in board order and leaves them as regions on the way out', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.runLayout([{ op: 'createRegion', name: 'Review', members: [note] }], {
      source: 'command',
    });
    store.setMode('pro');
    expect(store.desks.map((desk) => desk.name)).toEqual(['Review']);
    store.setMode('classic');
    expect(store.desks).toEqual([]);
    expect(Object.values(store.state.regions).map((region) => region.name)).toEqual(['Review']);
    expect(store.regionOf(note)).not.toBeNull();
    store.dispose();
  });

  it('creates desks, swaps between them in order, and is never off a desk', () => {
    const store = canvas();
    store.addNote('one');
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' });
    expect(review).not.toBeNull();
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main', 'Review']);
    expect(store.activeDeskId).toBe(review);
    // The swap is a cut: the camera jumps to the desk.
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: review, instant: true });

    expect(store.goToAdjacentRegion(1)).toBe(main);
    expect(store.activeDeskId).toBe(main);
    expect(store.goToAdjacentRegion(-1)).toBe(review);

    // There is no board above a desk to leave for.
    expect(store.up()).toBe(false);
    expect(store.leaveScope()).toBe(false);
    store.navigate({ kind: 'board', regionScope: null });
    expect(store.activeDeskId).toBe(review);
    expect(store.location).toEqual({ kind: 'board', regionScope: review });

    store.home();
    expect(store.activeDeskId).toBe(main);
    expect(store.back()).toBe(true);
    expect(store.activeDeskId).toBe(review);
    store.dispose();
  });

  it('homes a window that lands on no desk onto the desk in view', () => {
    const store = canvas();
    store.setMode('pro');
    const review = store.createDesk({ name: 'Review' }) as string;
    const stray = noteTileId(store.addNote('late'));
    expect(store.deskOf(stray)).toBe(review);
    store.dispose();
  });

  it('brings a window from another desk as a visitor without moving it, and sends it home on a swap', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const home = { ...store.tileRect(note) };
    const review = store.createDesk({ name: 'Review' }) as string;

    expect(store.bringHere([note])).toEqual([note]);
    expect(store.visitors).toEqual([note]);
    // It is drawn on the desk in view, and its own desk and place are untouched.
    const drawn = store.tileRect(note);
    const desk = store.regionEntry(review)?.rect;
    expect(desk && rectContains(desk, drawn)).toBe(true);
    expect(store.layoutState.tiles[note]).toEqual(home);
    expect(store.deskOf(note)).toBe(main);
    // Review has no windows of its own, so the visitor fills it rather than floating.
    expect(store.visitorsFloating).toBe(false);
    // A window that is already here cannot visit.
    expect(store.bringHere([note])).toEqual([note]);
    expect(store.visitors).toEqual([note]);

    store.switchDesk(main);
    expect(store.visitors).toEqual([]);
    expect(store.tileRect(note)).toEqual(home);
    expect(store.bringHere([note])).toEqual([]);
    store.dispose();
  });

  it('floats visitors above a desk that has its own windows, and can keep or send them back', () => {
    const store = canvas();
    const mine = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' }) as string;
    const theirs = noteTileId(store.addNote('two'));
    expect(store.deskOf(theirs)).toBe(review);

    store.bringHere([mine]);
    expect(store.visitorsFloating).toBe(true);
    expect(store.sendBack()).toEqual([mine]);
    expect(store.visitors).toEqual([]);

    store.bringHere([mine]);
    expect(store.keepVisitors()?.ok).toBe(true);
    expect(store.visitors).toEqual([]);
    expect(store.deskOf(mine)).toBe(review);
    expect(store.desks.find((desk) => desk.regionId === main)?.windowCount).toBe(0);
    store.dispose();
  });

  it('removes a desk, moves its windows to the one before it, and keeps the last desk', () => {
    const store = canvas();
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' }) as string;
    const note = noteTileId(store.addNote('one'));
    expect(store.deskOf(note)).toBe(review);

    const removed = store.removeDesk(review);
    expect(removed.ok).toBe(true);
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main']);
    expect(store.activeDeskId).toBe(main);
    expect(store.deskOf(note)).toBe(main);
    // Nothing was closed: the window is still there.
    expect(store.noteEntries).toHaveLength(1);

    expect(store.removeDesk(main)).toEqual({
      ok: false,
      reason: 'That is the only desk. Make another one first.',
    });
    store.dispose();
  });

  it('stays on the desk, framed again, when a region inside it is dissolved', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.createDesk({ name: 'Other' });
    store.switchDesk(main);
    const inner = store.groupSelection([one, two], 'Inner') as string;
    expect(store.location).toEqual({ kind: 'board', regionScope: inner });
    expect(store.activeDeskId).toBe(main);

    store.runLayout([{ op: 'dissolveRegion', region: inner }], { source: 'command' });
    expect(store.location).toEqual({ kind: 'board', regionScope: main });
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: main });
    expect(store.deskOf(one)).toBe(main);
    store.dispose();
  });

  it('undoes a new desk completely, windows and desk', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review', members: [note] }) as string;
    expect(store.deskOf(note)).toBe(review);

    expect(store.undo()).toEqual({ label: expect.any(String), conflicts: 0 });
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main']);
    expect(store.deskOf(note)).toBe(main);
    expect(store.activeDeskId).toBe(main);
    store.dispose();
  });

  it('remembers the desk that was in view before, across a visit to a region on this one', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' }) as string;
    store.switchDesk(main);
    expect(store.previousDeskId).toBe(review);
    store.groupSelection([one, two], 'Inner');
    store.up();
    expect(store.activeDeskId).toBe(main);
    expect(store.previousDeskId).toBe(review);
    store.dispose();
  });

  it('fits a desk to the screen when it comes into view', () => {
    const store = canvas();
    store.addNote('one');
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.createDesk({ name: 'Review' });
    // The window shrinks while Main is out of view.
    store.setBoardSize(1200, 700);
    store.switchDesk(main);
    expect(store.regionEntry(main)?.rect).toMatchObject(
      deskRectSize({ width: 1200, height: 700 }, 1)
    );
    expect(store.deskViolations).toEqual([]);
    expect(store.deskLocked).toBe(true);
    store.dispose();
  });

  it('fits a region made at another size when it becomes the first desk', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.runLayout([{ op: 'createRegion', name: 'Review', members: [note] }], {
      source: 'command',
    });
    store.setBoardSize(1200, 700);
    store.setMode('pro');
    const review = deskNamed(store, 'Review');
    expect(store.regionEntry(review)?.rect).toMatchObject(
      deskRectSize({ width: 1200, height: 700 }, 1)
    );
    expect(store.deskViolations).toEqual([]);
    expect(store.deskLocked).toBe(true);
    store.dispose();
  });

  it('undoing the switch to Pro goes back to the classic canvas, and redo switches again', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    const before = { ...store.layoutState.tiles };
    store.setMode('pro');

    expect(store.undo()).toEqual({ label: 'Switched to Canvas Pro', conflicts: 0 });
    expect(store.proMode).toBe(false);
    expect(Object.keys(store.state.regions)).toEqual([]);
    expect(store.regionOf(one)).toBeNull();
    expect(store.layoutState.tiles).toEqual(before);

    expect(store.redo()).toEqual({ label: 'Switched to Canvas Pro', conflicts: 0 });
    expect(store.proMode).toBe(true);
    // One Main, holding both: nothing was made twice.
    expect(store.desks.map((desk) => `${desk.name}:${desk.windowCount}`)).toEqual(['Main:2']);
    expect(store.deskOf(two)).toBe(deskNamed(store, 'Main'));
    expect(store.activeDeskId).toBe(deskNamed(store, 'Main'));
    store.dispose();
  });

  it('frames the desk again on stepping out of a region on it', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const inner = store.groupSelection([one, two], 'Inner') as string;
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: inner });

    // A click on the desk outside the region: the camera is locked, so it has to be put back.
    expect(store.leaveScope()).toBe(true);
    expect(store.location).toEqual({ kind: 'board', regionScope: main });
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: main });
    store.dispose();
  });

  it('frames the desk again when it changes size under the camera', () => {
    const store = canvas();
    store.addNote('one');
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const pending = store.viewportCommand;
    if (pending) store.consumeViewportCommand(pending.id);
    expect(store.viewportCommand).toBeNull();

    // The window shrank; the desk is re-tiled to it by a layout change, not by navigation.
    store.setBoardSize(1200, 700);
    store.runLayout([{ op: 'fitRegion', region: main }], { source: 'command' });
    expect(store.regionEntry(main)?.rect).toMatchObject(
      deskRectSize({ width: 1200, height: 700 }, 1)
    );
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: main });
    store.dispose();
  });

  it('goes back out to the desk to focus a window outside the region in scope', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    const three = noteTileId(store.addNote('three'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.groupSelection([one, two], 'Inner');

    store.requestFocus(three);
    expect(store.location).toEqual({ kind: 'board', regionScope: main });
    expect(store.focusedTileId).toBe(three);
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', regionId: main });
    store.dispose();
  });

  it('keeps a pointer drop on the desk in view, even over where another desk lies', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const other = store.createDesk({ name: 'Other' }) as string;
    store.switchDesk(main);
    const hidden = store.regionEntry(other)?.rect;
    if (!hidden) throw new Error('no rect for the other desk');

    // Dropped right in the middle of the desk that is not drawn.
    expect(store.dropRegionAt({ x: hidden.x + hidden.w / 2, y: hidden.y + 80 })).toBe(main);
    store.dropNodes([{ id: note, x: hidden.x + 200, y: hidden.y + 40 }]);
    expect(store.deskOf(note)).toBe(main);
    store.dispose();
  });

  it('does not let selection commands reach a visitor', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const home = { ...store.layoutState.tiles[note] };
    const review = store.createDesk({ name: 'Review' }) as string;
    store.bringHere([note]);

    expect(store.groupSelection([note])).toBeNull();
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main', 'Review']);
    expect(store.activeDeskId).toBe(review);
    expect(store.deskOf(note)).toBe(main);
    expect(store.layoutState.tiles[note]).toEqual(home);
    store.dispose();
  });

  it('steps to the next desk from inside a region with nothing beside it', () => {
    const store = canvas();
    const one = noteTileId(store.addNote('one'));
    const two = noteTileId(store.addNote('two'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' }) as string;
    store.switchDesk(main);
    store.groupSelection([one, two], 'Inner');

    expect(store.stepDesk(1)).toBe(review);
    store.switchDesk(main);
    store.groupSelection([one, two], 'Inner again');
    expect(store.goToAdjacentRegion(1)).toBe(review);
    store.dispose();
  });

  it('never leaves the desk in view folded away', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.runLayout([{ op: 'createRegion', name: 'Review', members: [note] }], {
      source: 'command',
    });
    const review = Object.keys(store.state.regions)[0] as string;
    store.runLayout([{ op: 'collapseRegion', region: review, collapsed: true }], {
      source: 'command',
    });
    const made = store.runLayout(
      [{ op: 'createRegion', name: 'Other', members: [], parent: null }],
      { source: 'command' }
    );
    // Pro starts on the region the user was in, so Review stays folded for now.
    store.goToRegion((made.ok ? made.plan.created[0] : undefined) as string);
    store.setMode('pro');
    expect(store.activeDeskId).toBe(deskNamed(store, 'Other'));
    expect(store.state.regions[review]?.collapsed).toBe(true);

    // Coming into view unfolds it, as an undoable change.
    store.switchDesk(review);
    expect(store.state.regions[review]?.collapsed).toBe(false);
    // Undo would fold it again under the user; it must not stay that way.
    expect(store.undo()?.label).toMatch(/Expanded/);
    expect(store.activeDeskId).toBe(review);
    expect(store.state.regions[review]?.collapsed).toBe(false);
    store.dispose();
  });

  it('puts a window that appears during a stage of loose windows on the desk in view', () => {
    const store = canvas();
    const note = noteTileId(store.addNote('one'));
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.runLayout([{ op: 'renameRegion', region: main, name: 'Work' }], { source: 'command' });
    expect(store.enterStage({ kind: 'solo', tileId: note })).toBe(true);

    const late = noteTileId(store.addNote('late'));
    expect(store.desks.map((desk) => desk.name)).toEqual(['Work']);
    expect(store.deskOf(late)).toBe(main);
    store.dispose();
  });

  it('reorders desks', () => {
    const store = canvas();
    store.setMode('pro');
    const review = store.createDesk({ name: 'Review' }) as string;
    store.createDesk({ name: 'Ops' });
    expect(store.desks.map((desk) => desk.name)).toEqual(['Main', 'Review', 'Ops']);
    expect(store.reorderDesk(review, 'first').ok).toBe(true);
    expect(store.desks.map((desk) => desk.name)).toEqual(['Review', 'Main', 'Ops']);
    expect(store.desks.map((desk) => desk.index)).toEqual([0, 1, 2]);
    store.dispose();
  });

  it('shows one view only', () => {
    const store = canvas();
    store.setPaneCount(3);
    expect(store.paneCount).toBe(3);
    store.setMode('pro');
    expect(store.paneCount).toBe(1);
    store.setPaneCount(2);
    expect(store.paneCount).toBe(1);
    store.dispose();
  });
});

/** A window small enough that six notes fill a page: more than that pages the desk. */
function smallCanvas(): CanvasStore {
  const store = canvas();
  store.setBoardSize(700, 600);
  // Task frames take room around each pane; without them six notes fit this page exactly.
  store.setShowTaskFrames(false);
  return store;
}

function notes(store: CanvasStore, count: number): string[] {
  return Array.from({ length: count }, (_, index) => noteTileId(store.addNote(`note ${index}`)));
}

describe('CanvasStore desks are always full', () => {
  it('tiles a hand-arranged region when it becomes a desk, and undo gives the arrangement back', () => {
    const store = canvas();
    const tiles = notes(store, 3);
    store.runLayout([{ op: 'createRegion', name: 'Review', members: tiles }], {
      source: 'command',
    });
    const review = Object.keys(store.state.regions)[0] as string;
    // Dragged by hand on the classic canvas: the region stops tiling.
    const first = store.layoutState.tiles[tiles[0] as string];
    store.dropNodes([{ id: tiles[0] as string, x: (first?.x ?? 0) + 30, y: (first?.y ?? 0) + 40 }]);
    expect(store.state.regions[review]?.arrangement).toBe('free');
    const arranged = { ...store.layoutState.tiles };

    store.setMode('pro');
    expect(store.state.regions[review]?.arrangement).toBe('tiled');
    expect(store.deskViolations).toEqual([]);

    store.undo();
    expect(store.proMode).toBe(false);
    expect(store.state.regions[review]?.arrangement).toBe('free');
    expect(store.layoutState.tiles).toEqual(arranged);
    store.dispose();
  });

  it('frames the page at zoom 1, flush with the desk insets', () => {
    const store = canvas();
    notes(store, 2);
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const camera = store.frameViewportFor(main);
    const page = store.deskFrame;
    expect(camera?.zoom).toBe(1);
    expect((page?.x ?? 0) + (camera?.x ?? 0)).toBe(DESK_INSETS.left);
    expect((page?.y ?? 0) + (camera?.y ?? 0)).toBe(DESK_INSETS.top);
    expect(page).toMatchObject({ w: 1600 - 16, h: 900 - 64 });
    store.dispose();
  });

  it('a drop on the desk trades places and leaves it full', () => {
    const store = canvas();
    const [a, b] = notes(store, 2) as [string, string];
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const before = { a: store.tileRect(a), b: store.tileRect(b) };
    store.dropNodes([{ id: a, x: before.b.x + 10, y: before.b.y + 10 }]);
    expect(store.tileRect(a)).toEqual(before.b);
    expect(store.tileRect(b)).toEqual(before.a);
    expect(store.state.regions[main]?.arrangement).toBe('tiled');
    expect(store.deskViolations).toEqual([]);
    store.dispose();
  });

  it('a hand resize changes shares and leaves the desk full', () => {
    const store = canvas();
    const [a, b] = notes(store, 2) as [string, string];
    store.setMode('pro');
    const rect = store.tileRect(a);
    store.resizeTile(a, { ...rect, w: rect.w * 1.5 });
    expect(store.tileRect(a).w).toBeGreaterThan(store.tileRect(b).w);
    expect(store.deskViolations).toEqual([]);
    store.dispose();
  });

  it('repairs a desk that something other than the planner changed', () => {
    const store = canvas();
    const [a] = notes(store, 3) as [string];
    store.setMode('pro');
    // A raw write, as an older build or an undo of stale geometry would leave.
    store.setTileRect(a, { w: 120, h: 90 });
    expect(store.deskViolations).toEqual([]);
    expect(store.tileRect(a).w).toBeGreaterThan(120);
    store.dispose();
  });

  it('stays full when task frames are switched on and off', () => {
    const store = canvas();
    notes(store, 4);
    store.setMode('pro');
    store.setShowTaskFrames(true);
    expect(store.deskViolations).toEqual([]);
    store.setShowTaskFrames(false);
    expect(store.deskViolations).toEqual([]);
    store.dispose();
  });

  it('follows the window once a resize settles', () => {
    vi.useFakeTimers();
    try {
      const store = canvas();
      notes(store, 3);
      store.setMode('pro');
      const main = deskNamed(store, 'Main');
      store.setBoardSize(1200, 700);
      // Mid-resize the desk is left alone; the camera already follows the screen.
      expect(store.deskViolations).toContain('wrong-size');
      expect(store.frameViewportFor(main)?.zoom).toBe(1);
      vi.advanceTimersByTime(400);
      expect(store.deskViolations).toEqual([]);
      expect(store.regionEntry(main)?.rect).toMatchObject(
        deskRectSize({ width: 1200, height: 700 }, 1)
      );
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages a desk too full for one screen and brings the page of a focused window into view', () => {
    const store = smallCanvas();
    const tiles = notes(store, 8);
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    expect(store.deskPageCount).toBe(2);
    expect(store.deskPage).toBe(0);
    expect(store.deskPager.map((page) => page.windowCount)).toEqual([6, 2]);
    expect(store.deskViolations).toEqual([]);

    const onSecond = tiles.find((id) => store.pageOf(id) === 1) as string;
    store.requestFocus(onSecond);
    expect(store.deskPage).toBe(1);
    const desk = store.regionEntry(main)?.rect;
    expect(store.deskFrame).toEqual(deskPageBox(desk!, { width: 700, height: 600 }, 1));
    // The camera is one screen further down, still at zoom 1.
    expect(store.frameViewportFor(main)).toMatchObject({ zoom: 1 });
    expect(store.viewportCommand).toMatchObject({ kind: 'frame', instant: true });
    store.dispose();
  });

  it('steps through pages and falls back to the last one when windows close', () => {
    const store = smallCanvas();
    const ids = Array.from({ length: 8 }, (_, index) => store.addNote(`note ${index}`));
    store.setMode('pro');
    expect(store.stepDeskPage(-1)).toBe(false);
    expect(store.stepDeskPage(1)).toBe(true);
    expect(store.deskPage).toBe(1);
    expect(store.stepDeskPage(1)).toBe(false);
    // Two windows close: everything fits one page again, and that is the page in view.
    store.removeNote(ids[0] as string);
    store.removeNote(ids[1] as string);
    expect(store.deskPageCount).toBe(1);
    expect(store.deskPage).toBe(0);
    expect(store.deskViolations).toEqual([]);
    store.dispose();
  });

  it('remembers the page of each desk across a swap', () => {
    const store = smallCanvas();
    notes(store, 8);
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.setDeskPage(1);
    store.createDesk({ name: 'Review' });
    expect(store.deskPage).toBe(0);
    store.switchDesk(main);
    expect(store.deskPage).toBe(1);
    store.dispose();
  });

  it('shows visitors on the page in view', () => {
    const store = smallCanvas();
    const tiles = notes(store, 8);
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    store.createDesk({ name: 'Review' });
    store.switchDesk(main);
    store.runLayout(
      [
        {
          op: 'move',
          targets: [tiles[0] as string],
          to: { kind: 'region', region: deskNamed(store, 'Review') },
        },
      ],
      { source: 'command' }
    );
    store.setDeskPage(1);
    store.bringHere([tiles[0] as string]);
    const page = store.deskFrame!;
    expect(rectContains(page, store.tileRect(tiles[0] as string))).toBe(true);
    store.dispose();
  });

  it('undo after the window was resized still moves the window back and leaves both desks full', () => {
    vi.useFakeTimers();
    try {
      const store = canvas();
      const [a] = notes(store, 3) as [string];
      store.setMode('pro');
      const main = deskNamed(store, 'Main');
      const review = store.createDesk({ name: 'Review' }) as string;
      store.switchDesk(main);
      store.runLayout([{ op: 'move', targets: [a], to: { kind: 'region', region: review } }], {
        source: 'command',
      });
      expect(store.deskOf(a)).toBe(review);
      store.setBoardSize(1300, 800);
      vi.advanceTimersByTime(400);

      store.undo();
      expect(store.deskOf(a)).toBe(main);
      expect(store.deskViolations).toEqual([]);
      store.switchDesk(review);
      expect(store.deskViolations).toEqual([]);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaving Pro makes desks one-screen sub-canvases again, side by side', () => {
    const store = smallCanvas();
    notes(store, 8);
    store.setMode('pro');
    const main = deskNamed(store, 'Main');
    const review = store.createDesk({ name: 'Review' }) as string;
    expect(store.deskPageCount).toBe(1);

    store.setMode('classic');
    const a = store.regionEntry(main)?.rect;
    const b = store.regionEntry(review)?.rect;
    expect(a && b).toBeTruthy();
    const overlap =
      Math.min(a!.x + a!.w, b!.x + b!.w) > Math.max(a!.x, b!.x) &&
      Math.min(a!.y + a!.h, b!.y + b!.h) > Math.max(a!.y, b!.y);
    expect(overlap).toBe(false);
    // Every window sits inside its region, below the header the classic canvas draws.
    for (const [id, rect] of Object.entries(store.layoutState.tiles)) {
      const region = store.regionEntry(store.regionOf(id) ?? '')?.rect;
      if (region) expect(rectContains(region, rect)).toBe(true);
    }
    store.dispose();
  });
});
