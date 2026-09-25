import type { Secret } from '@emdash/shared';
import {
  failFromResponse,
  isConnectionFailure,
  requestSignal,
  SttEngineError,
  vocabularyPrompt,
  wavBlob,
  type SttEngine,
  type SttRequest,
} from './engine';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'gpt-4o-transcribe';

/** OpenAI speech-to-text (batch). Vocabulary is passed as the transcription prompt. */
export class OpenAiSttEngine implements SttEngine {
  readonly id = 'openai' as const;

  constructor(private readonly apiKey: () => Promise<Secret<string> | null>) {}

  async transcribe(request: SttRequest): Promise<string> {
    const key = await this.apiKey();
    if (!key)
      throw new SttEngineError('not-configured', 'Add an OpenAI API key in Chorus settings.');

    const form = new FormData();
    form.append('file', wavBlob(request.audio), 'utterance.wav');
    form.append('model', MODEL);
    form.append('response_format', 'json');
    if (request.language) form.append('language', request.language);
    const prompt = vocabularyPrompt(request.vocabulary);
    if (prompt) form.append('prompt', `Developer voice commands. Names: ${prompt}.`);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.expose()}` },
        body: form,
        signal: requestSignal(request.signal),
      });
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new SttEngineError('unreachable', 'Could not reach OpenAI. Check your connection.');
      }
      throw error;
    }
    if (!response.ok) await failFromResponse('OpenAI', response);
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === 'string' ? body.text.trim() : '';
  }
}
