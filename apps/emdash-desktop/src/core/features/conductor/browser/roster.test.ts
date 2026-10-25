import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import type { WorkbenchView } from '../api/focus';
import {
  agentFact,
  buildContext,
  buildRoster,
  currentFocus,
  focusedConversationId,
  seedWorkbenchView,
  workingStatus,
} from './roster';

vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({ agentMetadata: vi.fn(async () => []) }));

function agent(id: string, taskId: string, projectId = 'p1'): AgentTileEntry {
  return {
    tileId: `agent:${id}`,
    conversationId: id,
    taskId,
    projectId,
    projectName: projectId === 'p1' ? 'chorus' : 'website',
    taskName: `task ${taskId}`,
    providerId: 'claude',
    conversationTitle: '',
    type: 'pty',
    status: 'working',
    seen: true,
    notificationType: null,
    sessionActive: true,
    linesAdded: 0,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
  } as unknown as AgentTileEntry;
}

const NAMES: Record<string, string> = { a: 'Atlas', b: 'Bravo', c: 'Cedar' };

function fakeCanvas(overrides: Partial<Record<keyof CanvasStore, unknown>> = {}): CanvasStore {
  const entries = [agent('a', 't1'), agent('b', 't2', 'p2'), agent('c', 't2', 'p2')];
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    visibleBrowserEntries: [],
    projectOptions: [
      { id: 'p1', name: 'chorus' },
      { id: 'p2', name: 'website' },
    ],
    projectFilter: null,
    regionEntries: [],
    layoutWindows: [],
    selection: [],
    lastChange: null,
    focusedTileId: null,
    focusedRegionId: null,
    multiCanvas: false,
    stageActive: false,
    location: { kind: 'board', regionScope: null },
    spokenName: (id: string) => NAMES[id] ?? id,
    formerNamesOf: () => [],
    departedNames: [],
    entryForTile: (tileId: string) => entries.find((entry) => entry.tileId === tileId),
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    ...overrides,
  } as unknown as CanvasStore;
}

function show(view: WorkbenchView): void {
  seedWorkbenchView(() => view);
}

function taskView(taskId: string, activeChatId: string | null, projectId = 'p2'): WorkbenchView {
  return {
    kind: 'task',
    projectId,
    taskId,
    activeChatId,
    visibleChatIds: activeChatId ? [activeChatId] : [],
  };
}

afterEach(() => show({ kind: 'canvas' }));

describe('the focused agent', () => {
  it('follows the view on screen from one turn to the next', () => {
    const canvas = fakeCanvas({ focusedTileId: 'agent:a' });
    expect(focusedConversationId(canvas)).toBe('a');

    // The developer opens Bravo's chat in the task view: the canvas focus no longer counts.
    show(taskView('t2', 'b'));
    expect(currentFocus(canvas)).toMatchObject({ agentId: 'b', surface: 'task-view' });

    // They switch to Cedar's tab, then to settings, then back to the canvas.
    show(taskView('t2', 'c'));
    expect(focusedConversationId(canvas)).toBe('c');
    show({ kind: 'other', viewId: 'settings' });
    expect(focusedConversationId(canvas)).toBeNull();
    show({ kind: 'canvas' });
    expect(focusedConversationId(canvas)).toBe('a');
  });

  it('is not picked between the agents of a task whose view shows a file', () => {
    const canvas = fakeCanvas({ focusedTileId: 'agent:a' });
    show(taskView('t2', null));
    expect(focusedConversationId(canvas)).toBeNull();
    show(taskView('t1', null, 'p1'));
    expect(focusedConversationId(canvas)).toBe('a');
  });

  it('is the window on the stage, not the one focused on the board underneath', () => {
    const canvas = fakeCanvas({
      focusedTileId: 'agent:a',
      stageActive: true,
      stageTileIds: ['agent:b', 'agent:c'],
      stageSaved: { order: [], trees: {}, soloTileId: 'agent:c' },
    });
    expect(currentFocus(canvas)).toMatchObject({ agentId: 'c', surface: 'stage' });
  });

  it('drops a canvas focus on an agent the project filter took off the board', () => {
    const canvas = fakeCanvas({ focusedTileId: 'agent:a', isOffBoard: () => true });
    expect(focusedConversationId(canvas)).toBeNull();
  });

  it('notes a focused window that is outside the region in view', () => {
    const canvas = fakeCanvas({
      focusedTileId: 'agent:a',
      focusedRegionId: 'region:r',
      windowName: () => 'Backend',
    });
    expect(currentFocus(canvas).why).toContain('outside region Backend');
    const inside = fakeCanvas({
      focusedTileId: 'agent:a',
      focusedRegionId: 'region:r',
      regionOf: (id: string) => (id === 'agent:a' ? 'region:r' : null),
      windowName: () => 'Backend',
    });
    expect(currentFocus(inside).why).toBe('its window is focused, in region Backend');
  });
});

describe('other titles', () => {
  /** A canvas whose agents carry the given spoken names and conversation titles. */
  function titled(agents: Record<string, { name: string; title: string }>): CanvasStore {
    const entries = Object.entries(agents).map(([id, { title }]) => ({
      ...agent(id, `t-${id}`),
      conversationTitle: title,
    }));
    return fakeCanvas({
      agentEntries: entries,
      visibleAgentEntries: entries,
      spokenName: (id: string) => agents[id]?.name ?? id,
    });
  }
  const titles = (canvas: CanvasStore) =>
    Object.fromEntries(buildRoster(canvas).map((entry) => [entry.name, entry.title]));

  it('carries the names an agent was renamed from, and the names of agents that left', () => {
    const canvas = fakeCanvas({
      // Atlas was called Backend, and before that Bravo, which another agent is called now.
      formerNamesOf: (id: string) => (id === 'a' ? ['Backend', 'bravo'] : []),
      departedNames: ['Zulu'],
    });
    const roster = buildRoster(canvas);
    expect(roster.find((entry) => entry.name === 'Atlas')?.formerly).toEqual(['Backend']);
    expect(roster.find((entry) => entry.name === 'Bravo')?.formerly).toBeUndefined();
    expect(roster.departed).toEqual(['Zulu']);
    expect(buildContext(canvas, [])).toContain('- Atlas (Claude, until just now called "Backend")');
  });

  it('offers a title only when saying it could mean no other agent', () => {
    const canvas = titled({
      a: { name: 'Kilo 3', title: 'Vesper 3' },
      // Another agent is really called Atlas 3, and "Atlas" alone means that one.
      b: { name: 'Jasper 3', title: 'Atlas' },
      c: { name: 'Atlas 3', title: 'Atlas 3' },
      // Lima's title is somebody's name, however it is written.
      d: { name: 'Lima', title: 'kilo-3' },
    });
    expect(titles(canvas)).toEqual({
      'Kilo 3': 'Vesper 3',
      'Jasper 3': undefined,
      'Atlas 3': undefined,
      Lima: undefined,
    });
  });

  it('drops a title that two agents share', () => {
    const canvas = titled({
      a: { name: 'Bravo', title: 'Vesper' },
      b: { name: 'Cedar', title: 'vesper' },
    });
    expect(titles(canvas)).toEqual({ Bravo: undefined, Cedar: undefined });
  });

  it('warns the conductor about names that differ only by number', () => {
    const canvas = titled({
      a: { name: 'Atlas', title: '' },
      b: { name: 'Atlas 3', title: '' },
      c: { name: 'Bravo', title: '' },
    });
    expect(buildContext(canvas, [])).toContain(
      'Names that differ only by number (different agents; ask when the number is unclear): Atlas / Atlas 3'
    );
    expect(buildContext(fakeCanvas(), [])).not.toContain('differ only by number');
  });
});

describe('buildContext', () => {
  it('states the focus, its surface, and the project of the view on screen', () => {
    const canvas = fakeCanvas({ focusedTileId: 'agent:a' });
    const onCanvas = buildContext(canvas, []);
    expect(onCanvas).toContain('Focused agent: Atlas (canvas: its window is focused)');
    expect(onCanvas).toContain('- Atlas (Claude, focused)');
    expect(onCanvas).toContain('Canvas view: the whole board.');

    show(taskView('t2', 'b'));
    const inTaskView = buildContext(canvas, []);
    expect(inTaskView).toContain('Focused agent: Bravo (task view: its chat is the active tab)');
    expect(inTaskView).toContain('- Bravo (Claude, focused)');
    expect(inTaskView).not.toContain('- Atlas (Claude, focused)');
    expect(inTaskView).toContain("website (the focused agent's project)");
    expect(inTaskView).toContain('Canvas view (not on screen now): the whole board.');

    show(taskView('t2', null));
    const onFile = buildContext(canvas, []);
    expect(onFile).toContain('Focused agent: none (task view:');
    expect(onFile).toContain('Bravo, Cedar');
    expect(onFile).toContain('website (its view is on screen)');
  });
});

describe('a working agent waiting on subagents', () => {
  it('says how many it is waiting on', () => {
    expect(workingStatus({ backgroundAgents: 6 })).toBe('working, waiting on 6 sub-agents');
    expect(workingStatus({ backgroundAgents: 1 })).toBe('working, waiting on 1 sub-agent');
    expect(workingStatus({})).toBe('working');
  });

  it('reads that way in the per-turn context', () => {
    const canvas = fakeCanvas();
    expect(agentFact(canvas, { ...agent('a', 't1'), backgroundAgents: 6 }).status).toBe(
      'working, waiting on 6 sub-agents'
    );
    expect(agentFact(canvas, agent('b', 't2')).status).toBe('working');
  });
});
