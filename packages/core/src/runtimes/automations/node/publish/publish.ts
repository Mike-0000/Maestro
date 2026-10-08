import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { createBoundExec, ExecError } from '#services/exec/api';
import type {
  AutomationDeliveryError,
  AutomationPublishInput,
  AutomationPublishResult,
} from '../../api';

const COMMAND_TIMEOUT_MS = 120_000;
const LEFTOVER_COMMIT_MESSAGE = 'chore: commit remaining agent changes';
/** Refs reach git and gh as arguments; this keeps one from being read as an option. */
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** Runs one tool in the run's worktree with arguments passed as an array (never a shell). */
export type PublishExec = (
  file: 'git' | 'gh',
  args: string[],
  options: { cwd: string; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Commits whatever the agent left uncommitted, pushes the run branch, and opens a
 * pull request. It never force-pushes, never pushes the base branch, and never
 * merges: the pull request is the hand-off to a human reviewer.
 */
export async function publishRunBranch(
  exec: PublishExec,
  input: AutomationPublishInput,
  signal?: AbortSignal
): Promise<Result<AutomationPublishResult, AutomationDeliveryError>> {
  for (const [label, ref] of [
    ['branch', input.branch],
    ['base branch', input.baseBranch],
    ['remote', input.remote],
  ] as const) {
    if (!SAFE_REF_PATTERN.test(ref)) {
      return err({ type: 'invalid-ref', message: `Unsupported ${label} name: ${ref}` });
    }
  }
  if (input.branch === input.baseBranch) {
    return err({ type: 'invalid-ref', message: 'Refusing to publish the base branch' });
  }

  const run = (file: 'git' | 'gh', args: string[]) =>
    exec(file, args, { cwd: input.cwd, signal }).then((result) => result.stdout.trim());

  try {
    const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current !== input.branch) {
      return err({
        type: 'branch-mismatch',
        message: `Worktree is on ${current}, expected ${input.branch}`,
      });
    }

    if (await run('git', ['status', '--porcelain'])) {
      await run('git', ['add', '--all']);
      await run('git', ['commit', '--message', LEFTOVER_COMMIT_MESSAGE]);
    }

    // Best effort: a stale base only changes whether an empty branch is detected.
    await run('git', ['fetch', input.remote, input.baseBranch]).catch(() => undefined);
    const base = await run('git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${input.remote}/${input.baseBranch}`,
    ])
      .then(() => `${input.remote}/${input.baseBranch}`)
      .catch(() => input.baseBranch);
    const ahead = await run('git', ['rev-list', '--count', `${base}..HEAD`]);
    if (Number.parseInt(ahead, 10) === 0) return ok({ outcome: 'no-changes' });

    await run('git', ['push', '--set-upstream', input.remote, input.branch]);

    const existing = await run('gh', [
      'pr',
      'list',
      '--head',
      input.branch,
      '--state',
      'open',
      '--json',
      'url',
      '--limit',
      '1',
    ]);
    const existingUrl = parseExistingUrl(existing);
    if (existingUrl) return ok({ outcome: 'pull-request', url: existingUrl });

    const created = await withBodyFile(input.body, (bodyFile) =>
      run('gh', [
        'pr',
        'create',
        '--base',
        input.baseBranch,
        '--head',
        input.branch,
        `--title=${input.title}`,
        '--body-file',
        bodyFile,
        ...(input.draft ? ['--draft'] : []),
      ])
    );
    const url = created
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//u.test(line))
      .pop();
    if (!url) {
      return err({ type: 'pull-request-failed', message: `gh did not print a URL: ${created}` });
    }
    return ok({ outcome: 'pull-request', url });
  } catch (error) {
    return err({ type: 'publish-failed', message: describeExecError(error) });
  }
}

function parseExistingUrl(json: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(json || '[]');
    if (!Array.isArray(parsed)) return undefined;
    const first: unknown = parsed[0];
    if (typeof first !== 'object' || first === null || !('url' in first)) return undefined;
    return typeof first.url === 'string' && first.url ? first.url : undefined;
  } catch {
    return undefined;
  }
}

/** The body goes through a file so its length and content never touch a command line. */
async function withBodyFile<T>(body: string, withFile: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'emdash-pr-'));
  try {
    const path = join(directory, 'body.md');
    await writeFile(path, body, { mode: 0o600 });
    return await withFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function describeExecError(error: unknown): string {
  if (error instanceof ExecError) {
    const detail = (error.stderr || error.stdout).trim().split(/\r?\n/u).slice(-5).join('\n');
    return detail ? `${error.message}: ${detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export type AutomationPublisher = (
  input: AutomationPublishInput,
  signal?: AbortSignal
) => Promise<Result<AutomationPublishResult, AutomationDeliveryError>>;

/**
 * A publisher that runs `git` and `gh` as the current user with that user's existing
 * credentials. Prompts are disabled: a tool that would ask for input fails instead.
 */
export function createAutomationPublisher(env: NodeJS.ProcessEnv): AutomationPublisher {
  const exec: PublishExec = (file, args, { cwd, signal }) =>
    createBoundExec({
      file,
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    }).exec(args, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
  return (input, signal) => publishRunBranch(exec, input, signal);
}
