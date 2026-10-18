import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secret } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { VoiceService } from './voice-service';

const { localSpeak } = vi.hoisted(() => ({ localSpeak: vi.fn() }));
const { openRouterSpeak } = vi.hoisted(() => ({ openRouterSpeak: vi.fn() }));
const { geminiSpeak } = vi.hoisted(() => ({ geminiSpeak: vi.fn() }));
vi.mock('./gemini-tts', () => ({ streamGeminiTts: geminiSpeak }));
vi.mock('./openrouter-tts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openrouter-tts')>()),
  streamOpenRouterTts: openRouterSpeak,
}));
vi.mock('./local-tts', () => ({
  LocalTts: class {
    speak = localSpeak;
  },
}));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  localSpeak.mockReset();
  openRouterSpeak.mockReset();
  geminiSpeak.mockReset();
});

describe('VoiceService offline speech', () => {
  it('synthesizes with the local voice without reading any API key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chorus-tts-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'voice-settings.json'),
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, ttsEngine: 'kitten', localVoice: 'Rosie' })
    );
    const getSecret = vi.fn();
    const host = { dataDir: dir, secrets: { getSecret } } as unknown as ChorusHostServices;
    const service = new VoiceService(host, () => {}, {} as Logger);
    localSpeak.mockImplementation(async (_text, _voice, _signal, emit) => {
      emit({ type: 'chunk', pcm: 'AAAA' });
      emit({ type: 'done' });
    });
    const emit = vi.fn();
    await service.startTts('reply-id', 'Ready.', emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(localSpeak).toHaveBeenCalledWith(
      'Ready.',
      'Rosie',
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(getSecret).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe('VoiceService OpenRouter speech', () => {
  async function serviceWith(ttsEngine: string, openRouterKey: string | null) {
    const dir = await mkdtemp(join(tmpdir(), 'chorus-tts-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'voice-settings.json'),
      JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, ttsEngine, geminiVoice: 'Puck' })
    );
    const getSecret = vi.fn(async (name: string) =>
      name.endsWith('openrouter') && openRouterKey ? secret(openRouterKey, 'openrouter') : null
    );
    const host = { dataDir: dir, secrets: { getSecret } } as unknown as ChorusHostServices;
    return { service: new VoiceService(host, () => {}, {} as Logger), getSecret };
  }

  it.each([
    ['openrouter-gemini-flash', 'google/gemini-3.8-flash-tts'],
    ['openrouter-gemini-flash-lite', 'google/gemini-3.8-flash-lite-tts'],
  ])('synthesizes %s with the OpenRouter key and model %s', async (engine, model) => {
    const { service, getSecret } = await serviceWith(engine, 'or-key');
    openRouterSpeak.mockImplementation(async (_options, emit) => {
      emit({ type: 'chunk', pcm: 'AAAA', sampleRate: 24_000 });
      emit({ type: 'done' });
    });
    const emit = vi.fn();
    await service.startTts('reply-id', 'Ready.', emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(openRouterSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ model, voice: 'Puck', text: 'Ready.' }),
      expect.any(Function)
    );
    expect(emit).toHaveBeenNthCalledWith(1, { type: 'chunk', pcm: 'AAAA', sampleRate: 24_000 });
    expect(getSecret.mock.calls.map(([name]) => name)).not.toContainEqual(
      expect.stringContaining('gemini')
    );
    service.dispose();
  });

  it('reports an error without an OpenRouter key so the renderer falls back', async () => {
    const { service } = await serviceWith('openrouter-gemini-flash', null);
    const emit = vi.fn();
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await service.startTts('reply-id', 'Ready.', emit);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
    expect(emit).toHaveBeenCalledWith({ type: 'error' });
    expect(openRouterSpeak).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe('VoiceService custom Gemini voice', () => {
  async function serviceWith(ttsEngine: string, geminiCustomVoice: string) {
    const dir = await mkdtemp(join(tmpdir(), 'chorus-tts-'));
    dirs.push(dir);
    await writeFile(
      join(dir, 'voice-settings.json'),
      JSON.stringify({
        ...DEFAULT_VOICE_SETTINGS,
        ttsEngine,
        geminiVoice: 'Puck',
        geminiCustomVoice,
      })
    );
    const getSecret = vi.fn(async (name: string) => secret('key', name));
    const host = { dataDir: dir, secrets: { getSecret } } as unknown as ChorusHostServices;
    return new VoiceService(host, () => {}, {} as Logger);
  }
  const speakOnce = async (_options: unknown, emit: (event: { type: 'done' }) => void) =>
    emit({ type: 'done' });

  it.each([
    ['gemini-flash', geminiSpeak],
    ['openrouter-gemini-flash-lite', openRouterSpeak],
  ])('speaks %s in the custom voice instead of the prebuilt one', async (engine, speak) => {
    const service = await serviceWith(engine, '  voice_abc123  ');
    speak.mockImplementation(speakOnce);
    const emit = vi.fn();
    await service.startTts('reply-id', 'Ready.', emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({ type: 'done' }));
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'voice_abc123' }),
      expect.any(Function)
    );
    service.dispose();
  });

  it('uses the prebuilt voice when the custom voice is blank', async () => {
    const service = await serviceWith('gemini-flash', '   ');
    geminiSpeak.mockImplementation(speakOnce);
    const emit = vi.fn();
    await service.startTts('reply-id', 'Ready.', emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({ type: 'done' }));
    expect(geminiSpeak).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'Puck' }),
      expect.any(Function)
    );
    service.dispose();
  });
});
