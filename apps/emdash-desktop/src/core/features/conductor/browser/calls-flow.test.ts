import type Anthropic from '@anthropic-ai/sdk';
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import { MAESTRO_EVENT_MARK } from '../api/history';
import {
  CANCEL_WINDOW_MS,
  ConductorStore,
  type ConductorCaptureEvent,
  type ConductorVoicePort,
} from './conductor-store';
import { focusedConversationId, setCallFocus } from './roster';
import type * as Roster from './roster';

// Calls end to end inside the conductor store: what agents need arrives one caller at a time,
// picking a call up binds the developer's next words to that caller, and a yes only counts for
// the prompt it was said to.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  sendToAgent: vi.fn(async (_entry: unknown, _text: string, _submit: boolean) => {}),
  answerPermission: vi.fn(async () => {}),
  readAgentOutput: vi.fn(async (): Promise<string> => '(terminal)'),
  submitAgentInput: vi.fn(async (_entry: unknown) => {}),
  interruptAgent: vi.fn(async (_entry: unknown) => {}),
  // What the main process reports; activating a store refreshes from it.
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
  spawnAgentTask: vi.fn(),
  startAgentSession: vi.fn(),
}));
vi.mock('./agent-io', () => ({
  answerPermission: mocks.answerPermission,
  interruptAgent: mocks.interruptAgent,
  lastMeaningfulLine: vi.fn(),
  readAgentOutput: mocks.readAgentOutput,
  readFinalChatReply: vi.fn(async () => null),
  readFinishedTerminal: vi.fn(async () => null),
  sendToAgent: mocks.sendToAgent,
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: mocks.submitAgentInput,
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function status(overrides: Partial<ConductorStatus['settings']> = {}): ConductorStatus {
  return {
    configured: true,
    jevReady: false,
    settings: {
      ...DEFAULT_CONDUCTOR_SETTINGS,
      calls: 'spoken',
      completionFollowUp: false,
      ...overrides,
    },
  } as unknown as ConductorStatus;
}

const NAMES: Record<string, string> = { 'conv-atlas': 'Atlas', 'conv-bravo': 'Bravo' };

function agent(name: 'atlas' | 'bravo', overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
  return {
    tileId: `tile-${name}`,
    conversationId: `conv-${name}`,
    taskId: `task-${name}`,
    projectId: 'proj',
    projectName: 'demo',
    taskName: `${name} task`,
    providerId: 'claude',
    conversationTitle: 'Claude',
    type: 'pty',
    status: 'completed',
    seen: false,
    notificationType: null,
    completionSummary: 'fixed the tests',
    completionReport: null,
    taskProvisioned: true,
    sessionActive: true,
    workspaceId: `ws-${name}`,
    linesAdded: 0,
    linesDeleted: 0,
    createdAt: null,
    lastInteractedAt: null,
    ...overrides,
  } as AgentTileEntry;
}

function fakeCanvas(entries: AgentTileEntry[]): CanvasStore {
  const insights = new Map<string, Record<string, unknown>>();
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
    insights,
    spokenName: (conversationId: string) => NAMES[conversationId] ?? conversationId,
    formerNamesOf: () => [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: (tileId: string) => entries.find((entry) => entry.tileId === tileId),
    insight: (conversationId: string) => insights.get(conversationId),
    setInsight: (conversationId: string, insight: Record<string, unknown>) =>
      insights.set(conversationId, { ...insights.get(conversationId), ...insight }),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

type FakeVoice = ConductorVoicePort & {
  capturing: boolean;
  spoken: { text: string; voice: string | undefined }[];
  /** Ends the sentence being spoken. */
  endSpeech(result?: 'ended' | 'cancelled'): Promise<void>;
  capture(event: ConductorCaptureEvent): void;
  say: Mock<(text: string, interactionId?: string) => void>;
};

function voice(): FakeVoice {
  let handler: ((event: ConductorCaptureEvent) => void) | null = null;
  const waiting: ((result: 'ended' | 'cancelled') => void)[] = [];
  const fake: FakeVoice = {
    muted: false,
    capturing: false,
    spoken: [],
    say: vi.fn<(text: string, interactionId?: string) => void>(),
    announce: vi.fn(),
    setMuted: vi.fn(),
    setTranscriptHandler: vi.fn(),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
    setCaptureHandler: (next) => {
      handler = next;
    },
    setTapGate: vi.fn(),
    speak: (text, options) => {
      fake.spoken.push({ text, voice: options?.voice });
      return new Promise((resolve) => waiting.push(resolve));
    },
    endSpeech: async (result = 'ended') => {
      waiting.shift()?.(result);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    },
    capture: (event) => {
      fake.capturing = event.type === 'start';
      handler?.(event);
    },
  };
  return fake;
}

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

function setup(
  entries: AgentTileEntry[] = [agent('atlas'), agent('bravo')],
  settings: Partial<ConductorStatus['settings']> = {}
) {
  const speech = voice();
  const canvas = fakeCanvas(entries);
  const store = new ConductorStore(canvas, speech);
  mocks.status = status(settings);
  store.status = status(settings);
  store.activate();
  return {
    store,
    speech,
    canvas,
    announce: (batch: AgentTileEntry[]) => store['announceBatch'](batch),
  };
}

/** Lets the conductor's promise chains settle without moving the clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}

function lastUserText(call: number): string {
  const messages: Anthropic.Beta.BetaMessageParam[] = mocks.runTurn.mock.calls[call]![0].messages;
  const content = messages.at(-1)!.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.readAgentOutput.mockResolvedValue('(terminal)');
  setCallFocus(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('calls', () => {
  it('delivers each agent as its own call instead of one batched announcement', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);

    await announce([atlas, bravo]);

    expect(speech.announce).not.toHaveBeenCalled();
    expect(speech.spoken).toHaveLength(1);
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    expect(store.calls.waiting.map((call) => call.agentName)).toEqual(['Bravo']);
    expect(canvas.insight('conv-atlas')).toMatchObject({ onLine: true });
    expect(store.reply).toBe(speech.spoken[0]?.text);
    store.dispose();
  });

  it('keeps the batched announcement when calls are off', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo], { calls: 'off' });
    await announce([atlas, bravo]);
    expect(speech.announce).toHaveBeenCalledTimes(1);
    expect(store.calls.current).toBeNull();
    store.dispose();
  });

  it('binds what the developer says after picking a call up to that caller', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas]);
    await speech.endSpeech();
    expect(store.calls.current?.state).toBe('on-line');

    // Nothing is focused, so without the call "it" would mean nobody.
    expect(focusedConversationId(store['canvas'])).toBeNull();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');
    speech.capturing = false;

    const done = store.handleUtterance('tell it to fix the lint error too', 'voice', id);
    await settle();
    // The cancel window is read out by the system voice, with the target in it.
    expect(store.pending?.label).toContain('Send to Atlas');
    expect(store.pending?.held).toBe(true);
    expect(speech.spoken.at(-1)).toMatchObject({ voice: 'system' });
    expect(speech.spoken.at(-1)?.text).toContain('Send to Atlas');
    expect(mocks.sendToAgent).not.toHaveBeenCalled();

    await speech.endSpeech();
    expect(store.pending?.held).toBe(false);
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS);
    await done;

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendToAgent.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conv-atlas' });
    expect(mocks.sendToAgent.mock.calls[0]?.[1]).toBe('fix the lint error too');
    // The exchange is over: the call is released and "it" is the window in front again.
    expect(store.calls.pickedUp).toBeNull();
    expect(focusedConversationId(store['canvas'])).toBeNull();
    store.dispose();
  });

  it('tells the model who the developer is answering', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capturing = false;
    mocks.runTurn.mockResolvedValueOnce(text('Okay.'));

    await store.handleUtterance('make sure the lint error is gone as well', 'voice', id);

    const sent = lastUserText(0);
    expect(sent).toContain("The developer picked up Atlas's call");
    expect(sent).toContain('Focused agent: Atlas (call: the developer picked up its call)');
    store.dispose();
  });

  it('puts a call back on the line when the developer opened the microphone and said nothing', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capture({ type: 'end', interactionId: id, reason: 'cancelled' });
    expect(store.calls.current?.state).toBe('on-line');
    expect(store['pickup']).toBeNull();
    store.dispose();
  });

  it('skips and holds calls by voice command', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas, bravo]);
    await speech.endSpeech();

    await store.handleUtterance('skip', 'typed');
    expect(store.calls.current?.call.agentName).toBe('Bravo');

    await store.handleUtterance('hold my calls', 'typed');
    expect(store.calls.held).toBe(true);
    expect(store.reply).toBe('Holding your calls.');
    store.dispose();
  });
});

describe('an agent that asked the developer a question', () => {
  async function ask(store: ConductorStore) {
    await store.requests.receive(
      {
        id: 'r-1',
        at: new Date().toISOString(),
        from: { conversationId: 'conv-atlas', taskId: 'task-atlas', projectId: 'proj' },
        kind: 'ask_developer',
        payload: { question: 'Should the retry limit be configurable?' },
      },
      async () => true
    );
    await settle();
  }

  it('calls with the question, and takes what the developer says next as the answer', async () => {
    const atlas = agent('atlas', { status: 'working' });
    const { store, speech } = setup([atlas]);
    await ask(store);

    expect(store.calls.current?.call).toMatchObject({
      kind: 'question',
      agentName: 'Atlas',
      requestId: 'r-1',
    });
    expect(speech.spoken[0]?.text).toContain('Should the retry limit be configurable?');
    await speech.endSpeech();

    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capturing = false;
    const done = store.handleUtterance('It should, default three', 'voice', id);
    await settle();
    // Their words are read back with who they go to, then sent after the cancel window.
    expect(store.pending?.label).toBe('Answer Atlas: “It should, default three”');
    expect(store.pending?.detail).toBe('It should, default three');
    await speech.endSpeech();
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS);
    await done;
    await settle();

    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendToAgent.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conv-atlas' });
    expect(mocks.sendToAgent.mock.calls[0]?.[1]).toContain(
      'The developer answered: It should, default three'
    );
    expect(store.requests.awaiting('r-1')).toBe(false);
    store.dispose();
  });

  it('sends nothing when the developer cancels the read-back', async () => {
    const atlas = agent('atlas', { status: 'working' });
    const { store, speech } = setup([atlas]);
    await ask(store);
    await speech.endSpeech();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capturing = false;
    const done = store.handleUtterance('It should, default three', 'voice', id);
    await settle();
    store.cancelPending();
    await done;

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    // The question is still open: nothing was answered for the developer.
    expect(store.requests.awaiting('r-1')).toBe(true);
    store.dispose();
  });
});

describe('consent is bound to its prompt', () => {
  it('ignores a yes the developer began before the prompt existed', async () => {
    const { store, speech } = setup();
    const early = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: early, origin: 'user' });

    // The prompt opens while they are still speaking: it is not armed.
    const decision = store.requestPending("Stop Atlas's session", 'confirm');
    expect(store.pending?.held).toBe(true);
    speech.capturing = false;

    await store.handleUtterance('yes', 'voice', early);
    expect(store.pending).not.toBeNull();
    expect(store.pending?.held).toBe(false);

    // A yes begun after it was armed counts.
    const late = crypto.randomUUID();
    vi.advanceTimersByTime(50);
    speech.capture({ type: 'start', interactionId: late, origin: 'user' });
    speech.capturing = false;
    await store.handleUtterance('yes', 'voice', late);
    await expect(decision).resolves.toBe(true);
    store.dispose();
  });

  it('stops the countdown while the developer is speaking and resumes when they said nothing', async () => {
    const { store, speech } = setup();
    const decision = store.requestPending('Send to Atlas: “hi”', 'countdown');
    vi.advanceTimersByTime(1_000);

    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.pending?.held).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(store.pending).not.toBeNull();

    speech.capture({ type: 'end', interactionId: id, reason: 'cancelled' });
    expect(store.pending?.held).toBe(false);
    vi.advanceTimersByTime(699);
    expect(store.pending).not.toBeNull();
    vi.advanceTimersByTime(1);
    await expect(decision).resolves.toBe(true);
    store.dispose();
  });

  it('cancels on anything the developer says once it is armed, as before', async () => {
    const { store, speech } = setup();
    const decision = store.requestPending('Send to Atlas: “hi”', 'countdown');
    vi.advanceTimersByTime(500);
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capturing = false;
    mocks.runTurn.mockResolvedValueOnce(text('Okay.'));
    await store.handleUtterance('wait, not Atlas', 'voice', id);
    await expect(decision).resolves.toBe(false);
    store.dispose();
  });

  it('lets the developer answer a prompt by speaking over its read-back', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    const first = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: first, origin: 'user' });
    speech.capturing = false;
    const done = store.handleUtterance('tell it to rebase', 'voice', first);
    await settle();
    expect(store.pending?.armedAt).toBe(Number.POSITIVE_INFINITY);

    // "No" over the read-back: it has not finished, but they heard enough.
    const second = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: second, origin: 'user' });
    await speech.endSpeech('cancelled');
    speech.capturing = false;
    await store.handleUtterance('no', 'voice', second);
    await done;

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(store.pending).toBeNull();
    store.dispose();
  });

  it('does not let a queued yes confirm something that appeared after it was said', async () => {
    const { store, speech } = setup();
    let answer: (value: unknown) => void = () => {};
    mocks.runTurn.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const running = store.handleUtterance('ask the model something long', 'typed');
    await settle();

    // Said while the conductor is busy: it waits its turn.
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capturing = false;
    await store.handleUtterance('yes', 'voice', id);
    expect(store['queued']?.text).toBe('yes');

    vi.advanceTimersByTime(1_000);
    const decision = store.requestPending("Stop Atlas's session", 'confirm');
    answer(text('Done thinking.'));
    await running;
    await settle();

    // The queued yes ran, and the prompt it never saw is still waiting.
    expect(store['queued']).toBeNull();
    expect(store.pending?.label).toBe("Stop Atlas's session");
    store.cancelPending();
    await expect(decision).resolves.toBe(false);
    store.dispose();
  });

  it('keeps a prompt armed for speech over its read-back after it replaced another one', async () => {
    const { store, speech } = setup();
    store['turnSource'] = 'voice';
    const first = store.requestPending("Stop Atlas's session", 'confirm');
    const second = store.requestPending("Archive Bravo's task", 'confirm');
    await expect(first).resolves.toBe(false);
    // The first read-back was cut off by the second; the second is still being read.
    await speech.endSpeech('cancelled');
    expect(store.pending?.armedAt).toBe(Number.POSITIVE_INFINITY);

    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(Number.isFinite(store.pending?.armedAt)).toBe(true);
    speech.capturing = false;
    await store.handleUtterance('no', 'voice', id);
    await expect(second).resolves.toBe(false);
    store.dispose();
  });

  it('does not press Enter in a permission prompt that changed while the developer was asked', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store } = setup([bravo]);
    mocks.readAgentOutput
      .mockResolvedValueOnce('Run git push origin main?\n1. Yes  2. No')
      .mockResolvedValueOnce('Run rm -rf build?\n1. Yes  2. No');

    const done = store.handleUtterance('allow Bravo', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    store.confirmPending();
    await done;

    expect(mocks.answerPermission).not.toHaveBeenCalled();
    expect(store.reply).toContain('different prompt');
    store.dispose();
  });

  it('answers a permission prompt that stayed the same, whatever its counters show', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store } = setup([bravo]);
    mocks.readAgentOutput
      .mockResolvedValueOnce(
        'Run git push origin main?\n1. Yes  2. No\n(3s · 1.2k tokens · esc to interrupt)'
      )
      .mockResolvedValueOnce(
        'Run git push origin main?\n1. Yes  2. No\n(9s · 4.7k tokens · esc to interrupt)'
      );

    const done = store.handleUtterance('allow Bravo', 'typed');
    await settle();
    store.confirmPending();
    await done;

    expect(mocks.answerPermission).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('stopping a turn', () => {
  it('ends a model turn at its next step and runs none of what it asked for', async () => {
    const { store } = setup();
    let answer: (value: unknown) => void = () => {};
    mocks.runTurn.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();
    expect(store.busy).toBe(true);

    await store.handleUtterance('stop', 'typed');
    answer(toolUse('send_to_agent', { agent: 'Atlas', text: 'do the thing' }));
    await done;

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(store.reply).toBe('Cancelled.');
    expect(store.pending).toBeNull();
    expect(store['history']).toEqual([]);
    expect(store.busy).toBe(false);
    store.dispose();
  });
});

describe('a yes to something an agent suggested', () => {
  const eventHistory: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: `${MAESTRO_EVENT_MARK} Atlas finished its turn.` },
    { role: 'assistant', content: [{ type: 'text', text: 'Atlas is done. Tell Bravo to merge?' }] },
  ];

  it('turns the cancel window into a confirmation', async () => {
    const { store } = setup();
    store['history'] = [...eventHistory];
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Bravo', text: 'merge it' }))
      .mockResolvedValueOnce(text('Not sent.'));

    const done = store.handleUtterance('yes', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    // A countdown would have sent it by now.
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS * 2);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.cancelPending();
    await done;
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });

  it('asks before a tool that would otherwise act without asking', async () => {
    const { store, canvas } = setup();
    const addNote = vi.fn();
    (canvas as unknown as { addNote: typeof addNote }).addNote = addNote;
    store['history'] = [...eventHistory];
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('add_note', { text: 'merge Atlas' }))
      .mockResolvedValueOnce(text('Okay.'));

    const done = store.handleUtterance('yes', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    expect(store.pending?.label).toContain('merge Atlas');
    expect(addNote).not.toHaveBeenCalled();
    store.cancelPending();
    await done;
    expect(addNote).not.toHaveBeenCalled();
    store.dispose();
  });

  it('leaves an instruction in the developer own words on its usual cancel window', async () => {
    const { store } = setup();
    store['history'] = [...eventHistory];
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Bravo', text: 'merge it' }))
      .mockResolvedValueOnce(text('Sent.'));

    const done = store.handleUtterance('have Bravo merge what Atlas did', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('countdown');
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS);
    await done;
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('the talk line', () => {
  function line(said = true) {
    return {
      ready: vi.fn(() => true),
      answer: vi.fn(async () => true),
      say: vi.fn(async () => said),
      note: vi.fn(),
      spoke: vi.fn(),
    };
  }

  it('lets the voice model read, and nothing else', async () => {
    const { store } = setup();
    const addressed = vi.spyOn(store['context'], 'noteAddressed');
    mocks.readAgentOutput.mockResolvedValueOnce('running tests with token sk-ant-abcdefghijklmnop');

    const read = await store.voiceRead('read_agent', { agent: 'Atlas' });
    expect(read).toContain('running tests');
    expect(read).not.toContain('sk-ant-abcdefghijklmnop');
    // Reading does not make Atlas "it".
    expect(addressed).not.toHaveBeenCalled();

    expect(await store.voiceRead('send_to_agent', { agent: 'Atlas', text: 'hi' })).toContain(
      'not something you can do'
    );
    expect(await store.voiceRead('focus_agent', { agent: 'Atlas' })).toContain(
      'not something you can do'
    );
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });

  it('takes steering and cancel words with no key, and refuses everything that acts', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas, bravo]);
    await speech.endSpeech();

    expect(store.hearOnLine("what's everyone doing")).toBe('talk');
    expect(store.hearOnLine('tell Atlas to rebase onto main')).toBe('needs-key');
    expect(store.hearOnLine('focus Bravo')).toBe('needs-key');
    expect(mocks.sendToAgent).not.toHaveBeenCalled();

    expect(store.hearOnLine('skip')).toBe('handled');
    expect(store.calls.current?.call.agentName).toBe('Bravo');
    store.dispose();
  });

  it('lets a spoken no cancel what is pending, and never lets a yes confirm it', async () => {
    const { store } = setup();
    const first = store.requestPending("Stop Atlas's session", 'confirm');
    expect(store.hearOnLine('yes')).toBe('needs-key');
    expect(store.pending).not.toBeNull();
    expect(store.hearOnLine('no')).toBe('handled');
    await expect(first).resolves.toBe(false);
    store.dispose();
  });

  it('asks before every action when the voice model hands a request off', async () => {
    const { store } = setup();
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Atlas', text: 'rebase' }))
      .mockResolvedValueOnce(text('Not sent.'));

    const handed = store.handOffFromVoice('can you get Atlas to rebase');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS * 2);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.cancelPending();

    await expect(handed).resolves.toBe('Not sent.');
    // What the model was given is the developer's sentence, word for word.
    expect(lastUserText(0)).toContain('can you get Atlas to rebase');
    expect(store.busy).toBe(false);
    store.dispose();
  });

  it('hands key-started talk to the line, and typed talk to the model as before', async () => {
    const { store } = setup();
    const talk = line();
    store.setTalkLine(talk);
    await expect(store['answerOnLine']('how is it going', 'voice')).resolves.toBe(true);
    expect(talk.answer).toHaveBeenCalledWith('how is it going');
    await expect(store['answerOnLine']('how is it going', 'typed')).resolves.toBe(false);
    store.setTalkLine(null);
    await expect(store['answerOnLine']('how is it going', 'voice')).resolves.toBe(false);
    store.dispose();
  });

  it('says replies and calls with the line, and falls back when the line cannot', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    const talk = line();
    store.setTalkLine(talk);
    await announce([atlas]);
    await settle();
    expect(talk.say).toHaveBeenCalledTimes(1);
    expect(speech.spoken).toEqual([]);

    talk.say.mockResolvedValue(false);
    await store.handleUtterance('hold my calls', 'voice');
    await settle();
    expect(speech.spoken.at(-1)?.text).toBe('Holding your calls.');
    store.dispose();
  });

  it('reads a permission call in the system voice even with a line open', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store, speech, announce } = setup([bravo]);
    const talk = line();
    store.setTalkLine(talk);
    await announce([bravo]);
    await settle();
    expect(talk.say).not.toHaveBeenCalled();
    expect(speech.spoken.at(-1)).toMatchObject({ voice: 'system' });
    expect(store.calls.current?.call.kind).toBe('permission');
    store.dispose();
  });
});

// ── What an independent review found; each test below failed before its fix ──────────────────

/** Opens the microphone for one utterance and closes it, as the voice store does. */
function capture(speech: FakeVoice): string {
  const id = crypto.randomUUID();
  speech.capture({ type: 'start', interactionId: id, origin: 'user' });
  speech.capturing = false;
  return id;
}

/** A model turn that has not answered yet; `answer` delivers what it says. */
function slowTurn(): (value: unknown) => void {
  let answer: (value: unknown) => void = () => {};
  mocks.runTurn.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  return (value) => answer(value);
}

describe('stop stops what the model asked for', () => {
  it('sends nothing when stop was begun before the cancel window appeared', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();

    // The developer starts saying "stop" while the model is still thinking, and its tool call
    // lands before their words do.
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    answer(toolUse('send_to_agent', { agent: 'Atlas', text: 'delete the build directory' }));
    await settle();
    expect(store.pending?.kind).toBe('countdown');
    expect(store.pending?.held).toBe(true);

    speech.capturing = false;
    await store.handleUtterance('stop', 'voice', id);
    expect(store.pending).toBeNull();
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 200);
    await done;

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(store.reply).toBe('Cancelled.');
    store.dispose();
  });

  it('runs none of the other things the model asked for in the same step', async () => {
    const { store } = setup(undefined, { calls: 'off' });
    mocks.runTurn.mockResolvedValueOnce(
      turn(
        [
          {
            type: 'tool_use',
            id: 'a',
            name: 'send_to_agent',
            input: { agent: 'Atlas', text: '1' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'send_to_agent',
            input: { agent: 'Bravo', text: '2' },
          },
        ],
        'tool_use'
      )
    );
    const done = store.handleUtterance('have them both do it', 'typed');
    await settle();
    expect(store.pending?.label).toContain('Send to Atlas');
    vi.advanceTimersByTime(300);
    await store.handleUtterance('stop', 'typed');
    await settle();
    expect(store.pending).toBeNull();
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 100);
    await done;

    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(store.reply).toBe('Cancelled.');
    store.dispose();
  });

  it('takes a no to a confirmation as an answer to that one question', async () => {
    const { store } = setup(undefined, { calls: 'off' });
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('stop_agent', { agent: 'Atlas' }))
      .mockResolvedValueOnce(text('Left Atlas running.'));
    const done = store.handleUtterance('is Atlas stuck, and if so stop it', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    await store.handleUtterance('no', 'typed');
    await done;
    // The model heard the refusal and finished its turn.
    expect(mocks.runTurn).toHaveBeenCalledTimes(2);
    expect(store.reply).toBe('Left Atlas running.');
    store.dispose();
  });

  it('cancels a cancel window over other words the developer was already saying', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    answer(toolUse('send_to_agent', { agent: 'Atlas', text: 'push it' }));
    await settle();
    expect(store.pending?.kind).toBe('countdown');

    mocks.runTurn.mockResolvedValue(text('Nothing was sent.'));
    speech.capturing = false;
    await store.handleUtterance('hang on that is the wrong agent', 'voice', id);
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 200);
    await done;
    await settle();
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });

  it('lets a cancel window run when the earlier words were only a yes to something else', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    answer(toolUse('send_to_agent', { agent: 'Atlas', text: 'push it' }));
    await settle();
    mocks.runTurn.mockResolvedValue(text('Sent.'));

    speech.capturing = false;
    await store.handleUtterance('yes', 'voice', id);
    // Not a yes to this prompt, and not a reason to drop it: its clock runs.
    expect(store.pending?.held).toBe(false);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 200);
    await done;
    await settle();
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('dictation', () => {
  it('does not freeze a confirmation that was waiting when it began', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    let settled: boolean | null = null;
    void store.requestPending("Stop Atlas's session", 'confirm').then((value) => (settled = value));
    vi.advanceTimersByTime(1_000);
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.pending?.held).toBe(true);
    speech.capturing = false;
    await store.dictate('some dictated text', id);
    expect(store.pending?.held).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    store.dispose();
  });

  it('goes to the caller after a pick-up even while a turn is running', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();

    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');
    speech.capturing = false;
    await store.dictate('yes go ahead and push', id);

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendToAgent.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conv-atlas' });
    // The running turn still means the window in front by "it".
    expect(focusedConversationId(canvas)).toBe('conv-bravo');
    expect(store.calls.current).toBeNull();
    answer(text('ok'));
    await done;
    store.dispose();
  });

  it('is sent with "send it" in the caller it was typed into, not the window in front', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    await store.dictate('yes go ahead and push', capture(speech));
    expect(store.reply).toBe('Typed into Atlas. Say "send it" to submit.');

    await store.handleUtterance('send it', 'voice', capture(speech));
    expect(mocks.submitAgentInput).toHaveBeenCalledTimes(1);
    expect(mocks.submitAgentInput.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'conv-atlas',
    });

    // Used once: the next "send it" is for the window in front again.
    await store.handleUtterance('send it', 'voice', capture(speech));
    expect(mocks.submitAgentInput.mock.calls[1]?.[0]).toMatchObject({
      conversationId: 'conv-bravo',
    });
    store.dispose();
  });

  it('is not sent into a permission prompt, where Enter would answer it', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store, canvas } = setup([bravo], { calls: 'off' });
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await store.handleUtterance('send it', 'typed');
    expect(mocks.submitAgentInput).not.toHaveBeenCalled();
    expect(store.reply).toContain('permission prompt');
    store.dispose();
  });
});

describe('a pick-up does not outlive its words', () => {
  it('gives the call back when the words were used up by a running turn', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas, bravo]);
    await speech.endSpeech();
    expect(store.calls.current?.state).toBe('on-line');

    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');
    speech.capturing = false;
    await store.handleUtterance('stop', 'voice', id);

    // Nobody answered Atlas: its call is on the line again, not "answering" for ever.
    expect(store['pickup']).toBeNull();
    expect(store.calls.current?.state).toBe('on-line');
    answer(text('whatever'));
    await done;
    await settle();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(store.calls.current?.call.agentName).toBe('Bravo');
    store.dispose();
  });

  it('hands the call to a second sentence said while the first still waits its turn', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();

    await store.handleUtterance('fix the lint error too', 'voice', capture(speech));
    // Waiting its turn: it keeps the call it picked up.
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');

    // The card still says "Answering Atlas": the second sentence is for Atlas as well.
    await store.handleUtterance('tell it to rebase', 'voice', capture(speech));
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');

    answer(text('ok'));
    await done;
    await settle();
    expect(store.pending?.label).toContain('Send to Atlas');
    store.cancelPending();
    await settle();
    expect(store.calls.current).toBeNull();
    store.dispose();
  });

  it('puts a call picked up for typing back when nothing was typed', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    expect(store.pickUpCall()).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store.calls.pickedUp).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.calls.current).toBeNull();

    // What is typed much later is for the window in front.
    const done = store.handleUtterance('tell it to rebase', 'typed');
    await settle();
    expect(store.pending?.label).toContain('Send to Bravo');
    store.cancelPending();
    await done;
    store.dispose();
  });

  it('does not lend its caller to the words that waited behind it', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();

    const answer = slowTurn();
    const done = store.handleUtterance(
      'make sure the lint error is gone as well',
      'voice',
      capture(speech)
    );
    await settle();
    expect(store.busy).toBe(true);
    await store.handleUtterance('tell it to rebase', 'voice', capture(speech));
    expect(store['queued']?.text).toBe('tell it to rebase');

    answer(text('Okay.'));
    await done;
    await settle();
    // The window in front is Bravo, and that is who "it" is for the words that waited.
    expect(store.pending?.label).toContain('Send to Bravo');
    store.cancelPending();
    await settle();
    store.dispose();
  });
});

describe('yes and no after a pick-up are for the caller', () => {
  const plan = {
    goal: 'g',
    projectId: 'proj',
    projectName: 'demo',
    subtasks: [],
    status: 'proposed',
    createdAt: 0,
  };

  it('answers the caller prompt, and leaves a plan that is waiting alone', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store, speech, announce } = setup([bravo]);
    await announce([bravo]);
    await settle();
    expect(store.calls.current?.call.kind).toBe('permission');
    await speech.endSpeech();
    // A plan arrives while the call is on the line.
    (store.plans as unknown as { plan: unknown }).plan = { ...plan };
    expect(store.plans.awaitingApproval).toBe(true);

    const done = store.handleUtterance('allow', 'voice', capture(speech));
    await settle();
    expect(store.pending?.label).toContain("Allow Bravo's permission request");
    store.confirmPending();
    await done;

    expect(mocks.answerPermission).toHaveBeenCalledTimes(1);
    expect(store.plans.awaitingApproval).toBe(true);
    store.dispose();
  });

  it('does not discard a waiting plan on a no that was for the caller', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    (store.plans as unknown as { plan: unknown }).plan = { ...plan };

    await store.handleUtterance('never mind', 'voice', capture(speech));
    expect(store.plans.awaitingApproval).toBe(true);
    expect(store.calls.current).toBeNull();
    store.dispose();
  });

  it('delivers no call while a plan waits for its yes', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    (store.plans as unknown as { plan: unknown }).plan = { ...plan };
    await announce([atlas]);
    await settle();
    expect(store.calls.current).toBeNull();
    expect(store.calls.waiting).toHaveLength(1);
    expect(speech.spoken).toEqual([]);
    store.dispose();
  });
});

describe('a reply that names no action', () => {
  const sendToBravo = () =>
    mocks.runTurn
      .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Bravo', text: 'merge it' }))
      .mockResolvedValueOnce(text('Not sent.'));

  it('asks before acting when it answers a call the developer picked up', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    // The newest stored turn is the developer's own: only the call makes this an agent's text.
    store['history'] = [
      { role: 'user', content: 'what is the weather' },
      { role: 'assistant', content: [{ type: 'text', text: 'No idea.' }] },
    ];
    await announce([atlas]);
    await speech.endSpeech();
    sendToBravo();
    const done = store.handleUtterance('yes', 'voice', capture(speech));
    await settle();
    expect(store.pending?.label).toContain('Send to Bravo');
    expect(store.pending?.kind).toBe('confirm');
    store.cancelPending();
    await done;
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });

  it('asks before acting whatever words of agreement follow an agent event', async () => {
    for (const words of ['sure', 'do that', 'okay', 'yes do it', 'sounds good, go ahead']) {
      const { store } = setup(undefined, { calls: 'off' });
      store['history'] = [
        { role: 'user', content: `${MAESTRO_EVENT_MARK} Atlas finished its turn.` },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Atlas is done. Have Bravo merge?' }],
        },
      ];
      sendToBravo();
      const done = store.handleUtterance(words, 'typed');
      await settle();
      expect(store.pending?.kind, words).toBe('confirm');
      store.cancelPending();
      await done;
      store.dispose();
    }
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
  });

  it('asks before acting after a turn in which the model read an agent output', async () => {
    const { store } = setup(undefined, { calls: 'off' });
    store['history'] = [
      { role: 'user', content: 'what is Atlas up to' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_agent', input: { agent: 'Atlas' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It asks to merge. Tell Bravo to?' }] },
    ];
    sendToBravo();
    const done = store.handleUtterance('yeah', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('confirm');
    store.cancelPending();
    await done;
    store.dispose();
  });

  it('leaves an instruction in the developer own words on its cancel window after a call', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas]);
    await speech.endSpeech();
    sendToBravo();
    const done = store.handleUtterance(
      'have Bravo merge that branch once the checks are green',
      'voice',
      capture(speech)
    );
    await settle();
    expect(store.pending?.kind).toBe('countdown');
    store.cancelPending();
    await done;
    store.dispose();
  });
});

describe('a permission prompt nobody could read', () => {
  const waiting = () =>
    agent('bravo', { status: 'awaiting-input', notificationType: 'permission_prompt' });

  it('is not allowed: nothing is sent, and nobody is asked to confirm it', async () => {
    const { store } = setup([waiting()]);
    mocks.readAgentOutput.mockResolvedValue('(no terminal session)');
    await store.handleUtterance('allow Bravo', 'typed');
    expect(store.pending).toBeNull();
    expect(mocks.answerPermission).not.toHaveBeenCalled();
    expect(store.reply).toContain("cannot read Bravo's prompt");
    store.dispose();
  });

  it('is not allowed when it could be read before the yes and not after', async () => {
    const { store } = setup([waiting()]);
    mocks.readAgentOutput
      .mockResolvedValueOnce('Run git push origin main?\n1. Yes  2. No')
      .mockResolvedValueOnce('(no output yet)');
    const done = store.handleUtterance('allow Bravo', 'typed');
    await settle();
    store.confirmPending();
    await done;
    expect(mocks.answerPermission).not.toHaveBeenCalled();
    store.dispose();
  });

  it('is not allowed when only a digit of the command changed', async () => {
    const { store } = setup([waiting()]);
    mocks.readAgentOutput
      .mockResolvedValueOnce('Run rm -rf releases/v1?\n1. Yes  2. No')
      .mockResolvedValueOnce('Run rm -rf releases/v2?\n1. Yes  2. No');
    const done = store.handleUtterance('allow Bravo', 'typed');
    await settle();
    store.confirmPending();
    await done;
    expect(mocks.answerPermission).not.toHaveBeenCalled();
    expect(store.reply).toContain('different prompt');
    store.dispose();
  });

  it('can still be denied', async () => {
    const { store } = setup([waiting()]);
    mocks.readAgentOutput.mockResolvedValue('(no terminal session)');
    const done = store.handleUtterance('deny Bravo', 'typed');
    await settle();
    store.confirmPending();
    await done;
    expect(mocks.answerPermission).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});

describe('steering calls', () => {
  it('sets the only call aside without saying it again, and brings it back when asked', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    expect(speech.spoken).toHaveLength(1);

    await store.handleUtterance('later', 'voice', capture(speech));
    await settle();
    expect(speech.spoken).toHaveLength(1);
    expect(store.calls.current).toBeNull();
    expect(store.calls.waiting.map((call) => call.agentName)).toEqual(['Atlas']);

    await store.handleUtterance('next call', 'typed');
    await settle();
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    store.dispose();
  });

  it('does not take words that name another agent as the answer to a question', async () => {
    const [atlas, bravo] = [agent('atlas', { status: 'working' }), agent('bravo')];
    const { store, speech } = setup([atlas, bravo]);
    await store.requests.receive(
      {
        id: 'r-1',
        at: new Date().toISOString(),
        from: { conversationId: 'conv-atlas', taskId: 'task-atlas', projectId: 'proj' },
        kind: 'ask_developer',
        payload: { question: 'Should the retry limit be configurable?' },
      },
      async () => true
    );
    await settle();
    await speech.endSpeech();
    mocks.runTurn.mockResolvedValue(text('Okay.'));
    await store.handleUtterance('have Bravo rebase onto main first', 'voice', capture(speech));
    await settle();
    // Not sent to Atlas as its answer: the model was asked what to make of it.
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(store.requests.awaiting('r-1')).toBe(true);
    store.dispose();
  });

  it('leaves "not now" to the model when no call is there to steer', async () => {
    const { store } = setup();
    store['history'] = [
      { role: 'user', content: 'should we merge' },
      { role: 'assistant', content: [{ type: 'text', text: 'Want me to merge it now?' }] },
    ];
    mocks.runTurn.mockResolvedValueOnce(text('Okay, not merging.'));
    await store.handleUtterance('not now', 'typed');
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(store.reply).toBe('Okay, not merging.');
    store.dispose();
  });
});

describe('an agent that leaves the canvas', () => {
  it('takes its calls with it, the one on the line included', async () => {
    const entries = observable.array([agent('atlas'), agent('bravo')], { deep: false });
    const { store, speech, announce } = setup(entries);
    await announce([...entries]);
    await speech.endSpeech();
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    expect(store.calls.waiting.map((call) => call.agentName)).toEqual(['Bravo']);

    // Bravo's window is gone: its waiting call goes too.
    runInAction(() => entries.replace([entries[0]!]));
    expect(store.calls.waiting).toEqual([]);

    // Atlas leaves while its call is picked up for typing: nothing stays bound to it.
    store.pickUpCall();
    runInAction(() => entries.clear());
    expect(store.calls.current).toBeNull();
    expect(store['pickup']).toBeNull();
    store.dispose();
  });
});

describe('muted', () => {
  it('keeps the line from answering aloud', async () => {
    const { store, speech } = setup();
    const talk = {
      ready: vi.fn(() => true),
      answer: vi.fn(async () => true),
      say: vi.fn(async () => true),
      note: vi.fn(),
      spoke: vi.fn(),
    };
    store.setTalkLine(talk);
    (speech as { muted: boolean }).muted = true;
    await expect(store['answerOnLine']('how is it going', 'voice')).resolves.toBe(false);
    expect(talk.answer).not.toHaveBeenCalled();

    (speech as { muted: boolean }).muted = false;
    await expect(store['answerOnLine']('how is it going', 'voice')).resolves.toBe(true);
    store.dispose();
  });
});

// ── What a second review found, of the fixes above ──────────────────────────────────────────

describe('stop, the way it is said', () => {
  const twoSends = () =>
    mocks.runTurn.mockResolvedValueOnce(
      turn(
        [
          {
            type: 'tool_use',
            id: 'a',
            name: 'send_to_agent',
            input: { agent: 'Atlas', text: '1' },
          },
          {
            type: 'tool_use',
            id: 'b',
            name: 'send_to_agent',
            input: { agent: 'Bravo', text: '2' },
          },
        ],
        'tool_use'
      )
    );

  it('ends the turn for every wording of stop, and runs none of them as a command', async () => {
    for (const words of [
      'No, stop!',
      'stop it',
      'cancel that',
      "no, don't send that",
      'stop everything',
      'no wait',
      'hang on',
    ]) {
      vi.clearAllMocks();
      const { store, canvas } = setup(undefined, { calls: 'off' });
      (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
      twoSends();
      const done = store.handleUtterance('have them both do it', 'typed');
      await settle();
      expect(store.pending?.label, words).toContain('Send to Atlas');
      vi.advanceTimersByTime(300);
      await store.handleUtterance(words, 'typed');
      await settle();
      expect(store.pending, words).toBeNull();
      await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 100);
      await done;
      await settle();

      expect(mocks.sendToAgent, words).not.toHaveBeenCalled();
      // "Stop it" was about the send, not an order to interrupt the window in front.
      expect(mocks.interruptAgent, words).not.toHaveBeenCalled();
      expect(mocks.runTurn, words).toHaveBeenCalledTimes(1);
      expect(store.reply, words).toBe('Cancelled.');
      store.dispose();
    }
  });

  it('drops the rest of the turn when other words cancel one of its cancel windows', async () => {
    const { store } = setup(undefined, { calls: 'off' });
    twoSends();
    mocks.runTurn.mockResolvedValue(text('Bravo is idle.'));
    const done = store.handleUtterance('have them both do it', 'typed');
    await settle();
    vi.advanceTimersByTime(300);
    await store.handleUtterance('hmm what is Bravo working on right now', 'typed');
    await vi.advanceTimersByTimeAsync(CANCEL_WINDOW_MS + 100);
    await done;
    await settle();
    // Neither send ran, and the words then took their own turn.
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(store.reply).toBe('Bravo is idle.');
    store.dispose();
  });

  it('does not stop a model turn when the no was for a note dropped by hand', async () => {
    const { store } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('ask the model something long', 'typed');
    await settle();
    void store['sendNote']('conv-bravo', 'remember the changelog');
    expect(store.pending?.label).toContain('Send note to Bravo');
    await store.handleUtterance('no', 'typed');
    expect(store.pending).toBeNull();
    answer(text('Here is the answer.'));
    await done;
    await settle();
    expect(store.reply).toBe('Here is the answer.');
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });
});

describe('a yes begun before there was anything to say yes to', () => {
  const plan = () => ({
    goal: 'g',
    projectId: 'proj',
    projectName: 'demo',
    subtasks: [],
    status: 'proposed',
    createdAt: Date.now(),
  });

  it('does not start a plan that appeared after it was said', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('plan the refactor across three agents', 'typed');
    await settle();
    await store.handleUtterance('yes', 'voice', capture(speech));
    expect(store['queued']?.text).toBe('yes');

    await vi.advanceTimersByTimeAsync(2_000);
    (store.plans as unknown as { plan: unknown }).plan = plan();
    answer(text('Here is the plan. Say yes to start it.'));
    await done;
    await settle();
    expect(store.plans.awaitingApproval).toBe(true);
    expect(store.reply).toContain('Say yes again');

    // Said now, with the plan in front of them, it counts.
    await vi.advanceTimersByTimeAsync(2_000);
    await store.handleUtterance('yes', 'voice', capture(speech));
    expect(store.reply).toContain('Starting');
    store.dispose();
  });

  it('does not discard a plan on a no that came before it either', async () => {
    const { store, speech } = setup(undefined, { calls: 'off' });
    const answer = slowTurn();
    const done = store.handleUtterance('plan the refactor across three agents', 'typed');
    await settle();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    await vi.advanceTimersByTimeAsync(1_000);
    (store.plans as unknown as { plan: unknown }).plan = plan();
    answer(text('Here is the plan.'));
    await done;
    await settle();
    speech.capturing = false;
    mocks.runTurn.mockResolvedValue(text('Okay.'));
    await store.handleUtterance('nope', 'voice', id);
    await settle();
    expect(store.plans.awaitingApproval).toBe(true);
    store.dispose();
  });

  it('is not typed into an agent that asked its question afterwards', async () => {
    const [atlas, bravo] = [agent('atlas', { status: 'working' }), agent('bravo')];
    const { store, speech } = setup([atlas, bravo], { calls: 'off' });
    // The developer opens the microphone to say yes to something else.
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    await vi.advanceTimersByTimeAsync(300);
    await store.requests.receive(
      {
        id: 'r-1',
        at: new Date().toISOString(),
        from: { conversationId: 'conv-atlas', taskId: 'task-atlas', projectId: 'proj' },
        kind: 'ask_developer',
        payload: { question: 'Shall I delete the old migrations?' },
      },
      async () => true
    );
    await settle();
    await vi.advanceTimersByTimeAsync(2_100);
    speech.capturing = false;
    mocks.runTurn.mockResolvedValue(text('Atlas asks whether to delete the old migrations.'));
    await store.handleUtterance('yes', 'voice', id);
    await settle();
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    expect(store.requests.awaiting('r-1')).toBe(true);
    store.dispose();
  });
});

describe('a reply to something Maestro only announced', () => {
  it('asks before acting, although no model turn left a trace of the announcement', async () => {
    const atlas = agent('atlas', { completionSummary: 'Tests pass. Shall I push to main?' });
    const { store, speech, announce } = setup([atlas, agent('bravo')], { calls: 'off' });
    store['history'] = [
      { role: 'user', content: 'what is the weather' },
      { role: 'assistant', content: [{ type: 'text', text: 'No idea.' }] },
    ];
    await announce([atlas]);
    await settle();
    expect(speech.announce).toHaveBeenCalledTimes(1);

    mocks.runTurn
      .mockResolvedValueOnce(
        toolUse('send_to_agent', { agent: 'Atlas', text: 'yes, push to main' })
      )
      .mockResolvedValue(text('Not sent.'));
    const done = store.handleUtterance('yes', 'typed');
    await settle();
    expect(store.pending?.label).toContain('Send to Atlas');
    expect(store.pending?.kind).toBe('confirm');
    store.cancelPending();
    await done;
    expect(mocks.sendToAgent).not.toHaveBeenCalled();

    // The developer has spoken since: their next bare reply is not about that announcement.
    mocks.runTurn
      .mockReset()
      .mockResolvedValueOnce(toolUse('send_to_agent', { agent: 'Atlas', text: 'ok' }))
      .mockResolvedValue(text('Sent.'));
    const again = store.handleUtterance('yes', 'typed');
    await settle();
    expect(store.pending?.kind).toBe('countdown');
    store.cancelPending();
    await again;
    store.dispose();
  });
});

describe('words after a pick-up never reach the window in front', () => {
  it('releases the call when the conductor became busy under the words that answered it', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo', { status: 'working' })];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();

    // A note dropped on Bravo, and a request of Bravo's that waits behind its cancel window.
    void store['sendNote']('conv-bravo', 'remember the changelog');
    await store.requests.receive(
      {
        id: 'r-9',
        at: new Date().toISOString(),
        from: { conversationId: 'conv-bravo', taskId: 'task-bravo', projectId: 'proj' },
        kind: 'message_agent',
        payload: { agent: 'Atlas', text: 'please rebase' },
      },
      async () => true
    );
    await settle();
    expect(store.pending).not.toBeNull();

    const answer = slowTurn(); // the turn that decides Bravo's request, about to start
    await store.handleUtterance('fix the lint error too', 'voice', capture(speech));
    // The words wait their turn and keep their call; "it" is not Atlas for anyone else.
    expect(store['queued']?.text).toBe('fix the lint error too');
    expect(store['pickup']?.call.agentName).toBe('Atlas');
    expect(focusedConversationId(canvas)).toBe('conv-bravo');

    mocks.runTurn.mockResolvedValue(text('ok'));
    answer(text('I will ask the developer.'));
    for (let round = 0; round < 6; round++) {
      await settle();
      await speech.endSpeech();
    }
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settle();
    expect(store.calls.pickedUp).toBeNull();
    expect(focusedConversationId(canvas)).toBe('conv-bravo');
    store.dispose();
  });

  it('types dictation into the window in front while a turn answers a call', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    const answer = slowTurn();
    const done = store.handleUtterance(
      'make sure the lint error is gone as well',
      'voice',
      capture(speech)
    );
    await settle();
    expect(focusedConversationId(canvas)).toBe('conv-atlas');

    // This dictation picked up no call: it is for what the developer is looking at.
    await store.dictate('note for later', capture(speech));
    expect(mocks.sendToAgent.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conv-bravo' });
    answer(text('ok'));
    await done;
    store.dispose();
  });

  it('sends nothing to the window in front when the caller left mid-sentence', async () => {
    const entries = observable.array([agent('atlas'), agent('bravo')], { deep: false });
    const { store, speech, canvas, announce } = setup(entries);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([entries[0]!]);
    await speech.endSpeech();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');
    // Atlas's window is closed while the developer is still speaking to it.
    runInAction(() => entries.replace([entries[1]!]));
    speech.capturing = false;
    mocks.runTurn.mockResolvedValue(text('Atlas is gone.'));
    await store.handleUtterance('tell it to rebase', 'voice', id);
    await settle();
    expect(store.pending).toBeNull();
    expect(mocks.sendToAgent).not.toHaveBeenCalled();
    store.dispose();
  });

  it('keeps a call picked up for typing when a sound opens the microphone by itself', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await announce([atlas]);
    await speech.endSpeech();
    expect(store.pickUpCall()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'hands-free' });
    speech.capture({ type: 'end', interactionId: id, reason: 'ignored' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');

    const done = store.handleUtterance('tell it to rebase', 'typed');
    await settle();
    expect(store.pending?.label).toContain('Send to Atlas');
    store.cancelPending();
    await done;
    store.dispose();
  });

  it('keeps it picked up for typing when the developer pressed the key and said nothing', async () => {
    const atlas = agent('atlas');
    const { store, speech, announce } = setup([atlas]);
    await announce([atlas]);
    await speech.endSpeech();
    store.pickUpCall();
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    speech.capture({ type: 'end', interactionId: id, reason: 'no-speech' });
    expect(store.calls.pickedUp?.agentName).toBe('Atlas');
    expect(store['pickup']?.interactionId).toBeNull();
    store.dispose();
  });

  it('sends dictation with "send it" in the window in front once the developer moved there', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    await announce([atlas]);
    await speech.endSpeech();
    await store.dictate('yes go ahead and push', capture(speech));
    expect(mocks.sendToAgent.mock.calls[0]?.[0]).toMatchObject({ conversationId: 'conv-atlas' });

    // They click Bravo's window and go on there.
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    await store.handleUtterance('send it', 'voice', capture(speech));
    expect(mocks.submitAgentInput.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'conv-bravo',
    });
    store.dispose();
  });
});

describe('calls that waited', () => {
  it('come through when the plan they waited behind is discarded by a click', async () => {
    const bravo = agent('bravo', {
      status: 'awaiting-input',
      notificationType: 'permission_prompt',
    });
    const { store, announce } = setup([bravo]);
    (store.plans as unknown as { plan: unknown }).plan = {
      goal: 'g',
      projectId: 'proj',
      projectName: 'demo',
      subtasks: [],
      status: 'proposed',
      createdAt: Date.now(),
    };
    await announce([bravo]);
    await settle();
    expect(store.calls.current).toBeNull();
    expect(store.calls.waiting).toHaveLength(1);

    // The plan panel's button, not a spoken no.
    store.plans.cancel();
    await settle();
    expect(store.calls.current?.call.kind).toBe('permission');
    store.dispose();
  });

  it('come through when the dictation they waited behind ends', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo', { status: 'working' })];
    const { store, speech, canvas, announce } = setup([atlas, bravo]);
    (canvas as { focusedTileId: string | null }).focusedTileId = 'tile-bravo';
    const id = crypto.randomUUID();
    speech.capture({ type: 'start', interactionId: id, origin: 'user' });
    await announce([atlas]);
    await settle();
    expect(store.calls.current).toBeNull();
    speech.capturing = false;
    await store.dictate('some dictated text', id);
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    store.dispose();
  });

  it('stay aside after "later" when another call is skipped', async () => {
    const [atlas, bravo] = [agent('atlas'), agent('bravo')];
    const { store, speech, announce } = setup([atlas, bravo]);
    await announce([atlas, bravo]);
    await speech.endSpeech();
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    await store.handleUtterance('later', 'typed');
    await settle();
    expect(store.calls.current?.call.agentName).toBe('Bravo');
    await speech.endSpeech();

    await store.handleUtterance('not now', 'typed');
    await settle();
    // Atlas was set aside two seconds ago: skipping Bravo does not bring it back.
    expect(store.calls.current).toBeNull();
    expect(store.calls.waiting.map((call) => call.agentName)).toEqual(['Atlas']);

    await store.handleUtterance('next call', 'typed');
    await settle();
    expect(store.calls.current?.call.agentName).toBe('Atlas');
    store.dispose();
  });
});
