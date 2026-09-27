import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoundExec } from '#services/exec/api';
import {
  integrate,
  parseMergeTree,
  parseOverwrittenPaths,
  previewIntegration,
  type IntegrationSide,
} from './integrate';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string) {
  await writeFile(path.join(cwd, file), content, 'utf8');
  await git(cwd, 'add', file);
  await git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function side(cwd: string): Promise<IntegrationSide> {
  const [gitDir, commonDir] = await Promise.all([
    git(cwd, 'rev-parse', '--absolute-git-dir'),
    git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  ]);
  return {
    exec: createBoundExec({ file: 'git', cwd }),
    gitDir,
    checkoutId: cwd,
    repositoryId: commonDir,
  };
}

const roots: string[] = [];

/** A main checkout on `main` plus a linked task worktree on `task`. */
async function makeRepoWithTask() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'emdash-git-integrate-')));
  roots.push(root);
  const main = path.join(root, 'main');
  const task = path.join(root, 'task');
  await execFileAsync('git', ['init', '-b', 'main', main]);
  await git(main, 'config', 'user.email', 'test@example.com');
  await git(main, 'config', 'user.name', 'Test User');
  await git(main, 'config', 'core.autocrlf', 'false');
  await commitFile(main, 'shared.txt', 'base\n', 'init');
  await git(main, 'worktree', 'add', '-b', 'task', task);
  return { main, task };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('previewIntegration / integrate', () => {
  it('fast-forwards the main checkout to the task commits', async () => {
    const { main, task } = await makeRepoWithTask();
    const taskHead = await commitFile(task, 'feature.txt', 'feature\n', 'add feature');
    const [target, source] = await Promise.all([side(main), side(task)]);

    const preview = await previewIntegration(target, source);
    expect(preview).toMatchObject({
      mode: 'fast-forward',
      ahead: 1,
      behind: 0,
      blockers: [],
      changedFiles: ['feature.txt'],
      target: { branch: 'refs/heads/main' },
      source: { branch: 'refs/heads/task', head: taskHead },
    });
    expect(preview.commits).toEqual([{ hash: taskHead, subject: 'add feature' }]);

    const result = await integrate(target, source, {
      expectedTargetHead: preview.target.head!,
      expectedSourceHead: taskHead,
    });
    expect(result).toEqual({
      success: true,
      data: {
        mode: 'fast-forward',
        branch: 'refs/heads/main',
        previousHead: preview.target.head,
        commit: taskHead,
      },
    });
    expect(await git(main, 'rev-parse', 'HEAD')).toBe(taskHead);
    expect(await readFile(path.join(main, 'feature.txt'), 'utf8')).toBe('feature\n');
  });

  it('creates a merge commit off-tree when both branches moved', async () => {
    const { main, task } = await makeRepoWithTask();
    const taskHead = await commitFile(task, 'feature.txt', 'feature\n', 'add feature');
    const mainHead = await commitFile(main, 'other.txt', 'other\n', 'main work');
    const [target, source] = await Promise.all([side(main), side(task)]);

    const preview = await previewIntegration(target, source);
    expect(preview).toMatchObject({ mode: 'merge', ahead: 1, behind: 1, blockers: [] });
    expect(preview.changedFiles).toEqual(['feature.txt']);

    const result = await integrate(target, source, {
      expectedTargetHead: mainHead,
      expectedSourceHead: taskHead,
      message: 'Integrate task',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.mode).toBe('merge');
    expect(await git(main, 'rev-parse', 'HEAD')).toBe(result.data.commit);
    expect(await git(main, 'log', '-1', '--format=%P')).toBe(`${mainHead} ${taskHead}`);
    expect(await git(main, 'log', '-1', '--format=%s')).toBe('Integrate task');
    expect(await git(main, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(main, 'feature.txt'), 'utf8')).toBe('feature\n');
    // The task worktree is never touched.
    expect(await git(task, 'rev-parse', 'HEAD')).toBe(taskHead);
  });

  it('reports conflicts without touching the main checkout', async () => {
    const { main, task } = await makeRepoWithTask();
    const taskHead = await commitFile(task, 'shared.txt', 'task\n', 'task edit');
    const mainHead = await commitFile(main, 'shared.txt', 'main\n', 'main edit');
    const [target, source] = await Promise.all([side(main), side(task)]);

    const preview = await previewIntegration(target, source);
    expect(preview).toMatchObject({ mode: 'conflict', conflictedFiles: ['shared.txt'] });

    const result = await integrate(target, source, {
      expectedTargetHead: mainHead,
      expectedSourceHead: taskHead,
    });
    expect(result).toMatchObject({
      success: false,
      error: { type: 'conflict', conflictedFiles: ['shared.txt'] },
    });
    expect(await git(main, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(await git(main, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(main, 'shared.txt'), 'utf8')).toBe('main\n');
  });

  it('reports up-to-date when the task is already integrated', async () => {
    const { main, task } = await makeRepoWithTask();
    const [target, source] = await Promise.all([side(main), side(task)]);
    const head = await git(main, 'rev-parse', 'HEAD');

    const preview = await previewIntegration(target, source);
    expect(preview).toMatchObject({ mode: 'up-to-date', ahead: 0, commits: [] });
    await expect(
      integrate(target, source, { expectedTargetHead: head, expectedSourceHead: head })
    ).resolves.toMatchObject({ success: true, data: { mode: 'up-to-date', commit: head } });
  });

  it('refuses when either side moved after the preview', async () => {
    const { main, task } = await makeRepoWithTask();
    const taskHead = await commitFile(task, 'feature.txt', 'feature\n', 'add feature');
    const [target, source] = await Promise.all([side(main), side(task)]);
    const preview = await previewIntegration(target, source);

    await commitFile(main, 'other.txt', 'other\n', 'main moved');
    await expect(
      integrate(target, source, {
        expectedTargetHead: preview.target.head!,
        expectedSourceHead: taskHead,
      })
    ).resolves.toMatchObject({ success: false, error: { type: 'target_moved' } });

    const movedMain = await git(main, 'rev-parse', 'HEAD');
    await commitFile(task, 'more.txt', 'more\n', 'task moved');
    await expect(
      integrate(target, source, {
        expectedTargetHead: movedMain,
        expectedSourceHead: taskHead,
      })
    ).resolves.toMatchObject({ success: false, error: { type: 'source_moved' } });
    expect(await git(main, 'rev-parse', 'HEAD')).toBe(movedMain);
  });

  it('blocks when uncommitted main-directory changes overlap incoming files', async () => {
    const { main, task } = await makeRepoWithTask();
    const taskHead = await commitFile(task, 'shared.txt', 'task\n', 'task edit');
    await writeFile(path.join(main, 'shared.txt'), 'local edit\n', 'utf8');
    const [target, source] = await Promise.all([side(main), side(task)]);
    const mainHead = await git(main, 'rev-parse', 'HEAD');

    const preview = await previewIntegration(target, source);
    expect(preview.mode).toBe('fast-forward');
    expect(preview.blockers).toEqual([{ kind: 'local-changes', paths: ['shared.txt'] }]);
    expect(preview.target.changes).toMatchObject({ unstaged: 1 });

    const result = await integrate(target, source, {
      expectedTargetHead: mainHead,
      expectedSourceHead: taskHead,
    });
    expect(result).toMatchObject({
      success: false,
      error: { type: 'local_changes', paths: ['shared.txt'] },
    });
    expect(await git(main, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(await readFile(path.join(main, 'shared.txt'), 'utf8')).toBe('local edit\n');
  });

  it('keeps unrelated uncommitted main-directory changes on fast-forward', async () => {
    const { main, task } = await makeRepoWithTask();
    await commitFile(main, 'notes.txt', 'notes\n', 'notes');
    await git(task, 'merge', '--ff-only', 'main');
    const taskHead = await commitFile(task, 'feature.txt', 'feature\n', 'add feature');
    await writeFile(path.join(main, 'notes.txt'), 'local notes\n', 'utf8');
    const [target, source] = await Promise.all([side(main), side(task)]);
    const preview = await previewIntegration(target, source);
    expect(preview.blockers).toEqual([]);

    const result = await integrate(target, source, {
      expectedTargetHead: preview.target.head!,
      expectedSourceHead: taskHead,
    });
    expect(result.success).toBe(true);
    expect(await readFile(path.join(main, 'notes.txt'), 'utf8')).toBe('local notes\n');
  });

  it('surfaces uncommitted task work and in-progress operations', async () => {
    const { main, task } = await makeRepoWithTask();
    await commitFile(task, 'shared.txt', 'task\n', 'task edit');
    await commitFile(main, 'shared.txt', 'main\n', 'main edit');
    await writeFile(path.join(task, 'draft.txt'), 'draft\n', 'utf8');
    const [target, source] = await Promise.all([side(main), side(task)]);

    const dirty = await previewIntegration(target, source);
    expect(dirty.source.changes).toMatchObject({ untracked: 1 });
    expect(dirty.blockers).toEqual([]);

    await execFileAsync('git', ['merge', 'main'], { cwd: task }).catch(() => undefined);
    const merging = await previewIntegration(target, source);
    expect(merging.blockers).toContainEqual({ kind: 'source-operation', operation: 'merge' });
    await expect(
      integrate(target, source, {
        expectedTargetHead: merging.target.head!,
        expectedSourceHead: merging.source.head!,
      })
    ).resolves.toMatchObject({
      success: false,
      error: { type: 'blocked', blocker: { kind: 'source-operation' } },
    });
  });

  it('blocks integrating a checkout into itself', async () => {
    const { main } = await makeRepoWithTask();
    const target = await side(main);
    const preview = await previewIntegration(target, target);
    expect(preview.blockers).toContainEqual({ kind: 'same-checkout' });
  });
});

describe('integration output parsers', () => {
  it('parses merge-tree name-only output', () => {
    expect(parseMergeTree('abc123\0a.txt\0b/c.txt\0a.txt\0')).toEqual({
      tree: 'abc123',
      files: ['a.txt', 'b/c.txt'],
    });
    expect(parseMergeTree('abc123\0')).toEqual({ tree: 'abc123', files: [] });
  });

  it('parses paths git refuses to overwrite', () => {
    const message = [
      'error: Your local changes to the following files would be overwritten by merge:',
      '\tshared.txt',
      '\tdir/other.txt',
      'Please commit your changes or stash them before you merge.',
      'Aborting',
    ].join('\n');
    expect(parseOverwrittenPaths(message)).toEqual(['shared.txt', 'dir/other.txt']);
  });
});
