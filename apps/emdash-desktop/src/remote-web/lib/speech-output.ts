import type { RemoteVoiceEvent } from '@emdash/core/services/remote-control/api';
import { base64ToBytes, pcm16ToFloat32 } from './audio-codec';
import type { AudioSession } from './audio-session';
import { randomUuid } from './uuid';

/** `host`: the computer synthesizes audio and streams it here. `device`: this browser's voice. */
export type SpeechMode = 'host' | 'device';

/** The host side of spoken replies. */
export type SpeechHost = {
  /** Asks the host to synthesize `text`; resolves false when it will not. */
  start(requestId: string, text: string): Promise<boolean>;
  stop(requestId: string): void;
};

/** The host accepts at most this much text per request; longer replies use the device voice. */
const HOST_TEXT_LIMIT = 1200;
/** How long to wait for the host's first audio before speaking with the device voice instead. */
const FIRST_AUDIO_TIMEOUT_MS = 8_000;
/** How long a suspended audio context gets to resume before the device voice takes over. */
const RESUME_TIMEOUT_MS = 1_000;

type HostRequest = {
  id: string;
  text: string;
  receivedAudio: boolean;
  finished: boolean;
};

/**
 * Speaks conductor replies, one at a time; a new one cuts off the last. Host speech arrives as
 * PCM chunks and is scheduled back to back on the shared audio context. Whenever the host
 * declines, fails, stays silent, or the context cannot play, the same text is spoken with the
 * browser's own voice instead, so a reply is not lost to a synthesis problem.
 */
export class SpeechOutput {
  private request: HostRequest | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private firstAudioTimer: ReturnType<typeof setTimeout> | undefined;
  private deviceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Held so the browser does not collect an utterance that is still being spoken. */
  private utterance: SpeechSynthesisUtterance | null = null;
  /** Bumped by every speak and stop; late callbacks from an earlier utterance check it. */
  private generation = 0;
  private speaking = false;

  constructor(
    private readonly audio: AudioSession,
    private readonly host: SpeechHost,
    private readonly onSpeakingChange: (speaking: boolean) => void
  ) {}

  /** Whether this browser can speak at all without the host. */
  static deviceVoiceAvailable(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance === 'function';
  }

  speak(text: string, mode: SpeechMode): void {
    const spoken = text.trim();
    this.stop();
    if (!spoken) return;
    const generation = this.generation;
    if (mode === 'device' || spoken.length > HOST_TEXT_LIMIT) {
      this.speakWithDevice(spoken, generation);
      return;
    }
    const request: HostRequest = {
      id: randomUuid(),
      text: spoken,
      receivedAudio: false,
      finished: false,
    };
    this.request = request;
    this.setSpeaking(true);
    this.firstAudioTimer = setTimeout(() => this.fallBack(request), FIRST_AUDIO_TIMEOUT_MS);
    this.host.start(request.id, spoken).then(
      (accepted) => {
        if (!accepted) this.fallBack(request);
      },
      () => this.fallBack(request)
    );
  }

  /** Feeds the host's event stream; events for other devices' requests are ignored. */
  handleEvent(event: RemoteVoiceEvent): void {
    const request = this.request;
    if (!request || event.type === 'partial' || event.requestId !== request.id) return;
    if (event.type === 'speech-chunk') {
      try {
        this.playChunk(request, event.pcm, event.sampleRate);
      } catch {
        if (request.receivedAudio) this.stop();
        else this.fallBack(request);
      }
      return;
    }
    request.finished = true;
    if (!request.receivedAudio) this.fallBack(request);
    else this.finishIfDrained(request);
  }

  /** Cuts off whatever is being said. */
  stop(): void {
    this.generation += 1;
    clearTimeout(this.firstAudioTimer);
    clearTimeout(this.deviceTimer);
    const request = this.request;
    this.request = null;
    if (request && !request.finished) this.host.stop(request.id);
    this.stopSources();
    if (this.utterance && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.utterance = null;
    this.setSpeaking(false);
  }

  private playChunk(request: HostRequest, pcm: string, sampleRate: number): void {
    const samples = pcm16ToFloat32(base64ToBytes(pcm));
    if (samples.length === 0) return;
    const context = this.audio.context();
    // A buffer at another rate than the context's is resampled on playback.
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, this.nextStart);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      this.finishIfDrained(request);
    };
    source.start(startAt);
    if (!request.receivedAudio) {
      request.receivedAudio = true;
      clearTimeout(this.firstAudioTimer);
      this.ensureRunning(context, request);
    }
  }

  /** A context that was never unlocked by a touch plays nothing; do not wait on it for long. */
  private ensureRunning(context: AudioContext, request: HostRequest): void {
    if (context.state === 'running') return;
    const giveUp = (): void => {
      if (this.request === request && context.state !== 'running') this.fallBack(request, true);
    };
    const timer = setTimeout(giveUp, RESUME_TIMEOUT_MS);
    context.resume().then(
      () => {
        clearTimeout(timer);
        giveUp();
      },
      () => {
        clearTimeout(timer);
        giveUp();
      }
    );
  }

  private finishIfDrained(request: HostRequest): void {
    if (this.request !== request || !request.finished || this.sources.size > 0) return;
    this.request = null;
    this.nextStart = 0;
    this.setSpeaking(false);
  }

  /** Abandons host speech for this request and says the text with the device voice. */
  private fallBack(request: HostRequest, evenAfterAudio = false): void {
    if (this.request !== request || (request.receivedAudio && !evenAfterAudio)) return;
    clearTimeout(this.firstAudioTimer);
    this.request = null;
    if (!request.finished) this.host.stop(request.id);
    this.stopSources();
    this.speakWithDevice(request.text, this.generation);
  }

  private speakWithDevice(text: string, generation: number): void {
    if (!SpeechOutput.deviceVoiceAvailable()) {
      this.setSpeaking(false);
      return;
    }
    // Cancelling an idle synthesizer makes iOS drop the utterance that follows.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.05;
    const done = (): void => {
      if (this.generation !== generation || this.utterance !== utterance) return;
      clearTimeout(this.deviceTimer);
      this.utterance = null;
      this.setSpeaking(false);
    };
    utterance.onend = done;
    utterance.onerror = done;
    this.utterance = utterance;
    this.setSpeaking(true);
    // Some Android voices never report the end; do not show "speaking" forever.
    this.deviceTimer = setTimeout(done, 6_000 + text.length * 110);
    try {
      speechSynthesis.speak(utterance);
    } catch {
      done();
    }
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.onSpeakingChange(speaking);
  }
}
