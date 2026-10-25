import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '@core/features/conductor/api/contract';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../api/contract';
import { MicRecorder } from './mic-recorder';
import { firstAudioTimeoutMs, SpeechOutput } from './speech-output';
import { VoiceStore, type CaptureEvent } from './voice-store';

const { transcribe, stream } = vi.hoisted(() => ({
  transcribe: vi.fn(),
  stream: {
    openStream: vi.fn(),
    pushAudio: vi.fn(async () => {}),
    closeStream: vi.fn(),
    abortStream: vi.fn(async () => {}),
    warmDictation: vi.fn(async () => {}),
  },
}));
vi.mock('../api/browser/client', () => ({
  getVoiceClient: async () => ({ transcribe, ...stream }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice interaction capture', () => {
  it('keeps raw STT distinct from wake-phrase-stripped command and records ignored utterances', async () => {
    vi.spyOn(MicRecorder.prototype, 'start').mockResolvedValue();
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = new VoiceStore();
    store.status = {
      settings: { ...DEFAULT_VOICE_SETTINGS, engine: 'whisper-local' },
      credentials: {
        openai: false,
        deepgram: false,
        anthropic: false,
        typesafe: false,
        openrouter: false,
        gemini: false,
        xai: false,
      },
      globalShortcutRegistered: false,
      globalHoldActive: false,
    };
    const events: TraceEvent[] = [];
    const commands: { text: string; id: string }[] = [];
    store.setTraceHandler((event) => events.push(event));
    store.setTranscriptHandler((text, _intent, id) => {
      commands.push({ text, id });
    });
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'Maestro, take a note: ship it', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('toggle', 'command', 'hands-free');
    await store.stopListening();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.text).toBe('take a note: ship it');
    expect(events.find((event) => event.kind === 'stt-final')?.text).toBe(
      'Maestro, take a note: ship it'
    );
    expect(events[0]?.interactionId).toBe(commands[0]?.id);

    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'background speech', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('toggle', 'command', 'hands-free');
    await store.stopListening();
    expect(commands).toHaveLength(1);
    expect(
      events.some((event) => event.kind === 'ignored' && event.detail?.reason === 'wake-phrase')
    ).toBe(true);
    store.dispose();
  });
});

function readyStore(): VoiceStore {
  vi.spyOn(MicRecorder.prototype, 'start').mockResolvedValue();
  vi.spyOn(MicRecorder.prototype, 'cancel').mockReturnValue();
  vi.spyOn(MicRecorder.prototype, 'setMonitoring').mockResolvedValue();
  const store = new VoiceStore();
  store.status = {
    settings: { ...DEFAULT_VOICE_SETTINGS, engine: 'whisper-local' },
    credentials: {
      openai: false,
      deepgram: false,
      anthropic: false,
      typesafe: false,
      openrouter: false,
      gemini: false,
      xai: false,
    },
    globalShortcutRegistered: false,
    globalHoldActive: false,
  };
  return store;
}

describe('capture events', () => {
  it('reports the start, and an end only when no transcript is handed on', async () => {
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = readyStore();
    const events: CaptureEvent[] = [];
    const handled: string[] = [];
    store.setCaptureHandler((event) => events.push(event));
    store.setTranscriptHandler((text) => {
      handled.push(text);
    });

    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'focus Atlas', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('hold');
    expect(store.capturing).toBe(true);
    await store.stopListening();
    expect(handled).toEqual(['focus Atlas']);
    expect(events.map((event) => event.type)).toEqual(['start']);

    await store.startListening('hold');
    store.cancelListening();
    expect(events.map((event) => event.type)).toEqual(['start', 'start', 'end']);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'cancelled' });
    expect(events[1]?.interactionId).toBe(events[2]?.interactionId);
    expect(store.capturing).toBe(false);
    store.dispose();
  });

  it('ends a capture that was too short or produced no words', async () => {
    const store = readyStore();
    const events: CaptureEvent[] = [];
    store.setCaptureHandler((event) => events.push(event));
    store.setTranscriptHandler(() => {});

    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValueOnce({
      wav: new Uint8Array(10),
      durationMs: 100,
    });
    await store.startListening('hold');
    await store.stopListening();
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'too-short' });

    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValueOnce({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: '   ', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('hold');
    await store.stopListening();
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'ignored' });
    store.dispose();
  });
});

describe('a live voice session', () => {
  function live(taken = true) {
    return {
      begin: vi.fn((_interactionId: string) => true),
      end: vi.fn(async (_interactionId: string) => taken),
      cancel: vi.fn(),
    };
  }

  function clock() {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    return (ms: number) => (now += ms);
  }

  it('hears a held command itself: no recorder, no transcription, no transcript handed on', async () => {
    transcribe.mockClear();
    const start = vi.spyOn(MicRecorder.prototype, 'start');
    const pass = clock();
    const store = readyStore();
    const session = live();
    const events: CaptureEvent[] = [];
    const handled: string[] = [];
    store.setLiveCapture(session);
    store.setCaptureHandler((event) => events.push(event));
    store.setTranscriptHandler((text) => {
      handled.push(text);
    });

    await store.startListening('hold');
    expect(store.capturing).toBe(true);
    const id = events[0]!.interactionId;
    expect(session.begin).toHaveBeenCalledWith(id);
    expect(start).not.toHaveBeenCalled();

    // Until the session has taken the words, the capture is not over.
    let taken: (value: boolean) => void = () => {};
    session.end.mockImplementationOnce(() => new Promise<boolean>((resolve) => (taken = resolve)));
    pass(1_000);
    await store.stopListening();
    expect(store.capturing).toBe(true);
    taken(true);
    for (let round = 0; round < 5; round++) await Promise.resolve();
    expect(store.capturing).toBe(false);
    expect(session.end).toHaveBeenCalledWith(id);
    expect(transcribe).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
    // The session took the words: the capture ends with its answer, not with an event.
    expect(events.map((event) => event.type)).toEqual(['start']);
    store.dispose();
  });

  it('ends the capture when the session heard nothing, or the key was only tapped', async () => {
    const pass = clock();
    const store = readyStore();
    const session = live(false);
    const events: CaptureEvent[] = [];
    store.setLiveCapture(session);
    store.setCaptureHandler((event) => events.push(event));

    await store.startListening('hold');
    pass(1_000);
    await store.stopListening();
    for (let round = 0; round < 5; round++) await Promise.resolve();
    expect(store.capturing).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'ignored' });

    await store.startListening('hold');
    pass(100);
    await store.stopListening();
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'too-short' });

    await store.startListening('hold');
    store.cancelListening();
    expect(session.cancel).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'cancelled' });
    store.dispose();
  });

  it('shows the level of a capture the session hears, without recording it', async () => {
    const start = vi.spyOn(MicRecorder.prototype, 'start');
    const pass = clock();
    const store = readyStore();
    const monitor = vi.mocked(MicRecorder.prototype.setMonitoring);
    const session = live();
    store.setLiveCapture(session);

    await store.startListening('hold');
    expect(monitor).toHaveBeenLastCalledWith(true);
    expect(start).not.toHaveBeenCalled();
    store['onChunk'](0.2, 20);
    expect(store.level).toBeGreaterThan(0);

    // Sent: the recorder stops listening along, and the meter is at rest.
    pass(1_000);
    await store.stopListening();
    expect(monitor).toHaveBeenLastCalledWith(false);
    expect(store.level).toBe(0);
    for (let round = 0; round < 5; round++) await Promise.resolve();

    await store.startListening('hold');
    expect(monitor).toHaveBeenLastCalledWith(true);
    store['onChunk'](0.2, 20);
    store.cancelListening();
    expect(monitor).toHaveBeenLastCalledWith(false);
    expect(store.level).toBe(0);

    // Hands-free keeps the microphone monitored between captures.
    store.status = { ...store.status!, settings: { ...store.settings!, handsFree: true } };
    await store.startListening('hold');
    store.cancelListening();
    expect(monitor).toHaveBeenLastCalledWith(true);
    store.dispose();
  });

  it('keeps the capture when the meter cannot open the microphone', async () => {
    const store = readyStore();
    vi.mocked(MicRecorder.prototype.setMonitoring).mockRejectedValue(new Error('no microphone'));
    const session = live();
    store.setLiveCapture(session);

    await store.startListening('hold');
    await Promise.resolve();
    expect(store.phase).toBe('listening');
    expect(store.error).toBeNull();
    store.cancelListening();
    store.dispose();
  });

  it('leaves dictation, and a session that cannot take the capture, to the recorder', async () => {
    const start = vi.spyOn(MicRecorder.prototype, 'start');
    const store = readyStore();
    const session = live();
    store.setLiveCapture(session);

    await store.startListening('hold', 'dictation');
    expect(session.begin).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    store.cancelListening();

    session.begin.mockReturnValueOnce(false);
    await store.startListening('hold');
    expect(start).toHaveBeenCalledTimes(2);
    store.cancelListening();

    store.setLiveCapture(null);
    await store.startListening('hold');
    expect(start).toHaveBeenCalledTimes(3);
    store.cancelListening();
    store.dispose();
  });
});

describe('tap to answer', () => {
  it('opens the microphone only when something is waiting for a reply', async () => {
    const store = readyStore();
    store.tap();
    expect(store.phase).toBe('idle');

    let waiting = false;
    store.setTapGate(() => waiting);
    store.tap();
    expect(store.phase).toBe('idle');

    waiting = true;
    store.tap();
    expect(store.phase).toBe('listening');
    expect(store.mode).toBe('toggle');
    store.cancelListening();
    store.dispose();
  });

  it('sends on a second tap', async () => {
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = readyStore();
    const handled: string[] = [];
    store.setTapGate(() => true);
    store.setTranscriptHandler((text) => {
      handled.push(text);
    });
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'fix the lint error too', latencyMs: 20, engine: 'whisper-local' },
    });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    store.tap();
    await Promise.resolve();
    // The same tap reported again by the system-wide hook does not send it.
    now.mockReturnValue(1_000_300);
    store.tap();
    expect(store.phase).toBe('listening');
    now.mockReturnValue(1_002_000);
    store.tap();
    await vi.waitFor(() => expect(handled).toEqual(['fix the lint error too']));
    store.dispose();
  });
});

describe('tap to dictate', () => {
  function dictationStub() {
    return { active: false, capturing: false, toggle: vi.fn() };
  }

  it('starts dictation on a tap when nothing is waiting for a reply, and finishes it on the next', () => {
    const store = readyStore();
    const dictation = dictationStub();
    store.setDictation(dictation);
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    store.tap();
    expect(dictation.toggle).toHaveBeenCalledTimes(1);
    expect(store.phase).toBe('idle');
    dictation.active = true;
    // The same tap reported again by the system-wide hook is not a second tap.
    now.mockReturnValue(1_000_300);
    store.tap();
    expect(dictation.toggle).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_005_000);
    store.tap();
    expect(dictation.toggle).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('answers a waiting call first', () => {
    const store = readyStore();
    const dictation = dictationStub();
    store.setDictation(dictation);
    store.setTapGate(() => true);
    store.tap();
    expect(store.phase).toBe('listening');
    expect(dictation.toggle).not.toHaveBeenCalled();
    store.cancelListening();
    store.dispose();
  });

  it('keeps the command microphone closed while dictation is listening', async () => {
    const store = readyStore();
    const dictation = dictationStub();
    dictation.capturing = true;
    store.setDictation(dictation);
    await store.startListening('hold');
    expect(store.phase).toBe('idle');
    store.dispose();
  });
});

describe('speak', () => {
  it('resolves when the sentence ends and records how long the first sound took', async () => {
    const store = readyStore();
    const events: TraceEvent[] = [];
    store.setTraceHandler((event) => events.push(event));
    const speak = vi
      .spyOn(SpeechOutput.prototype, 'speak')
      .mockImplementation((_text, onStatus) => {
        onStatus?.('started');
        onStatus?.('ended');
      });
    const id = crypto.randomUUID();
    await expect(store.speak('Atlas finished.', { interactionId: id })).resolves.toBe('ended');
    expect(speak).toHaveBeenCalledWith(
      'Atlas finished.',
      expect.any(Function),
      expect.objectContaining({ platform: false })
    );
    const statuses = events.filter((event) => event.kind === 'speech');
    expect(statuses.map((event) => event.detail?.status)).toEqual([
      'requested',
      'started',
      'ended',
    ]);
    expect(typeof statuses[1]?.detail?.ms).toBe('number');
    store.dispose();
  });

  it('uses the system voice when asked, and never starts while muted or listening', async () => {
    const store = readyStore();
    const speak = vi
      .spyOn(SpeechOutput.prototype, 'speak')
      .mockImplementation((_text, onStatus) => onStatus?.('ended'));
    const id = crypto.randomUUID();
    await store.speak('Send to Atlas.', { voice: 'system', interactionId: id });
    expect(speak).toHaveBeenLastCalledWith(
      'Send to Atlas.',
      expect.any(Function),
      expect.objectContaining({ platform: true })
    );

    store.setMuted(true);
    await expect(store.speak('x', { interactionId: id })).resolves.toBe('suppressed');
    store.setMuted(false);
    await store.startListening('hold');
    await expect(store.speak('x', { interactionId: id })).resolves.toBe('suppressed');
    expect(speak).toHaveBeenCalledTimes(1);
    store.cancelListening();
    store.dispose();
  });
});

describe('what speech and captures leave in the trace', () => {
  function traced() {
    const store = readyStore();
    const events: TraceEvent[] = [];
    store.setTraceHandler((event) => events.push(event));
    const speech = (id?: string) =>
      events
        .filter((event) => event.kind === 'speech' && (!id || event.interactionId === id))
        .map((event) => event.detail);
    return { store, events, speech };
  }

  it('traces an announcement like a reply, with the engine that was heard', async () => {
    const { store, speech } = traced();
    vi.spyOn(SpeechOutput.prototype, 'speak').mockImplementation((_text, onStatus, options) => {
      options?.onFallback?.({ engine: 'vertex-gemini-flash', reason: 'first-audio-timeout' });
      onStatus?.('started', { engine: 'platform' });
      onStatus?.('ended');
    });
    const id = crypto.randomUUID();
    await expect(store.announce('Atlas needs permission.', id)).resolves.toBe('ended');
    expect(speech(id)).toEqual([
      { status: 'requested', attention: true },
      {
        status: 'fallback',
        engine: 'vertex-gemini-flash',
        reason: 'first-audio-timeout',
        attention: true,
      },
      expect.objectContaining({ status: 'started', engine: 'platform', attention: true }),
      { status: 'ended', attention: true },
    ]);
    expect(store.speechInFlight).toBe(false);
    store.dispose();
  });

  it('says why an announcement or a reply was not said', async () => {
    const { store, speech } = traced();
    vi.spyOn(SpeechOutput.prototype, 'speak').mockImplementation(() => {});
    const id = crypto.randomUUID();
    store.setMuted(true);
    await expect(store.announce('Atlas needs you.', id)).resolves.toBe('suppressed');
    store.say('Sent.', id);
    store.setMuted(false);
    store.status = {
      ...store.status!,
      settings: { ...store.status!.settings, speakAttention: false, speakReplies: false },
    };
    await store.announce('Atlas needs you.', id);
    store.say('Sent.', id);
    store.status = {
      ...store.status!,
      settings: { ...store.status!.settings, speakAttention: true, speakReplies: true },
    };
    await store.startListening('hold');
    await store.announce('Atlas needs you.', id);
    expect(speech(id).map((detail) => detail?.reason)).toEqual([
      'muted',
      'muted',
      'speak-attention-off',
      'speak-replies-off',
      'listening',
    ]);
    // Muting and unmuting are traced too.
    expect(speech().map((detail) => detail?.status)).toEqual(
      expect.arrayContaining(['muted', 'unmuted'])
    );
    store.cancelListening();
    store.dispose();
  });

  it('says what cut speech off, and counts it in flight until then', async () => {
    const { store, speech } = traced();
    const listeners: ((status: 'started' | 'cancelled', detail?: { reason?: string }) => void)[] =
      [];
    vi.spyOn(SpeechOutput.prototype, 'speak').mockImplementation((_text, onStatus) => {
      // As the real output does: whatever is playing is cancelled as replaced first.
      listeners.at(-1)?.('cancelled', { reason: 'replaced' });
      if (onStatus) listeners.push(onStatus);
    });
    vi.spyOn(SpeechOutput.prototype, 'stop').mockImplementation((reason) =>
      listeners.at(-1)?.('cancelled', { reason: reason ?? 'stopped' })
    );
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    void store.speak('One.', { interactionId: first });
    expect(store.speechInFlight).toBe(true);
    void store.speak('Two.', { interactionId: second });
    expect(store.speechInFlight).toBe(true);
    await store.startListening('hold');
    expect(store.speechInFlight).toBe(false);
    expect(speech(first).at(-1)).toEqual({ status: 'cancelled', reason: 'replaced' });
    expect(speech(second).at(-1)).toEqual({ status: 'cancelled', reason: 'developer-capture' });
    store.cancelListening();
    store.dispose();
  });

  it('stops counting a sentence whose end never comes, so what follows can be said', async () => {
    vi.useFakeTimers();
    try {
      const { store, speech } = traced();
      const said: string[] = [];
      vi.spyOn(SpeechOutput.prototype, 'speak').mockImplementation((text, onStatus) => {
        said.push(text);
        // Starts, and never reports an end.
        onStatus?.('started', { engine: 'platform' });
      });
      // A cloud voice: its first audio may take its own timeout to come.
      store.speech.configure({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'vertex-gemini-flash' }, {});
      expect(store.firstAudioWaitMs).toBe(firstAudioTimeoutMs('vertex-gemini-flash'));
      const id = crypto.randomUUID();
      const first = store.announce('Atlas needs you.', id);
      expect(store.speechInFlight).toBe(true);
      const words = 8_000 + 90 * 'Atlas needs you.'.length;
      await vi.advanceTimersByTimeAsync(words);
      // Still within the voice's own wait for its first audio.
      expect(store.speechInFlight).toBe(true);
      await vi.advanceTimersByTimeAsync(store.firstAudioWaitMs);
      await expect(first).resolves.toBe('failed');
      expect(store.speechInFlight).toBe(false);
      expect(speech(id).at(-1)).toEqual({ status: 'timeout', attention: true });
      void store.announce('Bravo finished.');
      expect(said).toEqual(['Atlas needs you.', 'Bravo finished.']);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records why a capture was cancelled and whether speech was ever heard', async () => {
    const { store, events } = traced();
    await store.startListening('hold');
    store['onChunk'](0.5, 100);
    store.cancelListening('escape');
    await store.startListening('toggle', 'command', 'user', { endOnPause: true });
    for (let elapsed = 0; elapsed < 6_000; elapsed += 500) store['onChunk'](0.001, 500);
    const cancels = events
      .filter((event) => event.kind === 'ignored' && event.detail?.reason === 'cancelled')
      .map((event) => event.detail);
    expect(cancels).toEqual([
      { reason: 'cancelled', cause: 'escape', heardSpeech: true },
      { reason: 'cancelled', cause: 'no-speech-timeout', heardSpeech: false },
    ]);
    store.dispose();
  });
});

describe('the on-device model', () => {
  function localStore(settings: Partial<VoiceSettings> = {}) {
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = readyStore();
    store.status = {
      ...store.status!,
      settings: { ...store.status!.settings, localTranscriber: true, ...settings },
    };
    const handled: string[] = [];
    store.setTranscriptHandler((text) => {
      handled.push(text);
    });
    return { store, handled };
  }

  it('hears a command while it is spoken, and is warmed up when the capture starts', async () => {
    const { store, handled } = localStore();
    transcribe.mockClear();
    stream.openStream.mockResolvedValueOnce({ supported: true, streamId: 'local-1' });
    stream.closeStream.mockResolvedValueOnce({
      success: true,
      data: { text: 'focus Atlas', latencyMs: 40 },
    });
    await store.startListening('hold');
    expect(stream.warmDictation).toHaveBeenCalled();
    // The stream is open by the time the developer has said anything.
    await store['streamOpening'];
    store['onPcm'](new Uint8Array(new ArrayBuffer(4)));
    await store.stopListening();
    expect(handled).toEqual(['focus Atlas']);
    expect(stream.pushAudio).toHaveBeenCalledWith({ streamId: 'local-1', pcm: expect.any(String) });
    expect(transcribe).not.toHaveBeenCalled();
    store.dispose();
  });

  it('uploads the recording when there is no model to stream to, or streaming is off', async () => {
    const { store, handled } = localStore();
    stream.openStream.mockResolvedValueOnce({ supported: false, streamId: null });
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'show all', latencyMs: 20, engine: 'parakeet-local' },
    });
    await store.startListening('hold');
    await store.stopListening();
    expect(handled).toEqual(['show all']);

    const off = localStore({ streaming: false });
    stream.openStream.mockClear();
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'next', latencyMs: 20, engine: 'parakeet-local' },
    });
    await off.store.startListening('hold');
    await off.store.stopListening();
    expect(stream.openStream).not.toHaveBeenCalled();
    expect(off.handled).toEqual(['next']);
    store.dispose();
    off.store.dispose();
  });
});

describe('hands-free follow-up', () => {
  function handsFreeStore() {
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = readyStore();
    store.status = {
      ...store.status!,
      settings: { ...store.status!.settings, handsFree: true },
    };
    const commands: string[] = [];
    store.setTranscriptHandler((text) => {
      commands.push(text);
    });
    const say = async (text: string) => {
      transcribe.mockResolvedValueOnce({
        success: true,
        data: { text, latencyMs: 20, engine: 'whisper-local' },
      });
      await store.startListening('toggle', 'command', 'hands-free');
      await store.stopListening();
    };
    return { store, commands, say };
  }

  it('takes one utterance without the wake phrase right after a command', async () => {
    const { store, commands, say } = handsFreeStore();
    await say('Maestro, switch to the chorus desk');
    await say('go ahead and remove all of those');
    expect(commands).toEqual(['switch to the chorus desk', 'go ahead and remove all of those']);

    // The follow-up opened no window of its own.
    await say('and one more thing');
    expect(commands).toHaveLength(2);
    expect(store.ignoredUtterance).toBe('and one more thing');
    store.dispose();
  });

  it('ignores speech without the wake phrase once the window has passed', async () => {
    const { store, commands, say } = handsFreeStore();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await say('Maestro, switch to the chorus desk');
    now.mockReturnValue(1_000_000 + 11_000);
    await say('of course');
    expect(commands).toEqual(['switch to the chorus desk']);
    store.dispose();
  });
});

describe('a capture left open', () => {
  it('drops a click-to-talk capture nobody spoke into', async () => {
    const store = readyStore();
    const events: CaptureEvent[] = [];
    store.setCaptureHandler((event) => events.push(event));
    await store.startListening('toggle');
    for (let elapsed = 0; elapsed < 89_000; elapsed += 1_000) store['onChunk'](0.001, 1_000);
    expect(store.isListening).toBe(true);
    store['onChunk'](0.001, 1_000);
    expect(store.isListening).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'cancelled' });
    store.dispose();
  });

  it('sends what was said once the developer has been quiet for a while', async () => {
    vi.spyOn(MicRecorder.prototype, 'stop').mockReturnValue({
      wav: new Uint8Array(10000),
      durationMs: 1000,
    });
    const store = readyStore();
    const handled: string[] = [];
    store.setTranscriptHandler((text) => {
      handled.push(text);
    });
    transcribe.mockResolvedValueOnce({
      success: true,
      data: { text: 'focus Atlas', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('toggle');
    store['onChunk'](0.5, 1_000);
    for (let elapsed = 0; elapsed < 90_000; elapsed += 1_000) store['onChunk'](0.001, 1_000);
    await vi.waitFor(() => expect(handled).toEqual(['focus Atlas']));
    store.dispose();
  });

  it('leaves a held key alone', async () => {
    const store = readyStore();
    await store.startListening('hold');
    for (let elapsed = 0; elapsed < 120_000; elapsed += 1_000) store['onChunk'](0.001, 1_000);
    expect(store.isListening).toBe(true);
    store.cancelListening();
    store.dispose();
  });
});
