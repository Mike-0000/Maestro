import type { Secret } from '@emdash/shared';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  constructor(
    readonly kind: 'rejected-key' | 'no-credits' | 'rate-limited' | 'unreachable' | 'api-error',
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export type OpenRouterResponse = {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: OpenRouterUsage;
  error?: { message?: string; code?: number };
};

/**
 * One OpenRouter chat completion (`POST /chat/completions`). Shared by the conductor and the
 * OpenRouter speech engine so a single key can power everything. Main process only.
 */
export async function openRouterChat(
  key: Secret<string>,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OpenRouterResponse> {
  const base = (process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.expose()}`,
        'content-type': 'application/json',
        'X-OpenRouter-Title': 'Chorus',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new OpenRouterError(
      'unreachable',
      timedOut ? 'OpenRouter took too long to answer.' : 'Could not reach OpenRouter.'
    );
  }
  const text = await response.text();
  let parsed: OpenRouterResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterResponse) : {};
  } catch {
    // Non-JSON error bodies are reported by status below.
  }
  const detail = parsed.error?.message ?? text.slice(0, 200);
  if (response.status === 401 || response.status === 403) {
    throw new OpenRouterError(
      'rejected-key',
      'The OpenRouter API key was rejected.',
      response.status
    );
  }
  if (response.status === 402) {
    throw new OpenRouterError('no-credits', 'OpenRouter needs more credits.', response.status);
  }
  if (response.status === 429) {
    throw new OpenRouterError(
      'rate-limited',
      'OpenRouter is rate limited right now.',
      response.status
    );
  }
  if (!response.ok || parsed.error) {
    throw new OpenRouterError(
      'api-error',
      `OpenRouter error ${response.status}: ${detail}`,
      response.status
    );
  }
  return parsed;
}
