import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The app's dark palette must alias the generated @emdash/theme tokens rather
// than copy their values, so app chrome and @emdash/ui render one palette and
// a tweak in packages/theme/src/themes/dark.theme.ts reaches both. These tests
// stop a hard-coded copy from creeping back into index.css.

const css = readFileSync(new URL('../../../../renderer/index.css', import.meta.url), 'utf8');

/** Declarations of the first `.emdark { ... }` block (the palette in `@layer base`). */
function firstDarkBlock(source: string): Map<string, string> {
  const start = source.indexOf('.emdark {');
  if (start < 0) throw new Error('index.css has no .emdark block');
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('.emdark block in index.css is not closed');
  const body = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls.set(match[1], match[2].trim());
  }
  return decls;
}

const dark = firstDarkBlock(css);

/** Tokens that alias the generated token of the same name with an `em-` prefix. */
const SAME_NAME_ALIASES = [
  '--primary-button-background',
  '--primary-button-background-hover',
  '--primary-button-foreground',
  '--primary-button-border',
  '--selection',
  '--selection-foreground',
  '--status-in-progress',
  '--status-in-review',
  '--status-done',
  '--status-todo',
  '--status-cancelled',
  '--foreground-success',
  '--background-success',
  '--background-success-hover',
  '--border-success',
];

describe('.emdark palette aliases the generated @emdash/theme tokens', () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    '--neutral-%i aliases the same --em-neutral step',
    (step) => {
      expect(dark.get(`--neutral-${step}`)).toBe(`var(--em-neutral-${step})`);
    }
  );

  it.each(SAME_NAME_ALIASES)('%s aliases its --em- token', (name) => {
    expect(dark.get(name)).toBe(`var(--em-${name.slice(2)})`);
  });

  it('accent roles resolve through the generated accent ramp', () => {
    expect(dark.get('--accent')).toBe('var(--em-accent-9)');
    expect(dark.get('--accent-foreground')).toBe('var(--em-accent-contrast)');
    expect(dark.get('--link')).toBe('var(--em-accent-11)');
    expect(dark.get('--focus-ring')).toBe('var(--em-accent-8)');
  });
});
