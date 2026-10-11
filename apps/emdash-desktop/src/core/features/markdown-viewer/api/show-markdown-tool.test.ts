import { describe, expect, it } from 'vitest';
import {
  parseShowMarkdownArguments,
  SHOW_MARKDOWN_TOOL_NAME,
  showMarkdownToolDefinition,
} from './show-markdown-tool';

describe('showMarkdownToolDefinition', () => {
  it('requires only a path and describes present as opt-in', () => {
    const tool = showMarkdownToolDefinition();
    expect(tool.name).toBe(SHOW_MARKDOWN_TOOL_NAME);
    expect(tool.name).toBe('show_markdown');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        present: { type: 'boolean' },
        title: { type: 'string' },
      },
    });
    expect(tool.description).toContain('present: true');
  });
});

describe('parseShowMarkdownArguments', () => {
  it('only presents when present is exactly true', () => {
    expect(parseShowMarkdownArguments({ path: 'docs/plan.md' })).toEqual({
      ok: true,
      value: { path: 'docs/plan.md', present: false },
    });
    expect(parseShowMarkdownArguments({ path: 'docs/plan.md', present: false })).toEqual({
      ok: true,
      value: { path: 'docs/plan.md', present: false },
    });
    expect(parseShowMarkdownArguments({ path: 'docs/plan.md', present: true })).toEqual({
      ok: true,
      value: { path: 'docs/plan.md', present: true },
    });
  });

  it('refuses a present that is not a boolean instead of guessing', () => {
    expect(parseShowMarkdownArguments({ path: 'plan.md', present: 'true' })).toEqual({
      ok: false,
      error: 'present must be true or false.',
    });
  });

  it('trims the path and the title, and bounds the title', () => {
    const parsed = parseShowMarkdownArguments({
      path: '  plan.md ',
      title: `  ${'x'.repeat(200)}  `,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.path).toBe('plan.md');
    expect(parsed.value.title).toHaveLength(80);
  });

  it('drops an empty title', () => {
    expect(parseShowMarkdownArguments({ path: 'plan.md', title: '   ' })).toEqual({
      ok: true,
      value: { path: 'plan.md', present: false },
    });
  });

  it.each([{}, { path: '' }, { path: '   ' }, { path: 42 }, { path: ['plan.md'] }])(
    'asks for a path when given %j',
    (args) => {
      const parsed = parseShowMarkdownArguments(args as Record<string, unknown>);
      expect(parsed.ok).toBe(false);
    }
  );

  it('refuses a path with a null byte or of absurd length', () => {
    expect(parseShowMarkdownArguments({ path: 'plan.md\0.txt' }).ok).toBe(false);
    expect(parseShowMarkdownArguments({ path: `${'a'.repeat(5000)}.md` }).ok).toBe(false);
  });
});
