import { STT_SAMPLE_RATE } from '../api/wav';

/** Transcribes 16 kHz mono samples; resolves '' when nothing was said. */
export type DecodeSamples = (samples: Float32Array) => Promise<string>;

const MS = STT_SAMPLE_RATE / 1000;
/** New audio needed before the open phrase is transcribed again. */
const STEP_SAMPLES = 240 * MS;
/** A pause this long closes the phrase: its text is final and its audio is dropped. */
const PAUSE_SAMPLES = 700 * MS;
/** A phrase nobody paused in is cut at its quietest recent moment once it is this long. */
const MAX_PHRASE_SAMPLES = 20_000 * MS;
/** Where that cut may fall: within this much of the end of the phrase. */
const CUT_SEARCH_SAMPLES = 6_000 * MS;
/** Audio kept in front of the next phrase, so its first sound is not clipped. */
const LEAD_IN_SAMPLES = 300 * MS;
/** Audio with no sound above the threshold is still transcribed once it is this long. */
const QUIET_CHECK_SAMPLES = 2_000 * MS;
const FRAME_SAMPLES = 30 * MS;
/** RMS of a frame that counts as sound. Low on purpose: quiet speech must never be dropped. */
const SOUND_RMS = 0.005;
/** Less audio than this cannot hold a word. */
const MIN_DECODE_SAMPLES = 200 * MS;

/**
 * Live dictation on top of a recognizer that only transcribes whole recordings (buffered
 * streaming). The phrase being spoken is transcribed again every few hundred milliseconds, so its
 * text grows and corrects itself on screen; a pause makes the phrase final and starts the next
 * one, which keeps each pass short however long the dictation runs.
 */
export class BufferedDictationStream {
  private readonly finals: string[] = [];
  private tail = '';
  private buffer = new Float32Array(STT_SAMPLE_RATE * 8);
  private length = 0;
  /** How much of the open phrase the last pass covered. */
  private decoded = 0;
  private running: Promise<void> | null = null;
  private closed = false;
  private failure: unknown = null;
  private lastEmitted = '';

  constructor(
    private readonly decode: DecodeSamples,
    private readonly onPartial: (text: string) => void
  ) {}

  /** Everything heard so far, including the phrase still being spoken. */
  get text(): string {
    return [...this.finals, this.tail].filter(Boolean).join(' ');
  }

  /** Appends 16 kHz mono signed 16-bit little-endian PCM. */
  push(pcm: Uint8Array): void {
    if (this.closed) return;
    const count = pcm.byteLength >> 1;
    this.reserve(count);
    const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
    for (let i = 0; i < count; i++)
      this.buffer[this.length + i] = view.getInt16(i * 2, true) / 32768;
    this.length += count;
    this.schedule();
  }

  /** Ends the audio and resolves with the final text. */
  async finish(): Promise<string> {
    this.closed = true;
    await this.running;
    if (this.failure) throw this.failure;
    if (this.length >= MIN_DECODE_SAMPLES && (this.tail || this.length > this.decoded)) {
      this.tail = (await this.decode(this.buffer.slice(0, this.length))).trim();
    }
    return this.text;
  }

  abort(): void {
    this.closed = true;
    this.length = 0;
  }

  private schedule(): void {
    if (this.running || this.closed || this.failure) return;
    if (this.length - this.decoded < STEP_SAMPLES) return;
    const heard = this.length;
    this.running = this.step()
      .catch((error: unknown) => {
        this.failure = error;
      })
      .finally(() => {
        this.running = null;
        // Only audio that arrived meanwhile needs another pass; a step that is waiting for a
        // pause must not run again until there is more to look at.
        if (this.length !== heard) this.schedule();
      });
  }

  private async step(): Promise<void> {
    const length = this.length;
    const heardNew = hasSound(this.buffer, this.decoded, length);
    if (!heardNew && this.decoded > 0) {
      if (!this.tail) {
        // Silence after silence: nothing to transcribe, keep only a lead-in.
        this.dropFront(Math.max(0, length - LEAD_IN_SAMPLES));
        this.decoded = this.length;
      } else if (length - lastSound(this.buffer, length) >= PAUSE_SAMPLES) {
        // A pause. One more pass, now with the silence that follows the last word.
        const final = (await this.decode(this.buffer.slice(0, length))).trim();
        if (this.closed) return;
        this.commit(final, Math.max(0, length - LEAD_IN_SAMPLES));
      }
      return;
    }
    if (!heardNew && length < QUIET_CHECK_SAMPLES) return;
    if (length >= MAX_PHRASE_SAMPLES) {
      const cut = quietestPoint(this.buffer, length - CUT_SEARCH_SAMPLES, length);
      const final = (await this.decode(this.buffer.slice(0, cut))).trim();
      if (this.closed) return;
      this.commit(final, cut);
      return;
    }
    const text = (await this.decode(this.buffer.slice(0, length))).trim();
    if (this.closed) return;
    this.tail = text;
    this.decoded = length;
    this.emit();
  }

  /** Makes `text` final for the first `samples` of the open phrase and starts the next one. */
  private commit(text: string, samples: number): void {
    if (text) this.finals.push(text);
    this.tail = '';
    this.dropFront(samples);
    this.decoded = 0;
    this.emit();
  }

  private emit(): void {
    const text = this.text;
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.onPartial(text);
  }

  private dropFront(samples: number): void {
    this.buffer.copyWithin(0, samples, this.length);
    this.length -= samples;
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    const grown = new Float32Array(Math.max(this.buffer.length * 2, this.length + extra));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }
}

function frameRms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

function hasSound(samples: Float32Array, from: number, to: number): boolean {
  for (let start = from; start < to; start += FRAME_SAMPLES) {
    if (frameRms(samples, start, Math.min(to, start + FRAME_SAMPLES)) > SOUND_RMS) return true;
  }
  return false;
}

/** The end of the last frame with sound in it, or 0 when there is none. */
function lastSound(samples: Float32Array, length: number): number {
  for (let end = length; end > 0; end -= FRAME_SAMPLES) {
    if (frameRms(samples, Math.max(0, end - FRAME_SAMPLES), end) > SOUND_RMS) return end;
  }
  return 0;
}

/** The middle of the quietest stretch between `from` and `to`: the least harmful place to cut. */
function quietestPoint(samples: Float32Array, from: number, to: number): number {
  const window = FRAME_SAMPLES * 4;
  let best = to;
  let bestLevel = Infinity;
  for (let start = Math.max(0, from); start + window <= to; start += FRAME_SAMPLES) {
    const level = frameRms(samples, start, start + window);
    if (level < bestLevel) {
      bestLevel = level;
      best = start + window / 2;
    }
  }
  return best;
}
