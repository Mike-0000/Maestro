import { describe, expect, it } from 'vitest';
import { encodePastedText, encodeTerminalKey, type TerminalKey } from './terminal-keys';

const normal = { applicationCursorKeys: false };
const application = { applicationCursorKeys: true };

describe('encodeTerminalKey', () => {
  it('encodes the control keys', () => {
    const expected: Partial<Record<TerminalKey, string>> = {
      escape: '\x1b',
      enter: '\r',
      tab: '\t',
      'shift-tab': '\x1b[Z',
      'ctrl-c': '\x03',
    };
    for (const [key, sequence] of Object.entries(expected)) {
      expect(encodeTerminalKey(key as TerminalKey, normal)).toBe(sequence);
      expect(encodeTerminalKey(key as TerminalKey, application)).toBe(sequence);
    }
  });

  it('encodes arrows for the cursor-key mode the program selected', () => {
    expect(
      (['up', 'down', 'right', 'left'] as const).map((key) => encodeTerminalKey(key, normal))
    ).toEqual(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
    expect(
      (['up', 'down', 'right', 'left'] as const).map((key) => encodeTerminalKey(key, application))
    ).toEqual(['\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD']);
  });
});

describe('encodePastedText', () => {
  it('brackets text when the program asked for bracketed paste', () => {
    expect(encodePastedText('fix the bug', { bracketedPaste: true })).toBe(
      '\x1b[200~fix the bug\x1b[201~'
    );
  });

  it('sends plain text otherwise', () => {
    expect(encodePastedText('fix the bug', { bracketedPaste: false })).toBe('fix the bug');
  });

  it('turns every kind of line break into a carriage return', () => {
    expect(encodePastedText('one\r\ntwo\nthree\rfour', { bracketedPaste: false })).toBe(
      'one\rtwo\rthree\rfour'
    );
  });

  it('drops surrounding blank lines but keeps leading indentation', () => {
    expect(encodePastedText('\n\n  indented\nline  \n\n', { bracketedPaste: false })).toBe(
      '  indented\rline'
    );
  });

  it('sends nothing for blank text', () => {
    expect(encodePastedText('  \n ', { bracketedPaste: true })).toBe('');
  });

  it('cannot be tricked into ending the paste early', () => {
    expect(encodePastedText('a\x1b[201~rm -rf', { bracketedPaste: true })).toBe(
      '\x1b[200~arm -rf\x1b[201~'
    );
  });
});
