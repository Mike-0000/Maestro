import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { Logger } from '@emdash/shared/logger';
import {
  LOOKUP_LIMITS,
  lookupInputSchema,
  type ConductorSettings,
  type LookupError,
  type LookupResult,
  type LookupTermResult,
} from '../../api/contract';
import type { InvestigationFolder, InvestigationPorts } from './investigation-service';
import { isScoutDenied } from './scout-deny';

/**
 * The conductor's `find_in_project` job: where a name appears in a project, by file path and by
 * file text, so the conductor can place a term the developer used before it writes a prompt.
 *
 * It runs on Maestro's own file search, which serves every host the project can live on (this
 * computer, a WSL distro, an SSH machine), and it hands back names and counts only. No line of
 * any file leaves this function, and files on the scout's deny list are never named.
 */

/** Lines a content search may collect for one term before it stops. */
const CONTENT_LINE_LIMIT = 2_000;
/** Path hits asked of the index per term; most are dropped by the literal match below. */
const PATH_QUERY_LIMIT = 60;

/** The project search this job runs on, built in the node manifest from the search slice. */
export type LookupSearchPort = {
  /** Relevance-ordered files whose path matches `query`, relative to the workspace root. */
  searchFiles(workspaceId: string, query: string, limit: number): Promise<readonly string[]>;
  /** Files whose text holds `query` (literal, any case), with their matching lines counted. */
  searchContent(
    workspaceId: string,
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<{ files: readonly { path: string; lines: number }[]; complete: boolean } | null>;
};

export type ProjectLookupOptions = {
  readSettings(): Promise<ConductorSettings>;
  identity: InvestigationPorts['identity'];
  search: LookupSearchPort;
  logger: Logger;
};

export async function findInProject(
  input: unknown,
  context: { signal: AbortSignal; progress: (progress: { done: number }) => void },
  options: ProjectLookupOptions
): Promise<Result<LookupResult, LookupError>> {
  const request = lookupInputSchema.safeParse(input);
  if (!request.success) {
    return err({ type: 'failed', message: 'That lookup request was not valid.' });
  }
  const { target, terms } = request.data;
  if (!(await options.readSettings()).investigations) {
    return err({ type: 'disabled', message: 'Project lookups are turned off in Settings.' });
  }
  const folder: InvestigationFolder | null =
    'projectId' in target
      ? await options.identity.resolveProject(target.projectId)
      : await options.identity.resolve(target.workspaceId);
  if (!folder) return err({ type: 'not-found', message: 'That project was not found.' });

  let done = 0;
  try {
    const results = await Promise.all(
      terms.map(async (term) => {
        const result = await lookUp(folder.workspaceId, term, context.signal, options.search);
        context.progress({ done: ++done });
        return result;
      })
    );
    if (context.signal.aborted)
      return err({ type: 'failed', message: 'The lookup was cancelled.' });
    return ok({ folderName: baseName(folder.path), terms: results });
  } catch (error) {
    options.logger.warn('conductor: project lookup failed', { error });
    return err({ type: 'failed', message: 'The project could not be searched.' });
  }
}

async function lookUp(
  workspaceId: string,
  term: string,
  signal: AbortSignal,
  search: LookupSearchPort
): Promise<LookupTermResult> {
  const [pathHits, content] = await Promise.all([
    search.searchFiles(workspaceId, term, PATH_QUERY_LIMIT),
    search.searchContent(workspaceId, term, CONTENT_LINE_LIMIT, signal),
  ]);
  const wanted = squash(term);
  const paths = pathHits
    .filter((hit) => !isScoutDenied(hit) && squash(hit).includes(wanted))
    .slice(0, LOOKUP_LIMITS.pathHits);
  const files = (content?.files ?? []).filter((file) => !isScoutDenied(file.path));
  const ranked = [...files].sort((a, b) => b.lines - a.lines || compare(a.path, b.path));
  return {
    term,
    paths,
    files: ranked.slice(0, LOOKUP_LIMITS.fileHits).map(({ path: file, lines }) => ({
      path: file,
      lines: Math.max(1, lines),
    })),
    filesTotal: files.length,
    complete: content?.complete ?? false,
  };
}

/**
 * A name with case and separators taken out, so "talk line", "talk-line" and "TalkLine" all match
 * the path `talk/talk-line.ts`. The path index matches loosely; this keeps only real matches.
 */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function baseName(folder: string): string {
  return path.basename(folder.replace(/[\\/]+$/, '')) || folder;
}
