import { describe, expect, it } from 'vitest';
import { concatFloat32, downsample, encodeWav, rms, SilenceDetector } from './wav';

describe('downsample', () => {
  it('reduces 48 kHz to 16 kHz by averaging', () => {
    const input = new Float32Array([0, 0.3, 0.6, 0.9, 0.9, 0.9]);
    const output = downsample(input, 48_000, 16_000);
    expect(output.length).toBe(2);
    expect(output[0]).toBeCloseTo(0.3);
    expect(output[1]).toBeCloseTo(0.9);
  });

  it('copies when already at or below the target rate', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(Array.from(downsample(input, 16_000))).toEqual(Array.from(input));
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header and clamps samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...wav.slice(offset, offset + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(52);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(0x7fff);
  });
});

describe('levels', () => {
  it('computes RMS and concatenates chunks', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
    expect(Array.from(concatFloat32([new Float32Array([1]), new Float32Array([2, 3])]))).toEqual([
      1, 2, 3,
    ]);
  });

  it('ends an utterance only after speech followed by sustained silence', () => {
    const detector = new SilenceDetector(1000);
    expect(detector.push(0.005, 100)).toBe(false); // silence before speech never ends it
    expect(detector.push(0.2, 100)).toBe(false);
    for (let i = 0; i < 9; i++) expect(detector.push(0.004, 100)).toBe(false);
    expect(detector.push(0.004, 100)).toBe(true);
    expect(detector.hasSpeech).toBe(true);
  });
});
