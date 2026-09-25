import { secret } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { streamGeminiTts, type GeminiTtsEvent } from './gemini-tts';

const options = () => ({
  key: secret('test-api-key', 'gemini'),
  model: 'gemini-3.8-flash-lite-tts' as const,
  voice: 'Kore',
  text: 'Sent to Atlas.',
  signal: new AbortController().signal,
});

function response(...chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200 }
  );
}

const audioEvent = (data: string) =>
  `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'audio', data } })}\n\n`;

describe('Gemini TTS streaming', () => {
  it('sends verbatim text with the key only in the request header and emits PCM chunks', async () => {
    const pcm = Buffer.from([0, 0, 255, 127]).toString('base64');
    const data = audioEvent(pcm);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(
          'data: {"event_type":"interaction.started"}\r',
          '\n\r\n' + data.slice(0, 18),
          data.slice(18)
        )
      );
    const events: GeminiTtsEvent[] = [];
    await streamGeminiTts(options(), (event) => events.push(event), request);
    expect(events).toEqual([{ type: 'chunk', pcm }, { type: 'done' }]);
    expect(request).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-goog-api-key': 'test-api-key' }),
        body: expect.stringContaining('Sent to Atlas.'),
      })
    );
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      stream: true,
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    });
    expect(JSON.stringify(body)).not.toContain('test-api-key');
  });

  it('rejects empty, malformed, and failed streams without speaking', async () => {
    const events: GeminiTtsEvent[] = [];
    for (const payload of [
      'data: {"event_type":"interaction.completed"}\n\n',
      audioEvent('not pcm'),
      'data: {"event_type":"interaction.failed"}\n\n',
    ]) {
      await expect(
        streamGeminiTts(
          options(),
          (event) => events.push(event),
          async () => response(payload)
        )
      ).rejects.toThrow();
    }
    expect(events).toEqual([]);
  });

  it('does not emit audio after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: GeminiTtsEvent[] = [];
    await streamGeminiTts(
      { ...options(), signal: controller.signal },
      (event) => events.push(event),
      async () => response(audioEvent(Buffer.from([0, 0]).toString('base64')))
    );
    expect(events).toEqual([]);
  });
});
