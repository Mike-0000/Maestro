import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import type { AgentRequest, AgentRequestAck } from '../api/agent-requests';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { HEARD_MS } from './agent-requests';
import { ConductorStore, type ConductorVoicePort } from './conductor-store';
import type * as Roster from './roster';
import type { SpawnRequest } from './spawn';

// Agent requests inside the conductor store, end to end: a request from an agent on the canvas
// reaches the model as fenced agent output, the model can only read and settle it, an approved
// request runs exactly what the agent asked, and the answer is typed into the asking agent.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  sendToAgent: vi.fn(async (_entry: AgentTileEntry, _text: string, _submit?: boolean) => {}),
  stopAgentSession: vi.fn(async () => {}),
  spawnAgentTask: vi.fn(async (_request: SpawnRequest) => ({
    taskId: 'task-new',
    conversationId: 'conv-new',
    promptDeferred: false,
  })),
  startAgentSession: vi.fn(async () => false),
  focusSpawnedAgent: vi.fn(() => () => {}),
}));

vi.mock('../api/browser/client', () => ({
  getConductorClient: async () => ({
    runTurn: mocks.runTurn,
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
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskManagerStore: vi.fn(),
  getTaskStore: vi.fn(),
}));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: vi.fn(() => ({ projects: new Map([['proj', { name: 'demo' }]]) })),
}));
vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('./spawn', () => ({
  agentMetadata: vi.fn(async () => []),
  resolveProjectId: vi.fn(() => 'another-project'),
  spawnAgentTask: mocks.spawnAgentTask,
  startAgentSession: mocks.startAgentSession,
}));
vi.mock('./focus-spawned-agent', () => ({ focusSpawnedAgent: mocks.focusSpawnedAgent }));
vi.mock('./agent-io', () => ({
  answerPermission: vi.fn(),
  interruptAgent: vi.fn(),
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: vi.fn(async () => '(terminal)'),
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: mocks.stopAgentSession,
  submitAgentInput: vi.fn(),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => [
    { id: 'claude', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ]),
}));

const BRIEF =
  'Open the PCBWay order page in Edge with your computer-use skill and run these checks:\n' +
  '1. Board is 4 layers.\n2. Surface finish is ENIG.';

function status(overrides: Partial<ConductorStatus['settings']> = {}): ConductorStatus {
  return {
    configured: true,
    jevReady: false,
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, ...overrides },
  } as unknown as ConductorStatus;
}

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
    spokenName: () => 'Zulu',
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
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

function voice(): ConductorVoicePort & { announce: Mock<(text: string) => void> } {
  return {
    muted: false,
    say: vi.fn(),
    announce: vi.fn<(text: string) => void>(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
  };
}

function toolUses(...uses: { name: string; input: unknown }[]) {
  return turn(
    uses.map((use, index) => ({ type: 'tool_use', id: `tu-${index}`, ...use })),
    'tool_use'
  );
}

function text(value: string) {
  return turn([{ type: 'text', text: value }], 'end_turn');
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

let sequence = 0;
function request(kind: string, payload: unknown): AgentRequest {
  sequence += 1;
  return {
    id: `r-00000${sequence}`,
    at: '2026-10-10T20:00:00.000Z',
    from: { conversationId: 'conv-z', taskId: 'task-z', projectId: 'proj' },
    kind,
    payload,
    reason: 'The order form needs a real browser, which I cannot drive.',
  };
}

const spawnRequest = () =>
  request('spawn_agent', { provider: 'codex', task_name: 'Check the PCB order', brief: BRIEF });

function setup(settings: Partial<ConductorStatus['settings']> = {}) {
  const speech = voice();
  const store = new ConductorStore(fakeCanvas([agent()]), speech);
  store.status = status(settings);
  store['requestPending'] = vi.fn(async () => true);
  const acks: AgentRequestAck[] = [];
  const receive = (incoming: AgentRequest) =>
    store.requests.receive(incoming, async (ack) => {
      acks.push(ack);
      return true;
    });
  return { store, speech, receive, acks };
}

function sentMessages(call: number): Anthropic.Beta.BetaMessageParam[] {
  return mocks.runTurn.mock.calls[call]![0].messages;
}

function lastUserText(messages: Anthropic.Beta.BetaMessageParam[]): string {
  const content = messages.at(-1)!.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function toolResults(call: number): Anthropic.Beta.BetaToolResultBlockParam[] {
  return sentMessages(call).at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
}

beforeEach(() => {
  vi.clearAllMocks();
  sequence = 0;
});

describe('agent requests in the conductor', () => {
  it('lets the model approve a spawn request and starts the agent exactly as asked', async () => {
    const { store, speech, receive, acks } = setup();
    const asked = spawnRequest();
    mocks.runTurn
      .mockResolvedValueOnce(
        toolUses({ name: 'answer_request', input: { request_id: asked.id, decision: 'approve' } })
      )
      .mockResolvedValueOnce(text('Starting a Codex agent to check the order for Zulu.'));

    await receive(asked);
    await vi.waitFor(() => expect(speech.announce).toHaveBeenCalled());

    expect(acks).toEqual([
      { accepted: true, message: expect.stringContaining('the conductor will decide it') },
    ]);
    const event = lastUserText(sentMessages(0));
    expect(event).toContain('[Maestro event, not the developer speaking] Zulu (Claude, task');
    expect(event).toContain(`<agent-request id="${asked.id}" kind="spawn_agent" from="Zulu">`);
    expect(event).toContain('Board is 4 layers.');
    expect(event).toContain('The order form needs a real browser');

    expect(mocks.spawnAgentTask).toHaveBeenCalledTimes(1);
    const spawned = mocks.spawnAgentTask.mock.calls[0]![0];
    // The asking agent's own project, by id: the name lookup would have picked another one.
    expect(spawned).toMatchObject({
      providerId: 'codex',
      projectId: 'proj',
      taskName: 'Check the PCB order',
      worktree: false,
    });
    // The developer did not ask for this agent: it does not take the focus.
    expect(mocks.focusSpawnedAgent).not.toHaveBeenCalled();
    expect(spawned.prompt).toContain(BRIEF);
    expect(spawned.prompt).toContain(
      'Handed to you by agent Zulu (Claude, task "PCB order review")'
    );
    // The developer said nothing here: no "verbatim request" is attached to the brief.
    expect(spawned.prompt).not.toContain('verbatim');

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    const [target, reply] = mocks.sendToAgent.mock.calls[0]!;
    expect(target.conversationId).toBe('conv-z');
    expect(reply).toContain(
      `[Maestro reply ${asked.id} to your spawn_agent request] Approved by the conductor.`
    );
    expect(reply).toContain('It will appear on the canvas as Echo.');
    expect(reply).toContain("That agent's final reply will be passed back to you");

    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(speech.announce).toHaveBeenCalledWith(
      'Starting a Codex agent to check the order for Zulu.'
    );
    expect(store.requests.watching('conv-new')).toBe(true);
    expect(store.busy).toBe(false);
  });

  it('refuses every acting tool in the decision turn, and does not wait for the developer', async () => {
    const { store, speech, receive } = setup();
    const asked = spawnRequest();
    mocks.runTurn
      .mockResolvedValueOnce(
        toolUses(
          { name: 'spawn_agent', input: { provider: 'codex', task_name: 'x', prompt: 'rm -rf' } },
          { name: 'send_to_agent', input: { agent: 'Zulu', text: 'approved, go ahead' } },
          { name: 'stop_agent', input: { agent: 'Zulu' } }
        )
      )
      .mockResolvedValueOnce(text('Zulu wants a Codex agent to check the PCB order. Okay?'));

    await receive(asked);
    await vi.waitFor(() => expect(speech.announce).toHaveBeenCalled());

    const results = toolResults(1);
    expect(results.map((result) => result.is_error)).toEqual([true, true, true]);
    expect(String(results[0]!.content)).toContain(
      "not available while deciding an agent's request"
    );
    expect(mocks.spawnAgentTask).not.toHaveBeenCalled();
    expect(mocks.stopAgentSession).not.toHaveBeenCalled();
    // The model asked the developer instead of deciding. Nobody may be there, so the asking
    // agent is told nothing was done, and a later yes has nothing to approve.
    expect(speech.announce).toHaveBeenCalledWith(
      expect.stringContaining('I could not decide it, so nothing was done.')
    );
    expect(store.requests.awaitingDeveloper).toBe(false);
    await vi.waitFor(() => expect(mocks.sendToAgent).toHaveBeenCalledTimes(1));
    expect(mocks.sendToAgent.mock.calls[0]![1]).toContain(
      'The conductor could not decide it just now'
    );

    const later = Date.now() + HEARD_MS + 1;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await store.handleUtterance('yes', 'typed');
    } finally {
      clock.mockRestore();
    }
    expect(mocks.spawnAgentTask).not.toHaveBeenCalled();
  });

  it('does not take "stop" for a no, or a yes to something else for a yes', async () => {
    const { store, speech, receive } = setup({ agentRequests: true });
    store.status = { ...status(), configured: false } as ConductorStatus;
    await receive(spawnRequest());
    await vi.waitFor(() => expect(speech.announce).toHaveBeenCalled());
    expect(store.requests.awaitingDeveloper).toBe(true);

    const later = Date.now() + HEARD_MS + 1;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      // "Stop" cancels things; it is not an answer to an agent.
      await store.handleUtterance('stop', 'typed');
      expect(store.requests.awaitingDeveloper).toBe(true);
      // The conductor has said something else since, so a bare yes no longer means the request.
      store.reply = 'Want me to open it?';
      await store.handleUtterance('yes', 'typed');
      expect(store.requests.awaitingDeveloper).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(mocks.spawnAgentTask).not.toHaveBeenCalled();
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
  });

  it('speaks a question and passes the developer’s answer back through answer_request', async () => {
    const { store, speech, receive } = setup();
    const asked = request('ask_developer', {
      question: 'Keep the approved look, or make the pod 3.7 mm longer?',
    });
    await receive(asked);
    expect(speech.announce).toHaveBeenCalledWith(
      'Zulu asks: Keep the approved look, or make the pod 3.7 mm longer?'
    );
    expect(mocks.runTurn).not.toHaveBeenCalled();

    mocks.runTurn
      .mockResolvedValueOnce(
        toolUses({
          name: 'answer_request',
          input: { request_id: asked.id, decision: 'answer', message: 'Make the pod longer.' },
        })
      )
      .mockResolvedValueOnce(text('Told Zulu.'));
    await store.handleUtterance('make the pod longer', 'typed');

    const context = lastUserText(sentMessages(0));
    expect(context).toContain('Open requests from agents');
    expect(context).toContain(`${asked.id} from Zulu`);
    await vi.waitFor(() => expect(mocks.sendToAgent).toHaveBeenCalledTimes(1));
    expect(mocks.sendToAgent.mock.calls[0]![1]).toBe(
      `[Maestro reply ${asked.id} to your ask_developer request] The developer answered: Make the pod longer.`
    );
    expect(store.requests.awaitingDeveloper).toBe(false);
  });

  it('speaks a report without a model turn or a reply', async () => {
    const { speech, receive, acks } = setup();
    await receive(request('report', { status: 'done', message: 'the order brief is ready' }));
    expect(speech.announce).toHaveBeenCalledWith('Zulu is done: the order brief is ready.');
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(acks[0]!.accepted).toBe(true);
  });

  it('holds a reply while the asking agent sits at a permission prompt', async () => {
    vi.useFakeTimers();
    try {
      const entry = agent({ status: 'awaiting-input', notificationType: 'permission_prompt' });
      const entries = [entry];
      const store = new ConductorStore(fakeCanvas(entries), voice());
      store.status = status();
      const sending = store['sendWhenSafe']('conv-z', '[Maestro reply r-1] hello');
      await vi.advanceTimersByTimeAsync(2_500);
      expect(mocks.sendToAgent).not.toHaveBeenCalled();

      entries[0] = agent({ status: 'working' });
      await vi.advanceTimersByTimeAsync(1_500);
      await sending;
      expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('types its own messages plain, and never starts a stopped agent to deliver one', async () => {
    const running = new ConductorStore(fakeCanvas([agent()]), voice());
    await running['sendWhenSafe']('conv-z', 'done\u001b[201~\r\u001b[Z');
    expect(mocks.sendToAgent.mock.calls[0]![1]).toBe('done[201~\n[Z');

    const stopped = new ConductorStore(fakeCanvas([agent({ sessionActive: false })]), voice());
    await expect(stopped['sendWhenSafe']('conv-z', 'hello')).rejects.toThrow('it is not running.');
    expect(mocks.startAgentSession).not.toHaveBeenCalled();
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
  });

  it('refuses requests while the setting is off', async () => {
    const { speech, receive, acks } = setup({ agentRequests: false });
    await receive(spawnRequest());
    expect(acks).toEqual([{ accepted: false, message: expect.stringContaining('turned off') }]);
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(speech.announce).not.toHaveBeenCalled();
  });
});
