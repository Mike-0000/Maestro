import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GrokVoiceSession,
  type LineAudio,
  type RealtimeEvent,
  type SessionState,
  type SocketLike,
} from './grok-voice-session';

/** 50 ms at the line's rate. */
const FRAME = 1_200;
const loud = () => new Float32Array(FRAME).fill(0.3);
const quiet = () => new Float32Array(FRAME);

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  const socket: SocketLike & { readyState: number } = {
    readyState: 0,
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  return {
    socket,
    sent,
    types: () => sent.map((event) => event.type),
    open: () => {
      socket.readyState = 1;
      socket.onopen?.();
    },
    receive: (event: Record<string, unknown>) =>
      socket.onmessage?.({ data: JSON.stringify(event) }),
    drop: (code = 1006) => {
      socket.readyState = 3;
      socket.onclose?.({ code, reason: '' });
    },
  };
}

function fakeAudio() {
  let queued = 0;
  let played = 0;
  const audio: LineAudio & {
    played: Uint8Array[];
    finish(): void;
    hear(ms: number): void;
    capture(samples: Float32Array): void;
  } = {
    output: { id: 'voice' } as unknown as MediaStream,
    onCapture: null,
    onDrained: null,
    played: [],
    play(pcm) {
      this.played.push(pcm);
      queued += pcm.length / 2 / 24;
    },
    clear: vi.fn(() => {
      queued = played;
    }),
    queuedMs: () => queued,
    playedMs: () => played,
    close: vi.fn(),
    finish() {
      played = queued;
      this.onDrained?.();
    },
    hear(ms) {
      played = Math.min(queued, played + ms);
    },
    capture(samples) {
      this.onCapture?.(samples, 24_000);
    },
  };
  return audio;
}

function harness(options: { interrupt?: boolean } = {}) {
  const socket = fakeSocket();
  const audio = fakeAudio();
  const track = { enabled: true } as MediaStreamTrack;
  const events: RealtimeEvent[] = [];
  const states: SessionState[] = [];
  const streams: unknown[] = [];
  const createSocket = vi.fn((_url: string, _protocols: string[]) => socket.socket);
  const connect = vi.fn(async () => ({
    url: 'wss://api.x.ai/v1/realtime?model=grok-voice-3.0',
    clientSecret: 'secret-1',
    session: { instructions: 'Be brief.', turn_detection: { type: null } },
  }));
  const session = new GrokVoiceSession({
    connect,
    track,
    interrupt: options.interrupt ?? false,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onRemoteStream: (stream) => streams.push(stream),
    createSocket,
    createAudio: async () => audio,
  });
  const opened = async () => {
    const opening = session.open();
    await flush();
    socket.open();
    await flush();
    socket.receive({ type: 'session.updated', session: {} });
    await opening;
    socket.sent.length = 0;
    events.length = 0;
  };
  const eventTypes = () => events.map((event) => event.type);
  return {
    session,
    socket,
    audio,
    track,
    events,
    eventTypes,
    states,
    streams,
    connect,
    createSocket,
    opened,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Speech long enough to be found, then a pause long enough to end it. */
function speak(audio: ReturnType<typeof fakeAudio>, pauseMs = 1_200): void {
  for (let i = 0; i < 6; i++) audio.capture(loud());
  for (let at = 0; at < pauseMs; at += 50) audio.capture(quiet());
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('opening', () => {
  it('connects with the client secret, configures the session, and only then is open', async () => {
    const { session, socket, connect, createSocket, states, streams, audio } = harness();
    const opening = session.open();
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(createSocket).toHaveBeenCalledWith('wss://api.x.ai/v1/realtime?model=grok-voice-3.0', [
      'xai-client-secret.secret-1',
    ]);
    socket.open();
    await flush();
    expect(socket.sent).toEqual([
      {
        type: 'session.update',
        session: { instructions: 'Be brief.', turn_detection: { type: null } },
      },
    ]);
    expect(session.state).toBe('connecting');
    socket.receive({ type: 'session.updated', session: {} });
    await opening;
    expect(states).toEqual(['connecting', 'open']);
    expect(streams).toEqual([audio.output]);
  });

  it('fails with the reason when xAI refuses the session', async () => {
    const { session, socket, audio, states } = harness();
    const opening = session.open();
    await flush();
    socket.open();
    await flush();
    socket.receive({ type: 'error', error: { message: 'Unknown voice: marin' } });
    await expect(opening).rejects.toThrow('Unknown voice: marin');
    await flush();
    expect(states.at(-1)).toBe('failed');
    expect(audio.close).toHaveBeenCalled();
  });

  it('fails when the connection closes before it is configured', async () => {
    const { session, socket } = harness();
    const opening = session.open();
    await flush();
    socket.open();
    await flush();
    socket.drop();
    await expect(opening).rejects.toThrow();
    expect(session.state).toBe('failed');
  });

  it('gives up when nothing answers', async () => {
    const { session } = harness();
    const opening = session.open();
    const failed = expect(opening).rejects.toThrow('did not open in time');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
  });

  it('is closed or failed when the connection ends after opening', async () => {
    const closed = harness();
    await closed.opened();
    closed.socket.drop(1000);
    expect(closed.states.at(-1)).toBe('closed');

    const failed = harness();
    await failed.opened();
    failed.socket.drop(1006);
    expect(failed.states.at(-1)).toBe('failed');
    expect(failed.session.send({ type: 'response.create' })).toBe(false);
  });
});

describe('the microphone', () => {
  it('sends nothing while the track is off, and nothing but speech while it is on', async () => {
    const { socket, audio, track, opened } = harness();
    await opened();
    track.enabled = false;
    audio.capture(loud());
    audio.capture(loud());
    track.enabled = true;
    for (let i = 0; i < 20; i++) audio.capture(quiet());
    expect(socket.sent).toEqual([]);
  });

  it('keeps what is said while it opens, and sends it once released', async () => {
    const { session, socket, audio, opened, eventTypes } = harness();
    session.holdAudio();
    const opening = opened();
    await flush();
    // Spoken before the session is open: kept, not sent.
    speak(audio);
    await opening;
    expect(socket.sent).toEqual([]);
    // Still kept after it opens, until the line is ready for it.
    audio.capture(quiet());
    expect(socket.sent).toEqual([]);
    session.releaseAudio(true);
    expect(eventTypes()).toEqual([
      'input_audio_buffer.speech_started',
      'input_audio_buffer.speech_stopped',
    ]);
    expect(socket.sent.some((event) => event.type === 'input_audio_buffer.append')).toBe(true);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input_audio_buffer.commit' });
  });

  it('drops what it kept when told to', async () => {
    const { session, socket, audio, opened, eventTypes } = harness();
    session.holdAudio();
    const opening = opened();
    await flush();
    speak(audio);
    await opening;
    session.releaseAudio(false);
    expect(socket.sent).toEqual([]);
    expect(eventTypes()).toEqual([]);
    // What is heard after is sent as usual.
    speak(audio);
    expect(eventTypes()).toContain('input_audio_buffer.speech_started');
  });

  it('reports where speech starts and stops, with what came just before, and commits it', async () => {
    const { socket, audio, opened, eventTypes } = harness();
    await opened();
    for (let i = 0; i < 10; i++) audio.capture(quiet());
    audio.capture(loud());
    expect(socket.sent).toEqual([]);
    audio.capture(loud());
    expect(eventTypes()).toEqual(['input_audio_buffer.speech_started']);
    // The moments before speech was found go first, so its first syllable is not lost.
    const appended = socket.sent.filter((event) => event.type === 'input_audio_buffer.append');
    expect(appended.length).toBeGreaterThan(2);
    for (let at = 0; at < 1_200; at += 50) audio.capture(quiet());
    expect(eventTypes()).toEqual([
      'input_audio_buffer.speech_started',
      'input_audio_buffer.speech_stopped',
    ]);
    expect(socket.sent.at(-1)).toEqual({
      type: 'input_audio_buffer.commit',
      event_id: 'line_commit_1',
    });
    // Each frame is 24 kHz 16-bit PCM in base64.
    const audioBytes = atob(String(appended[0]!.audio)).length;
    expect(audioBytes).toBe(FRAME * 2);
  });

  it('ends speech in progress when the key is let go', async () => {
    const { socket, audio, track, opened, eventTypes } = harness();
    await opened();
    speak(audio, 0);
    track.enabled = false;
    audio.capture(quiet());
    expect(eventTypes().at(-1)).toBe('input_audio_buffer.speech_stopped');
    expect(socket.types().at(-1)).toBe('input_audio_buffer.commit');
  });

  it('commits speech in progress when the line asks', async () => {
    const { session, socket, audio, opened } = harness();
    await opened();
    speak(audio, 0);
    expect(session.send({ type: 'input_audio_buffer.commit' })).toBe(true);
    expect(socket.types().filter((type) => type === 'input_audio_buffer.commit')).toHaveLength(1);
  });

  it('answers a commit with nothing left only after the commits before it are confirmed', async () => {
    const { session, socket, audio, opened, events } = harness();
    await opened();
    speak(audio);
    events.length = 0;
    session.send({ type: 'input_audio_buffer.commit' });
    // Nothing more was sent, and the line hears nothing yet: the commit before is in flight.
    expect(socket.types().filter((type) => type === 'input_audio_buffer.commit')).toHaveLength(1);
    expect(events).toEqual([]);
    socket.receive({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    expect(events.map((event) => event.type)).toEqual(['input_audio_buffer.committed', 'error']);
    expect(events[1]).toMatchObject({ error: { code: 'input_audio_buffer_commit_empty' } });
  });

  it('answers a commit with nothing to commit at once when nothing is in flight', async () => {
    const { session, socket, opened, events } = harness();
    await opened();
    session.send({ type: 'input_audio_buffer.commit' });
    expect(socket.sent).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'input_audio_buffer_commit_empty' }),
      }),
    ]);
  });

  it('drops speech in progress on a clear', async () => {
    const { session, socket, audio, opened, eventTypes } = harness();
    await opened();
    speak(audio, 0);
    socket.sent.length = 0;
    session.send({ type: 'input_audio_buffer.clear' });
    expect(eventTypes().at(-1)).toBe('input_audio_buffer.speech_stopped');
    expect(socket.sent).toEqual([{ type: 'input_audio_buffer.clear' }]);
  });
});

describe('the voice', () => {
  const delta = (responseId: string, itemId = 'msg-1') => ({
    type: 'response.output_audio.delta',
    response_id: responseId,
    item_id: itemId,
    // 480 samples: 20 ms.
    delta: btoa(String.fromCharCode(...new Uint8Array(960))),
  });

  it('plays the voice here, and reports it starting and stopping once it has all played', async () => {
    const { socket, audio, opened, eventTypes } = harness();
    await opened();
    socket.receive({ type: 'response.created', response: { id: 'r1' } });
    socket.receive(delta('r1'));
    socket.receive(delta('r1'));
    expect(audio.played).toHaveLength(2);
    expect(eventTypes()).toEqual(['response.created', 'output_audio_buffer.started']);
    // A gap in the stream while the answer is still being made is not the end of it.
    audio.finish();
    expect(eventTypes()).not.toContain('output_audio_buffer.stopped');
    socket.receive(delta('r1'));
    socket.receive({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    expect(eventTypes()).not.toContain('output_audio_buffer.stopped');
    audio.finish();
    expect(eventTypes().at(-1)).toBe('output_audio_buffer.stopped');
  });

  it('stops the voice when asked, and cuts what the model remembers to what was heard', async () => {
    const { session, socket, audio, opened, events } = harness();
    await opened();
    socket.receive(delta('r1'));
    socket.receive(delta('r1'));
    socket.receive({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    audio.hear(10);
    socket.sent.length = 0;
    expect(session.send({ type: 'output_audio_buffer.clear' })).toBe(true);
    expect(audio.clear).toHaveBeenCalled();
    expect(socket.sent).toEqual([
      { type: 'conversation.item.truncate', item_id: 'msg-1', content_index: 0, audio_end_ms: 10 },
    ]);
    expect(events.at(-1)).toEqual({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  });

  it('does not play what is still to come of an answer that was stopped', async () => {
    const { session, socket, audio, opened } = harness();
    await opened();
    socket.receive(delta('r1'));
    session.send({ type: 'output_audio_buffer.clear' });
    socket.receive(delta('r1'));
    expect(audio.played).toHaveLength(1);
    socket.receive(delta('r2'));
    expect(audio.played).toHaveLength(2);
  });

  it('stops the answer when the developer speaks over it, with talk-over on', async () => {
    const { socket, audio, opened, events } = harness({ interrupt: true });
    await opened();
    socket.receive({ type: 'response.created', response: { id: 'r1' } });
    socket.receive(delta('r1'));
    speak(audio, 0);
    expect(socket.sent).toContainEqual({ type: 'response.cancel', response_id: 'r1' });
    expect(events).toContainEqual({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
  });

  it('plays nothing of a response the line cancelled, from the moment it asked', async () => {
    const { session, socket, audio, opened, events } = harness();
    await opened();
    socket.receive(delta('r1'));
    expect(session.send({ type: 'response.cancel', response_id: 'r1' })).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'r1' });
    expect(audio.clear).toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'output_audio_buffer.cleared', response_id: 'r1' });
    socket.receive(delta('r1'));
    expect(audio.played).toHaveLength(1);
    // One cancelled before it spoke is never heard at all.
    session.send({ type: 'response.cancel', response_id: 'r2' });
    socket.receive(delta('r2'));
    expect(audio.played).toHaveLength(1);
  });

  it('lets the developer speak over it, without stopping it, with talk-over off', async () => {
    const { socket, audio, opened, events } = harness();
    await opened();
    socket.receive(delta('r1'));
    speak(audio, 0);
    expect(socket.types()).not.toContain('response.cancel');
    expect(events.map((event) => event.type)).not.toContain('output_audio_buffer.cleared');
  });
});

describe('what the provider sends', () => {
  it('lists the output in response.done, and reports text that was only streamed', async () => {
    const { socket, opened, events } = harness();
    await opened();
    socket.receive({ type: 'response.created', response: { id: 'r1' } });
    socket.receive({
      type: 'response.output_item.done',
      response_id: 'r1',
      item: { id: 'msg-1', type: 'message', role: 'assistant', content: [] },
    });
    socket.receive({
      type: 'response.text.delta',
      response_id: 'r1',
      item_id: 'msg-1',
      delta: 'Hel',
    });
    socket.receive({
      type: 'response.output_text.delta',
      response_id: 'r1',
      item_id: 'msg-1',
      delta: 'lo.',
    });
    socket.receive({ type: 'response.done', response: { id: 'r1', status: 'completed' } });

    const textDone = events.find((event) => event.type === 'response.output_text.done');
    expect(textDone).toMatchObject({ text: 'Hello.' });
    const done = events.at(-1) as unknown as { response: { output: unknown[] } };
    expect(done.response.output).toEqual([
      {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello.' }],
      },
    ]);
  });

  it('reports every function call before its response is done, and each once', async () => {
    const { socket, opened, events } = harness();
    await opened();
    const call = {
      id: 'fc-1',
      type: 'function_call',
      call_id: 'call-1',
      name: 'list_agents',
      arguments: '{}',
    };
    socket.receive({ type: 'response.created', response: { id: 'r1' } });
    socket.receive({ type: 'response.output_item.done', response_id: 'r1', item: call });
    socket.receive({
      type: 'response.function_call_arguments.done',
      response_id: 'r1',
      call_id: 'call-1',
      name: 'list_agents',
      arguments: '{}',
    });
    // A call listed only in response.done is reported too.
    socket.receive({
      type: 'response.done',
      response: {
        id: 'r1',
        status: 'completed',
        output: [call, { ...call, id: 'fc-2', call_id: 'call-2', name: 'read_agent' }],
      },
    });
    const calls = events.filter((event) => event.type === 'response.function_call_arguments.done');
    expect(calls.map((event) => event.call_id)).toEqual(['call-1', 'call-2']);
    expect(events.at(-1)?.type).toBe('response.done');
    expect(events.findIndex((event) => event.call_id === 'call-2')).toBeLessThan(events.length - 1);
  });

  it('passes everything else on as it came', async () => {
    const { socket, opened, events } = harness();
    await opened();
    const transcript = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'close Ginger',
    };
    socket.receive(transcript);
    expect(events).toEqual([transcript]);
  });
});
