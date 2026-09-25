/**
 * Hold-to-talk as a small state machine shared by the global keyboard hook (main process) and
 * testable on its own. Holding the talk key for HOLD_DELAY_MS starts listening; releasing it stops.
 * Pressing any other key first means the user is typing a chord (Ctrl+C), so nothing starts; a key
 * pressed after listening started cancels the utterance. Shift held at the start means dictation.
 */

export const HOLD_DELAY_MS = 180;

export type HoldOutput =
  | { type: 'start'; intent: 'command' | 'dictation' }
  | { type: 'stop' }
  | { type: 'cancel' };

export type HoldTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export class HoldToTalkMachine {
  private state: 'idle' | 'pending' | 'listening' | 'chord' = 'idle';
  private timer: unknown = null;
  private shift = false;

  constructor(
    private readonly emit: (output: HoldOutput) => void,
    private readonly timers: HoldTimers = {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  ) {}

  /** The talk key went down (auto-repeat keydowns are ignored). */
  talkDown(shift: boolean): void {
    if (this.state !== 'idle') return;
    this.state = 'pending';
    this.shift = shift;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.state !== 'pending') return;
      this.state = 'listening';
      this.emit({ type: 'start', intent: this.shift ? 'dictation' : 'command' });
    }, HOLD_DELAY_MS);
  }

  talkUp(): void {
    const previous = this.state;
    this.reset();
    if (previous === 'listening') this.emit({ type: 'stop' });
  }

  /** Any other key went down while the talk key is held. Shift only switches to dictation. */
  otherDown(isShift: boolean): void {
    if (isShift) {
      if (this.state === 'pending') this.shift = true;
      return;
    }
    if (this.state === 'pending') {
      this.clearTimer();
      this.state = 'chord';
    } else if (this.state === 'listening') {
      this.state = 'chord';
      this.emit({ type: 'cancel' });
    }
  }

  reset(): void {
    this.clearTimer();
    this.state = 'idle';
    this.shift = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
