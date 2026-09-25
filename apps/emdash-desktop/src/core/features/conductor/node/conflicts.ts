import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConflictReport } from '../api/contract';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;

type GitRunner = (
  cwd: string,
  args: readonly string[]
) => Promise<{ stdout: string; exitCode: number }>;

const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (typeof failure.code === 'number') {
      return { stdout: typeof failure.stdout === 'string' ? failure.stdout : '', exitCode: failure.code };
    }
    throw error;
  }
};

/**
 * The commit that represents a worktree's current state: a `git stash create` snapshot when it
 * has uncommitted tracked changes (writes a dangling object only; the worktree is untouched),
 * otherwise HEAD.
 */
async function snapshotCommit(path: string, git: GitRunner): Promise<string> {
  const stash = await git(path, ['stash', 'create']);
  const stashSha = stash.stdout.trim();
  if (stash.exitCode === 0 && stashSha) return stashSha;
  const head = await git(path, ['rev-parse', 'HEAD']);
  if (head.exitCode !== 0) throw new Error(`Not a git worktree: ${path}`);
  return head.stdout.trim();
}

/** Parses `git merge-tree --write-tree --name-only --no-messages` output. */
export function parseMergeTreeOutput(stdout: string, exitCode: number): string[] | null {
  if (exitCode === 0) return [];
  if (exitCode !== 1) return null;
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  // Line 1 is the resulting tree OID; the rest (until a blank line) are conflicted paths.
  const files: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line) break;
    files.push(line);
  }
  return [...new Set(files)];
}

/** Predicts pairwise merge conflicts between worktrees that share one repository. */
export async function checkWorktreeConflicts(
  worktrees: readonly { label: string; path: string }[],
  git: GitRunner = runGit
): Promise<ConflictReport> {
  const commits = await Promise.all(worktrees.map((worktree) => snapshotCommit(worktree.path, git)));
  const pairs: ConflictReport['pairs'] = [];
  for (let i = 0; i < worktrees.length; i++) {
    for (let j = i + 1; j < worktrees.length; j++) {
      const a = worktrees[i];
      const b = worktrees[j];
      const shaA = commits[i];
      const shaB = commits[j];
      if (!a || !b || !shaA || !shaB) continue;
      const result = await git(a.path, [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        shaA,
        shaB,
      ]);
      const files = parseMergeTreeOutput(result.stdout, result.exitCode);
      if (files === null) throw new Error(`git merge-tree failed (exit ${result.exitCode}).`);
      pairs.push({ a: a.label, b: b.label, conflicted: files.length > 0, files });
    }
  }
  return { pairs };
}
