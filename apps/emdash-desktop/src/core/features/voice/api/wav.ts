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

/** Float samples (-1..1) to 16-bit little-endian PCM bytes, as streaming STT expects. */
export function pcm16Bytes(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return new Uint8Array(buffer);
}

/** Base64 without Node's Buffer (works in the renderer and in main). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Speech-onset detector for hands-free mode: fires once the level stays well above an adaptive
 * noise floor for `onsetMs`, so a cough or a door slam does not start an utterance.
 */
export class SpeechOnsetDetector {
  private noiseFloor = 0.01;
  private loudForMs = 0;

  constructor(
    private readonly onsetMs = 160,
    private readonly speechRatio = 3.5,
    private readonly minLevel = 0.025
  ) {}

  /** Feed one chunk's level and duration; returns true when speech has started. */
  push(level: number, durationMs: number): boolean {
    const isSpeech = level > Math.max(this.minLevel, this.noiseFloor * this.speechRatio);
    if (isSpeech) {
      this.loudForMs += durationMs;
    } else {
      this.loudForMs = 0;
      this.noiseFloor = this.noiseFloor * 0.97 + level * 0.03;
    }
    return this.loudForMs >= this.onsetMs;
  }

  reset(): void {
    this.loudForMs = 0;
  }
}

/**
 * Hands-free wake phrase: returns the command after the phrase ("Chorus, focus Claude 1" →
 * "focus Claude 1"), or null when the utterance does not start with it. An empty phrase accepts
 * everything.
 */
export function stripWakePhrase(transcript: string, phrase: string): string | null {
  const wanted = phrase.trim().toLowerCase();
  const text = transcript.trim();
  if (!wanted) return text;
  // People often greet the wake word ("hey Chorus", "okay, Chorus"); skip that lead-in.
  const greeting = /^[^a-zA-Z0-9]*(?:(?:hey|hi|ok|okay|yo|um|uh)[\s,.!]+)?/i.exec(text)?.[0] ?? '';
  const afterGreeting = text.slice(greeting.length);
  const normalized = afterGreeting.toLowerCase();
  // Allow common mishearings of the default phrase.
  const variants =
    wanted === 'chorus'
      ? ['chorus', 'choruses', 'corus', 'courses', 'course', 'horus', 'coarse', 'chorys']
      : [wanted];
  // Longest first, and only whole words: "chorused" or "course correct" are not the wake word
  // ("course" alone is accepted only as a separate word).
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (!normalized.startsWith(variant)) continue;
    if (/[a-z0-9]/i.test(afterGreeting.charAt(variant.length))) continue;
    const rest = afterGreeting.slice(variant.length).replace(/^[\s,.!?:;-]+/, '');
    return rest || null;
  }
  return null;
}
