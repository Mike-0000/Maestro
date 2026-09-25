import { describe, expect, it } from 'vitest';
import { readOutputLogTail, stripAnsi } from './terminal-tail';

describe('readOutputLogTail', () => {
  it('returns the last printable lines after stripping CSI', () => {
    const text = '\x1b[32mgreen\x1b[0m\nkeep\n\x1b[1;1Hspinner';
    expect(readOutputLogTail(text, 2)).toEqual(['keep', 'spinner']);
  });

  it('drops leading and trailing blank lines from the tail window', () => {
    expect(readOutputLogTail('a\n\n\nb\n\n', 10)).toEqual(['a', '', '', 'b']);
  });
});

describe('stripAnsi', () => {
  it('removes CSI color sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
});
