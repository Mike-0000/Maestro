/** Audio helpers for speech capture: resampling, WAV encoding, and levels. Pure and portable. */

export const STT_SAMPLE_RATE = 16_000;

/** Averaging downsampler from the device rate (usually 48 kHz) to `outputRate`. */
export function downsample(input: Float32Array, inputRate: number, outputRate = STT_SAMPLE_RATE) {
  if (outputRate >= inputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  let inputIndex = 0;
  for (let i = 0; i < length; i++) {
    const nextInputIndex = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = inputIndex; j < nextInputIndex; j++) {
      sum += input[j] ?? 0;
      count++;
    }
    output[i] = count > 0 ? sum / count : 0;
    inputIndex = nextInputIndex;
  }
  return output;
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Encodes mono float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = STT_SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

/** Root-mean-square level of a chunk, 0..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Energy-based end-of-speech detector for toggle mode. Tracks a noise floor and reports when
 * speech (level well above the floor) has been followed by `silenceMs` of quiet.
 */
export class SilenceDetector {
  private noiseFloor = 0.01;
  private heardSpeech = false;
  private silentForMs = 0;

  constructor(
    private readonly silenceMs = 1200,
    private readonly speechRatio = 3
  ) {}

  /** Feed one chunk's level and its duration; returns true when the utterance has ended. */
  push(level: number, durationMs: number): boolean {
    const isSpeech = level > Math.max(0.02, this.noiseFloor * this.speechRatio);
    if (isSpeech) {
      this.heardSpeech = true;
      this.silentForMs = 0;
    } else {
      // Adapt the floor slowly toward quiet levels only.
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
      if (this.heardSpeech) this.silentForMs += durationMs;
    }
    return this.heardSpeech && this.silentForMs >= this.silenceMs;
  }

  get hasSpeech(): boolean {
    return this.heardSpeech;
  }
}
