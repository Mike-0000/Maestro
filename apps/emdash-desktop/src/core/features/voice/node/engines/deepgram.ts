import type { Secret } from '@emdash/shared';
import {
  failFromResponse,
  isConnectionFailure,
  requestSignal,
  SttEngineError,
  type SttEngine,
  type SttRequest,
} from './engine';

const ENDPOINT = 'https://api.deepgram.com/v1/listen';
/** Nova-3 supports keyterm prompting, which biases recognition toward agent and project names. */
const MODEL = 'nova-3';
const MAX_KEYTERMS = 50;

export function deepgramUrl(request: Pick<SttRequest, 'language' | 'vocabulary'>): string {
  const params = new URLSearchParams({ model: MODEL, smart_format: 'true', punctuate: 'true' });
  if (request.language) params.set('language', request.language);
  const keyterms = [...new Set(request.vocabulary.map((word) => word.trim()).filter(Boolean))];
  for (const term of keyterms.slice(0, MAX_KEYTERMS)) params.append('keyterm', term);
  return `${ENDPOINT}?${params.toString()}`;
}

type DeepgramResponse = {
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
};

/** Deepgram prerecorded transcription. */
export class DeepgramSttEngine implements SttEngine {
  readonly id = 'deepgram' as const;

  constructor(private readonly apiKey: () => Promise<Secret<string> | null>) {}

  async transcribe(request: SttRequest): Promise<string> {
    const key = await this.apiKey();
    if (!key)
      throw new SttEngineError(
        'not-configured',
        'Add a Deepgram API key in Settings → Voice & Conductor.'
      );

    let response: Response;
    try {
      response = await fetch(deepgramUrl(request), {
        method: 'POST',
        headers: { Authorization: `Token ${key.expose()}`, 'Content-Type': 'audio/wav' },
        body: request.audio.slice(),
        signal: requestSignal(request.signal),
      });
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new SttEngineError('unreachable', 'Could not reach Deepgram. Check your connection.');
      }
      throw error;
    }
    if (!response.ok) await failFromResponse('Deepgram', response);
    const body = (await response.json()) as DeepgramResponse;
    return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
  }
}
