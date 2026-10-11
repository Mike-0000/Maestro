import { describe, expect, it } from 'vitest';
import { fileNameOf, isImagePath, isMarkdownPath, localReferencePath } from './markdown-paths';

describe('isMarkdownPath', () => {
  it.each(['plan.md', 'docs/Plan.MD', 'C:\\repo\\notes.markdown', 'page.mdx', '  README.md  '])(
    'accepts %j',
    (path) => expect(isMarkdownPath(path)).toBe(true)
  );

  it.each(['plan.txt', 'plan.md.bak', 'md', 'notes.mdown', '.env', 'plan.md/secret.txt', ''])(
    'refuses %j',
    (path) => expect(isMarkdownPath(path)).toBe(false)
  );
});

describe('isImagePath', () => {
  it('accepts the image types the viewer embeds and nothing else', () => {
    expect(isImagePath('shots/before.PNG')).toBe(true);
    expect(isImagePath('diagram.svg')).toBe(true);
    expect(isImagePath('photo.jpeg')).toBe(true);
    expect(isImagePath('notes.md')).toBe(false);
    expect(isImagePath('id_rsa')).toBe(false);
  });
});

describe('fileNameOf', () => {
  it('reads the name from either path dialect', () => {
    expect(fileNameOf('/repo/docs/plan.md')).toBe('plan.md');
    expect(fileNameOf('C:\\repo\\docs\\plan.md')).toBe('plan.md');
    expect(fileNameOf('plan.md')).toBe('plan.md');
    expect(fileNameOf('docs/')).toBe('docs');
  });
});

describe('localReferencePath', () => {
  it('strips the query and fragment and decodes the rest', () => {
    expect(localReferencePath('images/a%20b.png?raw=1#top')).toBe('images/a b.png');
    expect(localReferencePath(' ../other.md#section ')).toBe('../other.md');
  });

  it('keeps Windows drive paths, whose colon is not a scheme', () => {
    expect(localReferencePath('C:\\repo\\docs\\plan.md')).toBe('C:\\repo\\docs\\plan.md');
    expect(localReferencePath('D:/repo/plan.md')).toBe('D:/repo/plan.md');
  });

  it.each([
    'https://example.com/a.png',
    'file:///etc/passwd',
    'mailto:dev@example.com',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/a.png',
    '\\\\server\\share\\a.png',
    '#section',
    '?query',
    '',
  ])('returns null for %j, which is not a file path', (reference) => {
    expect(localReferencePath(reference)).toBeNull();
  });

  it('keeps a reference that is not valid percent-encoding as written', () => {
    expect(localReferencePath('100%.md')).toBe('100%.md');
  });
});
