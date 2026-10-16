import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { InvestigationEvidence } from '../../api/contract';
import type { ScoutEvidence } from './claude-scout';
import { isScoutDenied } from './scout-deny';

/** A file larger than this is not searched for a quote. */
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Looks up each quote a scout gave in the file it named. A scout can be confidently wrong, and
 * its answer rests on text it read in an untrusted repository, so a quote counts as found only
 * when the main process itself reads it: in a regular file, inside the project folder (or one of
 * the extra folders the scout was given) once every link is followed, under the size limit, and
 * not on the deny list.
 *
 * Call this before redacting. A redacted quote would no longer match its file.
 */
export async function checkEvidence(
  cwd: string,
  items: readonly ScoutEvidence[],
  extraFolders: readonly string[] = []
): Promise<InvestigationEvidence[]> {
  const roots = (
    await Promise.all([cwd, ...extraFolders].map((folder) => realpath(folder).catch(() => null)))
  ).filter((root): root is string => root !== null);
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      found: roots.length === 0 ? false : await quoteIsInFile(roots, cwd, item).catch(() => false),
    }))
  );
}

async function quoteIsInFile(
  roots: readonly string[],
  cwd: string,
  item: ScoutEvidence
): Promise<boolean> {
  const quote = collapse(item.quote);
  if (!quote) return false;
  for (const candidate of candidatePaths(item.path)) {
    const named = path.resolve(cwd, candidate);
    const file = await realpath(named).catch(() => null);
    if (file === null) continue;
    const root = roots.find((folder) => isInside(path.relative(folder, file)));
    if (root === undefined) return false;
    const relative = path.relative(root, file);
    // Denied by the name the scout used, or by the name the file really has behind a link.
    if (isScoutDenied(relative) || isScoutDenied(path.relative(cwd, named))) return false;
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_EVIDENCE_FILE_BYTES) return false;
    return collapse(await readFile(file, 'utf8')).includes(quote);
  }
  return false;
}

/** False for the project folder itself, anything above it, and another drive. */
function isInside(relative: string): boolean {
  if (!relative || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * A scout on Windows writes `src\file.ts`, and so may a model anywhere. Elsewhere a backslash is
 * an ordinary character in a name, so the path is tried as given first.
 */
function candidatePaths(reported: string): string[] {
  if (path.sep === '\\' || !reported.includes('\\')) return [reported];
  return [reported, reported.replaceAll('\\', '/')];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
