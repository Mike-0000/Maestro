import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FolderCheck } from '../../api/contract';
import { isScoutDenied } from './scout-deny';

/**
 * The folders outside a project that the developer lets a code check read as well. Each one is
 * checked here, in the main process, both when it is added in Settings and before every check:
 * the setting is only a list of strings, and a folder can change between the two.
 *
 * The rule is "one named folder of work", never "the computer": a drive root, the home folder,
 * anything that holds the home folder, and hidden or credential folders are refused.
 */

/** At most this many extra folders are passed to a scout; the rest are left out. */
export const MAX_SCOUT_FOLDERS = 10;

/**
 * Characters that Claude Code's permission rules read as a pattern or as the end of a rule. A
 * folder whose path holds one could widen or break its own deny rules, so it is refused.
 */
const RULE_CHARACTERS = /[*?[\]{}()\u0000-\u001f]/;

/** Folders under the home folder that hold settings and sign-ins, whatever their case. */
const PRIVATE_SEGMENTS = new Set(['appdata', 'library', 'keychains']);

export type FolderCheckOptions = {
  home?: string;
  platform?: NodeJS.Platform;
};

/** Checks one folder and, when it may be read, returns its real path (links followed). */
export async function checkScoutFolder(
  input: string,
  options: FolderCheckOptions = {}
): Promise<FolderCheck> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const given = input.trim();
  const refuse = (reason: string): FolderCheck => ({ ok: false, reason });

  if (!given) return refuse('No folder was given.');
  if (platform === 'win32' && /^[\\/]{2}/.test(given)) {
    return refuse('Network folders are not supported.');
  }
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!absolute(given)) return refuse('Give the full path of the folder.');
  if (RULE_CHARACTERS.test(given)) {
    return refuse('The path holds a character code checks cannot use: * ? [ ] { } ( ).');
  }
  const real = await realpath(given).catch(() => null);
  if (real === null) return refuse('That folder does not exist.');
  if (!(await stat(real).catch(() => null))?.isDirectory()) return refuse('That is not a folder.');
  if (RULE_CHARACTERS.test(real)) {
    return refuse('The real path holds a character code checks cannot use: * ? [ ] { } ( ).');
  }

  const key = (value: string) => {
    const resolved = path.resolve(value);
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  if (path.parse(real).root === real) return refuse('A whole drive cannot be read.');
  const realHome = await realpath(home).catch(() => home);
  if (key(real) === key(realHome)) return refuse('The whole home folder cannot be read.');
  if (isInside(key(realHome), key(real))) {
    return refuse('That folder holds the home folder, so it cannot be read.');
  }

  const segments = real.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    return refuse('Hidden folders hold settings and sign-ins, so they cannot be read.');
  }
  if (segments.some((segment) => PRIVATE_SEGMENTS.has(segment.toLowerCase()))) {
    return refuse('That folder holds app settings and sign-ins, so it cannot be read.');
  }
  if (segments.some((segment) => isScoutDenied(segment, platform))) {
    return refuse('That folder is on the list of secret files code checks never read.');
  }
  return { ok: true, path: real };
}

/**
 * The developer's extra folders that may be read now: checked, real paths, without repeats or
 * folders inside the project itself, and at most `MAX_SCOUT_FOLDERS`. A refused folder is left
 * out; `refused` says which and why, for the log.
 */
export async function usableScoutFolders(
  folders: readonly string[],
  projectFolder: string,
  options: FolderCheckOptions = {}
): Promise<{ folders: string[]; refused: { folder: string; reason: string }[] }> {
  const platform = options.platform ?? process.platform;
  const key = (value: string) =>
    platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value;
  const project = key(await realpath(projectFolder).catch(() => projectFolder));
  const checks = await Promise.all(folders.map((folder) => checkScoutFolder(folder, options)));
  const kept: string[] = [];
  const refused: { folder: string; reason: string }[] = [];
  checks.forEach((check, index) => {
    const folder = folders[index] ?? '';
    if (!check.ok) {
      refused.push({ folder, reason: check.reason });
      return;
    }
    const at = key(check.path);
    // The project is read anyway; a folder inside it adds nothing.
    if (at === project || isInside(at, project)) return;
    if (kept.some((other) => key(other) === at)) return;
    if (kept.length >= MAX_SCOUT_FOLDERS) {
      refused.push({ folder, reason: `Only ${MAX_SCOUT_FOLDERS} extra folders are read.` });
      return;
    }
    kept.push(check.path);
  });
  return { folders: kept, refused };
}

/** True when `inner` is strictly inside `outer`. */
function isInside(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}
