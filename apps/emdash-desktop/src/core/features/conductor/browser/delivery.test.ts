import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';

// Sending to an agent the session list calls stopped: the host is asked first, so a live agent
// gets the text at once, and a delivery that waits for a start is never dropped in silence.

const mocks = vi.hoisted(() => ({
  sendToAgent: vi.fn(async () => {}),
  sendToLiveSession: vi.fn(async (): Promise<boolean> => false),
  startAgentSession: vi.fn(async (): Promise<boolean> => true),
  deliverPromptWhenReady: vi.fn(async (): Promise<boolean> => true),
  status: null as unknown,
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: vi.fn(),
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => mocks.status),
  }),
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
  getProjectManagerStore: vi.fn(),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(),
  resolveSpokenProject: vi.fn(() => ({ ok: false, reason: 'No project is open.' })),
  spawnAgentTask: vi.fn(),
  startAgentSession: mocks.startAgentSession,
}));
vi.mock('./deferred-prompt', () => ({
  deliverPromptWhenReady: mocks.deliverPromptWhenReady,
}));
vi.mock('./agent-io', () => ({
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => ''),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: mocks.sendToLiveSession,
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function agent(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    tileId: 'tile-echo',
    conversationId: 'conv-echo',
    taskId: 'task-echo',
    projectId: 'proj',
    projectName: 'demo',
    taskName: 'echo task',
    providerId: 'claude',
    conversationTitle: 'Claude',
    type: 'pty',
    status: 'awaiting-input',
    seen: true,
    notificationType: null,
    completionSummary: null,
    completionReport: null,
    taskProvisioned: true,
    sessionActive: false,
    workspaceId: 'ws-echo',
    linesAdded: 0,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
    ...overrides,
  } as AgentTileEntry;
}

function fakeCanvas(entries: AgentTileEntry[]): CanvasStore {
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    attentionEntries: [],
    browserEntries: [],
    visibleBrowserEntries: [],
    projectOptions: [{ id: 'proj', name: 'demo' }],
    projectFilter: null,
    layoutSettings: { groupPlanAgents: false, speakLayoutConfirmations: false },
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
    spokenName: () => 'Echo',
    formerNamesOf: () => [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: (tileId: string) => entries.find((entry) => entry.tileId === tileId),
    insight: () => undefined,
    setInsight: vi.fn(),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

function setup(entry: AgentTileEntry) {
  const announce = vi.fn();
  const speech = {
    muted: false,
    say: vi.fn(),
    announce,
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
    setCaptureHandler: vi.fn(),
    setTapGate: vi.fn(),
  } as unknown as ConductorVoicePort;
  const store = new ConductorStore(fakeCanvas([entry]), speech);
  mocks.status = {
    configured: true,
    jevReady: false,
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS },
  } as unknown as ConductorStatus;
  store.status = mocks.status as ConductorStatus;
  const deliver = (text: string): Promise<'sent' | 'starting'> =>
    store['deliver'](entry, text, true);
  return { store, announce, deliver };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendToLiveSession.mockResolvedValue(false);
  mocks.startAgentSession.mockResolvedValue(true);
  mocks.deliverPromptWhenReady.mockResolvedValue(true);
});

describe('delivering to an agent the session list calls stopped', () => {
  it('types into a session its host still has, and starts nothing', async () => {
    mocks.sendToLiveSession.mockResolvedValue(true);
    const entry = agent();
    const { store, announce, deliver } = setup(entry);

    await expect(deliver('how does it listen?')).resolves.toBe('sent');

    expect(mocks.sendToLiveSession).toHaveBeenCalledWith(entry, 'how does it listen?', true);
    expect(mocks.startAgentSession).not.toHaveBeenCalled();
    expect(mocks.deliverPromptWhenReady).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    store.dispose();
  });

  it('starts an agent its host does not have and delivers once it is up', async () => {
    const { store, announce, deliver } = setup(agent());

    await expect(deliver('hello')).resolves.toBe('starting');
    await settle();

    expect(mocks.startAgentSession).toHaveBeenCalledWith('proj', 'task-echo', 'conv-echo');
    expect(mocks.deliverPromptWhenReady).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    store.dispose();
  });

  it('says so when the message could not be delivered after the start', async () => {
    mocks.deliverPromptWhenReady.mockResolvedValue(false);
    const { store, announce, deliver } = setup(agent());

    await expect(deliver('hello')).resolves.toBe('starting');
    await settle();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]?.[0]).toContain('was not delivered');
    store.dispose();
  });

  it('says so when the deferred delivery throws', async () => {
    mocks.deliverPromptWhenReady.mockRejectedValue(new Error('gone'));
    const { store, announce, deliver } = setup(agent());

    await deliver('hello');
    await settle();

    expect(announce).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('uses the ordinary path for an agent the list calls running', async () => {
    const entry = agent({ sessionActive: true });
    const { store, deliver } = setup(entry);

    await expect(deliver('hello')).resolves.toBe('sent');

    expect(mocks.sendToAgent).toHaveBeenCalledWith(entry, 'hello', true);
    expect(mocks.sendToLiveSession).not.toHaveBeenCalled();
    store.dispose();
  });
});
