import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../api/contract';
import { encodeWav } from '../api/wav';
import { VoiceService } from './voice-service';

const { cloudTranscribe, localTranscribe, modelReady } = vi.hoisted(() => ({
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
  DICTATION_MODEL_NAME: 'parakeet-test',
  DictationModel: class {
    ready = modelReady;
    dispose() {}
  },
  LocalDictation: class {
    constructor(readonly model: unknown) {}
    transcribe = localTranscribe;
    dispose() {}
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

  it('opens no Deepgram stream while it is on', async () => {
    const service = await serviceWith({
      engine: 'deepgram',
      streaming: true,
      localTranscriber: true,
    });
    expect(await service.openStream([], () => {})).toBeNull();
    service.dispose();
  });
});
