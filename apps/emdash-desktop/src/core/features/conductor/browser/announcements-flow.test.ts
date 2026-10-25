import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import type { AgentRequest } from '../api/agent-requests';
import { ANNOUNCEMENT_TTL_MS } from '../api/calls';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus, type TraceEvent } from '../api/contract';
import { CodexNotStartedError } from './agent-io';
import { HEARD_MS } from './agent-requests';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import { DeliveryHeldError, emitDelivery } from './delivery-lane';
import type * as Roster from './roster';
import type { SpawnRequest } from './spawn';

// News the conductor tells by itself, inside the conductor store: it waits until nothing the
// developer said, is saying or must answer would be talked over; it is shown, and its question
// becomes answerable, only once it is told; and it is dropped once it is no longer true.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  appendTrace: vi.fn(async (_event: unknown) => {}),
  appendLog: vi.fn(async (_record: unknown) => {}),
  sendToAgent: vi.fn(async (_entry: unknown, _text: string, _submit?: boolean) => {}),
  spawnAgentTask: vi.fn(async (_request: SpawnRequest) => ({
    taskId: 'task-new',
    conversationId: 'conv-new',
    promptDeferred: false,
    taskName: 'Check it',
    notes: [] as string[],
  })),
  startAgentSession: vi.fn(async () => true),
  providers: [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ],
  /** What detection finds when it runs again. */
  redetected: null as { id: string; name: string }[] | null,
  projectData: vi.fn((_store: unknown): { repositoryWorkspaceId: string } | null => null),
  deliverPromptWhenReady: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
    appendLog: mocks.appendLog,
    appendTrace: mocks.appendTrace,
    readLog: vi.fn(async () => []),
    getStatus: vi.fn(async () => status()),
  }),
}));
vi.mock('@core/features/canvas/contributions/browser/app-stores', () => ({
  getCanvasBrowserHost: vi.fn(),
}));
vi.mock('@core/features/browser/api/browser/client', () => ({ getBrowserClient: vi.fn() }));
vi.mock('@core/features/agents/api/browser/client', () => ({ getAgentsClient: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectStore: vi.fn(),
  projectData: mocks.projectData,
  getProjectManagerStore: vi.fn(() => ({ projects: new Map([['proj', { name: 'demo' }]]) })),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(() => 'proj'),
  resolveSpokenProject: vi.fn(() => ({ ok: true, id: 'proj' })),
  spawnAgentTask: mocks.spawnAgentTask,
  startAgentSession: mocks.startAgentSession,
  openProjects: vi.fn(() => [{ id: 'proj', name: 'Chorus' }]),
}));
vi.mock('./focus-spawned-agent', () => ({ focusSpawnedAgent: vi.fn(() => () => {}) }));
vi.mock('./deferred-prompt', () => ({ deliverPromptWhenReady: mocks.deliverPromptWhenReady }));
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
  installedProviders: vi.fn(async () => mocks.providers),
  forgetInstalledProviders: vi.fn(() => {
    if (mocks.redetected) mocks.providers = mocks.redetected;
  }),
}));

function status(overrides: Partial<ConductorStatus['settings']> = {}): ConductorStatus {
  return {
    configured: true,
    jevReady: false,
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, calls: 'off', ...overrides },
  } as unknown as ConductorStatus;
}

const NAMES: Record<string, string> = { 'conv-z': 'Zulu', 'conv-y': 'Yankee', 'conv-new': 'Echo' };

function agent(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    tileId: 'tile-z',
    conversationId: 'conv-z',
    taskId: 'task-z',
    projectId: 'proj',
    projectName: 'demo',
    taskName: 'PCB order review',
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
    workspaceId: 'ws-z',
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
    spokenName: (conversationId: string) => NAMES[conversationId] ?? conversationId,
    formerNamesOf: () => [],
    departedNames: [],
    claimSpokenName: () => 'Echo',
    releaseSpokenName: vi.fn(),
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: () => undefined,
    insight: () => undefined,
    setInsight: vi.fn(),
    clearInsight: vi.fn(),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

type FakeVoice = ConductorVoicePort & {
  /** What was said with the attention voice, in order. */
  heard: string[];
  /** Ends the sentence being said. */
  endSpeech(): Promise<void>;
  /** The conductor's own answer to the developer starts or stops playing. */
  replying(on: boolean): void;
};

function voice(): FakeVoice {
  const state = observable({ inFlight: false, capturing: false });
  const waiting: ((result: 'ended') => void)[] = [];
  const fake: FakeVoice = {
    muted: false,
    get capturing() {
      return state.capturing;
    },
    get speechInFlight() {
      return state.inFlight;
    },
    heard: [],
    say: vi.fn(),
    announce: vi.fn(),
    speak: (text) => {
      fake.heard.push(text);
      return new Promise((resolve) => waiting.push(resolve));
    },
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
    endSpeech: async () => {
      waiting.shift()?.('ended');
      await settle();
    },
    replying: (on) => runInAction(() => (state.inFlight = on)),
  };
  return fake;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 30; round++) await Promise.resolve();
}

function text(value: string) {
  return turn([{ type: 'text', text: value }], 'end_turn');
}

function toolUses(...uses: { name: string; input: unknown }[]) {
  return turn(
    uses.map((use, index) => ({ type: 'tool_use', id: `tu-${index}`, ...use })),
    'tool_use'
  );
}

function turn(content: unknown[], stopReason: string) {
  return {
    success: true,
    data: {
      content,
      stopReason,
      model: 'anthropic/claude-test',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    },
  };
}

let sequence = 0;
function request(kind: string, payload: unknown): AgentRequest {
  sequence += 1;
  return {
    id: `r-00000${sequence}`,
    at: '2026-10-10T20:00:00.000Z',
    from: { conversationId: 'conv-z', taskId: 'task-z', projectId: 'proj' },
    kind,
    payload,
  };
}

async function setup(
  entries: AgentTileEntry[] = [agent()],
  settings: Partial<ConductorStatus['settings']> = {}
) {
  const speech = voice();
  const canvas = fakeCanvas(entries);
  const store = new ConductorStore(canvas, speech);
  store.activate();
  // Activating reads the status once; what a test sets afterwards stays.
  await settle();
  store.status = status(settings);
  store['requestPending'] = vi.fn(async () => true);
  const receive = (incoming: AgentRequest) => store.requests.receive(incoming, async () => true);
  const traces = () => mocks.appendTrace.mock.calls.map(([event]) => event as TraceEvent);
  return { store, speech, entries, receive, traces };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runTurn.mockReset();
  sequence = 0;
  mocks.providers = [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ];
  mocks.redetected = null;
  mocks.startAgentSession.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('news waits for the developer', () => {
  it('never cuts off the conductor’s answer to the developer, and follows it', async () => {
    const { store, speech } = await setup();
    speech.replying(true);
    store.reply = 'Sent it to Yankee.';
    store['notify']('Zulu needs you.', null, { source: 'attention' });
    expect(speech.heard).toEqual([]);
    // Not even shown: the answer stays on screen while it is being said.
    expect(store.reply).toBe('Sent it to Yankee.');

    speech.replying(false);
    expect(speech.heard).toEqual(['Zulu needs you.']);
    expect(store.reply).toBe('Zulu needs you.');
    store.dispose();
  });

  it('waits while the microphone is open and while a turn the developer started runs', async () => {
    const { store, speech } = await setup();
    store['onCapture']({ type: 'start', interactionId: 'capture-1', origin: 'user' });
    store['notify']('Zulu finished.', null, { source: 'completion' });
    expect(speech.heard).toEqual([]);
    store['onCapture']({ type: 'end', interactionId: 'capture-1', reason: 'cancelled' });
    await settle();
    expect(speech.heard).toEqual(['Zulu finished.']);
    await speech.endSpeech();

    store['turnSource'] = 'voice';
    store['notify']('Yankee finished.', null, { source: 'completion', agents: ['conv-y'] });
    expect(speech.heard).toEqual(['Zulu finished.']);
    store['finishTurn']();
    expect(speech.heard).toEqual(['Zulu finished.', 'Yankee finished.']);
    store.dispose();
  });

  it('tells one at a time, keeps the latest word on an agent, and lets “stop” clear it', async () => {
    const { store, speech } = await setup();
    speech.replying(true);
    store['notify']('Zulu needs you.', null, { agents: ['conv-z'] });
    store['notify']('Zulu finished.', null, { agents: ['conv-z'] });
    store['notify']('Yankee finished.', null, { agents: ['conv-y'] });
    speech.replying(false);
    expect(speech.heard).toEqual(['Zulu finished.']);
    await speech.endSpeech();
    expect(speech.heard).toEqual(['Zulu finished.', 'Yankee finished.']);
    await speech.endSpeech();

    speech.replying(true);
    store['notify']('Yankee needs you.', null, { agents: ['conv-y'] });
    await store.handleUtterance('stop', 'typed');
    speech.replying(false);
    await settle();
    expect(speech.heard).toEqual(['Zulu finished.', 'Yankee finished.']);
    store.dispose();
  });

  it('drops old news, and an agent that no longer waits as it was said to', async () => {
    const waiting = agent({ status: 'awaiting-input', notificationType: 'permission_prompt' });
    const other = agent({
      tileId: 'tile-y',
      conversationId: 'conv-y',
      status: 'awaiting-input',
      notificationType: null,
    });
    const { store, speech, entries } = await setup([waiting, other]);
    speech.replying(true);
    await store['announceBatch']([waiting, other]);
    // Zulu's prompt was answered while the conductor was still talking.
    entries[0] = agent({ status: 'working' });
    speech.replying(false);
    expect(speech.heard).toEqual(['Yankee needs you.']);
    await speech.endSpeech();

    const now = vi.spyOn(Date, 'now');
    try {
      speech.replying(true);
      store['notify']('Zulu finished.', null, { agents: ['conv-z'] });
      now.mockReturnValue(Date.now() + ANNOUNCEMENT_TTL_MS + 1);
      speech.replying(false);
    } finally {
      now.mockRestore();
    }
    expect(speech.heard).toEqual(['Yankee needs you.']);
    store.dispose();
  });

  it('traces every announcement with where it came from, and the model it ran on', async () => {
    const { store, speech, receive, traces } = await setup();
    mocks.runTurn.mockResolvedValueOnce(text('Left it.'));
    const key = `sk-ant-${'a'.repeat(30)}`;
    await receive(
      request('ask_conductor', {
        question: `Tabs or spaces? My key is ${key}. ${'Also, '.repeat(300)}`,
      })
    );
    await vi.waitFor(() => expect(speech.heard).toHaveLength(1));
    // The turn log keeps what was asked: redacted, and bounded.
    const logged = mocks.appendLog.mock.calls.map(([record]) => record as { request?: string });
    const asked = logged.find((record) => record.request)?.request ?? '';
    expect(asked).toContain('Tabs or spaces?');
    expect(asked.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(logged)).not.toContain(key);
    const shown = traces().find(
      (event) => event.kind === 'reply' && event.detail?.surface === 'announce'
    );
    expect(shown?.detail).toMatchObject({ source: 'request' });
    expect(
      traces().some((event) => event.kind === 'call' && event.detail?.status === 'queued')
    ).toBe(true);
    expect(
      traces().find((event) => event.kind === 'model' && event.detail?.model)?.detail?.model
    ).toBe('anthropic/claude-test');
    store.dispose();
  });
});

describe('a question waiting to be told', () => {
  it('is not answered by a yes before it was shown and heard', async () => {
    const { store, speech, receive } = await setup();
    store.status = { ...status(), configured: false } as ConductorStatus;
    speech.replying(true);
    store.reply = 'Done.';
    await receive(
      request('spawn_agent', { provider: 'codex', task_name: 'Check it', brief: 'Check it.' })
    );
    expect(store.requests.awaitingDeveloper).toBe(true);
    // Queued behind the answer being said: the question is neither on screen nor answerable.
    expect(store.reply).toBe('Done.');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await store.handleUtterance('yes', 'typed');
    } finally {
      later.mockRestore();
    }
    expect(mocks.spawnAgentTask).not.toHaveBeenCalled();

    speech.replying(false);
    const question = 'Zulu asks to start a codex agent on “Check it”. Say yes to allow it, or no.';
    expect(store.reply).toBe(question);
    expect(speech.heard.at(-1)).toBe(question);
    await speech.endSpeech();
    const heard = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + HEARD_MS + 1);
    try {
      await store.handleUtterance('yes', 'typed');
    } finally {
      heard.mockRestore();
    }
    expect(mocks.spawnAgentTask).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('a request turn', () => {
  it('ends once the request is settled: one model call for a no, a yes, or an answer', async () => {
    const cases: { asked: AgentRequest; decision: 'approve' | 'deny' | 'answer'; said: string }[] =
      [
        {
          asked: request('spawn_agent', { provider: 'codex', task_name: 'Check it', brief: 'Go.' }),
          decision: 'deny',
          said: 'Zulu asks to start a codex agent on “Check it”. I said no.',
        },
        {
          asked: request('message_agent', { agent: 'Yankee', text: 'Which port?' }),
          decision: 'approve',
          said: 'Zulu asks to send Yankee a message. I approved it.',
        },
        {
          asked: request('ask_conductor', { question: 'Tabs or spaces?' }),
          decision: 'answer',
          said: 'Zulu asked me: Tabs or spaces? I answered it.',
        },
      ];
    for (const { asked, decision, said } of cases) {
      mocks.runTurn.mockReset();
      const yankee = agent({ tileId: 'tile-y', conversationId: 'conv-y' });
      const { store, receive } = await setup([agent(), yankee]);
      mocks.runTurn.mockResolvedValueOnce(
        toolUses({
          name: 'answer_request',
          input: { request_id: asked.id, decision, message: 'Spaces.' },
        })
      );
      await receive(asked);
      await vi.waitFor(() => expect(store.reply).toBe(said));
      expect(mocks.runTurn).toHaveBeenCalledTimes(1);
      // The turn stays in history, ending on the sentence the developer was given.
      expect(store['history'].at(-1)).toEqual({ role: 'assistant', content: said });
      store.dispose();
    }
  });
});

describe('what is said about agents’ requests', () => {
  it('shows a routine message approval without saying it, and still logs it', async () => {
    const yankee = agent({ tileId: 'tile-y', conversationId: 'conv-y' });
    const { store, speech, receive, traces } = await setup([agent(), yankee]);
    mocks.runTurn.mockImplementationOnce(async (input: { messages: unknown[] }) => {
      const id = JSON.stringify(input.messages).match(/r-0+\d/)?.[0];
      return toolUses({ name: 'answer_request', input: { request_id: id, decision: 'approve' } });
    });
    await receive(request('message_agent', { agent: 'Yankee', text: 'Which port is the API on?' }));
    await vi.waitFor(() =>
      expect(store.reply).toBe('Zulu asks to send Yankee a message. I approved it.')
    );
    expect(speech.heard).toEqual([]);
    expect(
      traces().find((event) => event.kind === 'reply' && event.detail?.surface === 'announce')
        ?.detail
    ).toMatchObject({ source: 'request', spoken: false });
    store.dispose();
  });

  it('says that a new agent did not start, and why when detection knows', async () => {
    const { store, speech, receive } = await setup();
    // Starting gives up only after a while, long after the conductor said it was starting.
    let giveUp: (started: boolean) => void = () => {};
    mocks.startAgentSession.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (giveUp = resolve))
    );
    mocks.redetected = [{ id: 'claude', name: 'Claude Code' }];
    mocks.runTurn.mockImplementationOnce(async (input: { messages: unknown[] }) => {
      const id = JSON.stringify(input.messages).match(/r-0+\d/)?.[0];
      return toolUses({ name: 'answer_request', input: { request_id: id, decision: 'approve' } });
    });
    await receive(
      request('spawn_agent', { provider: 'codex', task_name: 'Check it', brief: 'Check it.' })
    );
    const starting = 'Zulu asks to start a codex agent on “Check it”. I approved it.';
    await vi.waitFor(() => expect(speech.heard).toEqual([starting]));
    await speech.endSpeech();
    giveUp(false);
    await vi.waitFor(() =>
      expect(speech.heard.at(-1)).toBe("Echo didn't start: Codex isn't installed.")
    );
    store.dispose();
  });

  it('lets a report heard whole stand for the finished turn that follows it', async () => {
    const { store, speech, receive, entries } = await setup();
    await receive(request('report', { status: 'done', message: 'the order brief is ready' }));
    expect(speech.heard).toEqual(['Zulu is done: the order brief is ready.']);
    await speech.endSpeech();
    entries[0] = agent({ status: 'completed', seen: false, completionSummary: 'wrote the brief' });
    await store['announceBatch']([entries[0]]);
    await settle();
    // Shown, not said again.
    expect(speech.heard).toEqual(['Zulu is done: the order brief is ready.']);
    expect(store.reply).toContain('Zulu');

    // The next finished turn is news again.
    await store['announceBatch']([
      agent({ status: 'completed', seen: false, completionSummary: 'sent the order' }),
    ]);
    await settle();
    expect(speech.heard).toHaveLength(2);
    store.dispose();
  });

  it('keeps a waiting report rather than the bare “finished” of the turn it describes', async () => {
    const { store, speech, receive, entries } = await setup();
    speech.replying(true);
    await receive(request('report', { status: 'done', message: 'the order brief is ready' }));
    entries[0] = agent({ status: 'completed', seen: false, completionSummary: 'wrote the brief' });
    await store['announceBatch']([entries[0]]);
    speech.replying(false);
    await settle();
    expect(speech.heard).toEqual(['Zulu is done: the order brief is ready.']);
    await speech.endSpeech();
    expect(speech.heard).toHaveLength(1);
    store.dispose();
  });

  it('says a long report only up to a whole sentence, and shows it all', async () => {
    const { store, speech, receive } = await setup();
    const message = `${'The installer is signed and uploaded to the share. '.repeat(5)}Warning: do not run it on Y: yet.`;
    await receive(request('report', { status: 'blocked', message }));
    expect(speech.heard[0]).toMatch(/share\.$/);
    expect(store.reply).toContain('Warning: do not run it on Y: yet.');
    store.dispose();
  });
});

const LONG_REQUEST = `${'Please build the importer for the vendor files and keep every column. '.repeat(6)}Thanks.`;
const report = (text: string) => ({ text, truncated: false, appUrls: [] as string[] });

describe('starting an agent', () => {
  it('refuses an empty brief for a detailed request, and passes peers and notes on', async () => {
    const busy = agent({ status: 'working', workspaceId: 'repo-ws' });
    const { store } = await setup([busy]);
    store['lastUtterance'] = LONG_REQUEST;
    const empty = await store['executeTool']('spawn_agent', {
      provider: 'codex',
      task_name: 'Importer',
      prompt: '',
    });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('The prompt is empty');
    expect(mocks.spawnAgentTask).not.toHaveBeenCalled();

    mocks.projectData.mockReturnValue({ repositoryWorkspaceId: 'repo-ws' });
    mocks.spawnAgentTask.mockResolvedValueOnce({
      taskId: 'task-new',
      conversationId: 'conv-new',
      promptDeferred: false,
      taskName: 'Zulu task',
      notes: ['Zulu is also working in this folder.'],
    });
    const started = await store['executeTool']('spawn_agent', {
      provider: 'codex',
      task_name: 'Zulu',
      prompt: 'Build the importer.',
    });
    expect(mocks.spawnAgentTask.mock.calls[0]?.[0].peers).toEqual([
      {
        name: 'Zulu',
        title: 'Claude',
        projectId: 'proj',
        status: 'working',
        inProjectDirectory: true,
      },
    ]);
    expect(started.content).toContain('Created task "Zulu task"');
    expect(started.content).toContain('Zulu is also working in this folder.');
    mocks.projectData.mockReturnValue(null);
    store.dispose();
  });

  it('says a brief that was pasted but not sent, never "did not start"', async () => {
    const { store, speech } = await setup();
    mocks.spawnAgentTask.mockResolvedValueOnce({
      taskId: 'task-new',
      conversationId: 'conv-new',
      promptDeferred: true,
      taskName: 'Check it',
      notes: [],
    });
    mocks.deliverPromptWhenReady.mockRejectedValueOnce(new CodexNotStartedError('Check it'));
    await store['executeTool']('spawn_agent', {
      provider: 'codex',
      task_name: 'Check it',
      prompt: 'Check it.',
    });
    await vi.waitFor(() =>
      expect(speech.heard).toEqual([
        "Pasted into Echo, but Codex didn't start; press Enter in its window.",
      ])
    );
    await speech.endSpeech();
    mocks.spawnAgentTask.mockResolvedValueOnce({
      taskId: 'task-2',
      conversationId: 'conv-new',
      promptDeferred: true,
      taskName: 'Again',
      notes: [],
    });
    mocks.deliverPromptWhenReady.mockRejectedValueOnce(new DeliveryHeldError('typing', 'Again'));
    await store['executeTool']('spawn_agent', {
      provider: 'codex',
      task_name: 'Again',
      prompt: 'Again.',
    });
    await vi.waitFor(() =>
      expect(speech.heard.at(-1)).toBe('Echo did not get its brief: you kept typing there.')
    );
    store.dispose();
  });
});

describe('sending while the developer types there', () => {
  it('does not hold the turn for a held send, and says when it was given up on', async () => {
    const { store, speech } = await setup();
    let giveUp: (error: unknown) => void = () => {};
    mocks.sendToAgent.mockImplementationOnce(
      (_entry: unknown, _text: string, _submit?: boolean, options?: unknown) => {
        (options as { onHold: (hold: unknown) => void }).onHold({
          conversationId: 'conv-z',
          reason: 'typing',
          waiting: 0,
        });
        return new Promise<void>((_resolve, reject) => (giveUp = reject));
      }
    );
    const { reply } = await store['deliverWithReply'](agent(), 'run the tests');
    expect(reply).toBe('Holding it for Zulu while you type there.');
    giveUp(new DeliveryHeldError('typing', 'PCB order review'));
    await vi.waitFor(() =>
      expect(speech.heard).toEqual(['Zulu did not get your message: you kept typing there.'])
    );
    store.dispose();
  });

  it('tells once that its own message waits, and traces the delivery', async () => {
    const { store, speech, traces } = await setup();
    let typed: () => void = () => {};
    mocks.sendToAgent.mockImplementationOnce(
      (_entry: unknown, _text: string, _submit?: boolean, options?: unknown) => {
        const hold = (options as { onHold: (hold: unknown) => void }).onHold;
        hold({ conversationId: 'conv-z', reason: 'unsent-text', waiting: 0 });
        hold({ conversationId: 'conv-z', reason: 'unsent-text', waiting: 0 });
        return new Promise<void>((resolve) => (typed = resolve));
      }
    );
    const sending = store['sendWhenSafe']('conv-z', '[Maestro reply r-1] go ahead');
    await settle();
    expect(speech.heard).toEqual(["Holding my message to Zulu: it has text you haven't sent."]);
    emitDelivery({ type: 'released', conversationId: 'conv-z', heldMs: 1200 });
    typed();
    await sending;
    expect(traces().find((event) => event.detail?.tool === 'delivery')?.detail).toMatchObject({
      status: 'released',
      agent: 'Zulu',
      heldMs: 1200,
    });
    store.dispose();
  });
});

describe('completion follow-ups', () => {
  const settings = { completionFollowUp: true } as const;

  it('says an agent that waits is waiting, not finished, when there is nothing new', async () => {
    const waiting = agent({ status: 'awaiting-input', seen: false });
    const { store, speech } = await setup([waiting], settings);
    mocks.runTurn.mockResolvedValueOnce(text('NO_NEWS'));
    await store['followUpCompletions']([waiting], new Map([['conv-z', report('Done?')]]));
    await settle();
    expect(speech.heard).toEqual(['Zulu is waiting for you.']);
    store.dispose();
  });

  it('tells the model what the developer last heard about the agent', async () => {
    const done = agent({ status: 'completed', seen: false });
    const { store, speech } = await setup([done], settings);
    store['notify']('Zulu says the tests pass.', null, { agents: ['conv-z'] });
    await speech.endSpeech();
    mocks.runTurn.mockResolvedValueOnce(text('Zulu fixed it.'));
    await store['followUpCompletions']([done], new Map([['conv-z', report('Fixed.')]]));
    expect(JSON.stringify(mocks.runTurn.mock.calls[0]?.[0].messages)).toContain(
      'Zulu says the tests pass.'
    );
    store.dispose();
  });

  it('waits for a busy conductor instead of saying the bare sentence, within the expiry', async () => {
    const done = agent({ status: 'completed', seen: false, completionReport: report('Shipped.') });
    const { store, speech } = await setup([done], settings);
    runInAction(() => (store.phase = 'thinking'));
    await store['announceBatch']([done]);
    await settle();
    expect(speech.heard).toEqual([]);
    expect(mocks.runTurn).not.toHaveBeenCalled();

    mocks.runTurn.mockResolvedValueOnce(text('Zulu shipped the importer.'));
    store['finishTurn']();
    await vi.waitFor(() => expect(speech.heard).toEqual(['Zulu shipped the importer.']));
    await speech.endSpeech();

    // Waited past the expiry: too late to narrate, so the fixed sentence is shown, not said.
    store.reply = '';
    const later = agent({ status: 'completed', seen: false, completionReport: report('Again.') });
    runInAction(() => (store.phase = 'thinking'));
    await store['announceBatch']([later]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ANNOUNCEMENT_TTL_MS + 1);
    try {
      store['finishTurn']();
    } finally {
      now.mockRestore();
    }
    await settle();
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(store.reply).toContain('Zulu');
    expect(speech.heard).toEqual(['Zulu shipped the importer.']);
    store.dispose();
  });
});

describe('a question not yet told', () => {
  it('is no answer for the model to relay until the developer was told it', async () => {
    const { store, speech, receive } = await setup();
    speech.replying(true);
    const asked = request('ask_developer', { question: 'Keep the look, or a longer pod?' });
    await receive(asked);
    expect(store.requests.contextLines().join('\n')).toContain('not yet told to the developer');
    const early = await store.requests.answer(asked.id, 'answer', 'Longer pod.', false);
    expect(early).toMatchObject({ isError: true });
    expect(early.content).toContain('has not been told to the developer yet');
    expect(mocks.sendToAgent).not.toHaveBeenCalled();

    speech.replying(false);
    expect(speech.heard.at(-1)).toBe('Zulu asks: Keep the look, or a longer pod?');
    expect(store.requests.contextLines().join('\n')).toContain(
      "waiting for the developer's answer"
    );
    const told = await store.requests.answer(asked.id, 'answer', 'Longer pod.', false);
    expect(told.isError).toBeFalsy();
    await vi.waitFor(() => expect(mocks.sendToAgent).toHaveBeenCalledTimes(1));
    store.dispose();
  });
});

describe('a request turn that does more than settle', () => {
  it('keeps a valid history after a round of several calls and the round cap', async () => {
    const { store, receive } = await setup();
    const asked = request('ask_conductor', { question: 'Tabs or spaces?' });
    // Round 1 settles beside a read, so the turn goes on; then it reads until the cap.
    mocks.runTurn.mockResolvedValueOnce(
      toolUses(
        {
          name: 'answer_request',
          input: { request_id: asked.id, decision: 'answer', message: 'Spaces.' },
        },
        { name: 'list_agents', input: {} }
      )
    );
    mocks.runTurn.mockResolvedValue(toolUses({ name: 'list_agents', input: {} }));
    await receive(asked);
    await vi.waitFor(() =>
      expect(store.reply).toBe('Zulu asked me: Tabs or spaces? I answered it.')
    );
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
    const history = store['history'];
    expect(history.at(-1)).toEqual({
      role: 'assistant',
      content: 'Zulu asked me: Tabs or spaces? I answered it.',
    });
    // Every call in it has its results right after.
    history.forEach((message, index) => {
      if (message.role !== 'assistant' || typeof message.content === 'string') return;
      const ids = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
      if (ids.length === 0) return;
      const next = history[index + 1];
      const answered =
        next && typeof next.content !== 'string'
          ? next.content.flatMap((block) =>
              block.type === 'tool_result' ? [block.tool_use_id] : []
            )
          : [];
      expect(answered).toEqual(expect.arrayContaining(ids));
    });
    store.dispose();
  });
});

describe('a confirmation said aloud', () => {
  it('says the action with a preview, and a yes begun before it was said confirms nothing', async () => {
    const { store, speech } = await setup();
    store['turnSource'] = 'voice';
    store['turnTainted'] = true;
    store['requestPending'] = ConductorStore.prototype.requestPending.bind(store);
    // The developer started talking before the prompt existed.
    store['captureStarts'].set('early', Date.now() - 500);
    const label = 'Send to Zulu: “Yes, I can proceed with the migration and the backfill now”';
    const message = 'Yes, I can proceed with the migration and the backfill now.';
    let settled: boolean | null = null;
    void store.requestPending(label, 'confirm', { detail: message }).then((yes) => (settled = yes));
    expect(speech.heard).toEqual([
      'Send to Zulu "Yes, I can proceed with the migration…"? Say yes.',
    ]);
    expect(store.pending?.label).toBe(label);
    expect(store.pending?.detail).toBe(message);

    // Their words arrive while the prompt is read out: they were begun before it, so no yes.
    await store.handleUtterance('yes', 'voice', 'early');
    await settle();
    expect(settled).toBeNull();
    expect(store.pending).not.toBeNull();
    await speech.endSpeech();
    expect(settled).toBeNull();

    // Said once it was read out: that is the answer.
    store['captureStarts'].set('later', Date.now() + 1);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5);
    try {
      await store.handleUtterance('yes', 'voice', 'later');
    } finally {
      now.mockRestore();
    }
    await settle();
    expect(settled).toBe(true);
    store.dispose();
  });
});
