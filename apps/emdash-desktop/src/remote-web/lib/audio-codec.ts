/** Audio helpers for speech capture and playback: resampling, WAV, PCM16 and base64. Pure. */

/** What the host's speech-to-text engines expect. */
export const STT_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;

/** Averaging downsampler from the device rate (usually 44.1 or 48 kHz) to `outputRate`. */
export function downsample(
  input: Float32Array,
  inputRate: number,
  outputRate = STT_SAMPLE_RATE
): Float32Array {
  if (outputRate >= inputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  let inputIndex = 0;
  for (let index = 0; index < length; index += 1) {
    const nextInputIndex = Math.min(input.length, Math.round((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let cursor = inputIndex; cursor < nextInputIndex; cursor += 1) {
      sum += input[cursor] ?? 0;
      count += 1;
    }
    output[index] = count > 0 ? sum / count : 0;
    inputIndex = nextInputIndex;
  }
  return output;
}

/**
 * The same downsampler for audio that arrives in chunks: it carries its position across calls,
 * so the pieces it returns join into exactly what {@link downsample} gives for the whole
 * recording. Capture keeps only this 16 kHz audio, a third of what the device delivers.
 */
export function createDownsampler(
  inputRate: number,
  outputRate = STT_SAMPLE_RATE
): (input: Float32Array) => Float32Array {
  if (outputRate >= inputRate) return (input) => input.slice();
  const ratio = inputRate / outputRate;
  let consumed = 0;
  let produced = 0;
  let sum = 0;
  let count = 0;
  return (input) => {
    const output = new Float32Array(Math.ceil(input.length / ratio) + 1);
    let length = 0;
    for (let index = 0; index < input.length; index += 1) {
      sum += input[index] ?? 0;
      count += 1;
      if (consumed + index + 1 >= Math.round((produced + 1) * ratio)) {
        output[length] = sum / count;
        length += 1;
        produced += 1;
        sum = 0;
        count = 0;
      }
    }
    consumed += input.length;
    return output.subarray(0, length);
  };
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

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/** Float samples (-1..1) as 16-bit little-endian PCM bytes, as streaming transcription expects. */
export function pcm16Bytes(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, toPcm16(samples[index] ?? 0), true);
  }
  return new Uint8Array(buffer);
}

/** 16-bit little-endian PCM bytes as float samples, for playback. A trailing odd byte is dropped. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

/** Encodes mono float samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(
  samples: Float32Array,
  sampleRate = STT_SAMPLE_RATE
): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
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
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(WAV_HEADER_BYTES + index * bytesPerSample, toPcm16(samples[index] ?? 0), true);
  }
  return new Uint8Array(buffer);
}

/** Size in bytes of a 16 kHz 16-bit mono WAV of this length. */
export function wavBytesFor(durationMs: number, sampleRate = STT_SAMPLE_RATE): number {
  return WAV_HEADER_BYTES + Math.round((durationMs / 1000) * sampleRate) * 2;
}

/** Root-mean-square level of a chunk, 0..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Maps a raw RMS level to 0..1 for a meter. Speech sits around 0.02–0.2 RMS, so the scale is
 * stretched (square root) to make quiet talking visible without pinning loud talking.
 */
export function meterLevel(level: number): number {
  return Math.max(0, Math.min(1, Math.sqrt(level * 4)));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
