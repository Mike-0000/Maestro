import { makeAutoObservable, runInAction } from 'mobx';
import type { ChorusCredentialId } from '@core/primitives/chorus-host/api/credentials';
import { log } from '@core/primitives/logging/browser/logger';
import { getVoiceClient } from '../api/browser/client';
import type { VoiceSettings, VoiceStatus } from '../api/contract';
import { bytesToBase64, SilenceDetector, SpeechOnsetDetector, stripWakePhrase } from '../api/wav';
import { MicError, MicRecorder } from './mic-recorder';
import { SpeechOutput } from './speech-output';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'error';
/** "command" goes to the conductor; "dictation" types into the focused agent. */
export type TranscriptIntent = 'command' | 'dictation';
export type ListenMode = 'hold' | 'toggle';
/** Who started listening: the user (key, click, shortcut) or hands-free speech detection. */
export type ListenOrigin = 'user' | 'hands-free';
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
  /** Live partial transcript while streaming (Deepgram). */
  partial = '';
  origin: ListenOrigin = 'user';
  /** Set when a hands-free utterance was ignored for lacking the wake phrase. */
  ignoredUtterance: string | null = null;
  lastLatencyMs: number | null = null;
  error: VoiceErrorState | null = null;
  speaking = false;
  muted = false;
  status: VoiceStatus | null = null;

  readonly speech = new SpeechOutput();
  private readonly recorder = new MicRecorder();
  private silence: SilenceDetector | null = null;
  private readonly onset = new SpeechOnsetDetector();
  private streamId: string | null = null;
  private streamPending: string[] = [];
  private streamOpening: Promise<void> | null = null;
  private captureNext: ((text: string) => void) | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: TranscriptHandler | null = null;
  private vocabulary: () => string[] = () => [];
  private disposers: (() => void)[] = [];

  constructor() {
    makeAutoObservable<
      VoiceStore,
      | 'recorder'
      | 'silence'
      | 'maxTimer'
      | 'handler'
      | 'vocabulary'
      | 'disposers'
      | 'onset'
      | 'streamId'
      | 'streamPending'
      | 'streamOpening'
      | 'captureNext'
    >(this, {
      speech: false,
      recorder: false,
      silence: false,
      onset: false,
      streamId: false,
      streamPending: false,
      streamOpening: false,
      captureNext: false,
      maxTimer: false,
      handler: false,
      vocabulary: false,
      disposers: false,
    });
    this.recorder.onChunk = (level, durationMs) => this.onChunk(level, durationMs);
    this.recorder.onPcm = (pcm) => this.onPcm(pcm);
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
            else if (event.type === 'global-hold') this.onGlobalHold(event.action, event.intent);
            else if (event.type === 'partial' && event.streamId === this.streamId) {
              runInAction(() => (this.partial = event.text));
            }
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

  async startListening(
    mode: ListenMode,
    intent: TranscriptIntent = 'command',
    origin: ListenOrigin = 'user'
  ): Promise<void> {
    if (this.phase === 'listening' || this.phase === 'transcribing') return;
    this.speech.stop(); // barge-in
    this.mode = mode;
    this.intent = intent;
    this.origin = origin;
    this.error = null;
    this.ignoredUtterance = null;
    this.level = 0;
    this.partial = '';
    this.silence = mode === 'toggle' ? new SilenceDetector() : null;
    this.phase = 'listening';
    this.openStream();
    try {
      await this.recorder.start({ withPreRoll: origin === 'hands-free' });
    } catch (error) {
      this.abortStream();
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
    const origin = this.origin;
    const streamed = await this.closeStream();
    if (streamed !== null) {
      await this.finishTranscript(streamed.text, streamed.latencyMs, intent, origin);
      return;
    }
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
      await this.finishTranscript(result.data.text, result.data.latencyMs, intent, origin);
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
    this.abortStream();
    this.partial = '';
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
    if (this.phase === 'idle' && this.settings?.handsFree && !this.speaking && !this.muted) {
      if (this.onset.push(level, durationMs)) {
        this.onset.reset();
        void this.startListening('toggle', 'command', 'hands-free');
      }
      return;
    }
    if (this.phase !== 'listening') return;
    runInAction(() => {
      // Smooth for the HUD meter.
      this.level = this.level * 0.6 + Math.min(1, level * 6) * 0.4;
    });
    if (this.silence?.push(level, durationMs)) void this.stopListening();
  }

  /** Applies the wake phrase to hands-free speech, records the transcript, and hands it off. */
  private async finishTranscript(
    raw: string,
    latencyMs: number,
    intent: TranscriptIntent,
    origin: ListenOrigin
  ): Promise<void> {
    const text = raw.trim();
    let command: string | null = text;
    if (origin === 'hands-free') {
      command = stripWakePhrase(text, this.settings?.wakePhrase ?? 'chorus');
    }
    runInAction(() => {
      this.phase = 'idle';
      this.partial = '';
      this.lastTranscript = text;
      this.lastLatencyMs = latencyMs;
      this.ignoredUtterance = command === null && text ? text : null;
    });
    const capture = this.captureNext;
    if (capture) {
      this.captureNext = null;
      capture(text);
      return;
    }
    if (command) await this.handler?.(command, intent);
  }

  /**
   * Records one utterance and returns its transcript without sending it to the conductor (voice
   * setup's "say hello" test). Resolves '' if nothing was heard.
   */
  async captureOnce(): Promise<string> {
    const result = new Promise<string>((resolve) => (this.captureNext = resolve));
    await this.startListening('toggle', 'command', 'user');
    if (this.phase === 'error') {
      this.captureNext = null;
      return '';
    }
    return result;
  }

  // ── Live streaming ─────────────────────────────────────────────────────────

  private openStream(): void {
    this.streamId = null;
    this.streamPending = [];
    if (this.settings?.engine !== 'deepgram' || this.settings.streaming === false) {
      this.streamOpening = null;
      return;
    }
    this.streamOpening = getVoiceClient()
      .then((client) => client.openStream({ vocabulary: this.vocabulary().slice(0, 200) }))
      .then(async (opened) => {
        if (!opened.supported || !opened.streamId || this.phase !== 'listening') {
          if (opened.streamId)
            await (await getVoiceClient()).abortStream({ streamId: opened.streamId });
          this.streamPending = [];
          return;
        }
        this.streamId = opened.streamId;
        const client = await getVoiceClient();
        for (const pcm of this.streamPending.splice(0)) {
          void client.pushAudio({ streamId: opened.streamId, pcm });
        }
      })
      .catch((error: unknown) => {
        log.warn('voice: live stream unavailable; will upload instead', { error });
        this.streamPending = [];
      });
  }

  private onPcm(pcm: Uint8Array<ArrayBuffer>): void {
    if (this.phase !== 'listening' || !this.streamOpening) return;
    const encoded = bytesToBase64(pcm);
    const streamId = this.streamId;
    if (!streamId) {
      this.streamPending.push(encoded);
      return;
    }
    void getVoiceClient().then((client) => client.pushAudio({ streamId, pcm: encoded }));
  }

  /** Final text from the live stream, or null to fall back to uploading the recording. */
  private async closeStream(): Promise<{ text: string; latencyMs: number } | null> {
    const opening = this.streamOpening;
    this.streamOpening = null;
    if (!opening) return null;
    await opening;
    const streamId = this.streamId;
    this.streamId = null;
    if (!streamId) return null;
    try {
      const result = await (await getVoiceClient()).closeStream({ streamId });
      if (result.success) return result.data;
      log.warn('voice: live stream failed; uploading instead', { error: result.error });
    } catch (error) {
      log.warn('voice: live stream failed; uploading instead', { error });
    }
    return null;
  }

  private abortStream(): void {
    const streamId = this.streamId;
    this.streamId = null;
    this.streamOpening = null;
    this.streamPending = [];
    if (streamId) void getVoiceClient().then((client) => client.abortStream({ streamId }));
  }

  /** Global hold-to-talk from the system-wide key hook (works while other apps are focused). */
  private onGlobalHold(
    action: 'start' | 'stop' | 'cancel',
    intent: TranscriptIntent = 'command'
  ): void {
    if (action === 'start') void this.startListening('hold', intent);
    else if (action === 'stop') void this.stopListening();
    else this.cancelListening();
  }

  // ── Hands-free ─────────────────────────────────────────────────────────────

  /** Starts or stops continuous listening to match the setting. */
  async applyHandsFree(): Promise<void> {
    const on = this.settings?.handsFree ?? false;
    try {
      await this.recorder.setMonitoring(on);
    } catch (error) {
      runInAction(() => {
        this.phase = 'error';
        this.error = describeMicError(error);
      });
    }
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
      void this.applyHandsFree();
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
    if ('handsFree' in patch) void this.applyHandsFree();
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
