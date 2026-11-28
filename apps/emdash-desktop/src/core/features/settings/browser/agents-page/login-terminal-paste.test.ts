import { describe, expect, it } from 'vitest';
import { isLoginTerminalPasteShortcut, normalizeLoginPaste } from './login-terminal-paste';

const key = (
  key: string,
  mods: Partial<Record<'ctrl' | 'shift' | 'meta' | 'alt', boolean>> = {}
) => ({
  type: 'keydown',
  key,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
});

describe('isLoginTerminalPasteShortcut', () => {
  it('pastes on Ctrl+V, Ctrl+Shift+V and Shift+Insert off macOS', () => {
    expect(isLoginTerminalPasteShortcut(key('v', { ctrl: true }), false)).toBe(true);
    expect(isLoginTerminalPasteShortcut(key('V', { ctrl: true, shift: true }), false)).toBe(true);
    expect(isLoginTerminalPasteShortcut(key('Insert', { shift: true }), false)).toBe(true);
  });

  it('leaves other keys, key-ups and macOS to xterm', () => {
    expect(isLoginTerminalPasteShortcut(key('v'), false)).toBe(false);
    expect(isLoginTerminalPasteShortcut(key('c', { ctrl: true }), false)).toBe(false);
    expect(isLoginTerminalPasteShortcut(key('v', { ctrl: true, alt: true }), false)).toBe(false);
    expect(isLoginTerminalPasteShortcut(key('Insert', { ctrl: true }), false)).toBe(false);
    expect(
      isLoginTerminalPasteShortcut({ ...key('v', { ctrl: true }), type: 'keyup' }, false)
    ).toBe(false);
    expect(isLoginTerminalPasteShortcut(key('v', { ctrl: true }), true)).toBe(false);
    expect(isLoginTerminalPasteShortcut(key('v', { meta: true }), true)).toBe(false);
  });
});

describe('normalizeLoginPaste', () => {
  it('drops surrounding whitespace and newlines so the code is not submitted early', () => {
    expect(normalizeLoginPaste('  abc#def\n')).toBe('abc#def');
    expect(normalizeLoginPaste('\r\n')).toBe('');
  });
});
