import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MAX_AUDIO_BYTES = 24_000 * 2 * 45;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

export const VERTEX_TTS_MODELS = {
  'vertex-gemini-flash': 'gemini-3.8-flash-tts',
  'vertex-gemini-flash-lite': 'gemini-3.8-flash-lite-tts',
} as const;
export type VertexTtsModel = (typeof VERTEX_TTS_MODELS)[keyof typeof VERTEX_TTS_MODELS];

export type VertexTtsEvent = { type: 'chunk'; pcm: string; sampleRate: number } | { type: 'done' };

/** Where gcloud keeps application default credentials (`gcloud auth application-default login`). */
export function adcPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const configDir =
    env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32' && env.APPDATA
      ? join(env.APPDATA, 'gcloud')
      : join(homedir(), '.config', 'gcloud'));
  return join(configDir, 'application_default_credentials.json');
}

type AuthorizedUser = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
};

/**
 * Google Cloud sign-in for Vertex AI speech, from the developer's own gcloud application default
 * credentials. Custom voices made with voice design live in that Cloud project, so only these
 * credentials can speak with them. Access tokens are cached until shortly before they expire;
 * nothing here is logged.
 */
export class VertexAuth {
  private cached: { refreshToken: string; token: string; expiresAt: number } | null = null;

  constructor(
    private readonly path: () => string = () => adcPath(),
    private readonly request: typeof fetch = fetch
  ) {}

  /** Returns null when no usable gcloud sign-in exists, so the caller falls back. */
  async credentials(): Promise<AuthorizedUser | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path(), 'utf8'));
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const adc = raw as Record<string, unknown>;
    if (adc.type !== 'authorized_user') return null;
    const { client_id, client_secret, refresh_token, quota_project_id } = adc;
    if (
      typeof client_id !== 'string' ||
      typeof client_secret !== 'string' ||
      typeof refresh_token !== 'string'
    ) {
      return null;
    }
    return {
      client_id,
      client_secret,
      refresh_token,
      quota_project_id: typeof quota_project_id === 'string' ? quota_project_id : undefined,
    };
  }

  async accessToken(adc: AuthorizedUser, signal: AbortSignal): Promise<string> {
    const cached = this.cached;
    if (cached && cached.refreshToken === adc.refresh_token && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    const response = await this.request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: adc.refresh_token,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      throw new Error(
        `Google sign-in failed (${response.status}); run gcloud auth application-default login.`
      );
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('Google sign-in returned no token.');
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.cached = {
      refreshToken: adc.refresh_token,
      token: body.access_token,
      expiresAt: Date.now() + Math.max(0, lifetime - 120) * 1000,
    };
    return body.access_token;
  }
}

/** Reads `rate` from `audio/l16; rate=24000; channels=1`; only mono 16-bit PCM is accepted. */
function pcmRate(mimeType: unknown): number {
  if (typeof mimeType !== 'string') throw new Error('Vertex TTS returned audio without a type.');
  const [mime = '', ...params] = mimeType.split(';').map((part) => part.trim().toLowerCase());
  if (mime !== 'audio/l16' && mime !== 'audio/pcm') {
    throw new Error(`Vertex TTS returned ${mime}, not PCM.`);
  }
  const values = new Map(
    params.map((param) => param.split('=').map((v) => v.trim()) as [string, string])
  );
  const rate = Number(values.get('rate') ?? 24_000);
  if (Number(values.get('channels') ?? 1) !== 1) throw new Error('Vertex TTS returned stereo.');
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48_000) {
    throw new Error('Vertex TTS returned an unsupported sample rate.');
  }
  return rate;
}

/**
 * Streams Gemini speech from Vertex AI (`streamGenerateContent`, server-sent events) in the
 * developer's Google Cloud project, which can speak with that project's custom `voice_…` ids.
 * Main process only; neither the token nor the text is logged.
 */
export async function streamVertexTts(
  options: {
    token: string;
    project: string;
    model: VertexTtsModel;
    voice: string;
    text: string;
    /** Delivery for the sentence ("calm and friendly"); blank sends none. */
    style?: string;
    signal: AbortSignal;
  },
  emit: (event: VertexTtsEvent) => void,
  request: typeof fetch = fetch
): Promise<void> {
  const project = encodeURIComponent(options.project);
  const style = options.style?.trim();
  const url =
    `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global` +
    `/publishers/google/models/${options.model}:streamGenerateContent?alt=sse`;
  const response = await request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      'x-goog-user-project': options.project,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: options.text, ...(style ? { speechMetadata: { style } } : {}) }],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { voice: options.voice } },
      },
    }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok || !response.body) {
    let reason = '';
    try {
      const body = (await response.json()) as { error?: { status?: unknown } };
      if (typeof body.error?.status === 'string') reason = ` ${body.error.status}`;
    } catch {}
    throw new Error(`Vertex TTS failed (${response.status}${reason}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let audioBytes = 0;
  let receivedAudio = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as {
      error?: unknown;
      candidates?: {
        content?: { parts?: { inlineData?: { mimeType?: unknown; data?: unknown } }[] };
      }[];
    };
    if (event.error) throw new Error('Vertex TTS generation failed.');
    for (const candidate of event.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        const inline = part.inlineData;
        if (!inline) continue;
        const sampleRate = pcmRate(inline.mimeType);
        if (typeof inline.data !== 'string') throw new Error('Invalid Vertex TTS audio.');
        const bytes = Buffer.from(inline.data, 'base64');
        if (!bytes.length || bytes.length % 2) throw new Error('Invalid Vertex TTS PCM chunk.');
        audioBytes += bytes.length;
        if (audioBytes > MAX_AUDIO_BYTES) throw new Error('Vertex TTS audio exceeded the limit.');
        receivedAudio = true;
        if (!options.signal.aborted) {
          emit({ type: 'chunk', pcm: bytes.toString('base64'), sampleRate });
        }
      }
    }
  };

  try {
    while (!options.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = (pending + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      if (pending.length > MAX_EVENT_BYTES) throw new Error('Vertex TTS event exceeded the limit.');
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.trim() && !options.signal.aborted) consume(pending.trim());
    if (!options.signal.aborted) {
      if (!receivedAudio) throw new Error('Vertex TTS returned no audio.');
      emit({ type: 'done' });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
