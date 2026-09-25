import type { Secret } from '@emdash/shared';
import {
  JEV_MODEL,
  JEV_OPENROUTER_MODEL,
  jevResponseSchema,
  type JevAnswers,
  type JevQuestions,
} from '../api/jev';

export type JevVia = 'openrouter' | 'typesafe';

/** The System One endpoint and model for each source (both speak the same schema). */
export function jevEndpoint(via: JevVia): { url: string; model: string } {
  if (via === 'openrouter') {
    const base = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
      /\/+$/,
      ''
    );
    return { url: `${base}/systemone`, model: JEV_OPENROUTER_MODEL };
  }
  const base = (process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
  return { url: `${base}/v1/systemone`, model: JEV_MODEL };
}
/** Jev answers in ~50 ms; anything slower than this is not worth waiting for in a voice loop. */
const JEV_TIMEOUT_MS = 4_000;

export class JevRequestError extends Error {
  constructor(
    readonly kind: 'rejected-key' | 'no-credits' | 'rate-limited' | 'api-error',
    message: string
  ) {
    super(message);
    this.name = 'JevRequestError';
  }
}

/**
 * Minimal System One client (`POST .../systemone`) for TypeSafe or OpenRouter, which serve the
 * same schema. Raw fetch rather than an SDK: the API is one JSON call, and the key must stay in
 * the main process.
 */
export async function evaluateWithJev(
  key: Secret<string>,
  state: unknown,
  questions: JevQuestions,
  options: { via?: JevVia; baseUrl?: string; signal?: AbortSignal } = {}
): Promise<{ answers: JevAnswers; model: string; costUsd?: number }> {
  const via = options.via ?? 'typesafe';
  const endpoint = jevEndpoint(via);
  const url = options.baseUrl
    ? `${options.baseUrl.replace(/\/+$/, '')}${via === 'openrouter' ? '/systemone' : '/v1/systemone'}`
    : endpoint.url;
  const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.expose()}`,
        'content-type': 'application/json',
        ...(via === 'openrouter' ? { 'X-OpenRouter-Title': 'Chorus' } : {}),
      },
      body: JSON.stringify({ model: endpoint.model, state, questions }),
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new JevRequestError('api-error', `The Jev request ${reason}.`);
  }
  const keyName = via === 'openrouter' ? 'OpenRouter' : 'TypeSafe';
  if (response.status === 401 || response.status === 403) {
    throw new JevRequestError('rejected-key', `The ${keyName} API key was rejected.`);
  }
  if (response.status === 402) {
    throw new JevRequestError('no-credits', `${keyName} needs more credits for Jev.`);
  }
  if (response.status === 429) {
    throw new JevRequestError('rate-limited', 'Jev is rate limited right now.');
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new JevRequestError('api-error', `Jev returned ${response.status}: ${detail}`);
  }
  const parsed = jevResponseSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new JevRequestError('api-error', 'Jev returned an unexpected response.');
  const cost = parsed.data.usage?.cost;
  return {
    answers: parsed.data.answers,
    model: parsed.data.model,
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}
