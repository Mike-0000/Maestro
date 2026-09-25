import type { Secret } from '@emdash/shared';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** OpenAI-compatible PCM is 24 kHz mono s16le unless the Content-Type says otherwise. */
const DEFAULT_SAMPLE_RATE = 24_000;
const MAX_AUDIO_SECONDS = 45;
/** Emit playable audio promptly instead of waiting for large network reads. */
const CHUNK_BYTES = 9600;

export const OPENROUTER_TTS_MODELS = {
  'openrouter-gemini-flash': 'google/gemini-3.8-flash-tts',
  'openrouter-gemini-flash-lite': 'google/gemini-3.8-flash-lite-tts',
} as const;
export type OpenRouterTtsModel = (typeof OPENROUTER_TTS_MODELS)[keyof typeof OPENROUTER_TTS_MODELS];

export type OpenRouterTtsEvent =
  | { type: 'chunk'; pcm: string; sampleRate: number }
  | { type: 'done' };

/** Reads `rate` and `channels` from `audio/pcm; rate=24000; channels=1`. */
export function parsePcmContentType(contentType: string | null): {
  sampleRate: number;
  channels: number;
} {
  const [mime = '', ...params] = (contentType ?? '').split(';').map((part) => part.trim());
  if (mime && mime.toLowerCase() !== 'audio/pcm' && mime.toLowerCase() !== 'audio/l16') {
    throw new Error(`OpenRouter TTS returned ${mime}, not PCM.`);
  }
  const values = new Map(
    params.map((param) => {
      const [name = '', value = ''] = param.split('=');
      return [name.trim().toLowerCase(), Number(value.trim())] as const;
    })
  );
  const sampleRate = values.get('rate') ?? DEFAULT_SAMPLE_RATE;
  const channels = values.get('channels') ?? 1;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48_000) {
    throw new Error('OpenRouter TTS returned an unsupported sample rate.');
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error('OpenRouter TTS returned an unsupported channel count.');
  }
  return { sampleRate, channels };
}

/** Averages interleaved s16le stereo frames into mono. */
function toMono(frames: Buffer, channels: number): Buffer {
  if (channels === 1) return frames;
  const mono = Buffer.alloc(frames.length / channels);
  for (let i = 0; i < mono.length / 2; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += frames.readInt16LE((i * channels + c) * 2);
    mono.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return mono;
}

/**
 * Streams Gemini speech through OpenRouter's OpenAI-compatible `POST /audio/speech`, so the
 * OpenRouter key that runs the conductor and STT can also speak replies. Main process only;
 * neither the key nor the text is logged.
 */
export async function streamOpenRouterTts(
  options: {
    key: Secret<string>;
    model: OpenRouterTtsModel;
    voice: string;
    text: string;
    signal: AbortSignal;
  },
  emit: (event: OpenRouterTtsEvent) => void,
  request: typeof fetch = fetch
): Promise<void> {
  const base = (process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const response = await request(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.key.expose()}`,
      'content-type': 'application/json',
      'X-OpenRouter-Title': 'Chorus',
    },
    body: JSON.stringify({
      model: options.model,
      input: options.text,
      voice: options.voice,
      response_format: 'pcm',
    }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter TTS failed (${response.status}).`);
  }
  const { sampleRate, channels } = parsePcmContentType(response.headers.get('content-type'));
  const frameBytes = 2 * channels;
  const maxBytes = sampleRate * frameBytes * MAX_AUDIO_SECONDS;
  const chunkBytes = CHUNK_BYTES * channels;

  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  let audioBytes = 0;
  let receivedAudio = false;
  const flush = (all: boolean) => {
    while (pending.length >= chunkBytes || (all && pending.length >= frameBytes)) {
      const take = all
        ? pending.length - (pending.length % frameBytes)
        : chunkBytes - (chunkBytes % frameBytes);
      const frames = pending.subarray(0, take);
      pending = pending.subarray(take);
      receivedAudio = true;
      if (!options.signal.aborted) {
        emit({ type: 'chunk', pcm: toMono(frames, channels).toString('base64'), sampleRate });
      }
    }
  };

  try {
    while (!options.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      audioBytes += value.byteLength;
      if (audioBytes > maxBytes) throw new Error('OpenRouter TTS audio exceeded the limit.');
      pending = Buffer.concat([pending, value]);
      flush(false);
    }
    if (options.signal.aborted) return;
    flush(true);
    if (!receivedAudio) throw new Error('OpenRouter TTS returned no audio.');
    emit({ type: 'done' });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
