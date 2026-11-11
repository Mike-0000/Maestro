import { observable } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTileEntry,
  CanvasStore,
} from '@core/features/canvas/api/browser/stores/canvas-store';
import { DEFAULT_CONDUCTOR_SETTINGS, type ConductorStatus } from '../api/contract';
import type { ConductorTalkLine } from '../api/voice-line';
import type { FrontConductor } from './chat-conductor/front';
import {
  ConductorStore,
  type ConductorCaptureEvent,
  type ConductorVoicePort,
} from './conductor-store';
import { setCallFocus } from './roster';
import type * as Roster from './roster';

// The HUD's typed box, voice commands and dictation reach the chat conductor in front instead of
// Maestro, except for what answers Maestro; with none in front, Maestro's paths are unchanged.

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  sendToAgent: vi.fn(async (_entry: unknown, _text: string, _submit: boolean) => {}),
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
  sendToAgent: mocks.sendToAgent,
  sendToLiveSession: vi.fn(async () => false),
  stopAgentSession: vi.fn(async () => {}),
  submitAgentInput: vi.fn(async () => {}),
}));
vi.mock('./roster', async (importOriginal) => ({
  ...(await importOriginal<typeof Roster>()),
  installedProviders: vi.fn(async () => []),
}));

function status(): ConductorStatus {
  return {
    configured: true,
    jevReady: false,
    settings: { ...DEFAULT_CONDUCTOR_SETTINGS, calls: 'spoken', completionFollowUp: false },
  } as unknown as ConductorStatus;
}

function agent(overrides: Partial<AgentTileEntry> = {}): AgentTileEntry {
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
    spokenName: () => 'Atlas',
    formerNamesOf: () => [],
    isOffBoard: () => false,
    waitingSince: () => undefined,
    regionOf: () => null,
    windowName: (id: string) => id,
    entryForTile: (tileId: string) => entries.find((entry) => entry.tileId === tileId),
    insight: () => undefined,
    setInsight: vi.fn(),
    clearInsight: vi.fn(),
    browserForTask: () => undefined,
  } as unknown as CanvasStore;
}

type Transcript = (
  text: string,
  intent: 'command' | 'dictation',
  interactionId: string
) => Promise<void> | void;

function fakeVoice() {
  let onCapture: ((event: ConductorCaptureEvent) => void) | null = null;
  let onTranscript: Transcript | null = null;
  const speaking: ((result: 'ended') => void)[] = [];
  const voice = {
    muted: false,
    capturing: false,
    say: vi.fn(),
    announce: vi.fn(),
    setMuted: vi.fn(),
    setTranscriptHandler: (handler: Transcript) => (onTranscript = handler),
    setTraceHandler: vi.fn(),
    setVocabularyProvider: vi.fn(),
    setCaptureHandler: (handler: (event: ConductorCaptureEvent) => void) => (onCapture = handler),
    setTapGate: vi.fn(),
    speak: vi.fn(
      (_text: string) => new Promise<'ended'>((resolve) => speaking.push(() => resolve('ended')))
    ),
    /** The voice slice reports the capture's start before it first waits. */
    startListening: vi.fn(async (_mode: 'hold' | 'toggle', _intent: 'command') => {
      voice.capture({
        type: 'start',
        interactionId: `maestro-${voice.startListening.mock.calls.length}`,
        origin: 'user',
      });
    }),
    capture(event: ConductorCaptureEvent) {
      voice.capturing = event.type === 'start';
      onCapture?.(event);
    },
    /** One whole capture: it starts, then its transcript arrives. */
    async speak_(
      text: string,
      options: {
        intent?: 'command' | 'dictation';
        origin?: 'user' | 'hands-free';
        id?: string;
      } = {}
    ) {
      const id = options.id ?? crypto.randomUUID();
      voice.capture({
        type: 'start',
        interactionId: id,
        origin: options.origin ?? 'user',
        intent: options.intent ?? 'command',
      });
      voice.capturing = false;
      await onTranscript?.(text, options.intent ?? 'command', id);
      return id;
    },
    transcript: (text: string, intent: 'command' | 'dictation', id: string) =>
      onTranscript?.(text, intent, id),
    endSpeech: async () => {
      speaking.shift()?.('ended');
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    },
  };
  return voice;
}

function fakeFront(name = 'Atlas') {
  const session = observable({
    draft: '',
    busy: false,
    stopped: 0,
    sent: [] as string[],
    send(text: string) {
      this.sent.push(text);
    },
    setDraft(text: string) {
      this.draft = text;
    },
    stop() {
      this.stopped++;
    },
  });
  const front: FrontConductor = { session, name };
  return { front, session };
}

function setup(entries: AgentTileEntry[] = [agent()]) {
  const voice = fakeVoice();
  const store = new ConductorStore(fakeCanvas(entries), voice as unknown as ConductorVoicePort);
  mocks.status = status();
  store.status = status();
  store.activate();
  const { front, session } = fakeFront();
  const chats = observable({ front: front as FrontConductor | null }, { front: observable.ref });
  store.setChatConductors(chats);
  mocks.runTurn.mockResolvedValue({
    success: true,
    data: {
      content: [{ type: 'text', text: 'Okay.' }],
      stopReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    },
  });
  return { store, voice, chats, front, session };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setCallFocus(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('with a chat conductor in front', () => {
  it('sends typed words to it as a developer message, and Maestro neither answers nor speaks', async () => {
    const { store, voice, session } = setup();
    await store.submitTyped('ask it why the build failed');
    expect(session.sent).toEqual(['ask it why the build failed']);
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(store.lastUtterance).toBe('');
    expect(store.reply).toBe('');
    expect(voice.say).not.toHaveBeenCalled();
    expect(voice.speak).not.toHaveBeenCalled();
    store.dispose();
  });

  it('sends a voice command to it verbatim, past the grammar and the model', async () => {
    const { store, voice, session } = setup();
    // "mute" is a grammar command for Maestro; here it is words for the chat conductor.
    await voice.speak_('mute');
    await voice.speak_('Tell it to run the tests, then summarize');
    expect(session.sent).toEqual(['mute', 'Tell it to run the tests, then summarize']);
    expect(voice.setMuted).not.toHaveBeenCalled();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(store.reply).toBe('');
    store.dispose();
  });

  it('goes where it was in front when the capture began', async () => {
    const { store, voice, chats, session } = setup();
    const id = crypto.randomUUID();
    voice.capture({ type: 'start', interactionId: id, origin: 'user' });
    expect(store.listeningFor?.name).toBe('Atlas');
    chats.front = null;
    voice.capturing = false;
    await voice.transcript('keep an eye on the deploy', 'command', id);
    expect(session.sent).toEqual(['keep an eye on the deploy']);
    expect(store.listeningFor).toBeNull();
    store.dispose();
  });

  it('stops its running turn on a bare stop, and sends a stop as a message when it is idle', async () => {
    const { store, voice, session } = setup();
    session.busy = true;
    await voice.speak_('stop');
    await store.submitTyped('cancel that');
    expect(session.stopped).toBe(2);
    expect(session.sent).toEqual([]);
    // Words that say more than stop are a message, even while it works.
    await voice.speak_('stop the dev server when you are done');
    expect(session.sent).toEqual(['stop the dev server when you are done']);
    expect(mocks.runTurn).not.toHaveBeenCalled();

    session.busy = false;
    await voice.speak_('stop');
    expect(session.stopped).toBe(2);
    expect(session.sent).toEqual(['stop the dev server when you are done', 'stop']);
    store.dispose();
  });

  it('types dictation into its composer, and "send it" sends what is there', async () => {
    const { store, voice, session } = setup();
    session.setDraft('Ask it');
    await voice.speak_('to add a retry', { intent: 'dictation' });
    expect(session.draft).toBe('Ask it to add a retry');
    expect(session.sent).toEqual([]);
    expect(mocks.sendToAgent).not.toHaveBeenCalled();

    await voice.speak_('send it');
    expect(session.sent).toEqual(['Ask it to add a retry']);
    expect(session.draft).toBe('');
    store.dispose();
  });

  it('leaves the Maestro button to Maestro', async () => {
    const { store, voice, session } = setup();
    await store.listenToMaestro('hold');
    expect(voice.startListening).toHaveBeenCalledWith('hold', 'command');
    expect(store.listeningFor).toBeNull();
    voice.capturing = false;
    await voice.transcript('what is everyone doing', 'command', 'maestro-1');
    await settle();
    expect(session.sent).toEqual([]);
    expect(store.lastUtterance).toBe('what is everyone doing');
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);

    // Only that capture: the next one from the talk key goes to the chat conductor again.
    await voice.speak_('and you, summarize the chat');
    expect(session.sent).toEqual(['and you, summarize the chat']);
    store.dispose();
  });

  it('leaves typing to Maestro through the path the Maestro button uses', async () => {
    const { store, session } = setup();
    await store.handleUtterance('what is everyone doing', 'typed');
    expect(session.sent).toEqual([]);
    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('leaves hands-free speech and the open voice line to Maestro', async () => {
    const { store, voice, session } = setup();
    await voice.speak_('what is everyone doing', { origin: 'hands-free' });
    await settle();
    expect(session.sent).toEqual([]);
    expect(store.lastUtterance).toBe('what is everyone doing');

    const line = {
      ready: () => false,
      turn: async () => null,
      stop: vi.fn(),
      say: async () => false,
      note: vi.fn(),
      record: vi.fn(),
      spoke: vi.fn(),
    } satisfies ConductorTalkLine;
    store.setTalkLine(line);
    await voice.speak_('and Bravo?');
    await settle();
    expect(session.sent).toEqual([]);
    // Dictation is no conversation with Maestro: it still goes into the composer.
    await voice.speak_('add a retry', { intent: 'dictation' });
    expect(session.draft).toBe('add a retry');
    store.setTalkLine(null);
    store.dispose();
  });

  it('gives Maestro the yes to its confirmation on screen, and the chat conductor the rest', async () => {
    const { store, voice, session } = setup();
    const first = store.requestPending("Stop Atlas's session", 'confirm');
    expect(store.pending).not.toBeNull();

    await voice.speak_('what does it say about the migration?');
    expect(session.sent).toEqual(['what does it say about the migration?']);
    // Not an answer: the confirmation waits on, and its clock runs again.
    expect(store.pending?.held).toBe(false);

    await voice.speak_('yes');
    await expect(first).resolves.toBe(true);
    expect(session.sent).toEqual(['what does it say about the migration?']);

    const second = store.requestPending("Archive Atlas's task", 'confirm');
    await store.submitTyped('no');
    await expect(second).resolves.toBe(false);
    expect(session.sent).toEqual(['what does it say about the migration?']);
    store.dispose();
  });

  it('gives Maestro the answer to a call the developer picked up', async () => {
    const atlas = agent();
    const { store, voice, session } = setup([atlas]);
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
    expect(store.calls.current?.call.requestId).toBe('r-1');
    await voice.endSpeech();

    const id = crypto.randomUUID();
    voice.capture({ type: 'start', interactionId: id, origin: 'user' });
    voice.capturing = false;
    const done = voice.transcript('It should, default three', 'command', id);
    await settle();
    await voice.endSpeech();
    await done;
    await settle();

    expect(session.sent).toEqual([]);
    expect(mocks.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendToAgent.mock.calls[0]?.[1]).toContain(
      'The developer answered: It should, default three'
    );
    expect(store.requests.awaiting('r-1')).toBe(false);
    store.dispose();
  });
});

describe('with no chat conductor in front', () => {
  it('sends typed words and voice commands to Maestro', async () => {
    const { store, voice, chats, session } = setup();
    chats.front = null;
    await store.submitTyped('what is everyone doing');
    await settle();
    expect(store.lastUtterance).toBe('what is everyone doing');
    await voice.speak_('mute');
    expect(voice.setMuted).toHaveBeenCalledWith(true);
    expect(session.sent).toEqual([]);
    store.dispose();
  });

  it('types dictation into the agent in front, as before', async () => {
    const { store, voice, chats, session } = setup();
    chats.front = null;
    await voice.speak_('add a retry', { intent: 'dictation' });
    // Nothing is focused in this canvas: the existing path says so.
    expect(store.reply).toBe('Focus an agent first, then dictate.');
    expect(session.draft).toBe('');
    store.dispose();
  });
});
