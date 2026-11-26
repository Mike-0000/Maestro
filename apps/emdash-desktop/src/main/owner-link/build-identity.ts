import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildIdentity } from '@core/features/client-mode/api/build-identity';

// Which build this process is, for the owner handshake: client and host must run the same one.
// Electron-free: callers in the host and client composition pass `app.isPackaged`,
// `app.getVersion()` and `process.resourcesPath`.

/** Development builds may skip the build check with this set to `1`; ignored when packaged. */
export const SKIP_BUILD_CHECK_ENV = 'MAESTRO_SKIP_BUILD_CHECK';

const PROVENANCE_FILE = 'build-provenance.json';

export type BuildIdentitySource = {
  isPackaged: boolean;
  /** `app.getVersion()`. */
  version: string;
  /** `process.resourcesPath`; where a packaged build keeps `build-provenance.json`. */
  resourcesPath: string | undefined;
  readFile?: (path: string) => Promise<string>;
};

/**
 * The identity of this build. A packaged build takes its commit from
 * `<resources>/build-provenance.json` (written at packaging time); a build without that file, or
 * with one that cannot be read, has no commit and is matched by version alone. A development
 * run never has a commit.
 */
export async function resolveBuildIdentity(source: BuildIdentitySource): Promise<BuildIdentity> {
  if (!source.isPackaged) return { version: source.version, commit: null, dev: true };
  return { version: source.version, commit: await readProvenanceCommit(source), dev: false };
}

/** True when an unpackaged run asked to skip the build check (D6). */
export function isBuildCheckSkipped(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return !isPackaged && env[SKIP_BUILD_CHECK_ENV] === '1';
}

async function readProvenanceCommit(source: BuildIdentitySource): Promise<string | null> {
  if (!source.resourcesPath) return null;
  try {
    const text = await (source.readFile ?? readUtf8)(join(source.resourcesPath, PROVENANCE_FILE));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const commit = (parsed as { commit?: unknown }).commit;
    return typeof commit === 'string' && commit.trim() ? commit.trim() : null;
  } catch {
    return null;
  }
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
