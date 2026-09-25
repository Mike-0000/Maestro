import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceEvent } from '@core/features/conductor/api/contract';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { MicRecorder } from './mic-recorder';
import { VoiceStore } from './voice-store';

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
      data: { text: 'Chorus, take a note: ship it', latencyMs: 20, engine: 'whisper-local' },
    });
    await store.startListening('toggle', 'command', 'hands-free');
    await store.stopListening();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.text).toBe('take a note: ship it');
    expect(events.find((event) => event.kind === 'stt-final')?.text).toBe(
      'Chorus, take a note: ship it'
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
