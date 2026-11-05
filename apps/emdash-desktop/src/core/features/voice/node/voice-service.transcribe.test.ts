import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../api/contract';
import { encodeWav } from '../api/wav';
import { VoiceService } from './voice-service';

const { cloudTranscribe, disposedModel, localTranscribe, modelReady, usedModel, warmModel } =
  vi.hoisted(() => ({
    disposedModel: vi.fn(),
    usedModel: vi.fn(),
    warmModel: vi.fn(),
    cloudTranscribe: vi.fn(),
    localTranscribe: vi.fn(),
    modelReady: vi.fn(),
  }));
vi.mock('./engines/openrouter', () => ({
  OpenRouterSttEngine: class {
    readonly id = 'openrouter';
    transcribe = cloudTranscribe;
  },
}));
vi.mock('./local-dictation', () => ({
  DICTATION_MODELS: {
    'parakeet-ultra': { dirName: 'ultra-test' },
    'parakeet-unified-en': { dirName: 'unified-test' },
  },
  DictationModel: class {
    constructor(readonly dir: string) {}
    ready = modelReady;
    dispose() {}
  },
  LocalDictation: class {
    constructor(readonly model: { dir: string }) {}
    transcribe = (samples: Float32Array) => {
      usedModel(this.model.dir.split(/[\\/]/).at(-1));
      return localTranscribe(samples);
    };
    warm = warmModel;
    dispose() {
      disposedModel(this.model.dir.split(/[\\/]/).at(-1));
    }
  },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
/** One second of quiet: long enough to pass the too-short check. */
const UTTERANCE = encodeWav(new Float32Array(16_000));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  cloudTranscribe.mockReset();
  localTranscribe.mockReset();
  modelReady.mockReset();
  warmModel.mockReset();
  usedModel.mockReset();
  disposedModel.mockReset();
});

async function serviceWith(stored: Partial<VoiceSettings>): Promise<VoiceService> {
  const dir = await mkdtemp(join(tmpdir(), 'chorus-stt-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'voice-settings.json'),
    JSON.stringify({ ...DEFAULT_VOICE_SETTINGS, ...stored })
  );
  const getSecret = vi.fn().mockResolvedValue(null);
  const host = { dataDir: dir, secrets: { getSecret } } as unknown as ChorusHostServices;
  return new VoiceService(host, () => {}, logger);
}

describe('VoiceService local Parakeet transcription', () => {
  it('is off by default', () => {
    expect(DEFAULT_VOICE_SETTINGS.localTranscriber).toBe(false);
  });

  it('uses the configured cloud engine when the option is off', async () => {
    const service = await serviceWith({ engine: 'openrouter' });
    cloudTranscribe.mockResolvedValue('focus Claude 1');
    const result = await service.transcribe(UTTERANCE, ['Claude']);
    expect(result).toMatchObject({ text: 'focus Claude 1', engine: 'openrouter' });
    expect(cloudTranscribe).toHaveBeenCalledOnce();
    expect(localTranscribe).not.toHaveBeenCalled();
    service.dispose();
  });

  it('transcribes on this computer and never calls the cloud engine when on', async () => {
    const service = await serviceWith({ engine: 'openrouter', localTranscriber: true });
    modelReady.mockResolvedValue(true);
    localTranscribe.mockResolvedValue(' focus Claude 1 ');
    const result = await service.transcribe(UTTERANCE, ['Claude']);
    expect(result).toMatchObject({ text: 'focus Claude 1', engine: 'parakeet-local' });
    expect(localTranscribe).toHaveBeenCalledWith(expect.any(Float32Array));
    expect(localTranscribe.mock.calls[0]?.[0]).toHaveLength(16_000);
    expect(cloudTranscribe).not.toHaveBeenCalled();
    service.dispose();
  });

  it('reports a missing model instead of falling back to the cloud', async () => {
    const service = await serviceWith({ engine: 'openrouter', localTranscriber: true });
    modelReady.mockResolvedValue(false);
    await expect(service.transcribe(UTTERANCE, [])).rejects.toMatchObject({
      kind: 'not-configured',
      message: expect.stringContaining('not downloaded'),
    });
    expect(cloudTranscribe).not.toHaveBeenCalled();
    service.dispose();
  });

  it('reports a recognizer failure as a clear engine error', async () => {
    const service = await serviceWith({ localTranscriber: true });
    modelReady.mockResolvedValue(true);
    localTranscribe.mockRejectedValue(new Error('onnx runtime exploded'));
    await expect(service.transcribe(UTTERANCE, [])).rejects.toMatchObject({
      kind: 'engine-failed',
      message: expect.stringContaining('Local Parakeet transcription failed'),
    });
    expect(cloudTranscribe).not.toHaveBeenCalled();
    service.dispose();
  });

  it('opens no Deepgram stream while it is on, only a local capture once the model is there', async () => {
    const service = await serviceWith({
      engine: 'deepgram',
      streaming: true,
      localTranscriber: true,
    });
    modelReady.mockResolvedValue(false);
    expect(await service.openStream([], () => {})).toBeNull();
    modelReady.mockResolvedValue(true);
    expect(await service.openStream([], () => {})).toEqual(expect.any(String));
    expect(warmModel).toHaveBeenCalled();
    service.dispose();
  });

  it('transcribes a short streamed command capture as one clip with name fix-ups', async () => {
    const service = await serviceWith({ localTranscriber: true });
    modelReady.mockResolvedValue(true);
    localTranscribe.mockResolvedValue('ask Cloud Code');
    const streamId = await service.openStream([], () => {});
    service.pushAudio(streamId!, new Uint8Array(32_000));
    const result = await service.closeStream(streamId!);
    expect(result).toMatchObject({ text: 'ask Claude Code', engine: 'parakeet-local' });
    expect(localTranscribe).toHaveBeenCalledOnce();
    expect(localTranscribe.mock.calls[0]?.[0]).toHaveLength(16_000);
    service.dispose();
  });

  it('fixes misheard product names in the final text', async () => {
    const service = await serviceWith({ localTranscriber: true });
    modelReady.mockResolvedValue(true);
    localTranscribe.mockResolvedValue('ask Cloud Code about the cloud');
    const result = await service.transcribe(UTTERANCE, []);
    expect(result.text).toBe('ask Claude Code about the cloud');
    service.dispose();
  });

  it('leaves cloud engine text alone and hints the names instead', async () => {
    const service = await serviceWith({ engine: 'openrouter' });
    cloudTranscribe.mockResolvedValue('open the codec agent');
    const result = await service.transcribe(UTTERANCE, []);
    expect(result.text).toBe('open the codec agent');
    expect(cloudTranscribe.mock.calls[0]?.[0].vocabulary).toContain('Claude Code');
    service.dispose();
  });

  it('warms the model ahead of an utterance only when local transcription is on', async () => {
    modelReady.mockResolvedValue(true);
    const off = await serviceWith({ localTranscriber: false });
    await off.warmDictation();
    expect(warmModel).not.toHaveBeenCalled();
    const on = await serviceWith({ localTranscriber: true });
    await on.warmDictation();
    expect(warmModel).toHaveBeenCalledOnce();
    off.dispose();
    on.dispose();
  });

  it('uses Parakeet Ultra by default and releases a model that is switched away from', async () => {
    expect(DEFAULT_VOICE_SETTINGS.localSpeechModel).toBe('parakeet-ultra');
    const service = await serviceWith({ localTranscriber: true });
    modelReady.mockResolvedValue(true);
    localTranscribe.mockResolvedValue('hello');
    await service.transcribe(UTTERANCE, []);
    expect(usedModel).toHaveBeenLastCalledWith('ultra-test');
    await service.updateSettings({ localSpeechModel: 'parakeet-unified-en' });
    expect(disposedModel).toHaveBeenCalledExactlyOnceWith('ultra-test');
    await service.transcribe(UTTERANCE, []);
    expect(usedModel).toHaveBeenLastCalledWith('unified-test');
    service.dispose();
  });

  it('does not warm a model that is not downloaded', async () => {
    modelReady.mockResolvedValue(false);
    const service = await serviceWith({ localTranscriber: true });
    await service.warmDictation();
    expect(warmModel).not.toHaveBeenCalled();
    service.dispose();
  });
});
