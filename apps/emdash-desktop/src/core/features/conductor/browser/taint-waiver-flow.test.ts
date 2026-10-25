import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import {
  DEFAULT_CONDUCTOR_SETTINGS,
  type ConductorStatus,
  type InvestigationResult,
} from '../api/contract';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type { InvestigationRun } from './investigation-client';
import type * as Roster from './roster';

// The code check taint waiver, through the real turns: a check's result in the history makes the
// next turns ask before acting, except the developer's own start or send that the router read as
// exactly that command, once a turn, in the project the check read.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  sendToAgent: vi.fn(async (_entry: unknown, _text: string, _submit: boolean) => {}),
  runInvestigation: vi.fn(),
  runProjectLookup: vi.fn(),
  status: null as unknown,
  /** What the router read each utterance as, in its trace detail. */
  reading: {} as Record<string, string>,
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
    appendLog: vi.fn(async () => {}),
    appendTrace: vi.fn(async () => {}),
    getStatus: vi.fn(async () => mocks.status),
  }),
}));
vi.mock('./jev-router', () => ({
  routerInput: vi.fn(async () => ({})),
  routeUtterance: vi.fn(async () => ({
    ok: true,
    decision: { kind: 'llm', mode: 'command', reason: 'model', hints: '' },
    detail: { ...mocks.reading },
  })),
}));
vi.mock('./investigation-client', () => ({
  runInvestigation: mocks.runInvestigation,
  runProjectLookup: mocks.runProjectLookup,
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
  getProjectStore: vi.fn(),
  projectData: vi.fn(() => null),
  getProjectManagerStore: () => ({
    projects: new Map([
      ['proj', { id: 'proj', name: 'demo', data: { type: 'local', path: 'C:/demo' } }],
      ['other', { id: 'other', name: 'website', data: { type: 'local', path: 'C:/website' } }],
      ['far', { id: 'far', name: 'remote-thing', data: { type: 'ssh' } }],
    ]),
  }),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(() => 'proj'),
  resolveProviderId: vi.fn(async () => 'codex'),
  resolveSpokenProject: vi.fn(() => ({ ok: true, id: 'proj' })),
  spawnAgentTask: vi.fn(async () => ({
    taskId: 'task-new',
    conversationId: 'conv-new',
    promptDeferred: false,
    taskName: 'Importer',
    notes: [],
  })),
  startAgentSession: vi.fn(async () => true),
  openProjects: vi.fn(() => [{ id: 'proj', name: 'Chorus' }]),
}));
vi.mock('./focus-spawned-agent', () => ({ focusSpawnedAgent: vi.fn(() => () => {}) }));
vi.mock('./agent-io', () => ({
  CodexNotStartedError: class extends Error {},
  DeliveryLeftUnsentError: class extends Error {},
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => '(terminal)'),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function status(investigator: ConductorStatus['investigator']['state'] = 'ready') {
  return {
    configured: true,
    jevReady: true,
    investigator: { state: investigator, reason: investigator === 'ready' ? null : 'signed out' },
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, investigations: true, completionFollowUp: false },
  } as unknown as ConductorStatus;
}

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

function fakeCanvas(entries: AgentTileEntry[], projectFilter: string | null): CanvasStore {
  return {
    agentEntries: entries,
    visibleAgentEntries: entries,
    attentionEntries: [],
    browserEntries: [],
    visibleBrowserEntries: [],
    projectOptions: [
      { id: 'proj', name: 'demo' },
      { id: 'other', name: 'website' },
    ],
    projectFilter,
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
    claimSpokenName: () => 'Echo',
    releaseSpokenName: vi.fn(),
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

const answered: InvestigationResult = {
  model: 'haiku',
  folderName: 'demo',
  outcomes: [
    {
      status: 'answered',
      question: 'Is there a retry helper for uploads?',
      answer: 'Yes: retryUpload in upload-client.ts retries three times.',
      found: 'yes',
      evidence: [
        {
          path: 'src/upload-client.ts',
          line: 12,
          quote: 'export function retryUpload',
          found: true,
        },
      ],
      durationMs: 11_000,
      costUsd: 0.004,
      denied: 0,
    },
  ],
} as unknown as InvestigationResult;

function text(value: string) {
  return turn([{ type: 'text', text: value }], 'end_turn');
}

function toolUse(name: string, input: unknown, id = `tu-${name}`) {
  return turn([{ type: 'tool_use', id, name, input }], 'tool_use');
}

function turn(content: unknown[], stopReason: string) {
  return {
    success: true,
    data: {
      content,
      stopReason,
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  };
}

function setup(options: { investigator?: 'ready' | 'unavailable'; filter?: string | null } = {}) {
  mocks.status = status(options.investigator ?? 'ready');
  const filter = options.filter === undefined ? 'proj' : options.filter;
  const store = new ConductorStore(fakeCanvas([agent()], filter), voice());
  store.status = mocks.status as ConductorStatus;
  return store;
}

const CHECK_QUESTION = 'How does the importer treat the last column?';
const SPAWN = 'spawn_with_brief (0.97) | spawn_blank=0.02';
const COMMAND = 'command_for_chorus (0.98) | conversation_with_conductor=0.01';
const BRIEF = 'Keep every column when importing vendor files, with a test.';

/** Turn 1: the developer asks, the model runs a code check in `project`, and answers. */
async function checked(store: ConductorStore, project = 'demo') {
  mocks.reading = { jev_addressee: COMMAND, jev_intent: 'project_question (0.9)' };
  mocks.runTurn
    .mockResolvedValueOnce(toolUse('investigate', { project, questions: [CHECK_QUESTION] }))
    .mockResolvedValueOnce(text('It drops the last column.'));
  await store.handleUtterance('how does the importer treat the last column', 'typed');
}

/** The kinds of confirmation each tool call asked for, in order. */
function asked(store: ConductorStore): Mock {
  const pending = vi.fn(async (_label: string, _kind: string | null) => true);
  store['requestPending'] = pending;
  return pending;
}

const spawn = (id: string, prompt = BRIEF) => ({
  type: 'tool_use',
  id,
  name: 'spawn_agent',
  input: { provider: 'codex', task_name: 'Importer', prompt },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runTurn.mockReset();
  mocks.runInvestigation.mockResolvedValue({ success: true, data: answered } as InvestigationRun);
});

describe('the code check taint waiver', () => {
  it("lets the developer's own start in the checked project run once, then asks", async () => {
    const store = setup();
    await checked(store);
    const pending = asked(store);
    mocks.reading = { jev_addressee: COMMAND, jev_intent: SPAWN };
    mocks.runTurn
      .mockResolvedValueOnce(turn([spawn('s1'), spawn('s2', 'Also add a CSV export.')], 'tool_use'))
      .mockResolvedValueOnce(text('Started two agents.'));
    await store.handleUtterance('start a codex agent to keep every column, with a test', 'typed');
    expect(pending.mock.calls.map(([, kind]) => kind)).toEqual([null, 'direct']);
  });

  it('asks when the start is in another project than the one checked', async () => {
    const store = setup();
    await checked(store, 'website');
    const pending = asked(store);
    mocks.reading = { jev_addressee: COMMAND, jev_intent: SPAWN };
    mocks.runTurn
      .mockResolvedValueOnce(turn([spawn('s1')], 'tool_use'))
      .mockResolvedValueOnce(text('Started.'));
    await store.handleUtterance('start a codex agent to keep every column', 'typed');
    expect(pending.mock.calls.map(([, kind]) => kind)).toEqual(['direct']);
  });

  it('asks after a fresh code check in the same turn', async () => {
    const store = setup();
    await checked(store);
    const pending = asked(store);
    mocks.reading = { jev_addressee: COMMAND, jev_intent: SPAWN };
    mocks.runTurn
      .mockResolvedValueOnce(
        toolUse('investigate', { project: 'demo', questions: ['Where are vendor files imported?'] })
      )
      .mockResolvedValueOnce(turn([spawn('s1')], 'tool_use'))
      .mockResolvedValueOnce(text('Started.'));
    await store.handleUtterance('start a codex agent to keep every column', 'typed');
    expect(pending.mock.calls.map(([, kind]) => kind)).toEqual(['direct']);
  });

  it('asks when the router did not read the words as that command', async () => {
    const store = setup();
    await checked(store);
    const pending = asked(store);
    mocks.reading = { jev_addressee: COMMAND, jev_intent: 'spawn_with_brief (0.8)' };
    mocks.runTurn
      .mockResolvedValueOnce(turn([spawn('s1')], 'tool_use'))
      .mockResolvedValueOnce(text('Started.'));
    await store.handleUtterance('maybe start something for the columns', 'typed');
    expect(pending.mock.calls.map(([, kind]) => kind)).toEqual(['direct']);
  });

  it('lets a send through only to the agent the developer named', async () => {
    const send = {
      type: 'tool_use',
      id: 'm1',
      name: 'send_to_agent',
      input: { agent: 'Atlas', text: BRIEF },
    };
    for (const [said, kind] of [
      ['could you have atlas keep every column when importing, with a test', null],
      ['I want it to keep every column, with a test', 'direct'],
      // Named in passing: the send goes to another agent than the one addressed.
      ['I want Bravo to hear what Atlas found about every column', 'direct'],
    ] as const) {
      mocks.runTurn.mockReset();
      const store = setup();
      await checked(store);
      const pending = asked(store);
      mocks.reading = { jev_addressee: COMMAND, jev_intent: 'send_composed (0.97)' };
      mocks.runTurn
        .mockResolvedValueOnce(turn([send], 'tool_use'))
        .mockResolvedValueOnce(text('Sent.'));
      await store.handleUtterance(said, 'typed');
      // The model's turn made the send, not the fast grammar.
      expect(mocks.runTurn).toHaveBeenCalledTimes(4);
      expect(pending.mock.calls.map(([, asked]) => asked)).toEqual([kind]);
    }
  });
});
