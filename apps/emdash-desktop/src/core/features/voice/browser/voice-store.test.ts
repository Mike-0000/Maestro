import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '@core/features/conductor/api/contract';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { MicRecorder } from './mic-recorder';
import { SpeechOutput } from './speech-output';
import { VoiceStore, type CaptureEvent } from './voice-store';

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../api/browser/client', () => ({ getVoiceClient: async () => ({ transcribe }) }));

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
    expect(speak).toHaveBeenCalledWith('Atlas finished.', expect.any(Function), {
      platform: false,
    });
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
    expect(speak).toHaveBeenLastCalledWith('Send to Atlas.', expect.any(Function), {
      platform: true,
    });

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
