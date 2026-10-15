import { LINE_SAMPLE_RATE, type LineAudio } from './grok-voice-session';

/** Posts about 50 ms of mono samples at a time to the main thread. */
const WORKLET_SOURCE = `
class TalkLineCaptureProcessor extends AudioWorkletProcessor {
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
      if (this.size >= 1200) {
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
registerProcessor('talk-line-capture', TalkLineCaptureProcessor);
`;

/** A chunk of voice is started this far ahead, so the first one does not click in late. */
const START_LEAD_S = 0.02;

/**
 * The line's sound in this window: the microphone as samples at 24 kHz, and the voice played
 * from 16-bit PCM into a stream, which the page plays (and mutes) through an audio element.
 * One AudioContext at the line's rate does both, so neither way is resampled by hand.
 */
export async function createLineAudio(track: MediaStreamTrack): Promise<LineAudio> {
  const context = new AudioContext({ sampleRate: LINE_SAMPLE_RATE, latencyHint: 'interactive' });
  try {
    const moduleUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    );
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
    const audio = new WebLineAudio(context, track);
    await context.resume().catch(() => undefined);
    return audio;
  } catch (error) {
    void context.close().catch(() => undefined);
    throw error;
  }
}

class WebLineAudio implements LineAudio {
  readonly output: MediaStream;
  onCapture: ((samples: Float32Array, rate: number) => void) | null = null;
  onDrained: (() => void) | null = null;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly playing = new Set<AudioBufferSourceNode>();
  /** When the queue ends, in the context's time. */
  private queueEnd = 0;
  /** Milliseconds of sound queued and not dropped: played, or still to play. */
  private queued = 0;
  private closed = false;

  constructor(
    private readonly context: AudioContext,
    track: MediaStreamTrack
  ) {
    this.source = context.createMediaStreamSource(new MediaStream([track]));
    this.node = new AudioWorkletNode(context, 'talk-line-capture');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.onCapture?.(event.data, context.sampleRate);
    };
    this.source.connect(this.node);
    this.destination = context.createMediaStreamDestination();
    this.output = this.destination.stream;
  }

  play(pcm: Uint8Array): void {
    if (this.closed || pcm.length < 2) return;
    const { context } = this;
    const frames = Math.floor(pcm.length / 2);
    const buffer = context.createBuffer(1, frames, LINE_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2);
    for (let i = 0; i < frames; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.destination);
    const startAt = Math.max(context.currentTime + START_LEAD_S, this.queueEnd);
    this.queueEnd = startAt + buffer.duration;
    this.queued += buffer.duration * 1000;
    this.playing.add(node);
    node.onended = () => {
      this.playing.delete(node);
      node.disconnect();
      if (this.playing.size === 0 && !this.closed) this.onDrained?.();
    };
    node.start(startAt);
  }

  clear(): void {
    const unplayed = this.playing.size === 0 ? 0 : this.unplayedMs();
    this.queued = Math.max(0, this.queued - unplayed);
    for (const node of this.playing) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Not started yet, or already stopped.
      }
      node.disconnect();
    }
    this.playing.clear();
    this.queueEnd = 0;
  }

  queuedMs(): number {
    return this.queued;
  }

  playedMs(): number {
    if (this.playing.size === 0) return this.queued;
    return Math.max(0, this.queued - this.unplayedMs());
  }

  private unplayedMs(): number {
    return Math.max(0, this.queueEnd - this.context.currentTime) * 1000;
  }

  close(): void {
    if (this.closed) return;
    this.clear();
    this.closed = true;
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    void this.context.close().catch(() => undefined);
  }
}
