import { STT_SAMPLE_RATE } from '../api/wav';
import { BufferedDictationStream, type DecodeSamples } from './buffered-dictation';

/** Captures shorter than this are transcribed as one clip: fast already, and most accurate. */
export const CHUNKING_MIN_MS = 15_000;
/** Fewer words per second of audio than this means the chunked text is probably broken. */
const MIN_WORDS_PER_SECOND = 0.25;
/** A silent stretch this long is a pause between phrases; it matches the dictation stream's. */
const PAUSE_BYTES = 2 * 0.72 * STT_SAMPLE_RATE;
const FRAME_BYTES = 2 * 0.03 * STT_SAMPLE_RATE;
const SOUND_RMS = 0.005;

/**
 * A command capture transcribed on this computer. Short captures are kept and transcribed whole
 * on release. Once a capture passes `CHUNKING_MIN_MS`, the audio so far moves into a buffered
 * stream that transcribes finished phrases (split at pauses) while the key is still held, so only
 * the last phrase is left at release. If any chunk failed or the text looks broken, the whole
 * clip is transcribed instead.
 */
export class LocalCommandStream {
  private all: Uint8Array[] = [];
  /** Audio the chunked stream has not been given yet. */
  private unfed: Uint8Array[] = [];
  private bytes = 0;
  private chunked: BufferedDictationStream | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;
  private aborted = false;

  constructor(
    private readonly decode: DecodeSamples,
    private readonly chunkingMinMs: number = CHUNKING_MIN_MS
  ) {}

  /** Appends 16 kHz mono signed 16-bit little-endian PCM. */
  push(pcm: Uint8Array): void {
    if (this.closed) return;
    // The caller may reuse its buffer.
    const copy = pcm.slice();
    this.all.push(copy);
    this.bytes += copy.byteLength;
    if (!this.chunked && (this.bytes / 2 / STT_SAMPLE_RATE) * 1000 >= this.chunkingMinMs) {
      this.chunked = new BufferedDictationStream(this.decode, () => {});
      this.unfed = [...this.all];
    } else if (this.chunked) {
      this.unfed.push(copy);
    }
    if (this.chunked) this.pumping ??= this.pump();
  }

  /**
   * Hands audio to the chunked stream in the pieces real time would have: a phrase, then the
   * pause after it, waiting for each pass to finish. The audio recorded before chunking began
   * would otherwise arrive at once as one long phrase.
   */
  private async pump(): Promise<void> {
    const chunked = this.chunked;
    try {
      while (chunked && !this.aborted && this.unfed.length > 0) {
        const rest = concat(this.unfed);
        const take = nextSliceBytes(rest);
        this.unfed = take < rest.byteLength ? [rest.subarray(take)] : [];
        chunked.push(rest.subarray(0, take));
        await chunked.idle();
      }
    } finally {
      this.pumping = null;
    }
  }

  get usedChunks(): boolean {
    return this.chunked !== null;
  }

  async finish(): Promise<string> {
    this.closed = true;
    const chunked = this.chunked;
    if (chunked) {
      try {
        while (this.pumping) await this.pumping;
        const text = (await chunked.finish()).trim();
        const seconds = this.bytes / 2 / STT_SAMPLE_RATE;
        if (text.split(/\s+/).length >= seconds * MIN_WORDS_PER_SECOND) return text;
      } catch {
        // Fall through to a full pass.
      }
    }
    return (await this.decode(this.wholeClip())).trim();
  }

  abort(): void {
    this.closed = true;
    this.aborted = true;
    this.chunked?.abort();
    this.all = [];
    this.unfed = [];
    this.bytes = 0;
  }

  private wholeClip(): Float32Array {
    const samples = new Float32Array(this.bytes >> 1);
    let at = 0;
    for (const piece of this.all) {
      const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength & ~1);
      for (let i = 0; i < view.byteLength; i += 2) samples[at++] = view.getInt16(i, true) / 32768;
    }
    return samples;
  }
}

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1 && pieces[0]) return pieces[0];
  const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.byteLength, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}

function frameHasSound(pcm: Uint8Array, from: number): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const end = Math.min(pcm.byteLength & ~1, from + FRAME_BYTES);
  let sum = 0;
  for (let i = from; i + 1 < end; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, (end - from) / 2)) > SOUND_RMS;
}

/**
 * How many bytes to hand over next: the leading pause if the audio starts with one, otherwise the
 * speech up to the next pause, or everything when there is no pause in it.
 */
function nextSliceBytes(pcm: Uint8Array): number {
  const total = pcm.byteLength & ~1 || pcm.byteLength;
  const startsSilent = !frameHasSound(pcm, 0);
  let runStart = -1;
  for (let at = 0; at < total; at += FRAME_BYTES) {
    const silent = !frameHasSound(pcm, at);
    if (startsSilent) {
      if (!silent) return at > 0 ? at : total;
    } else if (silent) {
      if (runStart < 0) runStart = at;
      if (at + FRAME_BYTES - runStart >= PAUSE_BYTES) return runStart;
    } else {
      runStart = -1;
    }
  }
  return total;
}
