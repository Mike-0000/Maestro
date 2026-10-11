import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore, noteTileId } from '@core/features/canvas/api/browser/stores/canvas-store';
import {
  canvasBoardMemento,
  type CanvasBoardState,
} from '@core/features/canvas/contributions/mementos';
import type { ProjectManagerStore } from '@core/features/projects/api/browser/stores/project-manager';
import type { MementoHandle } from '@core/primitives/mementos/browser';
import { DESKS_NEED_PRO } from '../api/canvas-desk-ops';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import type { ToolOutcome } from '../api/tools';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';

// Desks (Canvas Pro) through the conductor, against a real canvas store: what `canvas_desks` and
// the spoken desk commands do to the board, what they answer, and that every change to the layout
// is a spoken one (so it previews, and the HUD offers to undo it).

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: vi.fn(),
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => status()),
  }),
}));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: vi.fn(),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(() => null),
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(async () => false),
}));
vi.mock('./focus-spawned-agent', () => ({ focusSpawnedAgent: vi.fn(() => () => {}) }));
vi.mock('./agent-io', () => ({
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => ''),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: vi.fn(),
  stopAgentSession: vi.fn(),
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function status(): ConductorStatus {
  return {
    configured: false,
    jevReady: false,
    settings: DEFAULT_CONDUCTOR_SETTINGS,
  } as unknown as ConductorStatus;
}

/** An in-memory memento, so the canvas runs with its layout tracking as it does in the app. */
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

function voice(): ConductorVoicePort {
  return {
    muted: false,
    say: vi.fn(),
    announce: vi.fn(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
  };
}

/**
 * A canvas with three notes standing in for windows (they are windows to the layout), spoken as
 * "note alpha", "note bravo", and "note cedar".
 */
function setup(mode: 'classic' | 'pro' = 'pro') {
  const canvas = new CanvasStore({ projects: new Map() } as unknown as ProjectManagerStore);
  canvas.attachMemento(memento(canvasBoardMemento.default));
  canvas.setBoardSize(1600, 900);
  const [alpha, bravo, cedar] = ['alpha', 'bravo', 'cedar'].map((text) =>
    noteTileId(canvas.addNote(text))
  ) as [string, string, string];
  if (mode === 'pro') canvas.setMode('pro');
  const speech = voice();
  const store = new ConductorStore(canvas, speech);
  store.status = status();
  // Previews run at once instead of waiting out their countdown.
  const pending = vi.fn(async (_label: string, _kind: 'countdown' | 'confirm' | null) => true);
  store['requestPending'] = pending;
  const desks = (input: Record<string, unknown>): Promise<ToolOutcome> =>
    store['executeTool']('canvas_desks', input);
  const tool = (name: string, input: Record<string, unknown> = {}): Promise<ToolOutcome> =>
    store['executeTool'](name, input);
  const deskNamed = (name: string): string => {
    const desk = canvas.desks.find((candidate) => candidate.name === name);
    if (!desk) throw new Error(`No desk called ${name}`);
    return desk.regionId;
  };
  const names = () => canvas.desks.map((desk) => desk.name);
  const inView = () => canvas.desks.find((desk) => desk.active)?.name ?? null;
  return {
    canvas,
    store,
    speech,
    pending,
    desks,
    tool,
    deskNamed,
    names,
    inView,
    alpha,
    bravo,
    cedar,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('canvas_desks', () => {
  it('needs Canvas Pro for everything but switching to it', async () => {
    const { canvas, desks } = setup('classic');
    expect(await desks({ action: 'switch', desk: 'next' })).toEqual({
      content: DESKS_NEED_PRO,
      isError: true,
    });
    expect(await desks({ action: 'create', name: 'Review' })).toMatchObject({ isError: true });
    expect(canvas.proMode).toBe(false);

    const entered = await desks({ action: 'set_mode', mode: 'pro' });
    expect(entered.isError).toBeUndefined();
    expect(entered.content).toBe(
      'Canvas Pro, 1 desk; 3 loose windows went to Main. You are on Main.'
    );
    expect(canvas.proMode).toBe(true);
    expect(await desks({ action: 'set_mode', mode: 'pro' })).toEqual({
      content: 'The canvas is already in Canvas Pro.',
    });
    expect((await desks({ action: 'set_mode', mode: 'classic' })).content).toContain('classic');
    expect(canvas.proMode).toBe(false);
  });

  it('makes a desk with windows, switches to it, and leaves a spoken change to undo', async () => {
    const { canvas, desks, names, inView, deskNamed, alpha, bravo, cedar } = setup();
    const made = await desks({
      action: 'create',
      name: 'Review',
      windows: ['note alpha', 'note bravo'],
    });
    expect(made).toEqual({ content: 'Made desk Review with note "alpha" and note "bravo".' });
    expect(names()).toEqual(['Main', 'Review']);
    expect(inView()).toBe('Review');
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Review'));
    expect(canvas.deskOf(bravo)).toBe(deskNamed('Review'));
    expect(canvas.deskOf(cedar)).toBe(deskNamed('Main'));
    // The HUD's undo line shows for spoken changes, under the same words as the reply.
    expect(canvas.lastChange).toMatchObject({ source: 'voice', label: made.content });
    expect(canvas.undoLabel).toBe(made.content);

    // Undo puts the windows back where they lived.
    canvas.undo();
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Main'));
    expect(canvas.deskOf(bravo)).toBe(deskNamed('Main'));
  });

  it('stays on the desk in view when asked not to follow', async () => {
    const { canvas, desks, names, inView, deskNamed } = setup();
    const made = await desks({ action: 'create', name: 'Scratch', follow: false });
    expect(made.content).toBe('Made desk Scratch. You are still on Main.');
    expect(names()).toEqual(['Main', 'Scratch']);
    expect(inView()).toBe('Main');
    // The camera is put back on the desk in view, not left chasing the new one.
    expect(canvas.viewportCommand).toMatchObject({ kind: 'frame', regionId: deskNamed('Main') });
  });

  it('makes a gathering desk and says what it shows', async () => {
    const { canvas, desks, inView } = setup();
    const made = await desks({ action: 'create', gather: 'needs-you' });
    expect(made.content).toBe('Made desk Triage; it shows every window that needs you.');
    expect(inView()).toBe('Triage');
    expect(canvas.desks.find((desk) => desk.name === 'Triage')?.gather).toBe('needs-you');
    // Nothing waits, so arriving there says so.
    await desks({ action: 'switch', desk: 'Main' });
    expect(await desks({ action: 'switch', desk: 'Triage' })).toEqual({
      content: 'On Triage. Nothing needs you now.',
    });
  });

  it('switches desks and answers with what is there', async () => {
    const { desks, inView } = setup();
    await desks({ action: 'create', name: 'Review', windows: ['note alpha'] });
    expect(await desks({ action: 'switch', desk: 'previous' })).toEqual({
      content: 'On Main, 2 windows.',
    });
    expect(inView()).toBe('Main');
    expect(await desks({ action: 'switch', desk: 'last' })).toEqual({
      content: 'On Review, 1 window.',
    });
    expect(await desks({ action: 'switch', desk: '1' })).toEqual({
      content: 'On Main, 2 windows.',
    });
    expect(await desks({ action: 'switch', desk: 'Billing' })).toEqual({
      content: 'No desk called "Billing". Desks: Main, Review.',
      isError: true,
    });
    expect(inView()).toBe('Main');
  });

  it('moves windows to another desk, and follows only when asked', async () => {
    const { canvas, desks, inView, deskNamed, alpha, bravo, cedar } = setup();
    await desks({ action: 'create', name: 'Review', follow: false });
    const moved = await desks({ action: 'move_windows', windows: ['note alpha'], desk: 'Review' });
    expect(moved).toEqual({ content: 'Moved note "alpha" to Review.' });
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Review'));
    expect(inView()).toBe('Main');
    expect(canvas.viewportCommand).toMatchObject({ kind: 'frame', regionId: deskNamed('Main') });
    expect(canvas.lastChange).toMatchObject({ source: 'voice', label: moved.content });

    const followed = await desks({
      action: 'move_windows',
      windows: ['note bravo', 'note alpha'],
      desk: 'Review',
      follow: true,
    });
    expect(followed.content).toBe(
      'Moved note "bravo" to Review. note "alpha" is already on Review.'
    );
    expect(canvas.deskOf(bravo)).toBe(deskNamed('Review'));
    expect(inView()).toBe('Review');
    expect(canvas.deskOf(cedar)).toBe(deskNamed('Main'));
  });

  it('removes the desk in view after a preview, and its heir comes into view', async () => {
    const { canvas, desks, pending, names, inView, deskNamed, alpha } = setup();
    await desks({ action: 'create', name: 'Scratch', windows: ['note alpha'] });
    expect(inView()).toBe('Scratch');
    const removed = await desks({ action: 'remove' });
    expect(removed).toEqual({ content: 'Removed Scratch; note "alpha" went to Main.' });
    // A desk with windows on it is previewed first, under the words of the reply.
    expect(pending).toHaveBeenCalledWith(removed.content, 'countdown');
    expect(names()).toEqual(['Main']);
    expect(inView()).toBe('Main');
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Main'));
    expect(canvas.visibleTileIds().has(alpha)).toBe(true);

    expect(await desks({ action: 'remove' })).toEqual({
      content: 'That is the only desk. Make another one first.',
      isError: true,
    });
    expect(names()).toEqual(['Main']);
  });

  it("sends a removed desk's windows to the named desk", async () => {
    const { canvas, desks, names, inView, deskNamed, alpha } = setup();
    await desks({ action: 'create', name: 'Review', follow: false });
    await desks({ action: 'create', name: 'Scratch', windows: ['note alpha'], follow: false });
    const removed = await desks({ action: 'remove', desk: 'Scratch', into: 'Review' });
    expect(removed.content).toBe('Removed Scratch; note "alpha" went to Review.');
    expect(names()).toEqual(['Main', 'Review']);
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Review'));
    // The desk in view was not the one removed, so the view stays.
    expect(inView()).toBe('Main');
  });

  it('cancels with the preview and changes nothing', async () => {
    const { desks, pending, names } = setup();
    await desks({ action: 'create', name: 'Scratch', windows: ['note alpha'] });
    pending.mockResolvedValueOnce(false);
    expect(await desks({ action: 'remove' })).toEqual({
      content: 'The user cancelled the change.',
    });
    expect(names()).toEqual(['Main', 'Scratch']);
  });

  it('renames and reorders desks', async () => {
    const { desks, names } = setup();
    await desks({ action: 'create', name: 'Review', follow: false });
    expect(await desks({ action: 'rename', name: 'Home' })).toEqual({
      content: 'Renamed Main to Home.',
    });
    expect(await desks({ action: 'reorder', desk: 'Review', position: 'first' })).toEqual({
      content: 'Review is now desk 1 of 2.',
    });
    expect(names()).toEqual(['Review', 'Home']);
    expect(await desks({ action: 'rename', desk: 'Home', name: 'Review' })).toMatchObject({
      isError: true,
    });
  });

  it('brings a window to visit, sends it back, and keeps it for good', async () => {
    const { canvas, desks, deskNamed, alpha } = setup();
    await desks({ action: 'create', name: 'Review', windows: ['note alpha'], follow: false });

    expect(await desks({ action: 'bring', windows: ['note alpha'] })).toEqual({
      content: 'note "alpha" is visiting from Review.',
    });
    expect(canvas.visitors).toEqual([alpha]);
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Review'));
    expect(await desks({ action: 'bring', windows: ['note bravo'] })).toEqual({
      content: 'note "bravo" is already on this desk.',
    });

    expect(await desks({ action: 'send_back' })).toEqual({
      content: 'Sent note "alpha" back to Review.',
    });
    expect(canvas.visitors).toEqual([]);
    expect(await desks({ action: 'send_back' })).toEqual({
      content: 'Nothing is visiting this desk.',
    });

    await desks({ action: 'bring', windows: ['note alpha'] });
    const kept = await desks({ action: 'keep', windows: ['note alpha'] });
    expect(kept).toEqual({ content: 'note "alpha" lives on Main now.' });
    expect(canvas.visitors).toEqual([]);
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Main'));
    // Keeping moves the window, so it is undone like any spoken change.
    expect(canvas.lastChange).toMatchObject({ source: 'voice', label: kept.content });
    canvas.undo();
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Review'));
  });
});

describe('the other canvas tools in Canvas Pro', () => {
  it('describes the mode, the desks in order, and the desk in view', async () => {
    const { desks, tool } = setup();
    await desks({ action: 'create', name: 'Review', windows: ['note alpha'], follow: false });
    await desks({ action: 'create', name: 'Triage', gather: 'needs-you', follow: false });
    const described = (await tool('describe_canvas')).content.split('\n');
    expect(described.slice(0, 5)).toEqual([
      'Canvas Pro: one desk shows at a time. On desk Main.',
      'Desks, in order:',
      '1. Main (in view): note "bravo", note "cedar".',
      '2. Review: note "alpha".',
      '3. Triage (gathers needs you): no windows.',
    ]);
  });

  it('has no canvas above a desk to leave for', async () => {
    const { tool, inView } = setup();
    expect(await tool('canvas_view', { action: 'leave_region' })).toEqual({
      content: 'You are on Main. Say which desk to switch to.',
      isError: true,
    });
    expect(await tool('canvas_view', { action: 'next_region' })).toEqual({
      content: 'There is only one desk.',
      isError: true,
    });
    expect((await tool('canvas_view', { action: 'home' })).content).toBe(
      'Canvas Pro has no main canvas. On Main, 3 windows.'
    );
    expect(inView()).toBe('Main');
  });

  it('goes to a desk by name or as "the X desk", without a way back to a main canvas', async () => {
    const { desks, tool, inView } = setup();
    await desks({ action: 'create', name: 'Review', windows: ['note alpha'], follow: false });
    expect(
      await tool('canvas_view', { action: 'go_to_region', windows: ['the Review desk'] })
    ).toEqual({ content: 'On Review, 1 window.' });
    expect(inView()).toBe('Review');
  });

  it('puts a region made by arrange_canvas on the desk in view, not beside the desks', async () => {
    const { canvas, tool, names, deskNamed } = setup();
    const made = await tool('arrange_canvas', { steps: [{ op: 'group', name: 'Pair' }] });
    expect(made.isError).toBe(false);
    expect(names()).toEqual(['Main']);
    const pair = canvas.regionEntries.find((region) => region.name === 'Pair');
    expect(pair?.parentId).toBe(deskNamed('Main'));
  });

  it('dissolving a desk through arrange_canvas sends its windows to the desk before it', async () => {
    const { canvas, desks, tool, names, deskNamed, alpha } = setup();
    await desks({ action: 'create', name: 'Scratch', windows: ['note alpha'], follow: false });
    await tool('arrange_canvas', { steps: [{ op: 'dissolve_region', region: 'Scratch' }] });
    expect(names()).toEqual(['Main']);
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Main'));
    // One step: undoing it brings the desk back with its window on it.
    canvas.undo();
    expect(names()).toEqual(['Main', 'Scratch']);
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Scratch'));

    const last = await tool('arrange_canvas', {
      steps: [{ op: 'dissolve_region', region: 'Main' }],
    });
    expect(names()).toEqual(['Scratch']);
    expect(last.isError).toBe(false);
    expect(
      await tool('arrange_canvas', { steps: [{ op: 'dissolve_region', region: 'Scratch' }] })
    ).toEqual({ content: 'That is the only desk. Make another one first.', isError: true });
  });
});

describe('spoken desk commands', () => {
  it('runs them without the model and keeps a visible change quiet', async () => {
    const { store, speech, names, inView } = setup();
    await store.handleUtterance('new desk called Review with note alpha', 'voice');
    expect(names()).toEqual(['Main', 'Review']);
    expect(inView()).toBe('Review');
    expect(store.reply).toBe('Made desk Review with note "alpha".');
    expect(store.lastRoute).toBe('grammar');

    await store.handleUtterance('previous desk', 'voice');
    expect(inView()).toBe('Main');
    expect(store.reply).toBe('On Main, 2 windows.');
    // The eyes confirm both, so neither is said aloud.
    expect(speech.say).not.toHaveBeenCalled();
  });

  it('speaks what the eyes cannot confirm', async () => {
    const { store, speech, inView } = setup();
    await store.handleUtterance('leave this desk', 'voice');
    expect(store.reply).toBe('You are on Main. Say which desk to switch to.');
    expect(speech.say).toHaveBeenLastCalledWith(store.reply, expect.any(String));

    await store.handleUtterance('next desk', 'voice');
    expect(store.reply).toBe('There is only one desk.');
    expect(inView()).toBe('Main');
  });

  it('switches the canvas mode both ways', async () => {
    const { canvas, store } = setup('classic');
    await store.handleUtterance('switch to Canvas Pro', 'typed');
    expect(canvas.proMode).toBe(true);
    expect(store.reply).toBe('Canvas Pro, 1 desk; 3 loose windows went to Main. You are on Main.');
    await store.handleUtterance('go back to the classic canvas', 'typed');
    expect(canvas.proMode).toBe(false);
  });

  it('brings a visitor and keeps it with "keep it here"', async () => {
    const { canvas, store, desks, deskNamed, alpha } = setup();
    await desks({ action: 'create', name: 'Review', windows: ['note alpha'], follow: false });
    await store.handleUtterance('bring note alpha here', 'typed');
    expect(store.reply).toBe('note "alpha" is visiting from Review.');
    expect(canvas.visitors).toEqual([alpha]);
    await store.handleUtterance('keep it here', 'typed');
    expect(store.reply).toBe('note "alpha" lives on Main now.');
    expect(canvas.deskOf(alpha)).toBe(deskNamed('Main'));
  });
});
