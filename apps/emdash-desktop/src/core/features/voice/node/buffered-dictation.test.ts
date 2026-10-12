import { describe, expect, it } from 'vitest';
import { BufferedDictationStream } from './buffered-dictation';

const RATE = 16_000;

/** 16 kHz PCM16 of `ms` milliseconds: a tone when `loud`, digital silence otherwise. */
function pcm(ms: number, loud: boolean): Uint8Array {
  const samples = new Int16Array((RATE * ms) / 1000);
  if (loud) for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 8000 : -8000;
  return new Uint8Array(samples.buffer);
}

/** A recognizer that hears one word per 100 ms of sound, so text grows with the audio. */
function wordsBySound(calls: number[] = []) {
  return async (samples: Float32Array): Promise<string> => {
    calls.push(samples.length);
    let loud = 0;
    for (const sample of samples) if (Math.abs(sample) > 0.1) loud++;
    const words = Math.floor(loud / (RATE / 10));
    return Array.from({ length: words }, (_, index) => `w${index + 1}`).join(' ');
  };
}

/** Feeds audio in 40 ms chunks, letting each pass finish as real time would. */
async function feed(stream: BufferedDictationStream, audio: Uint8Array): Promise<void> {
  const chunk = (RATE * 2 * 40) / 1000;
  for (let offset = 0; offset < audio.length; offset += chunk) {
    stream.push(audio.subarray(offset, offset + chunk));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('BufferedDictationStream', () => {
  it('shows the phrase growing while it is spoken', async () => {
    const partials: string[] = [];
    const stream = new BufferedDictationStream(wordsBySound(), (text) => partials.push(text));
    await feed(stream, pcm(1000, true));
    expect(partials.length).toBeGreaterThan(1);
    expect(partials.at(-1)).toMatch(/^w1 w2/);
    expect(await stream.finish()).toBe('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10');
  });

  it('makes a phrase final at a pause and starts the next from fresh audio', async () => {
    const calls: number[] = [];
    const stream = new BufferedDictationStream(wordsBySound(calls), () => {});
    await feed(stream, pcm(500, true));
    await feed(stream, pcm(1200, false));
    const afterPause = calls.length;
    await feed(stream, pcm(300, true));
    // The second phrase is transcribed without the first one's audio (2 s by then).
    expect(Math.max(...calls.slice(afterPause))).toBeLessThan(RATE * 1.5);
    expect(await stream.finish()).toBe('w1 w2 w3 w4 w5 w1 w2 w3');
  });

  it('does not keep transcribing silence', async () => {
    const calls: number[] = [];
    const stream = new BufferedDictationStream(wordsBySound(calls), () => {});
    await feed(stream, pcm(10_000, false));
    // One look at the first quiet stretch, then nothing while it stays quiet.
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(await stream.finish()).toBe('');
  });

  it('cuts a phrase nobody paused in, without losing words', async () => {
    const calls: number[] = [];
    const stream = new BufferedDictationStream(wordsBySound(calls), () => {});
    await feed(stream, pcm(25_000, true));
    expect(Math.max(...calls)).toBeLessThanOrEqual(RATE * 20.5);
    // The fake counts whole words on each side of the cut, so the one it falls in is not counted.
    expect((await stream.finish()).split(' ').length).toBeGreaterThanOrEqual(249);
  });

  it('reports a recognizer failure when the dictation is finished', async () => {
    const stream = new BufferedDictationStream(
      async () => {
        throw new Error('model missing');
      },
      () => {}
    );
    await feed(stream, pcm(600, true));
    await expect(stream.finish()).rejects.toThrow('model missing');
  });

  it('hears nothing more once aborted', async () => {
    const partials: string[] = [];
    const stream = new BufferedDictationStream(wordsBySound(), (text) => partials.push(text));
    stream.abort();
    await feed(stream, pcm(600, true));
    expect(partials).toEqual([]);
  });
});
