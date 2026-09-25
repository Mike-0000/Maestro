import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemChecks } from '../api/contract';

const execFileAsync = promisify(execFile);

async function gitGlobalConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--get', key], {
      windowsHide: true,
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    // Exit code 1 means the key is unset.
    return null;
  }
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Environment checks that commonly break agent worktrees on Windows. Long paths matter because
 * worktrees nest a repository path inside the worktree root; node_modules trees then exceed
 * MAX_PATH and checkouts fail midway.
 */
export async function readSystemChecks(): Promise<SystemChecks> {
  if (process.platform !== 'win32')
    return { platform: process.platform, git: true, longPaths: null };
  const git = await gitAvailable();
  if (!git) return { platform: process.platform, git: false, longPaths: null };
  const value = await gitGlobalConfig('core.longpaths');
  return { platform: process.platform, git: true, longPaths: value === 'true' };
}

/** Sets `git config --global core.longpaths true` (only ever on an explicit user click). */
export async function enableGitLongPaths(): Promise<SystemChecks> {
  await execFileAsync('git', ['config', '--global', 'core.longpaths', 'true'], {
    windowsHide: true,
    timeout: 10_000,
  });
  return readSystemChecks();
}
