import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isLocalHostRef } from '@emdash/core/primitives/host/api';
import { containsAbsolute, parseNativeAbsolute } from '@emdash/core/primitives/path/api';
import { err, ok, type Result } from '@emdash/shared';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import type { MarkdownAccessError } from '../api/contract';
import { fileNameOf, isImagePath, isMarkdownPath, localReferencePath } from '../api/markdown-paths';

/**
 * Decides which files the Markdown viewer may read, and reads them. A file is allowed when its
 * real path (symlinks resolved) is inside the agent's working directory or the project folder,
 * it is a regular file, and it has a Markdown extension (an image extension for a picture a
 * document embeds). Every read goes through here, so a window that kept a path from an earlier
 * run is checked again.
 *
 * Security-sensitive: this is the only bound on what an agent can make the viewer display.
 */

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type WorkspaceRef = { readonly projectId: string; readonly workspaceId: string };
type AccessResult<T> = Result<T, MarkdownAccessError>;
type FileKind = 'markdown' | 'image';
type Roots = {
  /** The workspace folder as recorded: relative paths are read against it. */
  readonly workspace: string;
  /** Allowed folders as recorded and with symlinks resolved, for the check before the disk is read. */
  readonly spelled: readonly string[];
  /** Allowed folders with symlinks resolved: the real path of a file must be inside one. */
  readonly real: readonly string[];
};

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const OUTSIDE_ROOTS =
  "That file is outside the agent's working directory and the project folder, so it cannot be shown.";

function fail(code: MarkdownAccessError['code'], message: string): AccessResult<never> {
  return err({ code, message });
}

/**
 * Whether `candidate` is `root` or inside it. Lexical: pass real paths to follow symlinks. A path
 * the parser cannot make sense of (a device path such as `\\.\C:\…`) is inside nothing.
 */
export function isPathInside(root: string, candidate: string): boolean {
  try {
    const parsedRoot = parseNativeAbsolute(root);
    const parsedCandidate = parseNativeAbsolute(candidate);
    return (
      parsedRoot.success &&
      parsedCandidate.success &&
      containsAbsolute(parsedRoot.data, parsedCandidate.data)
    );
  } catch {
    return false;
  }
}

export class MarkdownAccess {
  constructor(
    private readonly workspaces: Pick<WorkspaceIdentityService, 'resolve' | 'resolveProject'>
  ) {}

  /**
   * The canonical path of a Markdown file the viewer may show. A relative `path` is read against
   * the workspace folder, or against the folder of `from` when a document references it.
   */
  async resolveDocument(
    input: WorkspaceRef & { path: string; from?: string }
  ): Promise<AccessResult<{ path: string; name: string }>> {
    const located = await this.locate(input, 'markdown');
    if (!located.success) return located;
    return ok({ path: located.data.path, name: fileNameOf(located.data.path) });
  }

  async readDocument(
    input: WorkspaceRef & { path: string }
  ): Promise<AccessResult<{ path: string; name: string; content: string }>> {
    const located = await this.locate(input, 'markdown');
    if (!located.success) return located;
    const { path: file, size } = located.data;
    const name = fileNameOf(file);
    if (size > MAX_MARKDOWN_BYTES) {
      return fail('too-large', `${name} is ${megabytes(size)}; the viewer shows up to 2 MB.`);
    }
    try {
      return ok({ path: file, name, content: await readFile(file, 'utf8') });
    } catch {
      return fail('unreadable', `${name} could not be read.`);
    }
  }

  /** An image a document embeds, as a data URL. `src` is the reference as the document wrote it. */
  async readImage(
    input: WorkspaceRef & { from: string; src: string }
  ): Promise<AccessResult<{ dataUrl: string }>> {
    const reference = localReferencePath(input.src);
    if (!reference) return fail('invalid-path', 'That image is not a file in the workspace.');
    const located = await this.locate({ ...input, path: reference }, 'image');
    if (!located.success) return located;
    const { path: file, size } = located.data;
    const name = fileNameOf(file);
    if (size > MAX_IMAGE_BYTES) {
      return fail('too-large', `${name} is ${megabytes(size)}; the viewer shows up to 10 MB.`);
    }
    const mimeType = IMAGE_MIME_TYPES[path.extname(file).toLowerCase()];
    if (!mimeType) return fail('not-image', `"${name}" is not an image the viewer can show.`);
    try {
      const bytes = await readFile(file);
      return ok({ dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` });
    } catch {
      return fail('unreadable', `${name} could not be read.`);
    }
  }

  private async locate(
    input: WorkspaceRef & { path: string; from?: string },
    kind: FileKind
  ): Promise<AccessResult<{ path: string; size: number }>> {
    const requested = input.path.trim();
    if (!requested || requested.includes('\0')) {
      return fail('invalid-path', 'That is not a usable file path.');
    }
    // Refused by name before anything is looked up, so the tool cannot probe for other files.
    if (!accepts(kind, requested)) return wrongKind(kind, requested);
    const roots = await this.roots(input);
    if (!roots.success) return roots;

    let first: AccessResult<never> | undefined;
    for (const candidate of candidatePaths(roots.data.workspace, requested, input.from)) {
      const checked = await checkFile(candidate, roots.data, kind);
      if (checked.success) return checked;
      first ??= checked;
    }
    return first ?? fail('invalid-path', 'That is not a usable file path.');
  }

  private async roots(ref: WorkspaceRef): Promise<AccessResult<Roots>> {
    const workspace = await this.workspaces.resolve(ref.workspaceId);
    if (!workspace || workspace.projectId !== ref.projectId) {
      return fail('unknown-workspace', 'Maestro no longer knows the workspace this file is in.');
    }
    if (!isLocalHostRef(workspace.host)) {
      return fail(
        'remote-workspace',
        'This workspace is on another machine; the viewer only shows files on this computer.'
      );
    }
    const project = await this.workspaces.resolveProject(ref.projectId);
    const recorded = [
      workspace.path,
      ...(project && isLocalHostRef(project.host) ? [project.path] : []),
    ];
    const resolved = await Promise.all(recorded.map((root) => realpath(root).catch(() => null)));
    const real = resolved.filter((root): root is string => root !== null);
    if (real.length === 0) {
      return fail('unknown-workspace', 'The workspace folder is no longer on disk.');
    }
    return ok({ workspace: workspace.path, spelled: [...recorded, ...real], real });
  }
}

function accepts(kind: FileKind, file: string): boolean {
  return kind === 'markdown' ? isMarkdownPath(file) : isImagePath(file);
}

function wrongKind(kind: FileKind, file: string): AccessResult<never> {
  const name = fileNameOf(file);
  return kind === 'markdown'
    ? fail(
        'not-markdown',
        `Only Markdown files (.md, .markdown, .mdx) can be shown, and "${name}" is not one.`
      )
    : fail('not-image', `"${name}" is not an image the viewer can show.`);
}

/**
 * Where a path may point, most likely first. A document's reference that starts with one slash
 * is read from the workspace folder first (the Markdown convention), then as an absolute path.
 */
function candidatePaths(workspace: string, requested: string, from: string | undefined): string[] {
  const absolute = [
    ...driveSpelling(requested),
    ...(path.isAbsolute(requested) ? [path.resolve(requested)] : []),
  ];
  if (from === undefined) {
    return absolute.length > 0 ? absolute : [path.resolve(workspace, requested)];
  }
  if (/^[/\\](?![/\\])/u.test(requested)) {
    return [path.resolve(workspace, requested.replace(/^[/\\]+/u, '')), ...absolute];
  }
  return absolute.length > 0 ? absolute : [path.resolve(path.dirname(from), requested)];
}

/**
 * On Windows, a shell such as Git Bash writes `C:\repo\plan.md` as `/c/repo/plan.md`. Node would
 * read that as `\c\repo\plan.md` on the current drive, so the drive spelling is tried first.
 */
function driveSpelling(requested: string): string[] {
  if (process.platform !== 'win32') return [];
  const match = /^[/\\]([a-z])[/\\](.*)$/iu.exec(requested);
  return match ? [path.resolve(`${match[1]}:\\${match[2]}`)] : [];
}

async function checkFile(
  candidate: string,
  roots: Roots,
  kind: FileKind
): Promise<AccessResult<{ path: string; size: number }>> {
  // A path that is plainly elsewhere is refused without touching the disk.
  if (!roots.spelled.some((root) => isPathInside(root, candidate))) {
    return fail('outside-roots', OUTSIDE_ROOTS);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    return isMissing(error)
      ? fail('not-found', `There is no file at ${candidate}.`)
      : fail('unreadable', `${candidate} could not be read.`);
  }
  // A link inside an allowed folder may lead out of it, or to a file of another kind.
  if (!roots.real.some((root) => isPathInside(root, real))) {
    return fail('outside-roots', OUTSIDE_ROOTS);
  }
  if (!accepts(kind, real)) return wrongKind(kind, real);
  try {
    const info = await stat(real);
    if (!info.isFile()) return fail('not-a-file', `${candidate} is not a file.`);
    return ok({ path: real, size: info.size });
  } catch {
    return fail('unreadable', `${candidate} could not be read.`);
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
