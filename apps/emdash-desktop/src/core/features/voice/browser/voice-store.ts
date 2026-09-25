import { makeAutoObservable, runInAction } from 'mobx';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { log } from '@core/primitives/logging/browser/logger';
import { getVoiceClient } from '../api/browser/client';
import type { VoiceSettings, VoiceStatus } from '../api/contract';
import { SilenceDetector } from '../api/wav';
import { MicError, MicRecorder } from './mic-recorder';
import { SpeechOutput } from './speech-output';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'error';
/** "command" goes to the conductor; "dictation" types into the focused agent. */
export type TranscriptIntent = 'command' | 'dictation';
export type ListenMode = 'hold' | 'toggle';
export type TranscriptHandler = (text: string, intent: TranscriptIntent) => Promise<void> | void;

export type VoiceErrorState = {
  message: string;
  kind: 'mic-permission' | 'mic-missing' | 'engine' | 'not-configured' | 'other';
};

/** Utterances shorter than this are treated as accidental taps. */
const MIN_UTTERANCE_MS = 300;
/** A toggle-mode utterance never records longer than this. */
const MAX_UTTERANCE_MS = 60_000;

export class VoiceStore {
  phase: VoicePhase = 'idle';
  mode: ListenMode = 'hold';
  intent: TranscriptIntent = 'command';
  level = 0;
  lastTranscript = '';
  lastLatencyMs: number | null = null;
  error: VoiceErrorState | null = null;
  speaking = false;
  muted = false;
  status: VoiceStatus | null = null;

  readonly speech = new SpeechOutput();
  private readonly recorder = new MicRecorder();
  private silence: SilenceDetector | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: TranscriptHandler | null = null;
  private vocabulary: () => string[] = () => [];
  private disposers: (() => void)[] = [];

  constructor() {
    makeAutoObservable<
      VoiceStore,
      'recorder' | 'silence' | 'maxTimer' | 'handler' | 'vocabulary' | 'disposers'
    >(this, {
      speech: false,
      recorder: false,
      silence: false,
      maxTimer: false,
      handler: false,
      vocabulary: false,
      disposers: false,
    });
    this.recorder.onChunk = (level, durationMs) => this.onChunk(level, durationMs);
    this.speech.onSpeakingChange = (speaking) => runInAction(() => (this.speaking = speaking));
  }

  activate(): void {
    void this.refreshStatus();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getVoiceClient()
      .then(async (client) => {
        const next = await client.events.subscribe(undefined, {
          onEvent: (event) => {
            if (event.type === 'global-toggle') void this.toggle();
          },
        });
        if (disposed) next();
        else unsubscribe = next;
      })
      .catch((error: unknown) => log.warn('voice: event subscription failed', { error }));
    this.disposers.push(() => {
      disposed = true;
      unsubscribe?.();
    });
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.recorder.dispose();
    this.speech.stop();
  }

  setTranscriptHandler(handler: TranscriptHandler): void {
    this.handler = handler;
  }

  setVocabularyProvider(provider: () => string[]): void {
    this.vocabulary = provider;
  }

  get settings(): VoiceSettings | null {
    return this.status?.settings ?? null;
  }

  get isListening(): boolean {
    return this.phase === 'listening';
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  async startListening(mode: ListenMode, intent: TranscriptIntent = 'command'): Promise<void> {
    if (this.phase === 'listening' || this.phase === 'transcribing') return;
    this.speech.stop(); // barge-in
    this.mode = mode;
    this.intent = intent;
    this.error = null;
    this.level = 0;
    this.silence = mode === 'toggle' ? new SilenceDetector() : null;
    this.phase = 'listening';
    try {
      await this.recorder.start();
    } catch (error) {
      runInAction(() => {
        this.phase = 'error';
        this.error = describeMicError(error);
      });
      return;
    }
    if (mode === 'toggle') {
      this.maxTimer = setTimeout(() => void this.stopListening(), MAX_UTTERANCE_MS);
    }
  }

  async stopListening(): Promise<void> {
    if (this.phase !== 'listening') return;
    this.clearMaxTimer();
    const { wav, durationMs } = this.recorder.stop();
    if (durationMs < MIN_UTTERANCE_MS) {
      runInAction(() => {
        this.phase = 'idle';
        this.level = 0;
      });
      return;
    }
    runInAction(() => {
      this.phase = 'transcribing';
      this.level = 0;
    });
    const intent = this.intent;
    try {
      const client = await getVoiceClient();
      const result = await client.transcribe(
        { vocabulary: this.vocabulary().slice(0, 200) },
        {
          name: 'utterance.wav',
          mimeType: 'audio/wav',
          size: wav.byteLength,
          source: (async function* () {
            yield wav;
          })(),
        }
      );
      if (!result.success) {
        runInAction(() => {
          this.phase = 'error';
          this.error = {
            message: result.error.message,
            kind: result.error.type === 'not-configured' ? 'not-configured' : 'engine',
          };
        });
        return;
      }
      const text = result.data.text;
      runInAction(() => {
        this.phase = 'idle';
        this.lastTranscript = text;
        this.lastLatencyMs = result.data.latencyMs;
      });
      if (text) await this.handler?.(text, intent);
    } catch (error) {
      log.error('voice: transcription request failed', { error });
      runInAction(() => {
        this.phase = 'error';
        this.error = { message: 'Transcription failed. See the log for details.', kind: 'other' };
      });
    }
  }

  cancelListening(): void {
    this.clearMaxTimer();
    this.recorder.cancel();
    this.phase = 'idle';
    this.level = 0;
  }

  async toggle(intent: TranscriptIntent = 'command'): Promise<void> {
    if (this.phase === 'listening') await this.stopListening();
    else await this.startListening('toggle', intent);
  }

  dismissError(): void {
    this.error = null;
    if (this.phase === 'error') this.phase = 'idle';
  }

  private onChunk(level: number, durationMs: number): void {
    if (this.phase !== 'listening') return;
    runInAction(() => {
      // Smooth for the HUD meter.
      this.level = this.level * 0.6 + Math.min(1, level * 6) * 0.4;
    });
    if (this.silence?.push(level, durationMs)) void this.stopListening();
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** Speaks a conductor reply (respects mute and the speak-replies setting). */
  say(text: string): void {
    if (this.muted || this.settings?.speakReplies === false) return;
    this.speech.speak(text);
  }

  /** Speaks an attention event such as "Codex 1 needs permission". */
  announce(text: string): void {
    if (this.muted || this.settings?.speakAttention === false || this.isListening) return;
    this.speech.speak(text);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.speech.stop();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async refreshStatus(): Promise<void> {
    try {
      const status = await (await getVoiceClient()).getStatus();
      runInAction(() => {
        this.status = status;
        this.speech.setPreferredVoice(status.settings.ttsVoice);
      });
    } catch (error) {
      log.warn('voice: status unavailable', { error });
    }
  }

  async updateSettings(patch: Partial<VoiceSettings>): Promise<void> {
    const status = await (await getVoiceClient()).updateSettings(patch);
    runInAction(() => {
      this.status = status;
      this.speech.setPreferredVoice(status.settings.ttsVoice);
    });
  }

  async openMicrophoneSettings(): Promise<void> {
    await (await getVoiceClient()).openMicrophoneSettings();
  }

  async setCredential(id: ChorusCredentialId, value: string | null): Promise<void> {
    const status = await (await getVoiceClient()).setCredential({ id, value });
    runInAction(() => (this.status = status));
  }
}

function describeMicError(error: unknown): VoiceErrorState {
  if (error instanceof MicError) {
    if (error.kind === 'permission-denied')
      return { message: error.message, kind: 'mic-permission' };
    if (error.kind === 'no-device') return { message: error.message, kind: 'mic-missing' };
    return { message: error.message, kind: 'other' };
  }
  return { message: 'The microphone could not be opened.', kind: 'other' };
}
