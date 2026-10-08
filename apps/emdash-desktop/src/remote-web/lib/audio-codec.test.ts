import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  concatFloat32,
  createDownsampler,
  downsample,
  encodeWav,
  meterLevel,
  pcm16Bytes,
  pcm16ToFloat32,
  rms,
  STT_SAMPLE_RATE,
  wavBytesFor,
} from './audio-codec';

function sine(length: number, sampleRate: number, frequency = 440): Float32Array {
  return Float32Array.from({ length }, (_, index) =>
    Math.sin((2 * Math.PI * frequency * index) / sampleRate)
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

describe('downsample', () => {
  it('produces a third of the samples from 48 kHz', () => {
    expect(downsample(new Float32Array(48_000), 48_000).length).toBe(16_000);
  });

  it('averages each group of input samples', () => {
    const output = downsample(Float32Array.from([0, 0.3, 0.6, 1, 1, 1]), 48_000);
    expect(Array.from(output)).toEqual([expect.closeTo(0.3, 5), 1]);
  });

  it('handles a rate that is not a multiple of the output rate', () => {
    const output = downsample(sine(44_100, 44_100), 44_100);
    expect(output.length).toBe(16_000);
    expect(rms(output)).toBeGreaterThan(0.6);
  });

  it('copies the input when it is already at or below the output rate', () => {
    const input = Float32Array.from([0.1, 0.2]);
    const output = downsample(input, 16_000);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(output).not.toBe(input);
  });
});

describe('createDownsampler', () => {
  it.each([48_000, 44_100, 22_050])(
    'matches a one-shot downsample of the whole recording at %i Hz',
    (rate) => {
      const input = sine(rate, rate);
      const push = createDownsampler(rate);
      const pieces: Float32Array[] = [];
      // Uneven chunk sizes, as an audio callback delivers them.
      for (let offset = 0, size = 2048; offset < input.length; offset += size, size = 1500) {
        pieces.push(push(input.subarray(offset, offset + size)).slice());
      }
      const streamed = concatFloat32(pieces);
      const whole = downsample(input, rate);
      expect(streamed.length).toBe(whole.length);
      for (let index = 0; index < whole.length; index += 1) {
        expect(streamed[index]).toBeCloseTo(whole[index] ?? 0, 5);
      }
    }
  );
});

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit PCM header', () => {
    const wav = encodeWav(new Float32Array(16_000));
    const view = new DataView(wav.buffer);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 12)).toBe('WAVE');
    expect(ascii(wav, 12, 16)).toBe('fmt ');
    expect(ascii(wav, 36, 40)).toBe('data');
    expect(view.getUint32(4, true)).toBe(36 + 32_000);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(STT_SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(wav.byteLength).toBe(44 + 32_000);
  });

  it('clamps samples and scales them to 16 bits', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(wav.buffer);
    const samples = [0, 1, 2, 3, 4, 5].map((index) => view.getInt16(44 + index * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it('keeps five minutes under the host upload limit', () => {
    expect(wavBytesFor(5 * 60_000)).toBeLessThan(10 * 1024 * 1024);
    expect(wavBytesFor(1000)).toBe(encodeWav(new Float32Array(16_000)).byteLength);
  });
});

describe('PCM16', () => {
  it('round-trips through bytes within one quantization step', () => {
    const input = Float32Array.from([0, 0.25, -0.25, 0.999, -1]);
    const output = pcm16ToFloat32(pcm16Bytes(input));
    input.forEach((sample, index) => expect(output[index]).toBeCloseTo(sample, 3));
  });

  it('reads a view that does not start at the beginning of its buffer', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x40, 0x00, 0xc0]).subarray(1);
    expect(Array.from(pcm16ToFloat32(bytes))).toEqual([0.5, -0.5]);
  });

  it('drops a trailing odd byte', () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 0x40, 7])).length).toBe(1);
  });
});

describe('base64', () => {
  it('round-trips binary data larger than one encoding block', () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('levels', () => {
  it('measures RMS', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it('maps levels to a 0..1 meter that rises quickly for quiet speech', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(0.02)).toBeGreaterThan(0.25);
    expect(meterLevel(5)).toBe(1);
  });
});

describe('concat', () => {
  it('joins chunks in order', () => {
    expect(Array.from(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])]))).toEqual([
      1, 2, 3,
    ]);
    expect(Array.from(concatFloat32([Float32Array.from([1]), Float32Array.from([2, 3])]))).toEqual([
      1, 2, 3,
    ]);
  });
});
