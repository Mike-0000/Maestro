import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@emdash/shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { DEFAULT_VOICE_SETTINGS } from '../api/contract';
import { VoiceService } from './voice-service';

const { localSpeak } = vi.hoisted(() => ({ localSpeak: vi.fn() }));
vi.mock('./local-tts', () => ({
  LocalTts: class {
    speak = localSpeak;
  },
}));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  localSpeak.mockReset();
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
