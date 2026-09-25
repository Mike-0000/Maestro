import { join } from 'node:path';
import { app } from 'electron';
import type { OfflineTts } from 'sherpa-onnx-node';
import type { VoiceSettings } from '../api/contract';
import type { GeminiTtsEvent } from './gemini-tts';

const MODEL_NAME = 'kitten-mini-en-v0_8';
const VOICE_IDS: Record<VoiceSettings['localVoice'], number> = {
  Jasper: 0,
  Bella: 1,
  Bruno: 2,
  Luna: 3,
  Hugo: 4,
  Rosie: 5,
  Leo: 6,
  Kiki: 7,
};

export function localTtsModelDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', MODEL_NAME)
    : join(app.getAppPath(), '.cache', 'local-tts', MODEL_NAME);
}

/** Lazy, CPU-only native TTS. No network or subprocess is used at runtime. */
export class LocalTts {
  private model: Promise<OfflineTts> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly modelDir: string = localTtsModelDir()) {}

  speak(
    text: string,
    voice: VoiceSettings['localVoice'],
    signal: AbortSignal,
    emit: (event: GeminiTtsEvent) => void
  ): Promise<void> {
    const next = this.inFlight.catch(() => {}).then(() => this.generate(text, voice, signal, emit));
    this.inFlight = next;
    return next;
  }

  private async generate(
    text: string,
    voice: VoiceSettings['localVoice'],
    signal: AbortSignal,
    emit: (event: GeminiTtsEvent) => void
  ): Promise<void> {
    if (signal.aborted) return;
    const model = await (this.model ??= this.load());
    if (signal.aborted) return;
    if (model.sampleRate !== 24_000) throw new Error('Unsupported local TTS sample rate');
    // oxlint-disable-next-line emdash/no-dynamic-imports -- The optional native addon must not prevent app startup.
    const { default: sherpa } = await import('sherpa-onnx-node');
    let chunks = 0;
    await model.generateAsync({
      text,
      generationConfig: new sherpa.GenerationConfig({ sid: VOICE_IDS[voice], speed: 1 }),
      onProgress: ({ samples }) => {
        if (signal.aborted) return false;
        if (!samples.length) return true;
        const pcm = Buffer.allocUnsafe(samples.length * 2);
        for (let i = 0; i < samples.length; i++) {
          const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
          pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
        }
        emit({ type: 'chunk', pcm: pcm.toString('base64') });
        chunks++;
        return !signal.aborted;
      },
    });
    if (signal.aborted) return;
    if (!chunks) throw new Error('Local TTS returned no audio');
    emit({ type: 'done' });
  }

  private async load(): Promise<OfflineTts> {
    try {
      // oxlint-disable-next-line emdash/no-dynamic-imports -- Load native code only when local TTS is chosen.
      const { default: sherpa } = await import('sherpa-onnx-node');
      const root = this.modelDir;
      return await sherpa.OfflineTts.createAsync({
        model: {
          kitten: {
            model: join(root, 'model.onnx'),
            voices: join(root, 'voices.bin'),
            tokens: join(root, 'tokens.txt'),
            dataDir: join(root, 'espeak-ng-data'),
          },
          numThreads: 2,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      });
    } catch (error) {
      this.model = null; // Allow retry after the assets become available in development.
      throw error;
    }
  }
}
