import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARTIFACT_PACKAGE_NAME = '@emdash/workspace-server';

/**
 * The root of a packaged artifact (`<root>/dist/index.mjs`, `<root>/manifest.json`,
 * `<root>/bin/rg[.exe]`). The POSIX launcher script exports the app version and ripgrep path, but
 * Windows starts `node.exe dist/index.mjs` directly (through WMI, outside any shell), so the
 * server also discovers both from the artifact it runs from.
 */
export function artifactRootDirectory(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL('.', moduleUrl)), '..');
}

/** The version recorded in the artifact manifest, or undefined outside a packaged artifact. */
export function readArtifactVersion(root: string = artifactRootDirectory()): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const manifest = raw as Record<string, unknown>;
  if (manifest['name'] !== ARTIFACT_PACKAGE_NAME) return undefined;
  const version = manifest['version'];
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}

/** The ripgrep binary bundled next to the artifact's launcher, when present. */
export function bundledRipgrepPath(
  root: string = artifactRootDirectory(),
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const candidate = join(root, 'bin', platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(candidate) ? candidate : undefined;
}
