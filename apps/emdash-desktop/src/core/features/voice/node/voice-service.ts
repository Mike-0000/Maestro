import type { Logger } from '@emdash/shared/logger';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import type { ChorusHostServices } from '@core/primitives/chorus-host/api/host-services';
import { ChorusCredentials } from '@core/primitives/chorus-host/node/credentials';
import { JsonSettingsFile } from '@core/primitives/chorus-host/node/json-settings-file';
import {
  DEFAULT_VOICE_SETTINGS,
  voiceSettingsSchema,
  type SttEngineId,
  type Transcription,
  type VoiceSettings,
  type VoiceStatus,
} from '../api/contract';
import { HoldToTalkMachine, type HoldOutput } from '../api/hold-to-talk';
import { DeepgramSttEngine } from './engines/deepgram';
import { DeepgramStream } from './engines/deepgram-stream';
import { SttEngineError, type SttEngine } from './engines/engine';
import { OpenAiSttEngine } from './engines/openai';
import { OpenRouterSttEngine } from './engines/openrouter';
import { WhisperLocalSttEngine } from './engines/whisper-local';
import { streamGeminiTts } from './gemini-tts';
import { LocalTts } from './local-tts';

/** RIFF header (44 bytes) plus at least ~0.2 s of 16 kHz 16-bit audio. */
const MIN_WAV_BYTES = 44 + 6400;
/** uiohook key codes for the supported hold keys (libuiohook VC_* values). */
const HOLD_KEYCODES: Record<VoiceSettings['globalHoldKey'], number | null> = {
  off: null,
  'right-ctrl': 3613,
  'right-alt': 3640,
};
const SHIFT_KEYCODES = new Set([42, 54]);

/**
 * A stream left open longer than this (a stuck key, a crashed renderer) is dropped. Click-to-talk
 * records until Send for up to 5 minutes, so this leaves headroom above that.
 */
const STREAM_MAX_MS = 6 * 60_000;

export class VoiceService {
  readonly credentials: ChorusCredentials;
  private readonly settings: JsonSettingsFile<VoiceSettings>;
  private readonly engines: Record<SttEngineId, SttEngine>;
  private registeredShortcut: string | null = null;
  private holdKey: number | null = null;
  private readonly hold: HoldToTalkMachine;
  private readonly ttsRequests = new Map<string, AbortController>();
  private localTts: LocalTts | null = null;
  private readonly streams = new Map<
    string,
    { stream: DeepgramStream; startedAt: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly host: ChorusHostServices,
    private readonly onGlobalToggle: () => void,
    private readonly logger: Logger,
    onGlobalHold: (output: HoldOutput) => void = () => {}
  ) {
    this.hold = new HoldToTalkMachine(onGlobalHold);
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
      'whisper-local': new WhisperLocalSttEngine(
        async () => (await this.settings.read()).whisperUrl
      ),
      openrouter: new OpenRouterSttEngine(
        () => this.credentials.get('openrouter'),
        async () => (await this.settings.read()).openrouterSttModel
      ),
    };
  }

  async start(): Promise<void> {
    const settings = await this.settings.read();
    await this.applyGlobalShortcut(settings.globalShortcut);
    this.applyGlobalHold(settings.globalHoldKey);
  }

  dispose(): void {
    for (const id of [...this.ttsRequests.keys()]) this.stopTts(id);
    for (const id of [...this.streams.keys()]) this.abortStream(id);
    this.applyGlobalHold('off');
    if (this.registeredShortcut) this.host.globalShortcuts.unregister(this.registeredShortcut);
    this.registeredShortcut = null;
  }

  async status(): Promise<VoiceStatus> {
    return {
      settings: await this.settings.read(),
      credentials: await this.credentials.presence(),
      globalShortcutRegistered: this.registeredShortcut !== null,
      globalHoldActive: this.holdKey !== null,
    };
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<VoiceStatus> {
    const previous = await this.settings.read();
    const next = await this.settings.update(patch);
    if (next.globalShortcut !== previous.globalShortcut) {
      await this.applyGlobalShortcut(next.globalShortcut);
    }
    if (next.globalHoldKey !== previous.globalHoldKey) this.applyGlobalHold(next.globalHoldKey);
    return this.status();
  }

  async setCredential(id: ChorusCredentialId, value: string | null): Promise<VoiceStatus> {
    await this.credentials.set(id, value);
    return this.status();
  }

  /** Synthesis runs in the main process; Gemini credentials never reach the renderer. */
  async startTts(
    requestId: string,
    text: string,
    emit: (event: { type: 'chunk'; pcm: string } | { type: 'done' } | { type: 'error' }) => void
  ): Promise<void> {
    // Replies replace one another; never generate several billable utterances concurrently.
    for (const id of [...this.ttsRequests.keys()]) this.stopTts(id);
    const controller = new AbortController();
    this.ttsRequests.set(requestId, controller);
    try {
      const settings = await this.settings.read();
      if (controller.signal.aborted) return;
      if (settings.ttsEngine === 'platform') {
        emit({ type: 'error' });
        this.ttsRequests.delete(requestId);
        return;
      }
      const forward = (event: { type: 'chunk'; pcm: string } | { type: 'done' }) => {
        if (!controller.signal.aborted) emit(event);
      };
      let synthesis: Promise<void>;
      if (settings.ttsEngine === 'kitten') {
        synthesis = (this.localTts ??= new LocalTts()).speak(
          text,
          settings.localVoice,
          controller.signal,
          forward
        );
      } else {
        const key = await this.credentials.get('gemini');
        if (controller.signal.aborted) return;
        if (!key) {
          emit({ type: 'error' });
          this.ttsRequests.delete(requestId);
          return;
        }
        const model =
          settings.ttsEngine === 'gemini-flash'
            ? 'gemini-3.8-flash-tts'
            : 'gemini-3.8-flash-lite-tts';
        synthesis = streamGeminiTts(
          { key, model, voice: settings.geminiVoice, text, signal: controller.signal },
          forward
        );
      }
      void synthesis
        .catch(() => {
          if (!controller.signal.aborted) emit({ type: 'error' });
        })
        .finally(() => {
          if (this.ttsRequests.get(requestId) === controller) this.ttsRequests.delete(requestId);
        });
    } catch {
      this.ttsRequests.delete(requestId);
      if (!controller.signal.aborted) emit({ type: 'error' });
    }
  }

  stopTts(requestId: string): void {
    this.ttsRequests.get(requestId)?.abort();
    this.ttsRequests.delete(requestId);
  }

  /** Opens a live stream if the current engine supports one; null means upload instead. */
  async openStream(
    vocabulary: readonly string[],
    onPartial: (streamId: string, text: string, confidence?: number) => void
  ): Promise<string | null> {
    const settings = await this.settings.read();
    if (settings.engine !== 'deepgram' || !settings.streaming) return null;
    const key = await this.credentials.get('deepgram');
    if (!key) return null;
    const streamId = crypto.randomUUID();
    const stream = new DeepgramStream(
      key,
      { language: settings.language, vocabulary },
      (text, confidence) => onPartial(streamId, text, confidence)
    );
    const timer = setTimeout(() => this.abortStream(streamId), STREAM_MAX_MS);
    this.streams.set(streamId, { stream, startedAt: performance.now(), timer });
    return streamId;
  }

  pushAudio(streamId: string, pcm: Uint8Array<ArrayBuffer>): void {
    this.streams.get(streamId)?.stream.push(pcm);
  }

  async closeStream(streamId: string): Promise<Transcription> {
    const entry = this.streams.get(streamId);
    if (!entry) throw new SttEngineError('engine-failed', 'That transcription stream expired.');
    this.streams.delete(streamId);
    clearTimeout(entry.timer);
    const finishedAt = performance.now();
    const text = (await entry.stream.finish()).trim();
    // Latency the user feels: from releasing the key to having the final text.
    const latencyMs = Math.round(performance.now() - finishedAt);
    this.logger.info('voice: streamed', { latencyMs, chars: text.length });
    return {
      text,
      engine: 'deepgram',
      latencyMs,
      ...(entry.stream.confidence !== undefined ? { confidence: entry.stream.confidence } : {}),
    };
  }

  abortStream(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.streams.delete(streamId);
    clearTimeout(entry.timer);
    entry.stream.abort();
  }

  async transcribe(audio: Uint8Array, vocabulary: readonly string[]): Promise<Transcription> {
    if (audio.byteLength < MIN_WAV_BYTES) {
      throw new SttEngineError('empty-audio', 'That was too short to transcribe.');
    }
    const settings = await this.settings.read();
    const engine = this.engines[settings.engine];
    const started = performance.now();
    const result = await engine.transcribe({ audio, vocabulary, language: settings.language });
    const text = typeof result === 'string' ? result : result.text;
    const latencyMs = Math.round(performance.now() - started);
    this.logger.info('voice: transcribed', { engine: engine.id, latencyMs, chars: text.length });
    return {
      text,
      engine: engine.id,
      latencyMs,
      ...(typeof result !== 'string' && result.confidence !== undefined
        ? { confidence: result.confidence }
        : {}),
    };
  }

  /** Starts or stops the system-wide key hook for global hold-to-talk. */
  private applyGlobalHold(key: VoiceSettings['globalHoldKey']): void {
    if (this.holdKey !== null) {
      this.host.keyboardHook.stop();
      this.hold.reset();
      this.holdKey = null;
    }
    const keycode = HOLD_KEYCODES[key];
    if (keycode === null) return;
    const started = this.host.keyboardHook.start(({ type, keycode: pressed }) => {
      if (pressed === keycode) {
        if (type === 'down') this.hold.talkDown(false);
        else this.hold.talkUp();
      } else if (type === 'down') {
        this.hold.otherDown(SHIFT_KEYCODES.has(pressed));
      }
    });
    if (started) this.holdKey = keycode;
    else this.logger.warn('voice: global hold-to-talk could not start');
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
        this.logger.warn('voice: global shortcut is taken by another app', {
          accelerator: trimmed,
        });
      }
    } catch (error) {
      this.logger.warn('voice: invalid global shortcut', { accelerator: trimmed, error });
    }
  }
}
