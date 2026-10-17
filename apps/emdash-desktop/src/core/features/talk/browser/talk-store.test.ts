import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConductorTalkLine,
  LineSpeech,
  LineToolResult,
} from '@core/features/conductor/api/voice-line';
import type { TalkClient } from '../api/browser/client';
import { DEFAULT_TALK_SETTINGS, type TalkSettings, type TalkStatus } from '../api/contract';
import { NO_TOKENS } from '../api/usage';
import { ROLLOVER_INPUT_TOKENS } from '../api/world-feed';
import type { LineSessionDeps, RealtimeEvent, SessionState } from './grok-voice-session';
import {
  joinTranscripts,
  TalkStore,
  type LineCapture,
  type SessionLike,
  type TalkDeps,
} from './talk-store';

// The line end to end against a stand-in for the provider: its model is the conductor, every
// tool it calls goes through the conductor's gate, and words that could answer something in
// progress are read before anything answers them.

vi.mock('@core/primitives/logging/browser/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function status(settings: Partial<TalkSettings> = {}, overrides: Partial<TalkStatus> = {}) {
  return {
    settings: { ...DEFAULT_TALK_SETTINGS, enabled: true, ...settings },
    hasKey: true,
    usageToday: {
      day: '2026-10-10',
      usd: 0,
      responses: 0,
      sessions: 0,
      seconds: 0,
      tokens: NO_TOKENS,
    },
    overBudget: false,
    ...overrides,
  } satisfies TalkStatus;
}

type FakeSession = SessionLike & {
  sent: RealtimeEvent[];
  deps: LineSessionDeps;
  emit(event: RealtimeEvent): void;
  drop(): void;
};

function harness(settings: Partial<TalkSettings> = {}) {
  const sessions: FakeSession[] = [];
  let current = status(settings);
  const openSession = vi.fn(
    async (_input: { instructions: string; tools: { name: string }[] }) => ({
      success: true as const,
      data: {
        url: 'wss://example.test/realtime',
        clientSecret: 'secret',
        expiresAt: 0,
        session: {},
        model: 'm',
        voice: 'v',
      },
    })
  );
  const client = {
    getStatus: vi.fn(async () => current),
    updateSettings: vi.fn(async (patch: Partial<TalkSettings>) => {
      current = { ...current, settings: { ...current.settings, ...patch } };
      return current;
    }),
    openSession,
    recordUsage: vi.fn(async () => current),
  };
  const room = observable({ speaking: false, capturing: false, muted: false });
  let capture: LineCapture | null = null;
  const voice = {
    get speaking() {
      return room.speaking;
    },
    get capturing() {
      return room.capturing;
    },
    get muted() {
      return room.muted;
    },
    setLiveCapture: vi.fn((next: LineCapture | null) => {
      capture = next;
    }),
  };
  const callOnLine = observable.box(false);
  const standing = observable.box('');
  const guarded = { value: false };
  let line: ConductorTalkLine | null = null;
  const conductor = {
    setTalkLine: vi.fn((next: ConductorTalkLine | null) => {
      line = next;
    }),
    lineContext: vi.fn(async () => 'Agents: Atlas (working)'),
    get lineGuarded() {
      return guarded.value;
    },
    speechTurn: vi.fn(async (_speech: LineSpeech) => {}),
    hearOnLine: vi.fn(),
    lineTool: vi.fn(
      async (name: string, _input: unknown): Promise<LineToolResult> => ({
        output: `${name} result`,
      })
    ),
    showVoiceReply: vi.fn(),
    traceLine: vi.fn(),
    get callOnLine() {
      return callOnLine.get();
    },
    codeChecksReady: false,
    projectLookupsOn: false,
    get standingInstructions() {
      return standing.get();
    },
  };
  const track = { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
  const play = vi.fn();
  const deps: TalkDeps = {
    client: async () => client as unknown as TalkClient,
    conductor,
    voice,
    createSession: (sessionDeps) => {
      const session: FakeSession = {
        state: 'idle' as SessionState,
        sent: [],
        deps: sessionDeps,
        open: async () => {
          await sessionDeps.connect();
          (session as { state: SessionState }).state = 'open';
          sessionDeps.onState('open');
        },
        send: (event) => {
          if (session.state !== 'open') return false;
          session.sent.push(event);
          return true;
        },
        close: () => {
          (session as { state: SessionState }).state = 'closed';
        },
        emit: (event) => sessionDeps.onEvent(event),
        drop: () => {
          (session as { state: SessionState }).state = 'failed';
          sessionDeps.onState('failed');
        },
      };
      sessions.push(session);
      return session;
    },
    microphone: async () => track,
    play,
  };
  const store = new TalkStore(deps);
  const open = async () => {
    store.activate();
    await settle();
    const session = sessions.at(-1)!;
    session.sent.length = 0;
    return session;
  };
  return {
    store,
    sessions,
    open,
    client,
    conductor,
    room,
    voice,
    guarded,
    callOnLine,
    standing,
    track,
    play,
    line: () => line!,
    capture: () => capture!,
    setStatus: (next: TalkStatus) => {
      current = next;
    },
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 30; round++) await Promise.resolve();
}

function sentTypes(session: FakeSession): string[] {
  return session.sent.map((event) => event.type);
}

function committed(session: FakeSession, itemId: string): void {
  session.emit({ type: 'input_audio_buffer.committed', item_id: itemId });
}

function transcribed(session: FakeSession, transcript: string, itemId = 'item-1'): void {
  session.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

function toolCall(session: FakeSession, callId: string, name: string, args = '{}'): void {
  session.emit({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name,
    arguments: args,
  });
}

/** A response of the conversation ending: with a tool call in it, or with the answer. */
function responseDone(
  session: FakeSession,
  options: { tools?: boolean; status?: string; inputTokens?: number } = {}
): void {
  session.emit({
    type: 'response.done',
    response: {
      status: options.status ?? 'completed',
      output: [{ type: options.tools ? 'function_call' : 'message' }],
      usage: {
        input_tokens: options.inputTokens ?? 100,
        input_token_details: { text_tokens: options.inputTokens ?? 100 },
      },
    },
  });
}

function said(session: FakeSession, transcript: string): void {
  session.emit({ type: 'response.output_audio_transcript.done', transcript });
}

/** The pause after a voice before the microphone opens. */
const ECHO_TAIL = 300;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('opening the line', () => {
  it('stays shut while the setting is off, and asks for no microphone', async () => {
    const { store, sessions } = harness({ enabled: false });
    store.activate();
    await settle();
    expect(sessions).toEqual([]);
    expect(store.line).toBe('off');
    store.dispose();
  });

  it('opens as the conductor: its prompt, every tool, the state, and the key', async () => {
    const { store, sessions, track, conductor, voice, line, capture, client } = harness();
    store.activate();
    await settle();
    const session = sessions[0]!;

    expect(store.line).toBe('open');
    expect(track.enabled).toBe(false);
    const call = client.openSession.mock.calls[0]![0];
    expect(call.instructions).toContain('You are the conductor inside Maestro');
    expect(call.instructions).toContain('On the voice line');
    const tools = call.tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['send_to_agent', 'spawn_agent', 'list_agents']));
    expect(tools).not.toContain('investigate');
    const state = session.sent[0] as { item?: { role?: string; content?: { text: string }[] } };
    expect(state.item?.role).toBe('system');
    expect(state.item?.content?.[0]?.text).toContain('Agents: Atlas (working)');
    expect(conductor.setTalkLine).toHaveBeenLastCalledWith(line());
    expect(voice.setLiveCapture).toHaveBeenLastCalledWith(capture());
    expect(line().ready()).toBe(true);
    store.dispose();
  });

  it('goes down, and gives the conductor and the key back, when the connection drops', async () => {
    const { store, open, conductor, voice } = harness();
    const session = await open();
    session.drop();
    expect(store.line).toBe('down');
    expect(conductor.setTalkLine).toHaveBeenLastCalledWith(null);
    expect(voice.setLiveCapture).toHaveBeenLastCalledWith(null);
    store.dispose();
  });

  it('does not open when the provider refuses, and says why', async () => {
    const { store, client } = harness();
    client.openSession.mockResolvedValueOnce({
      success: false,
      error: { type: 'rejected-key', message: 'The OpenAI API key was rejected.' },
    } as never);
    store.activate();
    await settle();
    expect(store.line).toBe('down');
    expect(store.error).toBe('The OpenAI API key was rejected.');
    // A rejected key does not fix itself: no retry is scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.openSession).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('opens the microphone by itself only when it listens without the key', async () => {
    const keyed = harness();
    await keyed.open();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    expect(keyed.store.micOpen).toBe(false);
    expect(keyed.track.enabled).toBe(false);
    keyed.store.dispose();

    const always = harness({ listening: 'open' });
    await always.open();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    expect(always.store.micOpen).toBe(true);
    expect(always.track.enabled).toBe(true);
    // It does not run out.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(always.store.micOpen).toBe(true);
    always.store.dispose();
  });
});

describe('holding the talk key', () => {
  it('hears the developer itself and has the conductor answer the moment they let go', async () => {
    const { store, open, capture, conductor, track } = harness();
    const session = await open();

    expect(capture().begin('i-1')).toBe(true);
    expect(store.holding).toBe(true);
    expect(track.enabled).toBe(true);
    expect(sentTypes(session)).toEqual(['input_audio_buffer.clear']);

    session.emit({ type: 'input_audio_buffer.speech_started' });
    // A pause in the middle: the provider commits, and nothing answers yet.
    committed(session, 'item-1');
    expect(conductor.speechTurn).not.toHaveBeenCalled();

    const ended = capture().end('i-1');
    await expect(ended).resolves.toBe(true);
    expect(store.holding).toBe(false);
    expect(track.enabled).toBe(false);
    expect(sentTypes(session).at(-1)).toBe('input_audio_buffer.commit');
    // Answered at once, before the transcript exists.
    const speech = conductor.speechTurn.mock.calls[0]![0];
    expect(speech.interactionId).toBe('i-1');

    committed(session, 'item-2');
    transcribed(session, 'tell Atlas', 'item-1');
    transcribed(session, 'to rebase', 'item-2');
    await expect(speech.heard).resolves.toBe('tell Atlas to rebase');
    // The model heard the audio: its items stay in the conversation.
    expect(sentTypes(session)).not.toContain('conversation.item.delete');
    store.dispose();
  });

  it('drops a press nobody spoke into', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    const ended = capture().end('i-1');
    await vi.advanceTimersByTimeAsync(400);
    await expect(ended).resolves.toBe(false);
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    expect(sentTypes(session)).not.toContain('input_audio_buffer.commit');
    store.dispose();
  });

  it('gives a short word the moment the provider needs to report it', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    const ended = capture().end('i-1');
    await vi.advanceTimersByTimeAsync(200);
    session.emit({ type: 'input_audio_buffer.speech_started' });
    await expect(ended).resolves.toBe(true);
    expect(conductor.speechTurn).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('reads the words first when they could answer something in progress', async () => {
    const { store, open, capture, conductor, guarded } = harness();
    const session = await open();
    guarded.value = true;
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    const ended = capture().end('i-1');
    await settle();
    expect(conductor.hearOnLine).not.toHaveBeenCalled();

    committed(session, 'item-1');
    transcribed(session, 'yes');
    await expect(ended).resolves.toBe(true);
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    expect(conductor.hearOnLine).toHaveBeenCalledWith(
      'yes',
      expect.objectContaining({ interactionId: 'i-1', key: true })
    );
    // Read here, so the model does not answer the same words again.
    expect(session.sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'item-1' });
    store.dispose();
  });

  it('does not wait for a commit that had nothing left to take', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    committed(session, 'item-1');
    transcribed(session, 'what is Atlas doing');
    await capture().end('i-1');
    session.emit({ type: 'error', error: { code: 'input_audio_buffer_commit_empty' } });
    const speech = conductor.speechTurn.mock.calls[0]![0];
    await expect(speech.heard).resolves.toBe('what is Atlas doing');
    store.dispose();
  });

  it('gives up waiting for a transcript that never comes', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    await capture().end('i-1');
    committed(session, 'item-1');
    const speech = conductor.speechTurn.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(speech.heard).resolves.toBe('');
    store.dispose();
  });

  it('counts words as unread when part of them was never transcribed', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    committed(session, 'item-1');
    transcribed(session, 'Yeah.');
    await capture().end('i-1');
    committed(session, 'item-2');
    const speech = conductor.speechTurn.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(4_000);
    // "Yeah." alone is not what they said.
    await expect(speech.heard).resolves.toBe('');
    store.dispose();
  });

  it('takes a second press while the first still waits for its last words', async () => {
    const { store, open, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    committed(session, 'item-1');
    transcribed(session, 'what is Atlas doing');
    await capture().end('i-1');
    expect(capture().begin('i-2')).toBe(true);
    const first = conductor.speechTurn.mock.calls[0]![0];
    await expect(first.heard).resolves.toBe('what is Atlas doing');
    store.dispose();
  });

  it('forgets a cancelled capture', async () => {
    const { store, open, capture, conductor, track } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    capture().cancel();
    expect(store.holding).toBe(false);
    expect(track.enabled).toBe(false);
    expect(sentTypes(session).at(-1)).toBe('input_audio_buffer.clear');
    await expect(capture().end('i-1')).resolves.toBe(false);
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    store.dispose();
  });

  it('leaves the capture to the recorder when the line is down', async () => {
    const { store, open, capture } = harness();
    const session = await open();
    const taken = capture();
    session.drop();
    expect(taken.begin('i-1')).toBe(false);
    store.dispose();
  });
});

describe('what is heard with no key', () => {
  async function listening(settings: Partial<TalkSettings> = {}) {
    const h = harness({ listening: 'open', ...settings });
    const session = await h.open();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    return { ...h, session };
  }

  it('is read first, then answered by the model that heard it', async () => {
    const { store, session, conductor } = await listening();
    committed(session, 'item-1');
    expect(conductor.speechTurn).not.toHaveBeenCalled();

    transcribed(session, "what's everyone doing");
    const speech = conductor.speechTurn.mock.calls[0]![0];
    await expect(speech.heard).resolves.toBe("what's everyone doing");
    expect(sentTypes(session)).toEqual([]);
    store.dispose();
  });

  it('drops its own voice coming back through the microphone', async () => {
    const { store, session, conductor } = await listening({ talkOver: true });
    said(session, 'Atlas finished. Tests pass, but it skipped the lint error.');
    committed(session, 'item-1');
    transcribed(session, 'tests pass but it skipped the lint error');
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    expect(session.sent).toEqual([{ type: 'conversation.item.delete', item_id: 'item-1' }]);
    store.dispose();
  });

  it('drops noise the transcriber turned into a sentence, and a failed transcript', async () => {
    const { store, session, conductor } = await listening();
    committed(session, 'item-1');
    transcribed(session, "I'm sorry, I can't hear any audio.");
    committed(session, 'item-2');
    session.emit({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item-2',
    });
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    expect(conductor.hearOnLine).not.toHaveBeenCalled();
    expect(sentTypes(session)).toEqual(['conversation.item.delete', 'conversation.item.delete']);
    store.dispose();
  });

  it('goes to the conductor as words when something is in progress', async () => {
    const { store, session, conductor, guarded } = await listening();
    guarded.value = true;
    committed(session, 'item-1');
    transcribed(session, 'stop');
    expect(conductor.speechTurn).not.toHaveBeenCalled();
    expect(conductor.hearOnLine).toHaveBeenCalledWith(
      'stop',
      expect.objectContaining({ key: false })
    );
    expect(session.sent).toEqual([{ type: 'conversation.item.delete', item_id: 'item-1' }]);
    store.dispose();
  });

  it('closes while a local voice or a local capture has the room', async () => {
    const { store, room, track } = await listening();
    runInAction(() => (room.speaking = true));
    expect(store.micOpen).toBe(false);
    expect(track.enabled).toBe(false);
    runInAction(() => (room.speaking = false));
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    expect(store.micOpen).toBe(true);
    store.dispose();
  });
});

describe('a turn of the model', () => {
  it('takes typed words, replaces the state, and resolves with the answer', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    const result = line().turn({ text: 'how is Atlas', context: 'Agents: now', spoken: true });

    expect(session.sent[0]).toMatchObject({
      item: { role: 'user', content: [{ type: 'input_text', text: 'how is Atlas' }] },
    });
    expect(session.sent[1]).toMatchObject({ item: { id: 'state_2', role: 'system' } });
    expect(session.sent[2]).toEqual({ type: 'conversation.item.delete', item_id: 'state_1' });
    // Aloud is the provider's default.
    expect(session.sent[3]).toEqual({ type: 'response.create' });

    said(session, 'Atlas is running the tests.');
    expect(conductor.showVoiceReply).toHaveBeenLastCalledWith('Atlas is running the tests.');
    responseDone(session);
    await expect(result).resolves.toMatchObject({
      reply: 'Atlas is running the tests.',
      completed: true,
    });
    store.dispose();
  });

  it('answers in text when asked to, and when Maestro is muted', async () => {
    const { store, open, line, room } = harness();
    const session = await open();
    const typed = line().turn({ text: 'hi', context: 'c', spoken: false });
    expect(session.sent.at(-1)).toEqual({
      type: 'response.create',
      response: { modalities: ['text'] },
    });
    session.emit({ type: 'response.output_text.done', text: 'Hello.' });
    responseDone(session);
    await expect(typed).resolves.toMatchObject({ reply: 'Hello.' });

    runInAction(() => (room.muted = true));
    void line().turn({ text: 'hi', context: 'c', spoken: true });
    expect(session.sent.at(-1)).toEqual({
      type: 'response.create',
      response: { modalities: ['text'] },
    });
    store.dispose();
  });

  it('runs every tool through the conductor and goes back once all results are in', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    let finish: (result: LineToolResult) => void = () => {};
    conductor.lineTool.mockImplementationOnce(
      () => new Promise<LineToolResult>((resolve) => (finish = resolve))
    );
    const result = line().turn({ context: 'c', spoken: true });
    session.sent.length = 0;

    toolCall(session, 'c1', 'send_to_agent', '{"agent":"Atlas","text":"rebase"}');
    toolCall(session, 'c2', 'read_agent', '{"agent":"Atlas"}');
    responseDone(session, { tools: true });
    await settle();
    expect(conductor.lineTool).toHaveBeenCalledWith('send_to_agent', {
      agent: 'Atlas',
      text: 'rebase',
    });
    // One result is still out: the model is not asked again yet.
    expect(sentTypes(session)).toEqual(['conversation.item.create']);

    finish({ output: 'Sent to Atlas.' });
    await settle();
    expect(session.sent.at(-2)).toMatchObject({
      item: { type: 'function_call_output', call_id: 'c1', output: 'Sent to Atlas.' },
    });
    expect(sentTypes(session).at(-1)).toBe('response.create');

    said(session, 'Sent.');
    responseDone(session);
    await expect(result).resolves.toMatchObject({ reply: 'Sent.', completed: true });
    store.dispose();
  });

  it('counts the rounds of a turn and the words said before a tool had answered', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const result = line().turn({ context: 'c', spoken: true });

    said(session, 'Got it, let me do that.');
    toolCall(session, 'c1', 'close_agent', '{"agent":"Ginger"}');
    responseDone(session, { tools: true });
    await settle();
    said(session, 'Closed.');
    responseDone(session);
    await expect(result).resolves.toMatchObject({
      reply: 'Got it, let me do that. Closed.',
      rounds: 2,
      leadWords: 6,
    });

    const quiet = line().turn({ context: 'c', spoken: true });
    toolCall(session, 'c2', 'close_agent', '{"agent":"Ginger"}');
    responseDone(session, { tools: true });
    await settle();
    said(session, 'Closed.');
    responseDone(session);
    await expect(quiet).resolves.toMatchObject({ reply: 'Closed.', rounds: 2, leadWords: 0 });
    store.dispose();
  });

  it('does not ask again while the response that called the tool is still in flight', async () => {
    const { store, open, line } = harness();
    const session = await open();
    void line().turn({ context: 'c', spoken: true });
    session.sent.length = 0;
    toolCall(session, 'c1', 'read_agent');
    await settle();
    expect(sentTypes(session)).toEqual(['conversation.item.create']);
    responseDone(session, { tools: true });
    expect(sentTypes(session).at(-1)).toBe('response.create');
    store.dispose();
  });

  it('tells the model a screenshot was left out, since it takes no images', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    conductor.lineTool.mockResolvedValueOnce({
      output: 'Screenshot taken.',
      images: [{ mediaType: 'image/jpeg', data: 'AAAA', width: 2, height: 2 }],
    });
    void line().turn({ context: 'c', spoken: true });
    toolCall(session, 'c1', 'look_at_app');
    await settle();
    expect(session.sent.at(-1)).toMatchObject({
      item: {
        type: 'function_call_output',
        output: 'Screenshot taken.\n\n[An image left out: the voice model cannot see images.]',
      },
    });
    expect(JSON.stringify(session.sent)).not.toContain('input_image');
    store.dispose();
  });

  it('answers a tool call that belongs to no request, and runs nothing', async () => {
    const { store, open, conductor } = harness();
    const session = await open();
    toolCall(session, 'c1', 'send_to_agent', '{"agent":"Atlas","text":"hi"}');
    await settle();
    expect(conductor.lineTool).not.toHaveBeenCalled();
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toMatchObject({ item: { type: 'function_call_output' } });
    store.dispose();
  });

  it('stops where it is: the response is cancelled and later tools do not run', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    const result = line().turn({ context: 'c', spoken: true });
    line().stop();
    expect(sentTypes(session)).toContain('response.cancel');

    toolCall(session, 'c1', 'send_to_agent');
    await settle();
    expect(conductor.lineTool).not.toHaveBeenCalled();
    responseDone(session, { status: 'cancelled', tools: true });
    await expect(result).resolves.toMatchObject({ completed: false });
    // Nothing more was asked of the model.
    expect(sentTypes(session).at(-1)).toBe('conversation.item.create');
    store.dispose();
  });

  it('ends a stopped turn even when the cut-off response lists a call that never came', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const result = line().turn({ context: 'c', spoken: true });
    line().stop();
    responseDone(session, { status: 'cancelled', tools: true });
    await expect(result).resolves.toMatchObject({ completed: false });
    store.dispose();
  });

  it('does not ask the model again while the developer is speaking over the turn', async () => {
    const { store, open, line, capture, guarded } = harness();
    const session = await open();
    void line().turn({ context: 'c', spoken: true });
    guarded.value = true;
    toolCall(session, 'c1', 'read_agent');
    responseDone(session, { tools: true });
    // They take the key before the tool's result is in.
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    session.sent.length = 0;
    await settle();
    expect(sentTypes(session)).toEqual(['conversation.item.create']);

    const ended = capture().end('i-1');
    committed(session, 'item-1');
    transcribed(session, 'also tell Bravo to run the tests');
    await ended;
    // Their words were taken out and handed on as words; only then does the turn go on.
    const types = sentTypes(session);
    expect(types.indexOf('conversation.item.delete')).toBeGreaterThan(-1);
    expect(types.indexOf('response.create')).toBeGreaterThan(
      types.indexOf('conversation.item.delete')
    );
    store.dispose();
  });

  it('ignores the late end of a response an earlier turn gave up on', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const first = line().turn({ context: 'c', spoken: true });
    session.emit({ type: 'response.created', response: { id: 'r1' } });
    await vi.advanceTimersByTimeAsync(60_000);
    await first;
    const second = line().turn({ context: 'c', spoken: true });
    session.emit({ type: 'response.created', response: { id: 'r2' } });
    let ended = false;
    void second.then(() => (ended = true));
    session.emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } });
    await settle();
    expect(ended).toBe(false);
    session.emit({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
    await expect(second).resolves.toMatchObject({ completed: true });
    store.dispose();
  });

  it('asks again in a built-in voice when xAI will not speak in the custom one', async () => {
    const { store, open, line, conductor, sessions, client } = harness({ voice: 'amgtiwcbk60e' });
    const session = await open();
    const turn = line().turn({ context: 'c', spoken: true });
    session.emit({
      type: 'response.done',
      response: { status: 'cancelled', status_details: 'unimplemented' },
    });
    await settle();
    expect(session.sent).toContainEqual({ type: 'session.update', session: { voice: 'eve' } });
    expect(sentTypes(session).filter((type) => type === 'response.create')).toHaveLength(2);
    expect(conductor.traceLine).toHaveBeenCalledWith('voice-fallback', {
      voice: 'amgtiwcbk60e',
      to: 'eve',
    });
    expect(store.error).toContain('amgtiwcbk60e');
    responseDone(session);
    await expect(turn).resolves.toMatchObject({ completed: true });

    // The next session opens in the built-in voice, until the voice is changed.
    client.openSession.mockResolvedValue({
      success: true as const,
      data: {
        url: 'wss://example.test/realtime',
        clientSecret: 'secret',
        expiresAt: 0,
        session: { voice: 'amgtiwcbk60e' },
        model: 'm',
        voice: 'amgtiwcbk60e',
      },
    });
    await store.updateSettings({ model: 'grok-voice-latest' });
    await settle();
    expect(sessions).toHaveLength(2);
    expect((await sessions[1]!.deps.connect()).session).toEqual({ voice: 'eve' });
    store.dispose();
  });

  it('never second-guesses a built-in voice that was cut off', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    const turn = line().turn({ context: 'c', spoken: true });
    session.emit({
      type: 'response.done',
      response: { status: 'cancelled', status_details: 'unimplemented' },
    });
    await expect(turn).resolves.toMatchObject({ completed: false });
    expect(conductor.traceLine).not.toHaveBeenCalledWith('voice-fallback', expect.anything());
    store.dispose();
  });

  it('traces why a response ended without completing', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    const turn = line().turn({ context: 'c', spoken: true });
    session.emit({
      type: 'response.done',
      response: {
        status: 'failed',
        status_details: {
          type: 'failed',
          error: { code: 'invalid_request_error', message: 'Item not found: state_2' },
        },
      },
    });
    await expect(turn).resolves.toMatchObject({ completed: false });
    expect(conductor.traceLine).toHaveBeenCalledWith('incomplete', {
      response: 'failed',
      type: 'failed',
      code: 'invalid_request_error',
      message: 'Item not found: state_2',
    });
    store.dispose();
  });

  it('takes one turn at a time', async () => {
    const { store, open, line } = harness();
    await open();
    void line().turn({ context: 'c', spoken: true });
    await expect(line().turn({ context: 'c', spoken: true })).resolves.toBeNull();
    store.dispose();
  });

  it('gives up on a response that never finishes', async () => {
    const { store, open, line } = harness();
    await open();
    const result = line().turn({ context: 'c', spoken: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({ completed: false });
    store.dispose();
  });

  it('ends the turn when the line drops under it', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const result = line().turn({ context: 'c', spoken: true });
    session.drop();
    await expect(result).resolves.toMatchObject({
      reply: expect.stringContaining('dropped'),
      completed: false,
    });
    store.dispose();
  });

  it('lets a sentence being said as written finish before the model goes on', async () => {
    const { store, open, line } = harness();
    const session = await open();
    void line().turn({ context: 'c', spoken: true });
    toolCall(session, 'c1', 'send_to_agent');
    responseDone(session, { tools: true });
    // The conductor reads its confirmation out while the tool waits.
    const reading = line().say('Sending to Atlas. Say stop to cancel.');
    session.sent.length = 0;
    await settle();
    // The tool's result is in, but the sentence is still being said.
    expect(sentTypes(session)).toEqual(['conversation.item.create']);

    session.emit({ type: 'output_audio_buffer.started' });
    session.emit({ type: 'output_audio_buffer.stopped' });
    await expect(reading).resolves.toBe(true);
    expect(sentTypes(session).at(-1)).toBe('response.create');
    store.dispose();
  });
});

describe('an exchange that is over', () => {
  /** A response ending with the items it left in the conversation. */
  function responseLeft(session: FakeSession, items: { id: string; type: string }[]): void {
    session.emit({
      type: 'response.done',
      response: {
        status: 'completed',
        output: items,
        usage: { input_tokens: 100, input_token_details: { text_tokens: 100 } },
      },
    });
  }

  function deleted(session: FakeSession): string[] {
    return session.sent.flatMap((event) =>
      event.type === 'conversation.item.delete' ? [String(event.item_id)] : []
    );
  }

  function notes(session: FakeSession): string[] {
    return session.sent.flatMap((event) => {
      const item = event.item as { role?: string; id?: string; content?: { text: string }[] };
      return event.type === 'conversation.item.create' && item.role === 'system' && !item.id
        ? [item.content![0]!.text]
        : [];
    });
  }

  it('is replaced by its record: the words, the call, its result and the answer go', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const result = line().turn({ text: 'start an agent on X', context: 'c', spoken: false });
    toolCall(session, 'c1', 'spawn_agent', '{"prompt":"a long brief about X"}');
    responseLeft(session, [{ id: 'fc-1', type: 'function_call' }]);
    await settle();
    responseLeft(session, [{ id: 'msg-1', type: 'message' }]);
    await result;
    session.sent.length = 0;

    line().record('[Conductor] Earlier, and over: started Echo.', true);

    expect(notes(session)).toEqual(['[Conductor] Earlier, and over: started Echo.']);
    expect(deleted(session)).toEqual(['said_1', 'fc-1', 'out_2', 'msg-1']);
    // The record is in before anything is taken away.
    expect(sentTypes(session)[0]).toBe('conversation.item.create');
    store.dispose();
  });

  it('stays as it was said while it is open, and goes with the turn that closes it', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const asked = line().turn({ text: 'a brief with no project', context: 'c', spoken: false });
    responseLeft(session, [{ id: 'msg-1', type: 'message' }]);
    await asked;
    session.sent.length = 0;
    // The model asked which project: the developer has yet to answer.
    line().record('[Conductor] Earlier, and over: asked which project.', false);
    expect(session.sent).toEqual([]);

    const answered = line().turn({ text: 'Maestro', context: 'c', spoken: false });
    expect(deleted(session)).toEqual(['state_2']);
    responseLeft(session, [{ id: 'msg-2', type: 'message' }]);
    await answered;
    session.sent.length = 0;
    line().record('[Conductor] Earlier, and over: started Echo.', true);

    expect(notes(session)).toEqual([
      '[Conductor] Earlier, and over: asked which project.',
      '[Conductor] Earlier, and over: started Echo.',
    ]);
    expect(deleted(session)).toEqual(['said_1', 'msg-1', 'said_2', 'msg-2']);
    store.dispose();
  });

  it('takes the words the line heard itself with it', async () => {
    const { store, open, line, capture, conductor } = harness();
    const session = await open();
    capture().begin('i-1');
    session.emit({ type: 'input_audio_buffer.speech_started' });
    committed(session, 'item-1');
    await capture().end('i-1');
    committed(session, 'item-2');
    expect(conductor.speechTurn).toHaveBeenCalled();
    const result = line().turn({ context: 'c', spoken: false });
    responseLeft(session, [{ id: 'msg-1', type: 'message' }]);
    await result;
    session.sent.length = 0;

    line().record('[Conductor] Earlier, and over: sent.', true);
    expect(deleted(session)).toEqual(['item-1', 'item-2', 'msg-1']);
    store.dispose();
  });

  it('waits for the voice to finish the answer, but not past the next request', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const first = line().turn({ text: 'one', context: 'c', spoken: true });
    session.emit({ type: 'output_audio_buffer.started', response_id: 'r1' });
    responseLeft(session, [{ id: 'msg-1', type: 'message' }]);
    await first;
    session.sent.length = 0;
    line().record('[Conductor] Earlier, and over: one.', true);
    expect(session.sent).toEqual([]);
    session.emit({ type: 'output_audio_buffer.stopped', response_id: 'r1' });
    expect(deleted(session)).toEqual(['said_1', 'msg-1']);

    const second = line().turn({ text: 'two', context: 'c', spoken: true });
    session.emit({ type: 'output_audio_buffer.started', response_id: 'r2' });
    responseLeft(session, [{ id: 'msg-2', type: 'message' }]);
    await second;
    line().record('[Conductor] Earlier, and over: two.', true);
    session.sent.length = 0;
    // The voice is still speaking when the developer types the next request.
    void line().turn({ text: 'three', context: 'c', spoken: true });
    expect(notes(session)).toEqual(['[Conductor] Earlier, and over: two.']);
    expect(deleted(session).slice(0, 2)).toEqual(['said_2', 'msg-2']);
    // The record is there before the new request is.
    expect(session.sent[0]).toMatchObject({ item: { role: 'system' } });
    store.dispose();
  });

  it('answers no call of a turn that is already a record', async () => {
    const { store, open, line, conductor } = harness();
    const session = await open();
    let finish: (result: LineToolResult) => void = () => {};
    conductor.lineTool.mockImplementationOnce(
      () => new Promise<LineToolResult>((resolve) => (finish = resolve))
    );
    const result = line().turn({ text: 'go', context: 'c', spoken: false });
    toolCall(session, 'c1', 'send_to_agent');
    await settle();
    line().stop();
    responseLeft(session, [{ id: 'fc-1', type: 'function_call' }]);
    finish({ output: 'Sent.' });
    await settle();
    await result;
    line().record('[Conductor] Earlier, and over: sent.', true);
    session.sent.length = 0;

    toolCall(session, 'c1', 'send_to_agent');
    await settle();
    expect(session.sent).toEqual([]);
    store.dispose();
  });
});

describe('the voice', () => {
  it('says a sentence as written, by the provider and not the model', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const reading = line().say('Atlas finished.');
    expect(session.sent).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'force_message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Atlas finished.' }],
        },
      },
    ]);
    session.emit({ type: 'output_audio_buffer.started' });
    expect(store.speaking).toBe(true);
    session.emit({ type: 'output_audio_buffer.stopped' });
    await expect(reading).resolves.toBe(true);
    expect(store.speaking).toBe(false);
    store.dispose();
  });

  it('says nothing while the developer speaks, while muted, or over its own answer', async () => {
    const { store, open, line, room } = harness();
    await open();
    runInAction(() => (room.capturing = true));
    await expect(line().say('Atlas finished.')).resolves.toBe(false);
    runInAction(() => (room.capturing = false));
    runInAction(() => (room.muted = true));
    await expect(line().say('Atlas finished.')).resolves.toBe(false);
    runInAction(() => (room.muted = false));
    void line().turn({ context: 'c', spoken: true });
    await expect(line().say('Atlas finished.')).resolves.toBe(false);
    store.dispose();
  });

  it('goes quiet when the developer takes the key, and the turn keeps working', async () => {
    const { store, open, line, room, play } = harness();
    const session = await open();
    const stream = {} as MediaStream;
    session.deps.onRemoteStream(stream);
    const result = line().turn({ context: 'c', spoken: true });
    session.emit({ type: 'output_audio_buffer.started' });
    session.sent.length = 0;

    runInAction(() => (room.capturing = true));
    expect(play).toHaveBeenLastCalledWith(stream, true);
    expect(sentTypes(session)).toEqual(['output_audio_buffer.clear']);

    said(session, 'Sent to Atlas.');
    responseDone(session);
    await expect(result).resolves.toMatchObject({ reply: 'Sent to Atlas.', completed: true });
    session.emit({ type: 'output_audio_buffer.stopped' });
    runInAction(() => (room.capturing = false));
    expect(play).toHaveBeenLastCalledWith(stream, false);
    store.dispose();
  });

  it('opens the microphone for a moment after it speaks, so an answer needs no key', async () => {
    const { store, open, track } = harness({ windowSec: 6 });
    const session = await open();
    session.emit({ type: 'output_audio_buffer.started' });
    session.emit({ type: 'output_audio_buffer.stopped' });
    expect(store.micOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    expect(store.micOpen).toBe(true);
    expect(track.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(store.micOpen).toBe(false);
    expect(track.enabled).toBe(false);
    store.dispose();
  });

  it('never opens the microphone without a key when that is set to 0', async () => {
    const { store, open } = harness({ windowSec: 0 });
    const session = await open();
    session.emit({ type: 'output_audio_buffer.started' });
    session.emit({ type: 'output_audio_buffer.stopped' });
    await vi.advanceTimersByTimeAsync(ECHO_TAIL * 2);
    expect(store.micOpen).toBe(false);
    store.dispose();
  });

  it('opens the microphone as the voice starts when talking over it is on, with the key', async () => {
    const { store, open, track } = harness({ talkOver: true, windowSec: 6 });
    const session = await open();
    expect(store.micOpen).toBe(false);
    session.emit({ type: 'output_audio_buffer.started' });
    expect(store.micOpen).toBe(true);
    expect(track.enabled).toBe(true);
    store.dispose();
  });

  it('keeps the microphone shut while it speaks, unless talking over it is on', async () => {
    const quiet = harness({ listening: 'open' });
    const first = await quiet.open();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    first.emit({ type: 'output_audio_buffer.started' });
    expect(quiet.store.micOpen).toBe(false);
    quiet.store.dispose();

    const over = harness({ listening: 'open', talkOver: true });
    const second = await over.open();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    second.emit({ type: 'output_audio_buffer.started' });
    expect(over.store.micOpen).toBe(true);
    over.store.dispose();
  });
});

describe('a long session', () => {
  it('is replaced by a fresh one that starts from a summary, once nobody is talking', async () => {
    const { store, open, line, sessions } = harness();
    const session = await open();
    const result = line().turn({ text: 'hi', context: 'c', spoken: false });
    responseDone(session, { inputTokens: ROLLOVER_INPUT_TOKENS });
    await result;

    const asked = session.sent.at(-1) as { response?: { metadata?: { purpose?: string } } };
    expect(asked.response?.metadata?.purpose).toBe('rollover');
    expect(line().ready()).toBe(false);
    session.emit({
      type: 'response.done',
      response: {
        status: 'completed',
        metadata: { purpose: 'rollover' },
        output: [{ content: [{ text: 'They were rebasing Atlas.' }] }],
      },
    });
    await settle();

    expect(sessions).toHaveLength(2);
    expect(store.line).toBe('open');
    const carried = sessions[1]!.sent[1] as { item?: { content?: { text: string }[] } };
    expect(carried.item?.content?.[0]?.text).toContain('They were rebasing Atlas.');
    store.dispose();
  });

  it('takes turns again when the summary never comes', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const result = line().turn({ text: 'hi', context: 'c', spoken: false });
    responseDone(session, { inputTokens: ROLLOVER_INPUT_TOKENS });
    await result;
    expect(line().ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(line().ready()).toBe(true);
    store.dispose();
  });
});

describe('the daily limit', () => {
  it('shuts the line when a response takes the day over it, and gives the conductor back', async () => {
    const { store, open, line, client, conductor } = harness();
    const session = await open();
    client.recordUsage.mockResolvedValueOnce(status({}, { overBudget: true }));
    const result = line().turn({ text: 'hi', context: 'c', spoken: false });
    responseDone(session);
    await result;
    await settle();
    expect(store.line).toBe('off');
    expect(store.error).toContain('limit');
    expect(conductor.setTalkLine).toHaveBeenLastCalledWith(null);
    store.dispose();
  });

  it('reshapes the session when the model changes, and not when only the listening does', async () => {
    const { store, open, sessions } = harness();
    await open();
    await store.updateSettings({ listening: 'open' });
    await settle();
    expect(sessions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ECHO_TAIL);
    expect(store.micOpen).toBe(true);

    await store.updateSettings({ model: 'grok-voice-latest' });
    await settle();
    expect(sessions).toHaveLength(2);

    // A custom agent is another session too, and so is going back to the model.
    await store.updateSettings({ agentId: 'agent_9LN3SXMEJ4NuPEDm' });
    await settle();
    expect(sessions).toHaveLength(3);
    await store.updateSettings({ agentId: '' });
    await settle();
    expect(sessions).toHaveLength(4);
    store.dispose();
  });

  it('answers briefly unless told otherwise, and reopens to answer the other way', async () => {
    const { store, open, sessions, client } = harness();
    await open();
    const brief = client.openSession.mock.calls[0]![0].instructions;
    expect(brief).toContain('say nothing before or while you call them');
    expect(brief).not.toContain('one or two short sentences');

    await store.updateSettings({ replies: 'normal' });
    await settle();
    expect(sessions).toHaveLength(2);
    const normal = client.openSession.mock.calls[1]![0].instructions;
    expect(normal).toContain('one or two short sentences');
    expect(normal).not.toContain('say nothing before or while you call them');
    store.dispose();
  });

  it('gives the open session a new voice style without a new connection', async () => {
    const { store, open, sessions, client } = harness();
    const session = await open();
    const opened = client.openSession.mock.calls[0]![0].instructions;

    await store.updateSettings({ voiceStyle: 'Speak with a laid-back skater vibe.' });
    await settle();
    expect(sessions).toHaveLength(1);
    const update = session.sent.find((event) => event.type === 'session.update');
    const instructions = (update?.session as { instructions?: string } | undefined)?.instructions;
    expect(instructions).not.toBe(opened);
    expect(instructions).toContain('Speak with a laid-back skater vibe.');
    store.dispose();
  });

  it('gives the open session new standing instructions without a new connection', async () => {
    const { store, open, sessions, client, standing, conductor } = harness();
    const session = await open();
    const opened = client.openSession.mock.calls[0]![0].instructions;
    expect(opened).not.toContain('Standing instructions');

    runInAction(() => standing.set('Standing instructions from the developer:\n- [i1] Be open.'));
    await settle();
    expect(sessions).toHaveLength(1);
    const update = session.sent.find((event) => event.type === 'session.update');
    expect(update?.session).toEqual({
      instructions: `${opened}\n\nStanding instructions from the developer:\n- [i1] Be open.`,
    });
    expect(conductor.traceLine).toHaveBeenCalledWith('instructed', expect.anything());

    // The next session opens with them, and is not told twice.
    await store.updateSettings({ model: 'grok-voice-latest' });
    await settle();
    expect(sessions).toHaveLength(2);
    expect(client.openSession.mock.calls[1]![0].instructions).toContain('- [i1] Be open.');
    expect(sentTypes(sessions[1]!)).not.toContain('session.update');
    store.dispose();
  });
});

describe('on Grok Voice', () => {
  it('tells a sentence said as written from the turn that waits behind it', async () => {
    const { store, open, line } = harness();
    const session = await open();
    const reading = line().say('Atlas finished.');
    const result = line().turn({ text: 'hi', context: 'c', spoken: true });
    // One voice at a time: the turn is not asked for while the sentence is said.
    expect(sentTypes(session)).not.toContain('response.create');

    // A force message's response carries no metadata; it is still the sentence's.
    session.emit({ type: 'response.created', response: { id: 'say-1', metadata: null } });
    session.emit({
      type: 'response.done',
      response: { id: 'say-1', status: 'completed', output: [{ type: 'message' }] },
    });
    session.emit({ type: 'output_audio_buffer.started', response_id: 'say-1' });
    session.emit({ type: 'output_audio_buffer.stopped', response_id: 'say-1' });
    await expect(reading).resolves.toBe(true);
    expect(sentTypes(session).at(-1)).toBe('response.create');

    session.emit({ type: 'response.created', response: { id: 'turn-1', metadata: null } });
    said(session, 'Hello.');
    session.emit({
      type: 'response.done',
      response: { id: 'turn-1', status: 'completed', output: [{ type: 'message' }] },
    });
    await expect(result).resolves.toMatchObject({ reply: 'Hello.', completed: true });
    store.dispose();
  });

  it('reports each minute it is open, and the text it sent, for the daily limit', async () => {
    const { store, open, line, client } = harness();
    await open();
    line().note('[Conductor] Atlas finished.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.recordUsage).toHaveBeenLastCalledWith({
      model: DEFAULT_TALK_SETTINGS.model,
      tokens: NO_TOKENS,
      seconds: 60,
      // The state it was given on opening, and the note.
      textInputs: 2,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    store.dispose();
    await settle();
    expect(client.recordUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ seconds: 15, textInputs: 0 })
    );
  });

  it('closes for the day when the time it was open spends the limit', async () => {
    const { store, open, client } = harness();
    await open();
    client.recordUsage.mockResolvedValueOnce(status({}, { overBudget: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(store.line).toBe('off');
    expect(store.error).toBe("Today's talk line limit is used up.");
    store.dispose();
  });

  it('carries a summary over that came only as written text', async () => {
    const { store, open, line, sessions } = harness();
    const session = await open();
    const result = line().turn({ text: 'hi', context: 'c', spoken: false });
    responseDone(session, { inputTokens: ROLLOVER_INPUT_TOKENS });
    await result;
    session.emit({ type: 'response.output_text.done', text: 'They were rebasing Atlas.' });
    session.emit({
      type: 'response.done',
      response: { status: 'completed', metadata: { purpose: 'rollover' }, output: [] },
    });
    await settle();
    expect(sessions).toHaveLength(2);
    const carried = sessions[1]!.sent[1] as { item?: { content?: { text: string }[] } };
    expect(carried.item?.content?.[0]?.text).toContain('They were rebasing Atlas.');
    store.dispose();
  });
});

describe('joinTranscripts', () => {
  it('keeps the last of transcripts that each repeat everything said so far', () => {
    expect(
      joinTranscripts([
        'Message Vesper',
        'Message Vesper, the open agent.',
        'Message Vesper, the open agent. There is an issue',
        'message vesper the open agent there is an issue with the voice.',
      ])
    ).toBe('message vesper the open agent there is an issue with the voice.');
  });

  it('joins transcripts of separate stretches, and drops one already said', () => {
    expect(joinTranscripts(['Stop Atlas.', '', 'Then start Cedar.', 'start cedar'])).toBe(
      'Stop Atlas. Then start Cedar.'
    );
  });
});
