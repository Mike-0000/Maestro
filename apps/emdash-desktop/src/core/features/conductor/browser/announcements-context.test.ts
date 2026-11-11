import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';

// The Announcements line reaches the main conductor's context, so its report-back promise
// ("I'll tell you when it's done or needs you.") follows what Maestro will actually announce.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  status: null as unknown,
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => mocks.status),
  }),
}));
vi.mock('./investigation-client', () => ({
  runInvestigation: vi.fn(),
  runProjectLookup: vi.fn(),
}));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: () => ({}),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({
    projects: new Map([
      ['proj', { id: 'proj', name: 'demo', data: { type: 'local', path: 'C:/demo' } }],
    ]),
  }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(),
  resolveSpokenProject: vi.fn(() => ({ ok: false, reason: 'No project is open.' })),
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(),
}));
vi.mock('./agent-io', () => ({
  CodexNotStartedError: class extends Error {},
  DeliveryLeftUnsentError: class extends Error {},
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => '(terminal)'),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: vi.fn(async () => {}),
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

const ALL = 'Announcements: all finished agents, and agents that need the developer.';
const ATTENTION_ONLY =
  'Announcements: only agents that need the developer; a finished agent with nothing for them is shown, not spoken.';
const OFF = 'Announcements: off; nothing is spoken when an agent finishes or needs the developer.';

function agent(): AgentTileEntry {
  return {
    tileId: 'tile-atlas',
    conversationId: 'conv-atlas',
    taskId: 'task-atlas',
    projectId: 'proj',
    projectName: 'demo',
    taskName: 'atlas task',
    providerId: 'claude',
    conversationTitle: 'Claude',
    type: 'pty',
    status: 'working',
    seen: true,
    notificationType: null,
    completionSummary: null,
    completionReport: null,
    taskProvisioned: true,
    sessionActive: true,
    workspaceId: 'ws-atlas',
    linesAdded: 0,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
  } as unknown as AgentTileEntry;
}

function fakeCanvas(entries: AgentTileEntry[]): CanvasStore {
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    attentionEntries: [],
    browserEntries: [],
    visibleBrowserEntries: [],
    projectOptions: [{ id: 'proj', name: 'demo' }],
    projectFilter: 'proj',
    regionEntries: [],
    layoutWindows: [],
    selection: [],
    lastChange: null,
    focusedTileId: null,
    focusedRegionId: null,
    multiCanvas: false,
    stageActive: false,
    currentRegion: () => null,
    previousRegionId: null,
    newestRegionId: null,
    visibleTileIds: () => entries.map((entry) => entry.tileId),
    location: { kind: 'board', regionScope: null },
    noteDrop: null,
    insights: new Map(),
    spokenName: () => 'Atlas',
    formerNamesOf: () => [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: () => undefined,
    insight: () => undefined,
    setInsight: vi.fn(),
    addNote: vi.fn(),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
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

function setup(settings: Partial<ConductorStatus['settings']> = {}) {
  mocks.status = {
    configured: true,
    jevReady: false,
    investigator: { state: 'unavailable', reason: 'off' },
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, completionFollowUp: false, ...settings },
  } as unknown as ConductorStatus;
  const store = new ConductorStore(fakeCanvas([agent()]), voice());
  store.status = mocks.status as ConductorStatus;
  return store;
}

function text(value: string) {
  return {
    success: true,
    data: {
      content: [{ type: 'text', text: value }],
      stopReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('the Announcements line in the conductor context', () => {
  it('reaches the model with a typed command, in each mode', async () => {
    const cases = [
      [{}, ALL],
      [{ announceCompletions: 'attention_only' }, ATTENTION_ONLY],
      [{ calls: 'quiet' }, OFF],
    ] as const;
    for (const [settings, line] of cases) {
      vi.clearAllMocks();
      const store = setup(settings);
      mocks.runTurn.mockResolvedValueOnce(text('ok'));
      await store.handleUtterance('what could we refactor here', 'typed');
      const messages: Anthropic.Beta.BetaMessageParam[] = mocks.runTurn.mock.calls[0]![0].messages;
      const sent = JSON.stringify(messages.at(-1));
      expect(sent).toContain(line);
      for (const other of [ALL, ATTENTION_ONLY, OFF].filter((each) => each !== line)) {
        expect(sent).not.toContain(other);
      }
      store.dispose();
    }
  });

  it("is in the voice line's context too", async () => {
    const store = setup({ announceCompletions: 'attention_only' });
    expect(await store.lineContext()).toContain(ATTENTION_ONLY);
    store.dispose();
  });
});
