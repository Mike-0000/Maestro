import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Long enough for one pass over every known CLI; dropped sooner by `clear()` after an install. */
const LISTING_TTL_MS = 5_000;
/** A PATH folder that does not answer, such as a dead network share, is left alone for a while. */
const SLOW_DIR_TIMEOUT_MS = 5_000;
const SLOW_DIR_RETRY_MS = 5 * 60_000;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

type DirEntry = { name: string; isDirectory(): boolean };

export type WindowsPathScannerDeps = {
  /** The environment a program started now would get. */
  readEnv: () => Promise<Record<string, string | undefined>>;
  readDir?: (dir: string) => Promise<DirEntry[]>;
  now?: () => number;
  /** How long one folder may take to list. */
  dirTimeoutMs?: number;
};

export type WindowsPathScanner = {
  /** Every match for `command` in PATH order, as `where` lists them. Never starts a program. */
  find(command: string): Promise<string[]>;
  clear(): void;
};

type Listing = {
  expiresAt: number;
  /** Lowercased file name to the name on disk. */
  names: Promise<Map<string, string>>;
};

/**
 * Looks commands up on PATH by reading the folders directly. Starting `where.exe` blocks the
 * calling thread for as long as Windows takes to create the process, which endpoint security can
 * stretch to seconds, and a timed-out one then costs a `taskkill` as well.
 *
 * Unlike `where` this skips the current directory: a command found only there is not one that an
 * agent launch resolves through PATH.
 */
export function createWindowsPathScanner(deps: WindowsPathScannerDeps): WindowsPathScanner {
  const readDir =
    deps.readDir ?? ((dir: string) => readdir(dir, { withFileTypes: true }) as Promise<DirEntry[]>);
  const now = deps.now ?? Date.now;
  const dirTimeoutMs = deps.dirTimeoutMs ?? SLOW_DIR_TIMEOUT_MS;
  const listings = new Map<string, Listing>();

  const listDir = (dir: string): Promise<Map<string, string>> => {
    const key = dir.toLowerCase();
    const cached = listings.get(key);
    if (cached && cached.expiresAt > now()) return cached.names;

    const listing: Listing = {
      expiresAt: now() + LISTING_TTL_MS,
      names: withTimeout(readDir(dir), dirTimeoutMs).then(
        (entries) => {
          const names = new Map<string, string>();
          for (const entry of entries) {
            if (!entry.isDirectory()) names.set(entry.name.toLowerCase(), entry.name);
          }
          return names;
        },
        (error: unknown) => {
          if (error === DIR_TIMED_OUT) listing.expiresAt = now() + SLOW_DIR_RETRY_MS;
          // Like `where`, a PATH entry that cannot be read simply holds nothing.
          return new Map<string, string>();
        }
      ),
    };
    listings.set(key, listing);
    return listing.names;
  };

  return {
    async find(command) {
      if (!command || /[\\/]/.test(command)) return [];
      const env = await deps.readEnv();
      const dirs = pathDirs(envValue(env, 'PATH'));
      const candidates = [
        command,
        ...pathExtensions(envValue(env, 'PATHEXT')).map((ext) => command + ext),
      ].map((name) => name.toLowerCase());

      const listed = await Promise.all(dirs.map(listDir));
      const matches: string[] = [];
      dirs.forEach((dir, index) => {
        const names = listed[index];
        for (const candidate of new Set(candidates)) {
          const onDisk = names?.get(candidate);
          if (onDisk) matches.push(path.win32.join(dir, onDisk));
        }
      });
      return matches;
    },
    clear() {
      listings.clear();
    },
  };
}

const DIR_TIMED_OUT = Symbol('path folder timed out');

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(DIR_TIMED_OUT), timeoutMs);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Windows variable names ignore case, but a copied environment object does not. */
function envValue(env: Record<string, string | undefined>, name: string): string {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return (key ? env[key] : undefined) ?? '';
}

function pathDirs(value: string): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of value.split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    const key = dir.toLowerCase();
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

function pathExtensions(value: string): string[] {
  const source = value.trim() || DEFAULT_PATHEXT;
  return source
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.startsWith('.'));
}
