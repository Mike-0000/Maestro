import { concatFloat32, downsample, encodeWav, rms, STT_SAMPLE_RATE } from '../api/wav';

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

/**
 * Microphone capture for push-to-talk. The stream stays warm briefly between utterances to avoid
 * the ~200 ms device start cost, then releases so the OS mic indicator turns off.
 */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private recording = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called for every captured chunk with its RMS level and duration in ms. */
  onChunk: ((level: number, durationMs: number) => void) | null = null;

  get isRecording(): boolean {
    return this.recording;
  }

  async start(): Promise<void> {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    await this.ensureOpen();
    this.chunks = [];
    this.recording = true;
    await this.context?.resume();
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

  private async ensureOpen(): Promise<void> {
    if (this.stream && this.context && this.node) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MicError(
          'permission-denied',
          'Windows is blocking microphone access for desktop apps.'
        );
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new MicError('no-device', 'No microphone was found.');
      }
      throw new MicError('unavailable', 'The microphone could not be opened.');
    }
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    );
    try {
      await this.context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'chorus-capture');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const chunk = event.data;
      const durationMs = (chunk.length / (this.context?.sampleRate ?? 48_000)) * 1000;
      this.onChunk?.(rms(chunk), durationMs);
      if (this.recording) this.chunks.push(chunk);
    };
    this.source.connect(this.node);
  }

  private scheduleRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.release(), WARM_MS);
  }

  private release(): void {
    this.releaseTimer = null;
    this.node?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}
