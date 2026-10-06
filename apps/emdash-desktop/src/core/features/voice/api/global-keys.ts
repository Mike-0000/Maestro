/**
 * Global talk keys are recorded by listening for a key press instead of being picked from a list.
 * Keys are identified by their physical `KeyboardEvent.code`, then turned into what each OS
 * mechanism needs: an Electron accelerator for the toggle shortcut (`globalShortcut`), and
 * libuiohook key codes for hold-to-talk (the system key hook).
 */

export const HOLD_KEY_OFF = 'off';
/** A hold combo longer than this is almost certainly a mashed keyboard, not a chord. */
export const MAX_COMBO_KEYS = 4;

/** Values written by versions that offered a fixed list of hold keys. */
const LEGACY_HOLD_KEYS: Readonly<Record<string, string>> = {
  'right-ctrl': 'ControlRight',
  'right-alt': 'AltRight',
};

const MODIFIER_ACCELERATORS: Readonly<Record<string, string>> = {
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  MetaLeft: 'Super',
  MetaRight: 'Super',
};
const ACCELERATOR_MODIFIER_ORDER = ['Control', 'Alt', 'Shift', 'Super'];

/** Keys that type text or edit it: as a bare global shortcut they would break typing everywhere. */
const TYPING_KEY_ACCELERATORS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const OTHER_KEY_ACCELERATORS: Readonly<Record<string, string>> = {
  NumLock: 'Numlock',
  ScrollLock: 'Scrolllock',
  CapsLock: 'Capslock',
  PrintScreen: 'PrintScreen',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
};

function mainKeyAccelerator(code: string): { key: string; typing: boolean } | null {
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter?.[1]) return { key: letter[1], typing: true };
  const digit = /^Digit(\d)$/u.exec(code);
  if (digit?.[1]) return { key: digit[1], typing: true };
  const numpad = /^Numpad(\d)$/u.exec(code);
  if (numpad?.[1]) return { key: `num${numpad[1]}`, typing: false };
  if (/^F([1-9]|1\d|2[0-4])$/u.test(code)) return { key: code, typing: false };
  const typing = TYPING_KEY_ACCELERATORS[code];
  if (typing) return { key: typing, typing: true };
  const other = OTHER_KEY_ACCELERATORS[code];
  return other ? { key: other, typing: false } : null;
}

export type KeyComboResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Builds the Electron accelerator for the keys held during a recording: any modifiers plus exactly
 * one other key. Lock, function, numpad and media keys work alone; typing keys need Ctrl, Alt or
 * Win so the shortcut does not swallow ordinary typing.
 */
export function acceleratorFromCodes(codes: readonly string[]): KeyComboResult {
  const modifiers = new Set<string>();
  const mainCodes: string[] = [];
  for (const code of new Set(codes)) {
    const modifier = MODIFIER_ACCELERATORS[code];
    if (modifier) modifiers.add(modifier);
    else mainCodes.push(code);
  }
  const [mainCode] = mainCodes;
  if (mainCode === undefined) {
    return {
      ok: false,
      reason: 'A toggle shortcut needs one key besides Ctrl, Alt, Shift or Win.',
    };
  }
  if (mainCodes.length > 1) {
    return { ok: false, reason: 'Use modifier keys plus a single other key.' };
  }
  const main = mainKeyAccelerator(mainCode);
  if (!main) return { ok: false, reason: `${keyCodeLabel(mainCode)} cannot be a global shortcut.` };
  const strongModifier = modifiers.has('Control') || modifiers.has('Alt') || modifiers.has('Super');
  if (main.typing && !strongModifier) {
    return {
      ok: false,
      reason: `${keyCodeLabel(mainCode)} alone would stop that key from typing. Add Ctrl, Alt or Win.`,
    };
  }
  const ordered = ACCELERATOR_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return { ok: true, value: [...ordered, main.key].join('+') };
}

const ACCELERATOR_LABELS: Readonly<Record<string, string>> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  super: 'Win',
  meta: 'Win',
  return: 'Enter',
  numlock: 'Num Lock',
  scrolllock: 'Scroll Lock',
  capslock: 'Caps Lock',
  numadd: 'Numpad +',
  numsub: 'Numpad -',
  nummult: 'Numpad *',
  numdiv: 'Numpad /',
  numdec: 'Numpad .',
};

/** Human-readable form of a stored accelerator, e.g. `Control+Alt+Space` -> `Ctrl + Alt + Space`. */
export function acceleratorLabel(accelerator: string): string {
  return accelerator
    .trim()
    .split(/\+(?=.)/u)
    .map((token) => {
      const lower = token.toLowerCase();
      const numpad = /^num(\d)$/u.exec(lower);
      if (numpad?.[1]) return `Numpad ${numpad[1]}`;
      return ACCELERATOR_LABELS[lower] ?? token;
    })
    .join(' + ');
}

/**
 * libuiohook key codes per `KeyboardEvent.code`. Numpad keys report a second code while Num Lock
 * is off, so either one counts as that key.
 */
const HOOK_KEYCODES: Readonly<Record<string, readonly number[]>> = {
  Escape: [0x0001],
  Backspace: [0x000e],
  Tab: [0x000f],
  Enter: [0x001c],
  CapsLock: [0x003a],
  Space: [0x0039],
  PageUp: [0x0e49],
  PageDown: [0x0e51],
  End: [0x0e4f],
  Home: [0x0e47],
  ArrowLeft: [0xe04b],
  ArrowUp: [0xe048],
  ArrowRight: [0xe04d],
  ArrowDown: [0xe050],
  Insert: [0x0e52],
  Delete: [0x0e53],
  Digit1: [0x0002],
  Digit2: [0x0003],
  Digit3: [0x0004],
  Digit4: [0x0005],
  Digit5: [0x0006],
  Digit6: [0x0007],
  Digit7: [0x0008],
  Digit8: [0x0009],
  Digit9: [0x000a],
  Digit0: [0x000b],
  KeyA: [0x001e],
  KeyB: [0x0030],
  KeyC: [0x002e],
  KeyD: [0x0020],
  KeyE: [0x0012],
  KeyF: [0x0021],
  KeyG: [0x0022],
  KeyH: [0x0023],
  KeyI: [0x0017],
  KeyJ: [0x0024],
  KeyK: [0x0025],
  KeyL: [0x0026],
  KeyM: [0x0032],
  KeyN: [0x0031],
  KeyO: [0x0018],
  KeyP: [0x0019],
  KeyQ: [0x0010],
  KeyR: [0x0013],
  KeyS: [0x001f],
  KeyT: [0x0014],
  KeyU: [0x0016],
  KeyV: [0x002f],
  KeyW: [0x0011],
  KeyX: [0x002d],
  KeyY: [0x0015],
  KeyZ: [0x002c],
  Numpad0: [0x0052, 0xee52],
  Numpad1: [0x004f, 0xee4f],
  Numpad2: [0x0050, 0xee50],
  Numpad3: [0x0051, 0xee51],
  Numpad4: [0x004b, 0xee4b],
  Numpad5: [0x004c],
  Numpad6: [0x004d, 0xee4d],
  Numpad7: [0x0047, 0xee47],
  Numpad8: [0x0048, 0xee48],
  Numpad9: [0x0049, 0xee49],
  NumpadMultiply: [0x0037],
  NumpadAdd: [0x004e],
  NumpadSubtract: [0x004a],
  NumpadDecimal: [0x0053, 0xee53],
  NumpadDivide: [0x0e35],
  NumpadEnter: [0x0e1c],
  F1: [0x003b],
  F2: [0x003c],
  F3: [0x003d],
  F4: [0x003e],
  F5: [0x003f],
  F6: [0x0040],
  F7: [0x0041],
  F8: [0x0042],
  F9: [0x0043],
  F10: [0x0044],
  F11: [0x0057],
  F12: [0x0058],
  F13: [0x005b],
  F14: [0x005c],
  F15: [0x005d],
  F16: [0x0063],
  F17: [0x0064],
  F18: [0x0065],
  F19: [0x0066],
  F20: [0x0067],
  F21: [0x0068],
  F22: [0x0069],
  F23: [0x006a],
  F24: [0x006b],
  Semicolon: [0x0027],
  Equal: [0x000d],
  Comma: [0x0033],
  Minus: [0x000c],
  Period: [0x0034],
  Slash: [0x0035],
  Backquote: [0x0029],
  BracketLeft: [0x001a],
  Backslash: [0x002b],
  BracketRight: [0x001b],
  Quote: [0x0028],
  ControlLeft: [0x001d],
  ControlRight: [0x0e1d],
  AltLeft: [0x0038],
  AltRight: [0x0e38],
  ShiftLeft: [0x002a],
  ShiftRight: [0x0036],
  MetaLeft: [0x0e5b],
  MetaRight: [0x0e5c],
  NumLock: [0x0045],
  ScrollLock: [0x0046],
  PrintScreen: [0x0e37],
};

/** Stored hold-to-talk value for the keys held during a recording, modifiers first. */
export function holdComboFromCodes(codes: readonly string[]): KeyComboResult {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return { ok: false, reason: 'No key was pressed.' };
  if (unique.length > MAX_COMBO_KEYS) {
    return { ok: false, reason: `Use at most ${MAX_COMBO_KEYS} keys together.` };
  }
  const unsupported = unique.find((code) => !HOOK_KEYCODES[code]);
  if (unsupported !== undefined) {
    return {
      ok: false,
      reason: `${keyCodeLabel(unsupported)} cannot be watched system-wide. Try it as the toggle shortcut instead.`,
    };
  }
  const modifiers = unique.filter((code) => code in MODIFIER_ACCELERATORS);
  const others = unique.filter((code) => !(code in MODIFIER_ACCELERATORS));
  return { ok: true, value: [...modifiers, ...others].join('+') };
}

/** Key codes of a stored hold-to-talk value; null when hold-to-talk is off or unusable. */
export function parseHoldCombo(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === HOLD_KEY_OFF) return null;
  const codes = (LEGACY_HOLD_KEYS[trimmed] ?? trimmed).split('+');
  return codes.every((code) => HOOK_KEYCODES[code]) ? codes : null;
}

/** For each key of a hold combo, the hook key codes that mean "this key". */
export function holdComboKeycodes(value: string): number[][] | null {
  return parseHoldCombo(value)?.map((code) => [...(HOOK_KEYCODES[code] ?? [])]) ?? null;
}

const KEY_CODE_LABELS: Readonly<Record<string, string>> = {
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  MetaLeft: 'Left Win',
  MetaRight: 'Right Win',
};

export function keyCodeLabel(code: string): string {
  const known = KEY_CODE_LABELS[code];
  if (known) return known;
  const simple = /^(?:Key|Digit)(.)$/u.exec(code);
  if (simple?.[1]) return simple[1];
  // NumLock -> Num Lock, Numpad1 -> Numpad 1, PageUp -> Page Up.
  return code.replace(/([a-z])([A-Z0-9])/gu, '$1 $2');
}

export function holdComboLabel(value: string): string | null {
  return parseHoldCombo(value)?.map(keyCodeLabel).join(' + ') ?? null;
}

/**
 * One key-listen recording. Keys pressed together accumulate; releasing any of them finishes the
 * recording with everything that was held, so both a single key and a chord can be recorded.
 */
export class KeyCaptureSession {
  private readonly pressed: string[] = [];

  /** Returns 'cancel' when Escape is pressed on its own. */
  keyDown(code: string): 'cancel' | null {
    if (code === 'Escape' && this.pressed.length === 0) return 'cancel';
    if (code && !this.pressed.includes(code)) this.pressed.push(code);
    return null;
  }

  /** The recorded keys, or null if nothing was held (a stray key-up from before the recording). */
  keyUp(): string[] | null {
    return this.pressed.length > 0 ? [...this.pressed] : null;
  }
}

/** libuiohook codes for either Shift key (Shift during the hold delay switches to dictation). */
const SHIFT_KEYCODES: ReadonlySet<number> = new Set([0x002a, 0x0036]);

export type HoldTarget = {
  talkDown(shift: boolean): void;
  talkUp(): void;
  otherDown(isShift: boolean): void;
};

/**
 * Feeds system key-hook events into the hold-to-talk machine for a combo of one or more keys: the
 * talk "key" is down while every key of the combo is held.
 */
export class HoldComboTracker {
  private readonly down = new Set<number>();

  constructor(
    private readonly keys: readonly (readonly number[])[],
    private readonly target: HoldTarget
  ) {}

  onKey(event: { type: 'down' | 'up'; keycode: number }): void {
    const index = this.keys.findIndex((keycodes) => keycodes.includes(event.keycode));
    if (index === -1) {
      if (event.type === 'down') this.target.otherDown(SHIFT_KEYCODES.has(event.keycode));
      return;
    }
    if (event.type === 'down') {
      this.down.add(index);
      if (this.down.size === this.keys.length) this.target.talkDown(false);
      return;
    }
    const wasHeld = this.down.size === this.keys.length;
    this.down.delete(index);
    if (wasHeld) this.target.talkUp();
  }

  reset(): void {
    this.down.clear();
  }
}
