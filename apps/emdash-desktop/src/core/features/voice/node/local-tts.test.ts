import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTts } from './local-tts';

const { createAsync, generateAsync } = vi.hoisted(() => ({
  createAsync: vi.fn(),
  generateAsync: vi.fn(),
}));
vi.mock('sherpa-onnx-node', () => ({
  default: {
    OfflineTts: { createAsync },
    GenerationConfig: class {
      constructor(readonly options: unknown) {}
    },
  },
}));

beforeEach(() => {
  createAsync.mockReset().mockResolvedValue({ sampleRate: 24_000, generateAsync });
  generateAsync.mockReset().mockImplementation(async ({ onProgress }) => {
    onProgress({ samples: new Float32Array([-1, 0, 0.5, 1]), progress: 1 });
    return { samples: new Float32Array(), sampleRate: 24_000 };
  });
});

describe('LocalTts', () => {
  it('loads the bundled CPU model once and streams 24 kHz PCM for the selected voice', async () => {
    const tts = new LocalTts('test-model');
    const events: unknown[] = [];
    const signal = new AbortController().signal;
    await tts.speak('Ready.', 'Bella', signal, (event) => events.push(event));
    await tts.speak('Sent.', 'Jasper', signal, (event) => events.push(event));
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(createAsync).toHaveBeenCalledWith({
      model: {
        kitten: {
          model: expect.stringContaining('model.onnx'),
          voices: expect.stringContaining('voices.bin'),
          tokens: expect.stringContaining('tokens.txt'),
          dataDir: expect.stringContaining('espeak-ng-data'),
        },
        numThreads: 2,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    });
    expect(generateAsync.mock.calls[0]?.[0].generationConfig.options.sid).toBe(1);
    expect(generateAsync.mock.calls[1]?.[0].generationConfig.options.sid).toBe(0);
    expect(events).toEqual([
      { type: 'chunk', pcm: Buffer.from([0, 128, 0, 0, 0, 64, 255, 127]).toString('base64') },
      { type: 'done' },
      { type: 'chunk', pcm: Buffer.from([0, 128, 0, 0, 0, 64, 255, 127]).toString('base64') },
      { type: 'done' },
    ]);
  });

  it('cancels native generation and never emits late audio or completion', async () => {
    const controller = new AbortController();
    generateAsync.mockImplementation(async ({ onProgress }) => {
      controller.abort();
      expect(onProgress({ samples: new Float32Array([0]), progress: 1 })).toBe(false);
      return { samples: new Float32Array(), sampleRate: 24_000 };
    });
    const emit = vi.fn();
    await new LocalTts('test-model').speak('Ready.', 'Luna', controller.signal, emit);
    expect(emit).not.toHaveBeenCalled();
  });
});
