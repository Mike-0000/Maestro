import { getVoiceClient } from '../api/browser/client';
import type { VoiceEvent, VoiceSettings } from '../api/contract';

export type SpeechStatus = 'started' | 'ended' | 'cancelled' | 'failed';
/**
 * What a status carries for the trace: on `started` the engine that is heard (a cloud engine id,
 * or `platform` for the computer's own voice); on `cancelled` why it was cut off.
 */
export type SpeechStatusDetail = { readonly engine?: string; readonly reason?: string };
type SpeechStatusListener = (status: SpeechStatus, detail?: SpeechStatusDetail) => void;
/** The selected cloud engine was not used for an utterance: the platform voice says it instead. */
export type SpeechFallback = { readonly engine: string; readonly reason: string };
/**
 * Why speech in progress stopped: another utterance replaced it, the developer started talking,
 * speech was muted, or something else stopped it.
 */
export type SpeechStopReason = 'replaced' | 'developer-capture' | 'muted' | 'stopped';
/** Which cloud speech keys are configured; the renderer only ever sees presence, never keys. */
export type SpeechCredentials = { gemini?: boolean; openrouter?: boolean };

/** Cancellable spoken output: local, Gemini or OpenRouter PCM, otherwise the system voice. */
export class SpeechOutput {
  private preferredVoice = '';
  private engine: VoiceSettings['ttsEngine'] = 'platform';
  private credentials: SpeechCredentials = {};
  private requestId: string | null = null;
  private starting: Promise<void> | null = null;
  private context: AudioContext | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private receivedAudio = false;
  private finished = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  onSpeakingChange: ((speaking: boolean) => void) | null = null;
  /** Trace listener for the utterance in flight; notified once per terminal status. */
  private active: SpeechStatusListener | null = null;
  /** Told when the utterance in flight moves to the platform voice. */
  private onFallback: ((fallback: SpeechFallback) => void) | null = null;

  configure(settings: VoiceSettings, credentials: SpeechCredentials): void {
    this.preferredVoice = settings.ttsVoice;
    this.engine = settings.ttsEngine;
    this.credentials = credentials;
  }

  /** Whether the selected model engine can run; otherwise speech uses the system voice. */
  private engineAvailable(): boolean {
    switch (this.engine) {
      case 'platform':
        return false;
      case 'kitten':
        return true;
      case 'gemini-flash':
      case 'gemini-flash-lite':
        return this.credentials.gemini === true;
      case 'openrouter-gemini-flash':
      case 'openrouter-gemini-flash-lite':
        return this.credentials.openrouter === true;
      case 'vertex-gemini-flash':
      case 'vertex-gemini-flash-lite':
        // The main process reads the gcloud sign-in and reports an error when there is none.
        return true;
    }
  }

  /**
   * How long a sentence may wait for its first sound with the voice configured now: the
   * engine's first-audio timeout, or nothing for the system voice, which starts at once.
   */
  get firstAudioWaitMs(): number {
    return this.engine !== 'platform' && this.engineAvailable()
      ? firstAudioTimeoutMs(this.engine)
      : 0;
  }

  static voices(): SpeechSynthesisVoice[] {
    return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
  }

  /**
   * Speaks `text`, replacing whatever is playing. `platform` forces the system voice: it starts
   * without a network round trip and reads exactly what it is given.
   */
  speak(
    text: string,
    onStatus?: SpeechStatusListener,
    options: { platform?: boolean; onFallback?: (fallback: SpeechFallback) => void } = {}
  ): void {
    if (!text.trim()) {
      onStatus?.('failed');
      return;
    }
    this.stop('replaced');
    this.active = onceStarted(onStatus ?? (() => {}));
    this.onFallback = options.onFallback ?? null;
    const generation = this.generation;
    if (options.platform || !this.engineAvailable() || text.length > 1200) {
      // Asked for, or no cloud engine selected: not a fallback.
      if (!options.platform && this.engine !== 'platform') {
        this.reportFallback(this.engineAvailable() ? 'too-long' : 'no-credentials');
      }
      this.speakPlatform(text, generation);
      return;
    }
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.pendingText = text;
    // A stalled connection must not leave the reply silent indefinitely.
    this.fallbackTimer = setTimeout(
      () => this.fallback(text, generation, 'first-audio-timeout'),
      firstAudioTimeoutMs(this.engine)
    );
    const starting = getVoiceClient().then(async (client) => {
      if (this.requestId !== requestId) return;
      await client.startTts({ requestId, text });
    });
    this.starting = starting;
    void starting.catch(() => this.fallback(text, generation, 'start-failed'));
  }

  handleEvent(event: VoiceEvent): void {
    if (!('requestId' in event) || event.requestId !== this.requestId) return;
    if (event.type === 'tts-error') {
      if (!this.receivedAudio) this.fallbackToPlatform('tts-error');
      else {
        this.finished = true;
        this.finishCloud();
      }
    } else if (event.type === 'tts-done') {
      this.finished = true;
      if (!this.receivedAudio) this.fallbackToPlatform('no-audio');
      else this.finishCloud();
    } else if (event.type === 'tts-chunk') {
      try {
        this.playChunk(event.pcm, event.sampleRate ?? 24_000);
      } catch {
        if (!this.receivedAudio) this.fallbackToPlatform('bad-audio');
        else this.stop();
      }
    }
  }

  private playChunk(pcm: string, sampleRate: number): void {
    const bytes = Uint8Array.from(atob(pcm), (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('Invalid PCM chunk');
    const context = (this.context ??= new AudioContext({ sampleRate: 24_000 }));
    // A buffer at another rate is resampled by the context on playback.
    const buffer = context.createBuffer(1, bytes.length / 2, sampleRate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.nextStart);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      this.finishCloud();
    };
    source.start(startAt);
    this.receivedAudio = true;
    this.active?.('started', { engine: this.engine });
    this.clearFallbackTimer();
    this.onSpeakingChange?.(true);
    if (context.state !== 'running') {
      const generation = this.generation;
      const timeout = setTimeout(() => {
        if (this.generation === generation && context.state !== 'running') {
          this.fallbackToPlatform('audio-blocked');
        }
      }, 1000);
      void context.resume().then(
        () => {
          clearTimeout(timeout);
          if (this.generation === generation && context.state !== 'running') {
            this.fallbackToPlatform('audio-blocked');
          }
        },
        () => {
          clearTimeout(timeout);
          if (this.generation === generation) this.fallbackToPlatform('audio-blocked');
        }
      );
    }
  }

  private finishCloud(): void {
    if (!this.finished || this.sources.size) return;
    this.requestId = null;
    this.pendingText = '';
    this.settle('ended');
    this.onSpeakingChange?.(false);
  }

  private fallback(text: string, generation: number, reason: string): void {
    if (this.generation !== generation || this.receivedAudio) return;
    this.fallbackToPlatform(reason, text);
  }

  private fallbackToPlatform(reason: string, text?: string): void {
    // The text is stored only in this closure until the first chunk or timeout; no cloud retry.
    const fallbackText = text ?? this.pendingText;
    const listener = this.active;
    const onFallback = this.onFallback;
    this.reset();
    this.onSpeakingChange?.(false);
    this.active = listener;
    this.onFallback = onFallback;
    this.reportFallback(reason);
    if (fallbackText) this.speakPlatform(fallbackText, this.generation);
    else this.settle('failed');
  }

  private reportFallback(reason: string): void {
    this.onFallback?.({ engine: this.engine, reason });
  }

  private pendingText = '';

  private speakPlatform(text: string, generation: number): void {
    if (typeof speechSynthesis === 'undefined') {
      this.settle('failed');
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice =
      SpeechOutput.voices().find((candidate) => candidate.name === this.preferredVoice) ??
      SpeechOutput.voices().find(
        (candidate) => candidate.default && candidate.lang.startsWith('en')
      );
    if (voice) utterance.voice = voice;
    utterance.rate = 1.1;
    utterance.onstart = () => {
      if (this.generation !== generation) return;
      this.active?.('started', { engine: 'platform' });
      this.onSpeakingChange?.(true);
    };
    const done = (status: 'ended' | 'failed') => {
      if (this.generation !== generation) return;
      this.settle(status);
      this.onSpeakingChange?.(false);
    };
    utterance.onend = () => done('ended');
    utterance.onerror = () => done('failed');
    speechSynthesis.speak(utterance);
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  /** Reports a terminal status to the current trace listener, at most once. */
  private settle(status: Exclude<SpeechStatus, 'started'>, detail?: SpeechStatusDetail): void {
    const listener = this.active;
    this.active = null;
    this.onFallback = null;
    listener?.(status, detail);
  }

  stop(reason: SpeechStopReason = 'stopped'): void {
    this.settle('cancelled', { reason });
    this.reset();
    this.onSpeakingChange?.(false);
  }

  /** Cancels any in-flight synthesis and playback without notifying listeners. */
  private reset(): void {
    this.generation++;
    this.clearFallbackTimer();
    const requestId = this.requestId;
    const starting = this.starting;
    this.requestId = null;
    this.starting = null;
    this.pendingText = '';
    if (requestId) {
      // Wait for start's Wire acknowledgment so a delayed start cannot outlive its cancellation.
      void (starting ?? Promise.resolve())
        .catch(() => {})
        .then(async () => (await getVoiceClient()).stopTts({ requestId }))
        .catch(() => {});
    }
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextStart = 0;
    this.receivedAudio = false;
    this.finished = false;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }
}

/** How long to wait for an engine's first audio before falling back to the system voice. */
export function firstAudioTimeoutMs(engine: VoiceSettings['ttsEngine']): number {
  if (engine === 'kitten') return 12_000;
  // OpenRouter may buffer the provider's audio before the first byte arrives.
  if (engine.startsWith('openrouter-')) return 8000;
  // The first Vertex reply also exchanges the gcloud sign-in for an access token.
  if (engine.startsWith('vertex-')) return 8000;
  return 3500;
}

/** Forwards `started` at most once, so a platform fallback after playback began is not recounted. */
function onceStarted(listener: SpeechStatusListener): SpeechStatusListener {
  let started = false;
  return (status, detail) => {
    if (status === 'started') {
      if (started) return;
      started = true;
    }
    listener(status, detail);
  };
}
