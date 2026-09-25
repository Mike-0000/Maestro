import type { Secret } from '@emdash/shared';
import { STT_SAMPLE_RATE } from '../../api/wav';
import { SttEngineError } from './engine';

const STREAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const MAX_KEYTERMS = 50;
/** How long to wait for Deepgram's final results after the audio ends. */
const FINISH_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;

export function deepgramStreamUrl(options: { language: string; vocabulary: readonly string[] }) {
  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: String(STT_SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });
  if (options.language) params.set('language', options.language);
  const keyterms = [...new Set(options.vocabulary.map((word) => word.trim()).filter(Boolean))];
  for (const term of keyterms.slice(0, MAX_KEYTERMS)) params.append('keyterm', term);
  return `${STREAM_ENDPOINT}?${params.toString()}`;
}

type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
};

/**
 * Folds Deepgram live results into text: finalized segments accumulate; the latest interim result
 * is shown after them until it is finalized.
 */
export class TranscriptAccumulator {
  private finals: string[] = [];
  private interim = '';

  /** Applies one message; returns true when the visible text changed. */
  apply(message: DeepgramMessage): boolean {
    if (message.type !== 'Results') return false;
    const transcript = message.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
    const before = this.text;
    if (message.is_final) {
      if (transcript) this.finals.push(transcript);
      this.interim = '';
    } else {
      this.interim = transcript;
    }
    return this.text !== before;
  }

  /** Everything heard so far, including the unfinalized tail. */
  get text(): string {
    return [...this.finals, this.interim].filter(Boolean).join(' ');
  }

  /** Only finalized speech (the interim tail is dropped if Deepgram never finalized it). */
  get finalText(): string {
    return this.finals.length > 0 ? this.finals.join(' ') : this.interim;
  }
}

/**
 * One live transcription session. Audio arrives as 16 kHz PCM16 chunks while the user speaks;
 * partial text is reported as it forms, and `finish()` resolves with the final transcript.
 */
export class DeepgramStream {
  private readonly socket: WebSocket;
  private readonly accumulator = new TranscriptAccumulator();
  private readonly opened: Promise<void>;
  private readonly closed: Promise<void>;
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private failure: SttEngineError | null = null;

  constructor(
    key: Secret<string>,
    options: { language: string; vocabulary: readonly string[] },
    private readonly onPartial: (text: string) => void
  ) {
    // Browsers and Node's WebSocket cannot set headers; Deepgram accepts the key as a subprotocol.
    this.socket = new WebSocket(deepgramStreamUrl(options), ['token', key.expose()]);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SttEngineError('unreachable', 'Deepgram did not answer in time.')),
        CONNECT_TIMEOUT_MS
      );
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        for (const chunk of this.pending.splice(0)) this.socket.send(chunk);
        resolve();
      });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        this.failure = new SttEngineError('unreachable', 'Could not stream audio to Deepgram.');
        reject(this.failure);
      });
    });
    // Callers await finish(); an early connection failure is reported there.
    this.opened.catch(() => {});
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', () => resolve()));
    this.socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        if (this.accumulator.apply(JSON.parse(event.data) as DeepgramMessage)) {
          this.onPartial(this.accumulator.text);
        }
      } catch {
        // Ignore non-JSON keepalives.
      }
    });
  }

  push(pcm: Uint8Array<ArrayBuffer>): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(pcm);
    else if (this.socket.readyState === WebSocket.CONNECTING) this.pending.push(pcm);
  }

  /** Ends the audio and resolves with the final transcript. */
  async finish(): Promise<string> {
    await this.opened;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    await Promise.race([
      this.closed,
      new Promise((resolve) => setTimeout(resolve, FINISH_TIMEOUT_MS)),
    ]);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close();
    if (this.failure) throw this.failure;
    return this.accumulator.finalText;
  }

  abort(): void {
    this.pending = [];
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }
}
