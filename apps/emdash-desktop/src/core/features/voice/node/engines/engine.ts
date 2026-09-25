import type { SttEngineId, VoiceError } from '../../api/contract';

export type SttRequest = {
  /** 16 kHz mono 16-bit PCM WAV. */
  readonly audio: Uint8Array;
  /** Words the recognizer should favour: agent names, branches, project vocabulary. */
  readonly vocabulary: readonly string[];
  /** BCP-47 language, e.g. "en". */
  readonly language: string;
  readonly signal?: AbortSignal;
};

export interface SttEngine {
  readonly id: SttEngineId;
  transcribe(request: SttRequest): Promise<string>;
}

export class SttEngineError extends Error {
  constructor(
    readonly kind: VoiceError['type'],
    message: string
  ) {
    super(message);
    this.name = 'SttEngineError';
  }
}

export const STT_TIMEOUT_MS = 20_000;

export function wavBlob(audio: Uint8Array): Blob {
  // Copy into a plain ArrayBuffer so the Blob never aliases a pooled/shared buffer.
  return new Blob([audio.slice().buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** Joins vocabulary into a Whisper-style prompt, capped to stay well inside prompt limits. */
export function vocabularyPrompt(vocabulary: readonly string[], maxChars = 600): string {
  const unique = [...new Set(vocabulary.map((word) => word.trim()).filter(Boolean))];
  let prompt = '';
  for (const word of unique) {
    const next = prompt ? `${prompt}, ${word}` : word;
    if (next.length > maxChars) break;
    prompt = next;
  }
  return prompt;
}

export async function failFromResponse(engine: string, response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    throw new SttEngineError('not-configured', `${engine} rejected the API key (${response.status}).`);
  }
  throw new SttEngineError(
    'engine-failed',
    `${engine} transcription failed (${response.status})${detail ? `: ${detail}` : ''}`
  );
}

export function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(STT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}
