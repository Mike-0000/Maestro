import type { ILink } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import {
  ActivationModifierTracker,
  FileLinkProvider,
  isActivationModifierPressed,
  isPrimaryMouseButton,
} from '@core/features/terminals/api/browser/pty/file-link-provider';
import { findFileLinks } from '@core/features/terminals/browser/pty/file-link-detection';

class MockBufferLine {
  constructor(
    private readonly text: string,
    readonly isWrapped = false
  ) {}

  translateToString(): string {
    return this.text;
  }
}

function makeBuffer(lines: MockBufferLine[]) {
  return {
    getLine(index: number): MockBufferLine | undefined {
      return lines[index];
    },
  };
}

describe('file link provider', () => {
  it('detects one path across wrapped terminal lines', () => {
    const buffer = makeBuffer([
      new MockBufferLine('error in src/renderer/lib/pty/file-link-'),
      new MockBufferLine('provider.ts', true),
    ]);

    expect(findFileLinks(buffer, 1)).toEqual([
      {
        range: {
          start: { x: 10, y: 1 },
          end: { x: 11, y: 2 },
        },
        text: 'src/renderer/lib/pty/file-link-provider.ts',
        isExternal: false,
      },
    ]);
    expect(findFileLinks(buffer, 2)[0]?.text).toBe('src/renderer/lib/pty/file-link-provider.ts');
  });

  it('detects one path split by adjacent hard line breaks', () => {
    const buffer = makeBuffer([
      new MockBufferLine(
        '  Local agents do not use the terminal shell resolver at all. In src/main/core/'
      ),
      new MockBufferLine(
        '  conversations/impl/local-conversation.ts:140, agent sessions call resolveLocalPtySpawn'
      ),
    ]);

    const expectedFirstLineLink = {
      range: {
        start: { x: 66, y: 1 },
        end: { x: 79, y: 1 },
      },
      text: 'src/main/core/conversations/impl/local-conversation.ts',
      isExternal: false,
    };
    const expectedSecondLineLink = {
      range: {
        start: { x: 3, y: 2 },
        end: { x: 42, y: 2 },
      },
      text: 'src/main/core/conversations/impl/local-conversation.ts',
      isExternal: false,
    };
    expect(findFileLinks(buffer, 1)).toEqual([expectedFirstLineLink]);
    expect(findFileLinks(buffer, 2)).toEqual([expectedSecondLineLink]);
  });

  it('does not join unrelated hard line breaks', () => {
    const buffer = makeBuffer([
      new MockBufferLine('  See src/main/core/'),
      new MockBufferLine('  for more implementation details.'),
    ]);

    expect(findFileLinks(buffer, 1)).toEqual([]);
    expect(findFileLinks(buffer, 2)).toEqual([]);
  });

  it('does not join backward from the middle of a wrapped line chain', () => {
    const buffer = makeBuffer([
      new MockBufferLine('src/foo/'),
      new MockBufferLine('bar/', true),
      new MockBufferLine('  baz.ts'),
    ]);

    expect(findFileLinks(buffer, 3)).toEqual([]);
  });

  it('classifies absolute and home-relative paths as external', () => {
    const buffer = makeBuffer([
      new MockBufferLine('open /tmp/output/report.md and ~/notes/todo.md'),
    ]);

    expect(findFileLinks(buffer, 1)).toEqual([
      {
        range: {
          start: { x: 6, y: 1 },
          end: { x: 26, y: 1 },
        },
        text: '/tmp/output/report.md',
        isExternal: true,
      },
      {
        range: {
          start: { x: 32, y: 1 },
          end: { x: 46, y: 1 },
        },
        text: '~/notes/todo.md',
        isExternal: true,
      },
    ]);
  });

  it('keeps URL paths delegated to the web links addon', () => {
    const buffer = makeBuffer([new MockBufferLine('see https://example.com/src/file.ts')]);

    expect(findFileLinks(buffer, 1)).toEqual([]);
  });

  it('requires Command on macOS and Control elsewhere', () => {
    expect(isActivationModifierPressed({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isActivationModifierPressed({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isActivationModifierPressed({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isActivationModifierPressed({ metaKey: true, ctrlKey: false }, false)).toBe(false);
    expect(isActivationModifierPressed({ metaKey: true, ctrlKey: true }, true)).toBe(false);
    expect(isActivationModifierPressed({ metaKey: true, ctrlKey: true }, false)).toBe(false);
  });

  it('only treats the primary mouse button as link activation', () => {
    expect(isPrimaryMouseButton({ button: 0 })).toBe(true);
    expect(isPrimaryMouseButton({ button: 1 })).toBe(false);
    expect(isPrimaryMouseButton({ button: 2 })).toBe(false);
  });

  it('clears initial underline decorations from mouse events without the modifier', () => {
    const tracker = new ActivationModifierTracker(true);

    expect(tracker.update({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(tracker.decorations()).toEqual({ pointerCursor: true, underline: true });

    expect(tracker.update({ metaKey: false, ctrlKey: false })).toBe(false);
    expect(tracker.decorations()).toEqual({ pointerCursor: false, underline: false });
  });

  it('updates hovered decorations when the modifier changes without mouse movement', () => {
    const tracker = new ActivationModifierTracker(true);
    const decorations = tracker.decorations();

    tracker.hover(decorations, { metaKey: true, ctrlKey: false });
    expect(decorations).toEqual({ pointerCursor: true, underline: true });

    tracker.update({ metaKey: false, ctrlKey: false });
    expect(decorations).toEqual({ pointerCursor: false, underline: false });
  });

  it('only opens links when the activation modifier is pressed', () => {
    const openedFiles: string[] = [];
    const openedExternal: string[] = [];
    const buffer = makeBuffer([new MockBufferLine('open ./src/app.ts and /tmp/report.md')]);
    const provider = new FileLinkProvider(
      { buffer: { active: buffer } } as never,
      (filePath) => openedFiles.push(filePath),
      (filePath) => openedExternal.push(filePath),
      new ActivationModifierTracker(true)
    );

    let links: ILink[] = [];
    provider.provideLinks(1, (providedLinks) => {
      links = providedLinks ?? [];
    });

    const relativeLink = links[0]!;
    relativeLink.activate(
      { button: 0, metaKey: false, ctrlKey: false } as MouseEvent,
      relativeLink.text
    );
    relativeLink.activate(
      { button: 2, metaKey: true, ctrlKey: false } as MouseEvent,
      relativeLink.text
    );
    relativeLink.activate(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      relativeLink.text
    );

    const externalLink = links[1]!;
    externalLink.activate(
      { button: 0, metaKey: false, ctrlKey: false } as MouseEvent,
      externalLink.text
    );
    externalLink.activate(
      { button: 2, metaKey: true, ctrlKey: false } as MouseEvent,
      externalLink.text
    );
    externalLink.activate(
      { button: 0, metaKey: true, ctrlKey: false } as MouseEvent,
      externalLink.text
    );

    expect(openedFiles).toEqual(['src/app.ts']);
    expect(openedExternal).toEqual(['/tmp/report.md']);
  });
});

describe('Markdown paths in a terminal', () => {
  const textsIn = (line: string) =>
    findFileLinks(makeBuffer([new MockBufferLine(line)]), 1).map((link) => link.text);

  it.each([
    ['Write(docs\\plan.md)', ['docs\\plan.md']],
    ['saved C:\\Github\\chorus\\README.md for you', ['C:\\Github\\chorus\\README.md']],
    ['see C:/Github/chorus/docs/x.md.', ['C:/Github/chorus/docs/x.md']],
    ['wrote PLAN.md and notes.mdx', ['PLAN.md', 'notes.mdx']],
    ['..\\shared\\a.markdown', ['..\\shared\\a.markdown']],
    ['docs\\sub/x.md', ['docs\\sub/x.md']],
    ['Report: REPORT.MD', ['REPORT.MD']],
  ])('finds the whole path in %j', (line, expected) => {
    expect(textsIn(line)).toEqual(expected);
  });

  it('gives one link where the general pattern matches the same path', () => {
    expect(findFileLinks(makeBuffer([new MockBufferLine('open docs/guide.md now')]), 1)).toEqual([
      {
        range: { start: { x: 6, y: 1 }, end: { x: 18, y: 1 } },
        text: 'docs/guide.md',
        isExternal: false,
      },
    ]);
  });

  it('keeps POSIX absolute and home paths external and Windows paths in the app', () => {
    const links = findFileLinks(
      makeBuffer([new MockBufferLine('/tmp/report.md ~/notes/todo.md C:\\repo\\plan.md')]),
      1
    );
    expect(links.map((link) => [link.text, link.isExternal])).toEqual([
      ['/tmp/report.md', true],
      ['~/notes/todo.md', true],
      ['C:\\repo\\plan.md', false],
    ]);
  });

  it.each([
    'https://example.com/README.md',
    'plan.md.bak',
    'notes.mdtext',
    'key:docs\\plan.md',
    'the md format',
  ])('finds no Markdown link in %j', (line) => {
    expect(textsIn(line).filter((text) => /\.(?:md|mdx|markdown)$/i.test(text))).toEqual([]);
  });

  it.each([
    [
      "Wrote C:\\Users\\'admin'\\AppData\\Local\\notes\\plan.md",
      ["C:\\Users\\'admin'\\AppData\\Local\\notes\\plan.md"],
    ],
    ['C:\\Users\\José\\notes\\plan.md', ['C:\\Users\\José\\notes\\plan.md']],
    ['read \'docs/plan.md\' and "notes\\todo.md"', ['docs/plan.md', 'notes\\todo.md']],
    ["'C:\\repo\\plan.md'", ['C:\\repo\\plan.md']],
  ])('keeps the whole path in %j', (line, expected) => {
    expect(textsIn(line)).toEqual(expected);
  });

  it.each([
    // The match would be the tail of a path whose folder name the pattern cannot read.
    'C:\\Program Files (x86)\\app\\README.md',
    'saved C:\\My Docs\\plan.md',
    'see C:\\Users\\a&b\\notes\\plan.md',
  ])('gives no link rather than half of the path in %j', (line) => {
    expect(textsIn(line)).toEqual([]);
  });

  it('joins a Windows path split by a hard line break', () => {
    const buffer = makeBuffer([
      new MockBufferLine('Wrote C:\\Github\\chorus\\docs\\design\\very-'),
      new MockBufferLine('  long-name\\plan.md for you'),
    ]);
    const whole = 'C:\\Github\\chorus\\docs\\design\\very-long-name\\plan.md';
    expect(findFileLinks(buffer, 1).map((link) => link.text)).toEqual([whole]);
    expect(findFileLinks(buffer, 2)).toEqual([
      { range: { start: { x: 3, y: 2 }, end: { x: 19, y: 2 } }, text: whole, isExternal: false },
    ]);
  });

  it('reads a hostile line quickly', () => {
    const lines = [
      `${'a.'.repeat(2040)}txt`,
      `${'a\\'.repeat(2040)}b`,
      `${"'".repeat(2000)}${'x'.repeat(2000)}.m`,
      `C:\\${'seg.ment\\'.repeat(400)}file.mdx.bak`,
    ];
    const started = performance.now();
    for (const line of lines) textsIn(line);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('leaves other files to the general pattern', () => {
    expect(textsIn('src/app.ts and docs\\plan.md')).toEqual(['src/app.ts', 'docs\\plan.md']);
    expect(textsIn('src\\app.ts')).toEqual([]);
  });
});
