import { getVoiceClient } from '../api/browser/client';
import type { VoiceEvent, VoiceSettings } from '../api/contract';

export type SpeechStatus = 'started' | 'ended' | 'cancelled' | 'failed';
type SpeechStatusListener = (status: SpeechStatus) => void;
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
    }
  }

  /** How long to wait for the first audio before falling back to the system voice. */
  private firstAudioTimeoutMs(): number {
    if (this.engine === 'kitten') return 12_000;
    // OpenRouter may buffer the provider's audio before the first byte arrives.
    if (this.engine.startsWith('openrouter-')) return 8000;
    return 3500;
  }

  static voices(): SpeechSynthesisVoice[] {
    return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
  }

  /**
   * Speaks `text`, replacing whatever is playing. `platform` forces the system voice: it starts
   * without a network round trip and reads exactly what it is given.
   */
  speak(text: string, onStatus?: SpeechStatusListener, options: { platform?: boolean } = {}): void {
    if (!text.trim()) {
      onStatus?.('failed');
      return;
    }
    this.stop();
    this.active = onceStarted(onStatus ?? (() => {}));
    const generation = this.generation;
    if (options.platform || !this.engineAvailable() || text.length > 1200) {
      this.speakPlatform(text, generation);
      return;
    }
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.pendingText = text;
    // A stalled connection must not leave the reply silent indefinitely.
    this.fallbackTimer = setTimeout(
      () => this.fallback(text, generation),
      this.firstAudioTimeoutMs()
    );
    const starting = getVoiceClient().then(async (client) => {
      if (this.requestId !== requestId) return;
      await client.startTts({ requestId, text });
    });
    this.starting = starting;
    void starting.catch(() => this.fallback(text, generation));
  }

  handleEvent(event: VoiceEvent): void {
    if (!('requestId' in event) || event.requestId !== this.requestId) return;
    if (event.type === 'tts-error') {
      if (!this.receivedAudio) this.fallbackToPlatform();
      else {
        this.finished = true;
        this.finishCloud();
      }
    } else if (event.type === 'tts-done') {
      this.finished = true;
      if (!this.receivedAudio) this.fallbackToPlatform();
      else this.finishCloud();
    } else if (event.type === 'tts-chunk') {
      try {
        this.playChunk(event.pcm, event.sampleRate ?? 24_000);
      } catch {
        if (!this.receivedAudio) this.fallbackToPlatform();
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
    this.active?.('started');
    this.clearFallbackTimer();
    this.onSpeakingChange?.(true);
    if (context.state !== 'running') {
      const generation = this.generation;
      const timeout = setTimeout(() => {
        if (this.generation === generation && context.state !== 'running') {
          this.fallbackToPlatform();
        }
      }, 1000);
      void context.resume().then(
        () => {
          clearTimeout(timeout);
          if (this.generation === generation && context.state !== 'running') {
            this.fallbackToPlatform();
          }
        },
        () => {
          clearTimeout(timeout);
          if (this.generation === generation) this.fallbackToPlatform();
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

  private fallback(text: string, generation: number): void {
    if (this.generation !== generation || this.receivedAudio) return;
    this.fallbackToPlatform(text);
  }

  private fallbackToPlatform(text?: string): void {
    // The text is stored only in this closure until the first chunk or timeout; no cloud retry.
    const fallbackText = text ?? this.pendingText;
    const listener = this.active;
    this.reset();
    this.onSpeakingChange?.(false);
    this.active = listener;
    if (fallbackText) this.speakPlatform(fallbackText, this.generation);
    else this.settle('failed');
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
      this.active?.('started');
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
  private settle(status: Exclude<SpeechStatus, 'started'>): void {
    const listener = this.active;
    this.active = null;
    listener?.(status);
  }

  stop(): void {
    this.settle('cancelled');
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

/** Forwards `started` at most once, so a platform fallback after playback began is not recounted. */
function onceStarted(listener: SpeechStatusListener): SpeechStatusListener {
  let started = false;
  return (status) => {
    if (status === 'started') {
      if (started) return;
      started = true;
    }
    listener(status);
  };
}
