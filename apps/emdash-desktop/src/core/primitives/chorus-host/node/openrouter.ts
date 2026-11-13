import type { Secret } from '@emdash/shared';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Statuses another try may get past: rate limited, or a gateway that failed in passing. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503]);
/** The wait before another try when the answer names none. */
const DEFAULT_RETRY_WAIT_MS = 500;
/** The longest wait before another try, whatever Retry-After asks: a voice turn is waiting. */
const MAX_RETRY_WAIT_MS = 2_000;
/** How much of the upstream reason an error keeps. */
const DETAIL_CHARS = 200;

export class OpenRouterError extends Error {
  constructor(
    readonly kind: 'rejected-key' | 'no-credits' | 'rate-limited' | 'unreachable' | 'api-error',
    message: string,
    readonly status?: number,
    /** Set when another try may get through: how long to wait before it. */
    readonly retryInMs?: number
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Retry-After as a wait in milliseconds (seconds or an HTTP date), capped; a default without. */
function retryWait(header: string | null): number {
  if (!header) return DEFAULT_RETRY_WAIT_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (Number.isNaN(ms)) return DEFAULT_RETRY_WAIT_MS;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
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
 * OpenRouter speech engine so a single key can power everything. Main process only. With
 * `retries`, a rate limit, a passing gateway error or a dropped connection is tried again after
 * the wait the answer asks for (Retry-After, capped at two seconds); errors keep the upstream
 * reason in their message.
 */
export async function openRouterChat(
  key: Secret<string>,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number; retries?: number } = {}
): Promise<OpenRouterResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openRouterChatOnce(key, body, options);
    } catch (error) {
      const retryIn = error instanceof OpenRouterError ? error.retryInMs : undefined;
      if (retryIn === undefined || attempt >= (options.retries ?? 0) || options.signal?.aborted) {
        throw error;
      }
      await wait(retryIn, options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
}

async function openRouterChatOnce(
  key: Secret<string>,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number }
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
    if (timedOut) throw new OpenRouterError('unreachable', 'OpenRouter took too long to answer.');
    // A connection that failed or dropped (not one the caller called off) may get through again.
    const aborted = error instanceof Error && error.name === 'AbortError';
    const reason = networkReason(error);
    throw new OpenRouterError(
      'unreachable',
      `Could not reach OpenRouter${reason ? ` (${reason})` : ''}.`,
      undefined,
      aborted ? undefined : DEFAULT_RETRY_WAIT_MS
    );
  }
  const text = await response.text();
  let parsed: OpenRouterResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as OpenRouterResponse) : {};
  } catch {
    // Non-JSON error bodies are reported by status below.
  }
  const detail = (parsed.error?.message ?? text).trim().slice(0, DETAIL_CHARS);
  const retryIn = RETRY_STATUSES.has(response.status)
    ? retryWait(response.headers.get('retry-after'))
    : undefined;
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
      `OpenRouter is rate limited right now${detail ? `: ${detail}` : '.'}`,
      response.status,
      retryIn
    );
  }
  if (!response.ok || parsed.error) {
    throw new OpenRouterError(
      'api-error',
      `OpenRouter error ${response.status}: ${detail}`,
      response.status,
      retryIn
    );
  }
  return parsed;
}

/** Why a request never got an answer, from fetch's error and its cause: "ECONNRESET". */
function networkReason(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : null;
  if (typeof cause?.code === 'string') return cause.code;
  return error instanceof Error && error.message !== 'fetch failed' ? error.message : '';
}
