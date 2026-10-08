import { describe, expect, it } from 'vitest';
import { ExecError } from '#services/exec/api';
import type { AutomationPublishInput } from '../../api';
import { publishRunBranch, type PublishExec } from './publish';

const input: AutomationPublishInput = {
  cwd: '/pool/req-x',
  branch: 'req-x',
  baseBranch: 'main',
  remote: 'origin',
  title: 'Add CSV export',
  body: 'Request body',
  draft: false,
};

type Reply = string | Error;

/** Answers each command from the first matching prefix and records every call. */
function fakeExec(replies: Array<[prefix: string, reply: Reply]>) {
  const calls: string[] = [];
  const exec: PublishExec = async (file, args) => {
    const command = `${file} ${args.join(' ')}`;
    calls.push(command);
    const match = replies.find(([prefix]) => command.startsWith(prefix));
    const reply = match?.[1] ?? '';
    if (reply instanceof Error) throw reply;
    return { stdout: reply, stderr: '' };
  };
  return { calls, exec };
}

const onBranch: [string, Reply] = ['git rev-parse --abbrev-ref HEAD', 'req-x\n'];

describe('publishRunBranch', () => {
  it('pushes the branch and opens a pull request', async () => {
    const { calls, exec } = fakeExec([
      onBranch,
      ['git status --porcelain', ''],
      ['git rev-list --count', '3\n'],
      ['gh pr list', '[]'],
      ['gh pr create', 'Creating pull request\nhttps://github.com/acme/repo/pull/42\n'],
    ]);

    const result = await publishRunBranch(exec, input);

    expect(result).toEqual({
      success: true,
      data: { outcome: 'pull-request', url: 'https://github.com/acme/repo/pull/42' },
    });
    expect(calls).toContain('git push --set-upstream origin req-x');
    expect(calls.some((call) => call.startsWith('git add'))).toBe(false);
    const create = calls.find((call) => call.startsWith('gh pr create')) ?? '';
    expect(create).toContain('--base main --head req-x --title=Add CSV export --body-file ');
    expect(create).not.toContain('--draft');
    expect(calls.some((call) => /merge|--force/u.test(call))).toBe(false);
  });

  it('commits leftover changes and marks an incomplete run as a draft', async () => {
    const { calls, exec } = fakeExec([
      onBranch,
      ['git status --porcelain', ' M src/a.ts\n'],
      ['git rev-list --count', '1\n'],
      ['gh pr list', '[]'],
      ['gh pr create', 'https://github.com/acme/repo/pull/43\n'],
    ]);

    await publishRunBranch(exec, { ...input, draft: true });

    expect(calls).toContain('git add --all');
    expect(calls).toContain('git commit --message chore: commit remaining agent changes');
    expect(calls.find((call) => call.startsWith('gh pr create'))).toContain('--draft');
  });

  it('reports no-changes without pushing when the branch has no commits', async () => {
    const { calls, exec } = fakeExec([
      onBranch,
      ['git status --porcelain', ''],
      ['git rev-list --count', '0\n'],
    ]);

    expect(await publishRunBranch(exec, input)).toEqual({
      success: true,
      data: { outcome: 'no-changes' },
    });
    expect(calls.some((call) => call.startsWith('git push'))).toBe(false);
    expect(calls.some((call) => call.startsWith('gh'))).toBe(false);
  });

  it('returns an existing pull request instead of opening a second one', async () => {
    const { calls, exec } = fakeExec([
      onBranch,
      ['git status --porcelain', ''],
      ['git rev-list --count', '2\n'],
      ['gh pr list', '[{"url":"https://github.com/acme/repo/pull/9"}]'],
    ]);

    expect(await publishRunBranch(exec, input)).toEqual({
      success: true,
      data: { outcome: 'pull-request', url: 'https://github.com/acme/repo/pull/9' },
    });
    expect(calls.some((call) => call.startsWith('gh pr create'))).toBe(false);
  });

  it('refuses unsafe refs and the base branch before running anything', async () => {
    const { calls, exec } = fakeExec([]);

    for (const bad of [
      { branch: '--upload-pack=x' },
      { baseBranch: '-x' },
      { remote: 'origin; rm -rf /' },
      { branch: 'main' },
    ]) {
      const result = await publishRunBranch(exec, { ...input, ...bad });
      expect(result).toMatchObject({ success: false, error: { type: 'invalid-ref' } });
    }
    expect(calls).toEqual([]);
  });

  it('refuses to publish when the worktree is on another branch', async () => {
    const { calls, exec } = fakeExec([['git rev-parse --abbrev-ref HEAD', 'main\n']]);

    expect(await publishRunBranch(exec, input)).toMatchObject({
      success: false,
      error: { type: 'branch-mismatch' },
    });
    expect(calls).toHaveLength(1);
  });

  it('surfaces the failing command output', async () => {
    const { exec } = fakeExec([
      onBranch,
      ['git status --porcelain', ''],
      ['git rev-list --count', '1\n'],
      [
        'git push',
        new ExecError('git', ['push'], 128, '', 'remote: Permission to acme/repo denied\n'),
      ],
    ]);

    const result = await publishRunBranch(exec, input);

    expect(result).toMatchObject({ success: false, error: { type: 'publish-failed' } });
    if (result.success) throw new Error('expected failure');
    expect(result.error.message).toContain('Permission to acme/repo denied');
  });
});
