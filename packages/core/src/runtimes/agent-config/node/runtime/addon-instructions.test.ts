import { describe, expect, it } from 'vitest';
import {
  applyInstructionBlock,
  readInstructionBlock,
  removeInstructionBlock,
} from './addon-instructions';

const START = '<!-- maestro-addon:vibe:start (managed by Maestro: Settings > Add-ons) -->';
const END = '<!-- maestro-addon:vibe:end -->';

describe('add-on instruction blocks', () => {
  it('creates a file holding only the block', () => {
    expect(applyInstructionBlock(null, 'vibe', '# Vibe\n\nUse it.\n')).toBe(
      `${START}\n# Vibe\n\nUse it.\n${END}\n`
    );
  });

  it('appends after the developer text with one blank line, leaving that text intact', () => {
    const mine = '# My rules\n\nBe brief.\n';
    const next = applyInstructionBlock(mine, 'vibe', 'Use it.');
    expect(next).toBe(`${mine}\n${START}\nUse it.\n${END}\n`);
    expect(next.startsWith(mine)).toBe(true);
  });

  it('replaces only its own block on update', () => {
    const text = `before\n\n${START}\nold\n${END}\n\nafter\n`;
    expect(applyInstructionBlock(text, 'vibe', 'new')).toBe(
      `before\n\n${START}\nnew\n${END}\n\nafter\n`
    );
  });

  it('keeps CRLF files CRLF', () => {
    const next = applyInstructionBlock('mine\r\n', 'vibe', 'line one\nline two');
    expect(next).toBe(`mine\r\n\r\n${START}\r\nline one\r\nline two\r\n${END}\r\n`);
    expect(readInstructionBlock(next, 'vibe')).toBe('line one\r\nline two');
  });

  it('reads the block body, or null without one', () => {
    expect(readInstructionBlock(`x\n${START}\nbody\n${END}\n`, 'vibe')).toBe('body');
    expect(readInstructionBlock('x\n', 'vibe')).toBeNull();
    expect(readInstructionBlock(`${START}\nbody\n${END}`, 'other')).toBeNull();
  });

  it('removal restores the text it was appended to', () => {
    const mine = '# My rules\n\nBe brief.\n';
    expect(removeInstructionBlock(applyInstructionBlock(mine, 'vibe', 'Use it.'), 'vibe')).toBe(
      mine
    );
    expect(removeInstructionBlock(applyInstructionBlock(null, 'vibe', 'Use it.'), 'vibe')).toBe('');
  });

  it('removal keeps text on both sides of a block in the middle', () => {
    const text = `before\n\n${START}\nbody\n${END}\nafter\n`;
    expect(removeInstructionBlock(text, 'vibe')).toBe('before\nafter\n');
  });
});
