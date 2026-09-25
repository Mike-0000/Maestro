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

/**
 * Local, offline transcription through a whisper.cpp `whisper-server` (its `/inference` endpoint).
 * Nothing leaves the machine. The server is started by the user (see docs/chorus/voice.md).
 */
export class WhisperLocalSttEngine implements SttEngine {
  readonly id = 'whisper-local' as const;

  constructor(private readonly baseUrl: () => Promise<string>) {}

  async transcribe(request: SttRequest): Promise<string> {
    const base = (await this.baseUrl()).replace(/\/+$/, '');
    const form = new FormData();
    form.append('file', wavBlob(request.audio), 'utterance.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    if (request.language) form.append('language', request.language);
    const prompt = vocabularyPrompt(request.vocabulary);
    if (prompt) form.append('prompt', prompt);

    let response: Response;
    try {
      response = await fetch(`${base}/inference`, {
        method: 'POST',
        body: form,
        signal: requestSignal(request.signal),
      });
    } catch (error) {
      if (isConnectionFailure(error)) {
        throw new SttEngineError(
          'unreachable',
          `No whisper-server is answering at ${base}. Start it or switch engines.`
        );
      }
      throw error;
    }
    if (!response.ok) await failFromResponse('whisper-server', response);
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === 'string' ? body.text.trim() : '';
  }
}
