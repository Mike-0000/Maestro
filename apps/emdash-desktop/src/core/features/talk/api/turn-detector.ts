/**
 * Where the developer starts and stops speaking, from the microphone's level. Grok Voice's own
 * turn detection always answers by itself, so the line takes turns by hand and finds them here:
 * speech starts once the level stays well above the room's noise floor for a moment, and stops
 * after a pause long enough to be the end of a sentence rather than a breath.
 */

export type TurnEdge = 'start' | 'stop';

export type TurnDetectorOptions = {
  /** Loud this long before it counts as speech, so a click or a cough is not a turn. */
  readonly startMs: number;
  /** Quiet this long after speech before the turn ends. */
  readonly stopMs: number;
  /** One stretch of speech never runs longer: a radio or a meeting is cut into turns. */
  readonly maxMs: number;
  /** Speech is at least this loud (RMS of samples in -1..1), however quiet the room is. */
  readonly minLevel: number;
  /** And this many times the noise floor. */
  readonly floorRatio: number;
};

export const DEFAULT_TURN_DETECTOR: TurnDetectorOptions = {
  startMs: 100,
  // A pause to think mid-sentence is not the end of a turn: with the microphone open, each
  // stretch that ends here is answered.
  stopMs: 1_200,
  maxMs: 60_000,
  minLevel: 0.02,
  floorRatio: 3,
};

/** Where the noise floor starts, and the least it falls to. */
const INITIAL_FLOOR = 0.01;
const MIN_FLOOR = 0.002;
/** How fast the floor follows a quiet room: about a second to settle. */
const FLOOR_TIME_MS = 1_000;

export class TurnDetector {
  private floor = INITIAL_FLOOR;
  private inSpeech = false;
  private loudMs = 0;
  private quietMs = 0;
  private speechMs = 0;

  constructor(private readonly options: TurnDetectorOptions = DEFAULT_TURN_DETECTOR) {}

  get speaking(): boolean {
    return this.inSpeech;
  }

  /** Feeds one chunk's level and length; returns where a turn started or stopped, if it did. */
  push(level: number, durationMs: number): TurnEdge | null {
    const { startMs, stopMs, maxMs, minLevel, floorRatio } = this.options;
    const loud = level > Math.max(minLevel, this.floor * floorRatio);
    if (!loud) {
      // Only quiet moves the floor, so a long sentence does not raise it.
      const weight = Math.min(1, durationMs / FLOOR_TIME_MS);
      this.floor = Math.max(MIN_FLOOR, this.floor + (level - this.floor) * weight);
    }
    if (!this.inSpeech) {
      this.loudMs = loud ? this.loudMs + durationMs : 0;
      if (this.loudMs < startMs) return null;
      this.inSpeech = true;
      this.quietMs = 0;
      this.speechMs = this.loudMs;
      return 'start';
    }
    this.speechMs += durationMs;
    this.quietMs = loud ? 0 : this.quietMs + durationMs;
    if (this.quietMs < stopMs && this.speechMs < maxMs) return null;
    this.reset();
    return 'stop';
  }

  /** Forgets the turn in progress; the noise floor it learned is kept. */
  reset(): void {
    this.inSpeech = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.speechMs = 0;
  }
}
