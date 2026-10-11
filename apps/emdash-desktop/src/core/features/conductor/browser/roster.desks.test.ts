import { describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
  DeskEntry,
  RegionEntry,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { buildCanvasRefContext, buildContext, currentFocus, vocabulary } from './roster';

vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({ agentMetadata: vi.fn(async () => []) }));

// The conductor's context in Canvas Pro: three desks (Main, Review, Triage), Review in view with
// a region on it. Atlas is on Review, Bravo in the region, Cedar on Main.

const NAMES: Record<string, string> = {
  a: 'Atlas',
  b: 'Bravo',
  c: 'Cedar',
  'agent:a': 'Atlas',
  'agent:b': 'Bravo',
  'agent:c': 'Cedar',
  'region:main': 'Main',
  'region:review': 'Review',
  'region:triage': 'Triage',
  'region:pair': 'Pair',
};
const PARENTS: Record<string, string | null> = {
  'agent:a': 'region:review',
  'agent:b': 'region:pair',
  'agent:c': 'region:main',
  'region:pair': 'region:review',
};

function agent(id: string): AgentTileEntry {
  return {
    tileId: `agent:${id}`,
    conversationId: id,
    taskId: `task-${id}`,
    projectId: 'p1',
    projectName: 'chorus',
    taskName: `task ${id}`,
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

function desk(regionId: string, index: number, extra: Partial<DeskEntry> = {}): DeskEntry {
  return {
    regionId,
    name: NAMES[regionId] ?? regionId,
    index,
    color: undefined,
    active: false,
    windowCount: 0,
    waiting: 0,
    working: 0,
    failed: 0,
    summary: '',
    gather: null,
    ...extra,
  };
}

function region(regionId: string, parentId: string | null): RegionEntry {
  return {
    regionId,
    name: NAMES[regionId] ?? regionId,
    parentId,
    collapsed: false,
    summary: '',
  } as unknown as RegionEntry;
}

function deskOf(id: string): string | null {
  let current: string | null = id;
  while (current && PARENTS[current]) current = PARENTS[current] ?? null;
  return current?.startsWith('region:') ? current : null;
}

function proCanvas(overrides: Partial<Record<keyof CanvasStore, unknown>> = {}): CanvasStore {
  const entries = [agent('a'), agent('b'), agent('c')];
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    visibleBrowserEntries: [],
    projectOptions: [{ id: 'p1', name: 'chorus' }],
    projectFilter: null,
    proMode: true,
    desks: [
      desk('region:main', 0, { windowCount: 1 }),
      desk('region:review', 1, {
        active: true,
        windowCount: 2,
        waiting: 1,
        working: 1,
        summary: '1 needs you · 1 working',
      }),
      desk('region:triage', 2, { gather: 'needs-you' }),
    ],
    activeDeskId: 'region:review',
    visitors: [],
    regionEntries: [
      region('region:main', null),
      region('region:review', null),
      region('region:triage', null),
      region('region:pair', 'region:review'),
    ],
    layoutState: {
      regions: {
        'region:main': { createdAt: 1 },
        'region:review': { createdAt: 3 },
        'region:triage': { createdAt: 2 },
        'region:pair': { createdAt: 9 },
      },
    },
    layoutWindows: entries.map((entry) => ({
      tileId: entry.tileId,
      kind: 'agent',
      name: NAMES[entry.tileId],
    })),
    selection: [],
    lastChange: null,
    focusedTileId: null,
    focusedRegionId: 'region:review',
    multiCanvas: false,
    stageActive: false,
    newestRegionId: 'region:pair',
    previousRegionId: 'region:main',
    location: { kind: 'board', regionScope: 'region:review' },
    currentRegion: () => 'region:review',
    visibleTileIds: () => new Set(entries.map((entry) => entry.tileId)),
    spokenName: (id: string) => NAMES[id] ?? id,
    formerNamesOf: () => [],
    departedNames: [],
    entryForTile: (tileId: string) => entries.find((entry) => entry.tileId === tileId),
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: (id: string) => PARENTS[id] ?? null,
    deskOf,
    windowName: (id: string) => NAMES[id] ?? id,
    ...overrides,
  } as unknown as CanvasStore;
}

describe('the context in Canvas Pro', () => {
  it('states the mode, the desks in order, and where the view is', () => {
    const context = buildContext(proCanvas(), []);
    expect(context).toContain('Canvas: Pro.');
    expect(context).toContain(
      'Desks, in order (* is the one in view): Main (1), Review* (2, 1 needs you, 1 working), Triage (gathers needs you)'
    );
    expect(context).toContain('Canvas view: desk Review.');
    // Desks are in the Desks line; only the regions on them are listed as regions.
    expect(context).toContain('Regions on desks (named areas grouping windows):');
    expect(context).toContain('- Pair inside Review: Bravo');
    expect(context).not.toContain('- Review:');
    expect(context).not.toContain('the whole board');
  });

  it("gives each agent's desk, and its region when it is in one", () => {
    const context = buildContext(proCanvas(), []);
    expect(context).toMatch(/- Atlas \(Claude\): .*; on desk Review$/m);
    expect(context).toMatch(/- Bravo \(Claude\): .*; in region Pair; on desk Review$/m);
    expect(context).toMatch(/- Cedar \(Claude\): .*; on desk Main$/m);
  });

  it('says when the view is a region on a desk, and who is visiting', () => {
    const context = buildContext(
      proCanvas({
        currentRegion: () => 'region:pair',
        focusedRegionId: 'region:pair',
        visitors: ['agent:c'],
      }),
      []
    );
    expect(context).toContain('Canvas view: region Pair on desk Review.');
    expect(context).toContain('Visiting the desk in view from other desks: Cedar');
  });

  it('reads the focus against the desk in view, counting a visitor as on it', () => {
    expect(currentFocus(proCanvas({ focusedTileId: 'agent:a' })).why).toBe(
      'its window is focused, on desk Review'
    );
    expect(currentFocus(proCanvas({ focusedTileId: 'agent:c' })).why).toContain(
      'outside desk Review'
    );
    expect(currentFocus(proCanvas({ focusedTileId: 'agent:c', visitors: ['agent:c'] })).why).toBe(
      'its window is focused, on desk Review'
    );
  });
});

describe('the canvas reference context in Canvas Pro', () => {
  it('carries the desks in order, the one in view, the newest, and the visitors', () => {
    expect(buildCanvasRefContext(proCanvas({ visitors: ['agent:c'] })).desks).toEqual({
      order: ['region:main', 'region:review', 'region:triage'],
      active: 'region:review',
      // The newest desk, not the newest region: Pair was made later but is on a desk.
      newest: 'region:review',
      visitors: ['agent:c'],
    });
  });

  it('has no desks on the classic canvas', () => {
    expect(buildCanvasRefContext(proCanvas({ proMode: false })).desks).toBeUndefined();
  });
});

describe('the speech vocabulary in Canvas Pro', () => {
  it('expects desk names and the word desk', () => {
    const words = vocabulary(proCanvas());
    expect(words).toEqual(expect.arrayContaining(['Review', 'Triage', 'desk']));
    expect(vocabulary(proCanvas({ proMode: false }))).not.toContain('desk');
  });
});
