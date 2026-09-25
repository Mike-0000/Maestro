import type { Secret } from '@emdash/shared';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_AUDIO_BYTES = 24_000 * 2 * 45;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

export type GeminiTtsEvent = { type: 'chunk'; pcm: string } | { type: 'done' };

/** Fetches headerless 24 kHz PCM from Gemini's Interactions streaming API. No text or key is logged. */
export async function streamGeminiTts(
  options: {
    key: Secret<string>;
    model: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts';
    voice: string;
    text: string;
    signal: AbortSignal;
  },
  emit: (event: GeminiTtsEvent) => void,
  request: typeof fetch = fetch
): Promise<void> {
  const response = await request(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': options.key.expose(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model,
      input: [{ type: 'user_input', content: [{ type: 'text', text: options.text }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24_000 },
      generation_config: { speech_config: [{ voice: options.voice }] },
      stream: true,
    }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok || !response.body) throw new Error(`Gemini TTS failed (${response.status}).`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let audioBytes = 0;
  let receivedAudio = false;
  const consume = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event: unknown = JSON.parse(data);
    if (!event || typeof event !== 'object') return;
    const envelope = event as { event_type?: unknown; delta?: { type?: unknown; data?: unknown } };
    if (envelope.event_type === 'interaction.failed' || envelope.event_type === 'error') {
      throw new Error('Gemini TTS generation failed.');
    }
    if (envelope.event_type !== 'step.delta' || envelope.delta?.type !== 'audio') return;
    if (typeof envelope.delta.data !== 'string') throw new Error('Invalid Gemini TTS audio.');
    const pcm = envelope.delta.data;
    const bytes = Buffer.from(pcm, 'base64');
    if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== pcm) {
      throw new Error('Invalid Gemini TTS PCM chunk.');
    }
    audioBytes += bytes.length;
    if (audioBytes > MAX_AUDIO_BYTES) throw new Error('Gemini TTS audio exceeded the limit.');
    receivedAudio = true;
    if (!options.signal.aborted) emit({ type: 'chunk', pcm });
  };

  try {
    while (!options.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = (pending + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      if (pending.length > MAX_EVENT_BYTES) throw new Error('Gemini TTS event exceeded the limit.');
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        consume(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        boundary = pending.indexOf('\n\n');
      }
    }
    pending = (pending + decoder.decode()).replaceAll('\r\n', '\n');
    if (pending.trim() && !options.signal.aborted) consume(pending);
    if (!options.signal.aborted) {
      if (!receivedAudio) throw new Error('Gemini TTS returned no audio.');
      emit({ type: 'done' });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
