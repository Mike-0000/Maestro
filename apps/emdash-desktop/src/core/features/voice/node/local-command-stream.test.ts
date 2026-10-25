import { describe, expect, it, vi } from 'vitest';
import { LocalCommandStream } from './local-command-stream';

const RATE = 16_000;

function pcm(ms: number, loud: boolean): Uint8Array {
  const samples = new Int16Array((RATE * ms) / 1000);
  if (loud) for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 8000 : -8000;
  return new Uint8Array(samples.buffer);
}

/** One word per 100 ms of sound; a whole-clip pass of the same audio gives the same words. */
function wordsBySound(calls: number[] = []) {
  return async (samples: Float32Array): Promise<string> => {
    calls.push(samples.length);
    let loud = 0;
    for (const sample of samples) if (Math.abs(sample) > 0.1) loud++;
    return Array.from({ length: Math.floor(loud / (RATE / 10)) }, (_, i) => `w${i + 1}`).join(' ');
  };
}

async function feed(stream: LocalCommandStream, audio: Uint8Array): Promise<void> {
  const chunk = (RATE * 2 * 40) / 1000;
  for (let offset = 0; offset < audio.length; offset += chunk) {
    stream.push(audio.subarray(offset, offset + chunk));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Three 6 s phrases split by one-second pauses: about 20 s. */
function longSpeech(): Uint8Array[] {
  return [pcm(6000, true), pcm(1000, false), pcm(6000, true), pcm(1000, false), pcm(6000, true)];
}

describe('LocalCommandStream', () => {
  it('transcribes a short capture as one clip, with no chunk passes while recording', async () => {
    const calls: number[] = [];
    const stream = new LocalCommandStream(wordsBySound(calls));
    await feed(stream, pcm(3000, true));
    expect(calls).toEqual([]);
    expect(stream.usedChunks).toBe(false);
    expect(await stream.finish()).toBe(Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(' '));
    expect(calls).toEqual([3 * RATE]);
  });

  it('transcribes phrases during a long capture and joins them without loss or repeats', async () => {
    const decode = vi.fn(wordsBySound());
    const stream = new LocalCommandStream(decode);
    for (const part of longSpeech()) await feed(stream, part);
    expect(stream.usedChunks).toBe(true);
    const callsBeforeRelease = decode.mock.calls.length;
    expect(callsBeforeRelease).toBeGreaterThan(0);
    const text = await stream.finish();
    // 18 s of sound at 10 words per second, every phrase counted exactly once.
    expect(text.split(' ')).toHaveLength(180);
    // No whole-clip pass: nothing decoded the full ~20 s of audio.
    expect(decode.mock.calls.every(([samples]) => samples.length < 19 * RATE)).toBe(true);
  });

  it('falls back to a whole-clip pass when a chunk failed', async () => {
    const good = wordsBySound();
    let failOnce = true;
    const decode = vi.fn(async (samples: Float32Array) => {
      if (failOnce && samples.length < 10 * RATE) {
        failOnce = false;
        throw new Error('onnx exploded');
      }
      return good(samples);
    });
    const stream = new LocalCommandStream(decode);
    for (const part of longSpeech()) await feed(stream, part);
    const text = await stream.finish();
    expect(text.split(' ')).toHaveLength(180);
    expect(decode.mock.calls.some(([samples]) => samples.length > 19 * RATE)).toBe(true);
  });

  it('falls back to a whole-clip pass when the chunked text is far too short', async () => {
    const decode = vi.fn(async (samples: Float32Array) =>
      samples.length > 19 * RATE ? 'whole clip text here' : ''
    );
    const stream = new LocalCommandStream(decode);
    for (const part of longSpeech()) await feed(stream, part);
    expect(await stream.finish()).toBe('whole clip text here');
  });
});
