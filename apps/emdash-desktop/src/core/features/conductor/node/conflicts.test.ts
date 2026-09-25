import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWorktreeConflicts, parseMergeTreeOutput } from './conflicts';

describe('parseMergeTreeOutput', () => {
  it('reads clean merges and conflicted paths', () => {
    expect(parseMergeTreeOutput('abc123\n', 0)).toEqual([]);
    expect(parseMergeTreeOutput('abc123\nsrc/a.ts\nsrc/b.ts\n\n', 1)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(parseMergeTreeOutput('', 128)).toBeNull();
  });
});

describe('checkWorktreeConflicts (real git)', () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'chorus-conflicts-'));
    const main = join(root, 'main');
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    git(main, 'config', 'user.email', 'test@chorus.invalid');
    git(main, 'config', 'user.name', 'test');
    writeFileSync(join(main, 'shared.txt'), 'line 1\nline 2\n');
    writeFileSync(join(main, 'other.txt'), 'other\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    for (const name of ['a', 'b', 'c']) {
      git(main, 'worktree', 'add', '-q', '-b', `agent-${name}`, join(root, name));
    }
    // a and b edit the same line differently (committed vs uncommitted); c edits another file.
    writeFileSync(join(root, 'a', 'shared.txt'), 'line 1 from a\nline 2\n');
    git(join(root, 'a'), 'commit', '-q', '-am', 'a');
    writeFileSync(join(root, 'b', 'shared.txt'), 'line 1 from b\nline 2\n');
    writeFileSync(join(root, 'c', 'other.txt'), 'changed by c\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('predicts conflicts including uncommitted work, without touching the worktrees', async () => {
    const report = await checkWorktreeConflicts([
      { label: 'A', path: join(root, 'a') },
      { label: 'B', path: join(root, 'b') },
      { label: 'C', path: join(root, 'c') },
    ]);
    expect(report.pairs).toEqual([
      { a: 'A', b: 'B', conflicted: true, files: ['shared.txt'] },
      { a: 'A', b: 'C', conflicted: false, files: [] },
      { a: 'B', b: 'C', conflicted: false, files: [] },
    ]);
    // b's edit is still uncommitted in its working tree.
    expect(git(join(root, 'b'), 'status', '--porcelain').trim()).toBe('M shared.txt');
  });
});
