import type { Secret } from '@emdash/shared';
import { openRouterChat, OpenRouterError } from '@core/primitives/chorus-host/node/openrouter';
import { SttEngineError, STT_TIMEOUT_MS, type SttEngine, type SttRequest } from './engine';

const INSTRUCTIONS =
  'You are a speech-to-text engine. Transcribe the audio exactly as spoken, in the spoken language. ' +
  'Output only the transcript: no quotes, labels, commentary, or translation. ' +
  'If nothing intelligible is said, output nothing.';

/**
 * Speech-to-text through an OpenRouter audio-input model (chat completions with `input_audio`),
 * so one OpenRouter key can run voice and the conductor.
 */
export class OpenRouterSttEngine implements SttEngine {
  readonly id = 'openrouter' as const;

  constructor(
    private readonly apiKey: () => Promise<Secret<string> | null>,
    private readonly model: () => Promise<string>
  ) {}

  async transcribe(request: SttRequest): Promise<string> {
    const key = await this.apiKey();
    if (!key) {
      throw new SttEngineError(
        'not-configured',
        'Add an OpenRouter API key in Settings → Voice & Conductor.'
      );
    }
    const vocabulary = [...new Set(request.vocabulary.map((word) => word.trim()).filter(Boolean))]
      .slice(0, 60)
      .join(', ');
    const hint = vocabulary ? ` Names that may be spoken: ${vocabulary}.` : '';
    let base64 = '';
    for (let i = 0; i < request.audio.length; i += 0x8000) {
      base64 += String.fromCharCode(...request.audio.subarray(i, i + 0x8000));
    }
    try {
      const response = await openRouterChat(
        key,
        {
          model: await this.model(),
          temperature: 0,
          max_tokens: 1024,
          messages: [
            { role: 'system', content: INSTRUCTIONS + hint },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Transcribe this audio${request.language ? ` (${request.language})` : ''}.`,
                },
                { type: 'input_audio', input_audio: { data: btoa(base64), format: 'wav' } },
              ],
            },
          ],
        },
        { signal: request.signal, timeoutMs: STT_TIMEOUT_MS }
      );
      const text = response.choices?.[0]?.message?.content ?? '';
      return text
        .trim()
        .replace(/^["“](.*)["”]$/s, '$1')
        .trim();
    } catch (error) {
      if (error instanceof OpenRouterError) {
        const kind =
          error.kind === 'rejected-key'
            ? 'not-configured'
            : error.kind === 'unreachable'
              ? 'unreachable'
              : 'engine-failed';
        throw new SttEngineError(kind, error.message);
      }
      throw error;
    }
  }
}
