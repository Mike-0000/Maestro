import type { Secret } from '@emdash/shared';
import { JEV_MODEL, jevResponseSchema, type JevAnswers, type JevQuestions } from '../api/jev';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** Jev answers in ~50 ms; anything slower than this is not worth waiting for in a voice loop. */
const JEV_TIMEOUT_MS = 4_000;

export class JevRequestError extends Error {
  constructor(
    readonly kind: 'rejected-key' | 'rate-limited' | 'api-error',
    message: string
  ) {
    super(message);
    this.name = 'JevRequestError';
  }
}

/**
 * Minimal client for TypeSafe's System One endpoint (`POST /v1/systemone`). Raw fetch rather than
 * the SDK: the API is one JSON call, and the key must stay in the main process.
 */
export async function evaluateWithJev(
  key: Secret<string>,
  state: unknown,
  questions: JevQuestions,
  options: { baseUrl?: string; signal?: AbortSignal } = {}
): Promise<{ answers: JevAnswers; model: string }> {
  const base = (options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ''
  );
  const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.expose()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new JevRequestError('api-error', `The Jev request ${reason}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new JevRequestError('rejected-key', 'The TypeSafe API key was rejected.');
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
  return { answers: parsed.data.answers, model: parsed.data.model };
}
