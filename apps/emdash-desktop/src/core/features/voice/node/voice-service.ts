import type { Logger } from '@emdash/shared/logger';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import {
  DEFAULT_VOICE_SETTINGS,
  voiceSettingsSchema,
  type SttEngineId,
  type Transcription,
  type VoiceSettings,
  type VoiceStatus,
} from '../api/contract';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { DeepgramSttEngine } from './engines/deepgram';
import { SttEngineError, type SttEngine } from './engines/engine';
import { OpenAiSttEngine } from './engines/openai';
import { WhisperLocalSttEngine } from './engines/whisper-local';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';

/** RIFF header (44 bytes) plus at least ~0.2 s of 16 kHz 16-bit audio. */
const MIN_WAV_BYTES = 44 + 6400;

export class VoiceService {
  readonly credentials: ChorusCredentials;
  private readonly settings: JsonSettingsFile<VoiceSettings>;
  private readonly engines: Record<SttEngineId, SttEngine>;
  private registeredShortcut: string | null = null;

  constructor(
    private readonly host: ChorusHostServices,
    private readonly onGlobalToggle: () => void,
    private readonly logger: Logger
  ) {
    this.credentials = new ChorusCredentials(host.secrets);
    this.settings = JsonSettingsFile.inDir(
      host.dataDir,
      'voice-settings.json',
      voiceSettingsSchema,
      DEFAULT_VOICE_SETTINGS
    );
    this.engines = {
      openai: new OpenAiSttEngine(() => this.credentials.get('openai')),
      deepgram: new DeepgramSttEngine(() => this.credentials.get('deepgram')),
      'whisper-local': new WhisperLocalSttEngine(async () => (await this.settings.read()).whisperUrl),
    };
  }

  async start(): Promise<void> {
    await this.applyGlobalShortcut((await this.settings.read()).globalShortcut);
  }

  dispose(): void {
    if (this.registeredShortcut) this.host.globalShortcuts.unregister(this.registeredShortcut);
    this.registeredShortcut = null;
  }

  async status(): Promise<VoiceStatus> {
    return {
      settings: await this.settings.read(),
      credentials: await this.credentials.presence(),
      globalShortcutRegistered: this.registeredShortcut !== null,
    };
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<VoiceStatus> {
    const previous = await this.settings.read();
    const next = await this.settings.update(patch);
    if (next.globalShortcut !== previous.globalShortcut) {
      await this.applyGlobalShortcut(next.globalShortcut);
    }
    return this.status();
  }

  async setCredential(id: ChorusCredentialId, value: string | null): Promise<VoiceStatus> {
    await this.credentials.set(id, value);
    return this.status();
  }

  async transcribe(audio: Uint8Array, vocabulary: readonly string[]): Promise<Transcription> {
    if (audio.byteLength < MIN_WAV_BYTES) {
      throw new SttEngineError('empty-audio', 'That was too short to transcribe.');
    }
    const settings = await this.settings.read();
    const engine = this.engines[settings.engine];
    const started = performance.now();
    const text = await engine.transcribe({ audio, vocabulary, language: settings.language });
    const latencyMs = Math.round(performance.now() - started);
    this.logger.info('voice: transcribed', { engine: engine.id, latencyMs, chars: text.length });
    return { text, engine: engine.id, latencyMs };
  }

  private async applyGlobalShortcut(accelerator: string): Promise<void> {
    if (this.registeredShortcut) this.host.globalShortcuts.unregister(this.registeredShortcut);
    this.registeredShortcut = null;
    const trimmed = accelerator.trim();
    if (!trimmed) return;
    try {
      if (this.host.globalShortcuts.register(trimmed, this.onGlobalToggle)) {
        this.registeredShortcut = trimmed;
      } else {
        this.logger.warn('voice: global shortcut is taken by another app', { accelerator: trimmed });
      }
    } catch (error) {
      this.logger.warn('voice: invalid global shortcut', { accelerator: trimmed, error });
    }
  }
}
