import { secret } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePcmContentType,
  streamOpenRouterTts,
  type OpenRouterTtsEvent,
} from './openrouter-tts';

const options = (signal = new AbortController().signal) => ({
  key: secret('test-openrouter-key', 'openrouter'),
  model: 'google/gemini-3.8-flash-lite-tts' as const,
  voice: 'Kore',
  text: 'Sent to Atlas.',
  signal,
});

function response(
  chunks: Uint8Array[],
  init: ResponseInit = { status: 200, headers: { 'content-type': 'audio/pcm' } }
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}

const samples = (...values: number[]) => {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
  return bytes;
};

describe('OpenRouter TTS', () => {
  it('posts an OpenAI-compatible speech request with the key only in the header', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response([samples(1, 2)]));
    const events: OpenRouterTtsEvent[] = [];
    await streamOpenRouterTts(options(), (event) => events.push(event), request);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-openrouter-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'google/gemini-3.8-flash-lite-tts',
      input: 'Sent to Atlas.',
      voice: 'Kore',
      response_format: 'pcm',
    });
    expect(String(init?.body)).not.toContain('test-openrouter-key');
    expect(events).toEqual([
      { type: 'chunk', pcm: samples(1, 2).toString('base64'), sampleRate: 24_000 },
      { type: 'done' },
    ]);
  });

  it('keeps samples whole when network reads split them', async () => {
    const pcm = samples(100, -200, 300);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([pcm.subarray(0, 3), pcm.subarray(3)]));
    const events: OpenRouterTtsEvent[] = [];
    await streamOpenRouterTts(options(), (event) => events.push(event), request);
    const audio = Buffer.concat(
      events.flatMap((event) => (event.type === 'chunk' ? [Buffer.from(event.pcm, 'base64')] : []))
    );
    expect(audio).toEqual(pcm);
  });

  it('honours the reported rate and mixes stereo down to mono', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response([samples(100, 300, -50, -150)], {
        status: 200,
        headers: { 'content-type': 'audio/pcm; rate=16000; channels=2' },
      })
    );
    const events: OpenRouterTtsEvent[] = [];
    await streamOpenRouterTts(options(), (event) => events.push(event), request);
    expect(events[0]).toEqual({
      type: 'chunk',
      pcm: samples(200, -100).toString('base64'),
      sampleRate: 16_000,
    });
  });

  it('fails on errors, compressed audio, and empty responses', async () => {
    const emit = vi.fn();
    await expect(
      streamOpenRouterTts(
        options(),
        emit,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{}}', { status: 402 }))
      )
    ).rejects.toThrow('OpenRouter TTS failed (402).');
    await expect(
      streamOpenRouterTts(
        options(),
        emit,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response([samples(1)], { status: 200, headers: { 'content-type': 'audio/mpeg' } })
          )
      )
    ).rejects.toThrow('not PCM');
    await expect(
      streamOpenRouterTts(options(), emit, vi.fn<typeof fetch>().mockResolvedValue(response([])))
    ).rejects.toThrow('no audio');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits nothing further once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const emit = vi.fn();
    await streamOpenRouterTts(
      options(controller.signal),
      emit,
      vi.fn<typeof fetch>().mockResolvedValue(response([samples(1, 2)]))
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it('parses PCM content types', () => {
    expect(parsePcmContentType(null)).toEqual({ sampleRate: 24_000, channels: 1 });
    expect(parsePcmContentType('audio/pcm;rate=48000;channels=1')).toEqual({
      sampleRate: 48_000,
      channels: 1,
    });
    expect(() => parsePcmContentType('audio/pcm; rate=abc')).toThrow('sample rate');
  });
});
