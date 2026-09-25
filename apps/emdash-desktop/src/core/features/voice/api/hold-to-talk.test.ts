import { describe, expect, it, vi } from 'vitest';
import { HOLD_DELAY_MS, HoldToTalkMachine, type HoldOutput } from './hold-to-talk';

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

  it('ignores a quick tap', () => {
    const { machine, outputs } = setup();
    machine.talkDown(false);
    vi.advanceTimersByTime(HOLD_DELAY_MS - 50);
    machine.talkUp();
    vi.advanceTimersByTime(500);
    expect(outputs).toEqual([]);
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
});
