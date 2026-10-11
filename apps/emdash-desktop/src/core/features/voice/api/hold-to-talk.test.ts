import { describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_TAP_MS,
  HOLD_DELAY_MS,
  HoldToTalkMachine,
  LATCH_MAX_MS,
  type HoldOutput,
} from './hold-to-talk';

function setup() {
  vi.useFakeTimers();
  const outputs: HoldOutput[] = [];
  const machine = new HoldToTalkMachine((output) => outputs.push(output));
  return { machine, outputs };
}

describe('HoldToTalkMachine', () => {
  it('starts after the hold delay and stops on release', () => {
    const { machine, outputs } = setup();
    machine.talkDown(false);
    machine.talkDown(false); // auto-repeat
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    machine.talkUp();
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
  });

  it('reports a lone quick tap once no second tap followed, and never starts listening', () => {
    const { machine, outputs } = setup();
    machine.talkDown(false);
    vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
    machine.talkUp();
    expect(outputs).toEqual([]);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(outputs).toEqual([{ type: 'tap' }]);
  });

  it('lets chords through and cancels when typing starts mid-utterance', () => {
    const { machine, outputs } = setup();
    machine.talkDown(false);
    machine.otherDown(false); // Ctrl+C
    vi.advanceTimersByTime(500);
    machine.talkUp();
    expect(outputs).toEqual([]);

    machine.talkDown(false);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    machine.otherDown(false);
    machine.talkUp();
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'cancel' }]);
  });

  it('uses dictation when Shift is held at the start', () => {
    const { machine, outputs } = setup();
    machine.talkDown(false);
    machine.otherDown(true);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(outputs).toEqual([{ type: 'start', intent: 'dictation' }]);
    vi.useRealTimers();
  });

  function tap(machine: HoldToTalkMachine) {
    machine.talkDown(false);
    vi.advanceTimersByTime(40);
    machine.talkUp();
  }

  it('latches on a double tap and stops on the next tap without holding', () => {
    const { machine, outputs } = setup();
    tap(machine);
    vi.advanceTimersByTime(100);
    machine.talkDown(false);
    machine.talkDown(false); // auto-repeat
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }]);
    machine.talkUp();
    machine.otherDown(false); // typing while latched does not cancel
    vi.advanceTimersByTime(30_000);
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }]);

    machine.talkDown(false);
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
    machine.talkUp();
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(outputs).toHaveLength(2);
  });

  it('still holds to talk after a latched utterance ended', () => {
    const { machine, outputs } = setup();
    tap(machine);
    tap(machine);
    tap(machine);
    outputs.length = 0;
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    machine.talkDown(false);
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    machine.talkUp();
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
  });

  it('does not latch when the taps are too far apart or a key is typed between them', () => {
    const { machine, outputs } = setup();
    tap(machine);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    tap(machine);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    tap(machine);
    machine.otherDown(false);
    tap(machine);
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 1);
    // Three lone taps; the one a key was typed after was part of typing.
    expect(outputs).toEqual([{ type: 'tap' }, { type: 'tap' }, { type: 'tap' }]);
  });

  it('dictates when Shift is pressed between the taps and stops a forgotten latch', () => {
    const { machine, outputs } = setup();
    tap(machine);
    machine.otherDown(true);
    tap(machine);
    expect(outputs).toEqual([{ type: 'start', intent: 'dictation' }]);
    vi.advanceTimersByTime(LATCH_MAX_MS);
    expect(outputs).toEqual([{ type: 'start', intent: 'dictation' }, { type: 'stop' }]);
    vi.useRealTimers();
  });
});
