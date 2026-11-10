import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { parseObject } from './account-settings';
import { syncSharedSetup } from './shared-setup-sync';

/**
 * The folder of one extra Claude account: a Claude Code configuration directory whose only
 * real, per-account files are the sign-in (`.credentials.json`, written by the CLI alone) and
 * the account's `.claude.json`. Everything else is the primary setup in `~/.claude`, shared:
 * its subdirectories are linked in, and `settings.json`, `CLAUDE.md` and the MCP servers are
 * kept in step both ways (see `shared-setup-sync.ts`).
 *
 * Nothing here opens, copies or links `.credentials.json`.
 */

export type AccountFolderFs = Pick<
  typeof nodeFs,
  | 'lstat'
  | 'stat'
  | 'readdir'
  | 'mkdir'
  | 'symlink'
  | 'readlink'
  | 'realpath'
  | 'unlink'
  | 'rmdir'
  | 'rename'
  | 'readFile'
  | 'writeFile'
>;

export type AccountFolderEnvironment = {
  /** The user's home directory, which holds `.claude` and `.claude.json`. */
  homeDir: string;
  platform: NodeJS.Platform;
  fs?: AccountFolderFs;
};

export type PrepareAccountFolderResult = {
  /**
   * Parts of the shared setup that were not brought in step this time (a directory that could
   * not be linked, a file another program was writing, an item edited on both sides), with the
   * reason. None of them stops a session from starting; the next preparation tries again.
   */
  skipped: Array<{ name: string; reason: string }>;
};

const CREDENTIALS_FILE = '.credentials.json';
const STATE_FILE = '.claude.json';

/**
 * Keys of `.claude.json` that describe the signed-in account or cache what it is entitled to.
 * A new account starts without them and lets the CLI fill them in for its own sign-in. Keys
 * named `cached…` or `…Cache` are dropped as well.
 */
const ACCOUNT_BOUND_STATE_KEYS = new Set([
  'oauthAccount',
  'userID',
  'primaryApiKey',
  'customApiKeyResponses',
  'claudeAiMcpEverConnected',
  'hasAvailableSubscription',
  'recommendedSubscription',
  'subscriptionNoticeCount',
  'hasAvailableMaxSubscription',
  'isQualifiedForDataSharing',
  'organizationSettings',
]);

export function primaryClaudeDir(homeDir: string): string {
  return path.join(homeDir, '.claude');
}

export function primaryClaudeStateFile(homeDir: string): string {
  return path.join(homeDir, STATE_FILE);
}

/**
 * Creates the folder if needed and brings it up to date with the primary setup. Idempotent and
 * safe to call before every launch: a second call with nothing changed writes nothing.
 */
export async function prepareAccountFolder(
  accountDir: string,
  environment: AccountFolderEnvironment
): Promise<PrepareAccountFolderResult> {
  const fs = environment.fs ?? nodeFs;
  const primaryDir = primaryClaudeDir(environment.homeDir);
  await fs.mkdir(accountDir, { recursive: true });

  const skipped = await shareDirectories(fs, accountDir, primaryDir, environment.platform);
  const primaryStateFile = primaryClaudeStateFile(environment.homeDir);
  try {
    await seedStateFile(fs, primaryStateFile, path.join(accountDir, STATE_FILE));
  } catch (error) {
    if (!isCode(error, 'EEXIST')) skipped.push({ name: STATE_FILE, reason: errorMessage(error) });
  }
  skipped.push(...(await syncSharedSetup(fs, { accountDir, primaryDir, primaryStateFile })));
  return { skipped };
}

/**
 * Deletes an account folder without ever following a link. Links (junctions on Windows) are
 * unlinked; only real directories are entered, so nothing under `~/.claude` can be reached.
 * `accountsRoot` is the directory that holds every account folder; anything else is refused.
 */
export async function removeAccountFolder(
  accountDir: string,
  accountsRoot: string,
  fs: AccountFolderFs = nodeFs
): Promise<void> {
  const relative = path.relative(path.resolve(accountsRoot), path.resolve(accountDir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a folder outside the Claude accounts directory');
  }
  const info = await lstatOrNull(fs, accountDir);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    await removeLinkOrFile(fs, accountDir);
    return;
  }
  // The real location, so a child that resolves anywhere else is recognised as a link.
  await removeRealDirectory(fs, accountDir, await fs.realpath(accountDir));
}

async function removeRealDirectory(
  fs: AccountFolderFs,
  directory: string,
  realDirectory: string
): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    const child = path.join(directory, name);
    const info = await lstatOrNull(fs, child);
    if (!info) continue;
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const expected = path.join(realDirectory, name);
      // A directory that is not where its parent puts it is some kind of link the platform
      // did not report as one. It is detached, never entered.
      if (await resolvesTo(fs, child, expected)) {
        await removeRealDirectory(fs, child, expected);
        continue;
      }
    }
    await removeLinkOrFile(fs, child);
  }
  await fs.rmdir(directory);
}

/** Removes one entry itself: a file, or a link without touching what it points at. */
async function removeLinkOrFile(fs: AccountFolderFs, entry: string): Promise<void> {
  try {
    await fs.unlink(entry);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    // A directory link that the platform will not unlink. `rmdir` is not recursive: it
    // detaches a link and fails on a directory with content, so it cannot delete a target.
    await fs.rmdir(entry);
  }
}

async function resolvesTo(fs: AccountFolderFs, entry: string, expected: string): Promise<boolean> {
  try {
    return samePath(await fs.realpath(entry), expected);
  } catch {
    return false;
  }
}

/** Links every subdirectory of the primary setup into the account folder. */
async function shareDirectories(
  fs: AccountFolderFs,
  accountDir: string,
  primaryDir: string,
  platform: NodeJS.Platform
): Promise<PrepareAccountFolderResult['skipped']> {
  const skipped: PrepareAccountFolderResult['skipped'] = [];
  const shared = new Set<string>();
  const linkType = platform === 'win32' ? 'junction' : 'dir';

  await adoptAccountDirectories(fs, accountDir, primaryDir);

  for (const name of await readdirOrEmpty(fs, primaryDir)) {
    if (name === CREDENTIALS_FILE) continue;
    const target = path.join(primaryDir, name);
    if (!(await isDirectory(fs, target))) continue;
    shared.add(name);

    const link = path.join(accountDir, name);
    const existing = await lstatOrNull(fs, link);
    if (existing?.isSymbolicLink()) {
      if (await linkPointsAt(fs, link, target)) continue;
      await removeLinkOrFile(fs, link);
    } else if (existing?.isDirectory()) {
      // Only an empty directory is replaced; one with content is somebody's data.
      try {
        await fs.rmdir(link);
      } catch {
        skipped.push({ name, reason: 'a folder with its own content is in the way' });
        continue;
      }
    } else if (existing) {
      skipped.push({ name, reason: 'a file of the same name is in the way' });
      continue;
    }
    try {
      await fs.symlink(target, link, linkType);
    } catch (error) {
      // Another launch preparing the same folder got there first.
      if (isCode(error, 'EEXIST') && (await linkPointsAt(fs, link, target))) continue;
      skipped.push({ name, reason: errorMessage(error) });
    }
  }

  // A link left behind by a directory that is gone from the primary setup would stop the CLI
  // from creating that directory again.
  for (const name of await readdirOrEmpty(fs, accountDir)) {
    if (shared.has(name)) continue;
    const link = path.join(accountDir, name);
    if (!(await lstatOrNull(fs, link))?.isSymbolicLink()) continue;
    const target = await fs.readlink(link).catch(() => null);
    if (target === null || !samePath(path.dirname(stripLinkPrefix(target)), primaryDir)) continue;
    await removeLinkOrFile(fs, link);
  }
  return skipped;
}

/**
 * A real directory in the account folder that the primary setup does not have yet (the CLI
 * created it while running under this account) is moved into the primary setup, so it is
 * shared like the rest. Left in place when it cannot be moved, for example while in use.
 */
async function adoptAccountDirectories(
  fs: AccountFolderFs,
  accountDir: string,
  primaryDir: string
): Promise<void> {
  if (!(await isDirectory(fs, primaryDir))) return;
  for (const name of await readdirOrEmpty(fs, accountDir)) {
    const own = path.join(accountDir, name);
    const info = await lstatOrNull(fs, own);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const target = path.join(primaryDir, name);
    if (await lstatOrNull(fs, target)) continue;
    await fs.rename(own, target).catch(() => undefined);
  }
}

async function linkPointsAt(fs: AccountFolderFs, link: string, target: string): Promise<boolean> {
  try {
    return samePath(stripLinkPrefix(await fs.readlink(link)), target);
  } catch {
    return false;
  }
}

/** Windows reports junction targets with a `\\?\` prefix and sometimes a trailing separator. */
function stripLinkPrefix(target: string): string {
  return target.startsWith('\\\\?\\') ? target.slice(4) : target;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * The account's `.claude.json` is seeded once from the primary file, without anything that
 * belongs to the primary sign-in. After that the file is the CLI's; only its `mcpServers` are
 * kept in step with the primary file, by the shared-setup sync.
 */
async function seedStateFile(
  fs: AccountFolderFs,
  primaryFile: string,
  accountFile: string
): Promise<void> {
  if ((await readTextOrNull(fs, accountFile)) !== null) return;
  const primaryText = await readTextOrNull(fs, primaryFile);
  const primary = primaryText === null ? {} : parseObject(primaryText);
  // Unreadable right now (the CLI may be mid-write): seed on a later preparation instead.
  if (!primary) throw new Error('the primary .claude.json could not be read');
  await fs.writeFile(accountFile, serializeState(seedAccountState(primary)), {
    encoding: 'utf8',
    mode: 0o600,
    // Never over a file the CLI created in the meantime.
    flag: 'wx',
  });
}

/** The primary `.claude.json` without the primary sign-in's identity and entitlement caches. */
export function seedAccountState(primary: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(primary).filter(
      ([key]) => !ACCOUNT_BOUND_STATE_KEYS.has(key) && !/^cached|Cache$/.test(key)
    )
  );
}

function serializeState(state: Record<string, unknown>): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

async function readTextOrNull(fs: AccountFolderFs, file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'EISDIR')) return null;
    throw error;
  }
}

async function readdirOrEmpty(fs: AccountFolderFs, directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return [];
    throw error;
  }
}

async function lstatOrNull(fs: AccountFolderFs, entry: string) {
  try {
    return await fs.lstat(entry);
  } catch (error) {
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTDIR')) return null;
    throw error;
  }
}

/** Follows links: a linked directory in the primary setup is shared like a real one. */
async function isDirectory(fs: AccountFolderFs, entry: string): Promise<boolean> {
  try {
    return (await fs.stat(entry)).isDirectory();
  } catch {
    return false;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
