/**
 * Hold-to-talk as a small state machine shared by the global keyboard hook (main process) and
 * testable on its own. Holding the talk key for HOLD_DELAY_MS starts listening; releasing it stops.
 * Pressing any other key first means the user is typing a chord (Ctrl+C), so nothing starts; a key
 * pressed after listening started cancels the utterance. Shift held at the start means dictation.
 *
 * A double tap latches instead: two quick taps start listening without holding the key, and one
 * more tap stops. Other keys do not cancel a latched utterance, since nothing is being held.
 *
 * A single tap that no second tap follows is reported as `tap`: it answers whatever is waiting
 * for a spoken reply, and starts dictation to the open agent when nothing is.
 */

export const HOLD_DELAY_MS = 180;
/** After a quick tap, a second press within this window latches listening on. */
export const DOUBLE_TAP_MS = 400;
/** A latched utterance left open (the user walked away) is stopped after this long. */
export const LATCH_MAX_MS = 5 * 60_000;

export type HoldOutput =
  | { type: 'start'; intent: 'command' | 'dictation' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'tap' };

export type HoldTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export class HoldToTalkMachine {
  /**
   * `tapped`: a quick tap was released and a second press would latch. `latched`: listening with
   * no key held. `ending`: the tap that stopped a latched utterance has not been released yet.
   */
  private state: 'idle' | 'pending' | 'listening' | 'chord' | 'tapped' | 'latched' | 'ending' =
    'idle';
  private timer: unknown = null;
  private shift = false;
  /** The press that latched is still down; its release must not count as the ending tap. */
  private latchKeyDown = false;

  constructor(
    private readonly emit: (output: HoldOutput) => void,
    private readonly timers: HoldTimers = {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  ) {}

  /** The talk key went down (auto-repeat keydowns are ignored). */
  talkDown(shift: boolean): void {
    if (this.state === 'tapped') {
      this.clearTimer();
      this.state = 'latched';
      this.latchKeyDown = true;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.reset();
        this.emit({ type: 'stop' });
      }, LATCH_MAX_MS);
      this.emit({ type: 'start', intent: this.shift || shift ? 'dictation' : 'command' });
      return;
    }
    if (this.state === 'latched') {
      if (this.latchKeyDown) return;
      this.clearTimer();
      this.state = 'ending';
      this.emit({ type: 'stop' });
      return;
    }
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
    if (this.state === 'latched') {
      this.latchKeyDown = false;
      return;
    }
    if (this.state === 'pending') {
      // A quick tap: wait briefly for the second tap of a double tap.
      this.clearTimer();
      this.state = 'tapped';
      this.timer = this.timers.set(() => {
        this.timer = null;
        if (this.state !== 'tapped') return;
        this.reset();
        this.emit({ type: 'tap' });
      }, DOUBLE_TAP_MS);
      return;
    }
    const previous = this.state;
    this.reset();
    if (previous === 'listening') this.emit({ type: 'stop' });
  }

  /** Any other key went down while the talk key is held. Shift only switches to dictation. */
  otherDown(isShift: boolean): void {
    if (isShift) {
      if (this.state === 'pending' || this.state === 'tapped') this.shift = true;
      return;
    }
    if (this.state === 'pending') {
      this.clearTimer();
      this.state = 'chord';
    } else if (this.state === 'listening') {
      this.state = 'chord';
      this.emit({ type: 'cancel' });
    } else if (this.state === 'tapped') {
      // Typing between the taps: this was not a double tap.
      this.reset();
    }
  }

  reset(): void {
    this.clearTimer();
    this.state = 'idle';
    this.shift = false;
    this.latchKeyDown = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
