import { describe, expect, it } from 'vitest';
import { inlineCodeParts } from './inline-code';

describe('inlineCodeParts', () => {
  it('returns plain text as one part, and nothing for empty text', () => {
    expect(inlineCodeParts('Tests pass.')).toEqual([{ code: false, text: 'Tests pass.' }]);
    expect(inlineCodeParts('')).toEqual([]);
  });

  it('cuts backtick spans out as code', () => {
    expect(inlineCodeParts('Ran `pnpm test` in `apps/desktop`.')).toEqual([
      { code: false, text: 'Ran ' },
      { code: true, text: 'pnpm test' },
      { code: false, text: ' in ' },
      { code: true, text: 'apps/desktop' },
      { code: false, text: '.' },
    ]);
    expect(inlineCodeParts('`a``b`')).toEqual([
      { code: true, text: 'a' },
      { code: true, text: 'b' },
    ]);
  });

  it('keeps an unclosed backtick as text', () => {
    expect(inlineCodeParts('Fixed `hangUp() and `call.ts`')).toEqual([
      { code: false, text: 'Fixed ' },
      { code: true, text: 'hangUp() and ' },
      { code: false, text: 'call.ts`' },
    ]);
    expect(inlineCodeParts('it`s fine')).toEqual([{ code: false, text: 'it`s fine' }]);
  });

  it('does not make code of an empty span or one across a line break', () => {
    expect(inlineCodeParts('a `` b')).toEqual([{ code: false, text: 'a `` b' }]);
    expect(inlineCodeParts('a `b\nc` d')).toEqual([{ code: false, text: 'a `b\nc` d' }]);
  });

  it('parses nothing but backticks', () => {
    expect(inlineCodeParts('**bold** [link](x)')).toEqual([
      { code: false, text: '**bold** [link](x)' },
    ]);
  });
});
