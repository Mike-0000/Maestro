import {
  concatFloat32,
  createDownsampler,
  encodeWav,
  pcm16Bytes,
  rms,
  STT_SAMPLE_RATE,
} from './audio-codec';

/** Posts mono samples to the page in batches of about 40 ms. */
const WORKLET_SOURCE = `
class MaestroCaptureProcessor extends AudioWorkletProcessor {
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
registerProcessor('maestro-capture', MaestroCaptureProcessor);
`;

/**
 * - `insecure`: the page is on plain http, where browsers do not expose the microphone at all.
 * - `unsupported`: this browser has no microphone API.
 * - `denied`: the person, or the system, refused access.
 * - `no-device`: there is no microphone.
 * - `busy`: another app holds the microphone.
 */
export type MicErrorKind = 'insecure' | 'unsupported' | 'denied' | 'no-device' | 'busy' | 'failed';

export class MicError extends Error {
  constructor(readonly kind: MicErrorKind) {
    super(`Microphone unavailable: ${kind}`);
    this.name = 'MicError';
  }
}

export type Recording = {
  /** 16 kHz mono 16-bit PCM WAV. */
  wav: Uint8Array<ArrayBuffer>;
  durationMs: number;
  /** Loudest chunk (RMS, 0..1); near zero means the microphone delivered silence. */
  peak: number;
};

export type MicRecorderEvents = {
  /** RMS level (0..1) of each captured chunk and the time recorded so far. */
  onLevel(level: number, elapsedMs: number): void;
  /** Each chunk as 16 kHz PCM16 bytes, for live transcription. */
  onPcm(pcm: Uint8Array<ArrayBuffer>): void;
};

type Graph = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  tap: Tap;
  sink: GainNode;
};

type Tap = { node: AudioNode; detach(): void };

function classify(error: unknown): MicErrorKind {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/** Why the microphone cannot even be asked for, or null when it can. */
export function micBlocker(): MicErrorKind | null {
  if (typeof navigator.mediaDevices?.getUserMedia === 'function') return null;
  return window.isSecureContext ? 'unsupported' : 'insecure';
}

/**
 * Records one utterance at a time. The microphone is held only while recording: `stop` and
 * `cancel` release it at once, so the phone's recording indicator goes out between utterances.
 */
export class MicRecorder {
  private graph: Graph | null = null;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private peak = 0;
  /** Bumped by every open and release, so a slow `open` can tell it has been superseded. */
  private generation = 0;
  private readonly workletReady = new WeakMap<AudioContext, Promise<void>>();

  constructor(
    private readonly audio: () => AudioContext,
    private readonly events: MicRecorderEvents
  ) {}

  get isOpen(): boolean {
    return this.graph !== null;
  }

  /** Opens the microphone and starts recording. Throws a {@link MicError}. */
  async open(): Promise<void> {
    this.release();
    const generation = this.generation;
    const blocker = micBlocker();
    if (blocker) throw new MicError(blocker);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new MicError(classify(error));
    }
    const abandon = (): void => {
      for (const track of stream.getTracks()) track.stop();
    };
    if (generation !== this.generation) {
      abandon();
      return;
    }

    try {
      const context = this.audio();
      if (context.state !== 'running') await context.resume();
      const downsampleChunk = createDownsampler(context.sampleRate, STT_SAMPLE_RATE);
      const onChunk = (chunk: Float32Array): void => {
        if (generation !== this.generation) return;
        const resampled = downsampleChunk(chunk);
        if (resampled.length === 0) return;
        const level = rms(resampled);
        this.chunks.push(resampled);
        this.samples += resampled.length;
        this.peak = Math.max(this.peak, level);
        this.events.onPcm(pcm16Bytes(resampled));
        this.events.onLevel(level, (this.samples / STT_SAMPLE_RATE) * 1000);
      };
      const tap = await this.createTap(context, onChunk);
      if (generation !== this.generation) {
        abandon();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      // Safari only runs nodes that lead to the destination, so the tap drains into a muted gain.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(tap.node);
      tap.node.connect(sink);
      sink.connect(context.destination);
      this.graph = { stream, source, tap, sink };
    } catch {
      abandon();
      throw new MicError('failed');
    }
  }

  /** Ends the recording, releases the microphone and returns what was captured. */
  stop(): Recording {
    const samples = concatFloat32(this.chunks);
    const peak = this.peak;
    this.release();
    return {
      wav: encodeWav(samples, STT_SAMPLE_RATE),
      durationMs: Math.round((samples.length / STT_SAMPLE_RATE) * 1000),
      peak,
    };
  }

  /** Drops the recording and releases the microphone. */
  cancel(): void {
    this.release();
  }

  private async createTap(
    context: AudioContext,
    onChunk: (chunk: Float32Array) => void
  ): Promise<Tap> {
    if (typeof AudioWorkletNode === 'function') {
      try {
        let ready = this.workletReady.get(context);
        if (!ready) {
          const url = URL.createObjectURL(
            new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
          );
          ready = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
          this.workletReady.set(context, ready);
        }
        await ready;
        const node = new AudioWorkletNode(context, 'maestro-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data);
        return {
          node,
          detach: () => {
            node.port.onmessage = null;
          },
        };
      } catch {
        this.workletReady.delete(context);
      }
    }
    // Older WebViews: the deprecated main-thread processor still captures correctly.
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    return {
      node: processor,
      detach: () => {
        processor.onaudioprocess = null;
      },
    };
  }

  private release(): void {
    this.generation += 1;
    const graph = this.graph;
    this.graph = null;
    this.chunks = [];
    this.samples = 0;
    this.peak = 0;
    if (!graph) return;
    graph.tap.detach();
    graph.source.disconnect();
    graph.tap.node.disconnect();
    graph.sink.disconnect();
    for (const track of graph.stream.getTracks()) track.stop();
  }
}
