import { LiveMicrophone } from '../api/browser/live-microphone';
import { concatFloat32, downsample, encodeWav, pcm16Bytes, rms, STT_SAMPLE_RATE } from '../api/wav';

/** Posts each render quantum batch (~43 ms at 48 kHz) of mono samples to the main thread. */
const WORKLET_SOURCE = `
class ChorusCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.size = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.buffer.push(new Float32Array(channel));
      this.size += channel.length;
      if (this.size >= 2048) {
        const out = new Float32Array(this.size);
        let offset = 0;
        for (const chunk of this.buffer) { out.set(chunk, offset); offset += chunk.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buffer = [];
        this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor('chorus-capture', ChorusCaptureProcessor);
`;

export type MicErrorKind = 'permission-denied' | 'no-device' | 'unavailable';

export class MicError extends Error {
  constructor(
    readonly kind: MicErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'MicError';
  }
}

/** Keep the microphone open this long after an utterance so the next one starts instantly. */
const WARM_MS = 30_000;
/** Audio kept from before speech onset in hands-free mode, so first syllables are not lost. */
const PRE_ROLL_MS = 400;

const CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Microphone capture for push-to-talk. The stream stays warm briefly between utterances to avoid
 * the ~200 ms device start cost, then releases so the OS mic indicator turns off. While open it
 * follows the device in use (a picked microphone, or a new Windows default).
 */
export class MicRecorder {
  private microphone: LiveMicrophone | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  private chunks: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private recording = false;
  private monitoring = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called for every captured chunk with its RMS level and duration in ms. */
  onChunk: ((level: number, durationMs: number) => void) | null = null;
  /** While recording: each chunk as 16 kHz PCM16 bytes, for live streaming. */
  onPcm: ((pcm: Uint8Array<ArrayBuffer>) => void) | null = null;

  get isRecording(): boolean {
    return this.recording;
  }

  /** Starts recording; `withPreRoll` prepends the last moments heard while monitoring. */
  async start(options: { withPreRoll?: boolean } = {}): Promise<void> {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    await this.ensureOpen();
    this.chunks = options.withPreRoll ? this.preRoll.splice(0) : [];
    this.preRoll = [];
    this.recording = true;
    for (const chunk of this.chunks) this.emitPcm(chunk);
    await this.context?.resume();
  }

  /** Keeps the mic open and levels flowing between utterances (hands-free mode). */
  async setMonitoring(on: boolean): Promise<void> {
    this.monitoring = on;
    if (on) {
      if (this.releaseTimer) clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      await this.ensureOpen();
      await this.context?.resume();
    } else {
      this.preRoll = [];
      if (!this.recording) this.scheduleRelease();
    }
  }

  /** Stops recording and returns 16 kHz mono WAV bytes. */
  stop(): { wav: Uint8Array; durationMs: number } {
    this.recording = false;
    this.scheduleRelease();
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const samples = downsample(concatFloat32(this.chunks), sampleRate, STT_SAMPLE_RATE);
    this.chunks = [];
    return {
      wav: encodeWav(samples, STT_SAMPLE_RATE),
      durationMs: Math.round((samples.length / STT_SAMPLE_RATE) * 1000),
    };
  }

  cancel(): void {
    this.recording = false;
    this.chunks = [];
    this.scheduleRelease();
  }

  dispose(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.release();
  }

  private ensureOpen(): Promise<void> {
    if (this.microphone && this.context && this.node) return Promise.resolve();
    // Hands-free monitoring and a key press can both ask at once: one microphone serves both.
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    const context = new AudioContext({ latencyHint: 'interactive' });
    let microphone: LiveMicrophone | null = null;
    try {
      const moduleUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
      );
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const node = new AudioWorkletNode(context, 'chorus-capture');
      microphone = new LiveMicrophone(context, node, CAPTURE_CONSTRAINTS);
      try {
        await microphone.open();
      } catch (error) {
        throw micError(error);
      }
      this.context = context;
      this.node = node;
      this.microphone = microphone;
    } catch (error) {
      microphone?.close();
      void context.close().catch(() => {});
      throw error;
    }
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data;
      const durationMs = (chunk.length / (this.context?.sampleRate ?? 48_000)) * 1000;
      if (this.recording) {
        this.chunks.push(chunk);
        this.emitPcm(chunk);
      } else if (this.monitoring) {
        this.preRoll.push(chunk);
        let kept = this.preRoll.reduce((total, part) => total + part.length, 0);
        const limit = ((this.context?.sampleRate ?? 48_000) * PRE_ROLL_MS) / 1000;
        while (kept > limit && this.preRoll.length > 1) kept -= this.preRoll.shift()?.length ?? 0;
      }
      this.onChunk?.(rms(chunk), durationMs);
    };
  }

  private emitPcm(chunk: Float32Array): void {
    if (!this.onPcm) return;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    this.onPcm(pcm16Bytes(downsample(chunk, sampleRate, STT_SAMPLE_RATE)));
  }

  private scheduleRelease(): void {
    if (this.monitoring) return;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.release(), WARM_MS);
  }

  private release(): void {
    this.releaseTimer = null;
    this.microphone?.close();
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    void this.context?.close().catch(() => {});
    this.microphone = null;
    this.node = null;
    this.context = null;
  }
}

/** The reason a microphone could not be opened, as the voice bar explains it. */
function micError(error: unknown): MicError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError(
      'permission-denied',
      'Windows is blocking microphone access for desktop apps.'
    );
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new MicError('no-device', 'No microphone was found.');
  }
  return new MicError('unavailable', 'The microphone could not be opened.');
}
