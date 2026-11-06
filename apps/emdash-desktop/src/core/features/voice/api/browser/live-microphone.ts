import { log } from '@core/primitives/logging/browser/logger';
import { getAudioDevices, openMicrophoneStream, type AudioDevicesStore } from './audio-devices';

/**
 * A microphone feeding `target` that follows the device in use: when the developer picks another
 * microphone, or Windows moves its default (a headset taken off), the stream is reopened on the
 * new device and swapped in under the same audio graph, so nobody downstream has to reopen.
 */
export class LiveMicrophone {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private closed = false;

  constructor(
    private readonly context: AudioContext,
    private readonly target: AudioNode,
    private readonly constraints: MediaTrackConstraints,
    private readonly devices: AudioDevicesStore = getAudioDevices()
  ) {}

  /** Opens the microphone; rejects with the `getUserMedia` error when it cannot. */
  async open(): Promise<void> {
    const generation = ++this.generation;
    const stream = await openMicrophoneStream(this.constraints, this.devices);
    if (this.closed || generation !== this.generation) {
      stopStream(stream);
      return;
    }
    this.attach(stream);
    this.unsubscribe ??= this.devices.onInputChange(() => void this.move('device-changed'));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source?.disconnect();
    stopStream(this.stream);
    this.source = null;
    this.stream = null;
  }

  private attach(stream: MediaStream): void {
    const previousSource = this.source;
    const previousStream = this.stream;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.target);
    this.stream = stream;
    previousSource?.disconnect();
    stopStream(previousStream);
    for (const track of stream.getAudioTracks()) {
      // An unplugged device ends its track; the next device in line takes over.
      track.addEventListener(
        'ended',
        () => {
          if (this.stream === stream) void this.move('track-ended');
        },
        { once: true }
      );
    }
  }

  private async move(reason: string): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    let stream: MediaStream;
    try {
      stream = await openMicrophoneStream(this.constraints, this.devices);
    } catch (error) {
      // The old stream keeps going if it still can; the next device change tries again.
      log.warn('voice: could not move to the new microphone', { reason, error });
      return;
    }
    if (this.closed || generation !== this.generation) {
      stopStream(stream);
      return;
    }
    this.attach(stream);
    log.info('voice: microphone moved to the device in use', { reason });
  }
}

/**
 * A microphone track that stays the same object while the device under it changes, for the
 * voice line, which is handed one track for its whole session. Stopping the track releases the
 * microphone.
 */
export async function openLiveMicrophoneTrack(
  constraints: MediaTrackConstraints
): Promise<MediaStreamTrack> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;
  const microphone = new LiveMicrophone(context, destination, constraints);
  try {
    await microphone.open();
  } catch (error) {
    microphone.close();
    void context.close().catch(() => undefined);
    throw error;
  }
  void context.resume().catch(() => undefined);
  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    microphone.close();
    void context.close().catch(() => undefined);
    throw new Error('No microphone is available.');
  }
  // The line only ever stops its track, so stopping is where the device and graph are let go.
  const stop = track.stop.bind(track);
  track.stop = () => {
    stop();
    microphone.close();
    void context.close().catch(() => undefined);
  };
  return track;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
