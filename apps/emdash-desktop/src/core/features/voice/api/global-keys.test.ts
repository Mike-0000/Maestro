import { describe, expect, it, vi } from 'vitest';
import {
  acceleratorFromCodes,
  acceleratorFromStored,
  acceleratorLabel,
  HoldComboTracker,
  holdComboFromCodes,
  holdComboKeycodes,
  holdComboLabel,
  KeyCaptureSession,
  parseHoldCombo,
} from './global-keys';
import { HOLD_DELAY_MS, HoldToTalkMachine, type HoldOutput } from './hold-to-talk';

describe('KeyCaptureSession', () => {
  it('records a single key on release', () => {
    const session = new KeyCaptureSession();
    expect(session.keyDown('NumLock')).toBeNull();
    expect(session.keyUp()).toEqual(['NumLock']);
  });

  it('records every key held together as one chord', () => {
    const session = new KeyCaptureSession();
    session.keyDown('ControlLeft');
    session.keyDown('AltLeft');
    session.keyDown('Space');
    session.keyDown('Space');
    expect(session.keyUp()).toEqual(['ControlLeft', 'AltLeft', 'Space']);
  });

  it('cancels on a lone Escape and ignores a stray key-up', () => {
    const session = new KeyCaptureSession();
    expect(session.keyUp()).toBeNull();
    expect(session.keyDown('Escape')).toBe('cancel');
  });
});

describe('acceleratorFromCodes', () => {
  it.each([
    [['NumLock'], 'Numlock'],
    [['ScrollLock'], 'Scrolllock'],
    [['F13'], 'F13'],
    [['Numpad5'], 'num5'],
    [['ControlLeft', 'AltLeft', 'Space'], 'Control+Alt+Space'],
    [['KeyK', 'ShiftRight', 'ControlRight'], 'Control+Shift+K'],
    [['MetaLeft', 'F2'], 'Super+F2'],
    [['AltLeft', 'Slash'], 'Alt+/'],
  ])('turns %j into %s', (codes, accelerator) => {
    expect(acceleratorFromCodes(codes)).toEqual({ ok: true, value: accelerator });
  });

  it.each([
    [['ControlRight']],
    [['ControlLeft', 'ShiftLeft']],
    [['KeyA']],
    [['ShiftLeft', 'KeyA']],
    [['Space']],
    [['ControlLeft', 'KeyA', 'KeyB']],
    [['Pause']],
  ])('rejects %j', (codes) => {
    expect(acceleratorFromCodes(codes).ok).toBe(false);
  });

  it('labels stored accelerators', () => {
    expect(acceleratorLabel('Control+Alt+Space')).toBe('Ctrl + Alt + Space');
    expect(acceleratorLabel('Numlock')).toBe('Num Lock');
    expect(acceleratorLabel('Super+num5')).toBe('Win + Numpad 5');
  });
});

describe('hold-to-talk combos', () => {
  it('stores single keys and chords with modifiers first', () => {
    expect(holdComboFromCodes(['NumLock'])).toEqual({ ok: true, value: 'NumLock' });
    expect(holdComboFromCodes(['ControlRight'])).toEqual({ ok: true, value: 'ControlRight' });
    expect(holdComboFromCodes(['F13', 'ControlLeft'])).toEqual({
      ok: true,
      value: 'ControlLeft+F13',
    });
  });

  it('rejects keys the system hook cannot see and oversized chords', () => {
    expect(holdComboFromCodes(['MediaPlayPause']).ok).toBe(false);
    expect(holdComboFromCodes(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE']).ok).toBe(false);
  });

  it('reads the values written by the old fixed list', () => {
    expect(parseHoldCombo('off')).toBeNull();
    expect(parseHoldCombo('right-ctrl')).toEqual(['ControlRight']);
    expect(holdComboKeycodes('right-ctrl')).toEqual([[3613]]);
    expect(holdComboKeycodes('right-alt')).toEqual([[3640]]);
    expect(holdComboLabel('right-alt')).toBe('Right Alt');
  });

  it('maps keys to hook key codes', () => {
    expect(holdComboKeycodes('NumLock')).toEqual([[69]]);
    expect(holdComboKeycodes('ControlLeft+F13')).toEqual([[29], [91]]);
    expect(holdComboKeycodes('NotAKey')).toBeNull();
    expect(holdComboLabel('ControlLeft+NumLock')).toBe('Left Ctrl + Num Lock');
  });
});

describe('HoldComboTracker', () => {
  function setup(combo: string) {
    vi.useFakeTimers();
    const outputs: HoldOutput[] = [];
    const machine = new HoldToTalkMachine((output) => outputs.push(output));
    const tracker = new HoldComboTracker(holdComboKeycodes(combo) ?? [], machine);
    return { tracker, outputs };
  }

  it('starts while a single key is held and stops on release', () => {
    const { tracker, outputs } = setup('NumLock');
    tracker.onKey({ type: 'down', keycode: 69 });
    tracker.onKey({ type: 'down', keycode: 69 }); // auto-repeat
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    tracker.onKey({ type: 'up', keycode: 69 });
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
  });

  it('needs every key of a chord and stops when any is released', () => {
    const { tracker, outputs } = setup('ControlLeft+F13');
    tracker.onKey({ type: 'down', keycode: 29 });
    vi.advanceTimersByTime(HOLD_DELAY_MS * 2);
    expect(outputs).toEqual([]);
    tracker.onKey({ type: 'down', keycode: 91 });
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    tracker.onKey({ type: 'up', keycode: 29 });
    tracker.onKey({ type: 'up', keycode: 91 });
    expect(outputs).toEqual([{ type: 'start', intent: 'command' }, { type: 'stop' }]);
  });

  it('treats other keys as typing and Shift as dictation', () => {
    const { tracker, outputs } = setup('NumLock');
    tracker.onKey({ type: 'down', keycode: 69 });
    tracker.onKey({ type: 'down', keycode: 30 }); // A
    vi.advanceTimersByTime(HOLD_DELAY_MS * 2);
    tracker.onKey({ type: 'up', keycode: 69 });
    expect(outputs).toEqual([]);

    tracker.onKey({ type: 'down', keycode: 69 });
    tracker.onKey({ type: 'down', keycode: 42 }); // Left Shift
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(outputs).toEqual([{ type: 'start', intent: 'dictation' }]);
    vi.useRealTimers();
  });
});

describe('acceleratorFromStored', () => {
  it.each([
    ['Scroll Lock', 'Scrolllock'],
    ['Ctrl + Alt + Space', 'Control+Alt+Space'],
    ['Win + Numpad 5', 'Super+num5'],
    ['Ctrl + Numpad +', 'Control+numadd'],
    ['Control+Alt+Space', 'Control+Alt+Space'],
    ['Scrolllock', 'Scrolllock'],
    ['  ', ''],
  ])('turns %j into %j', (stored, accelerator) => {
    expect(acceleratorFromStored(stored)).toBe(accelerator);
  });
});
