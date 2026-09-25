import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  concatFloat32,
  downsample,
  encodeWav,
  pcm16Bytes,
  rms,
  SilenceDetector,
  SpeechOnsetDetector,
  stripWakePhrase,
} from './wav';

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

describe('streaming helpers', () => {
  it('encodes PCM16 little-endian and round-trips base64', () => {
    const bytes = pcm16Bytes(new Float32Array([0, 1, -1]));
    expect([...bytes]).toEqual([0, 0, 0xff, 0x7f, 0x00, 0x80]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('SpeechOnsetDetector', () => {
  it('ignores short bursts and fires on sustained speech', () => {
    const detector = new SpeechOnsetDetector(160);
    for (let i = 0; i < 20; i++) expect(detector.push(0.005, 20)).toBe(false);
    expect(detector.push(0.2, 20)).toBe(false);
    expect(detector.push(0.005, 20)).toBe(false);
    let fired = false;
    for (let i = 0; i < 10 && !fired; i++) fired = detector.push(0.2, 20);
    expect(fired).toBe(true);
  });
});

describe('stripWakePhrase', () => {
  it('requires and strips the phrase', () => {
    expect(stripWakePhrase('Chorus, focus Claude 1.', 'chorus')).toBe('focus Claude 1.');
    expect(stripWakePhrase('courses show all', 'chorus')).toBe('show all');
    expect(stripWakePhrase('focus Claude 1', 'chorus')).toBeNull();
    expect(stripWakePhrase('Chorus', 'chorus')).toBeNull();
    expect(stripWakePhrase('focus Claude 1', '')).toBe('focus Claude 1');
  });
});
