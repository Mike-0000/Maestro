import { describe, expect, it } from 'vitest';
import { findPlanOverlaps, pathsMayOverlap, scopedPrompt, staticPrefix, type PlanSubtask } from './plan';

function subtask(title: string, owned: string[], extra: Partial<PlanSubtask> = {}): PlanSubtask {
  return { title, provider: 'claude', prompt: `do ${title}`, owned_paths: owned, ...extra };
}

describe('staticPrefix', () => {
  it('keeps literal directories before the first wildcard', () => {
    expect(staticPrefix('src/auth/**')).toEqual(['src', 'auth']);
    expect(staticPrefix('./src/ui/*.tsx')).toEqual(['src', 'ui']);
    expect(staticPrefix('**/*.ts')).toEqual([]);
    expect(staticPrefix('src\\Windows\\path.ts')).toEqual(['src', 'windows', 'path.ts']);
  });
});

describe('pathsMayOverlap', () => {
  it('detects nesting and ignores siblings', () => {
    expect(pathsMayOverlap('src/**', 'src/auth/login.ts')).toBe(true);
    expect(pathsMayOverlap('src/auth/**', 'src/ui/**')).toBe(false);
    expect(pathsMayOverlap('**', 'docs/readme.md')).toBe(true);
    expect(pathsMayOverlap('src/api', 'src/api-client')).toBe(false);
  });
});

describe('findPlanOverlaps', () => {
  it('flags parallel subtasks that share paths', () => {
    const overlaps = findPlanOverlaps([
      subtask('backend', ['src/server/**']),
      subtask('frontend', ['src/ui/**']),
      subtask('shared', ['src/server/types.ts']),
    ]);
    expect(overlaps).toEqual([
      { a: 'backend', b: 'shared', pathA: 'src/server/**', pathB: 'src/server/types.ts' },
    ]);
  });

  it('allows overlap when one subtask runs after the other', () => {
    expect(
      findPlanOverlaps([
        subtask('schema', ['src/db/**']),
        subtask('migrate', ['src/db/migrations/**'], { sequential_after: 'schema' }),
      ])
    ).toEqual([]);
  });
});

describe('scopedPrompt', () => {
  it('adds the goal, ownership, and acceptance command', () => {
    const prompt = scopedPrompt(subtask('ui', ['src/ui/**'], { acceptance: 'pnpm test' }), 'Dark mode');
    expect(prompt).toContain('do ui');
    expect(prompt).toContain('Dark mode');
    expect(prompt).toContain('src/ui/**');
    expect(prompt).toContain('`pnpm test`');
  });
});
