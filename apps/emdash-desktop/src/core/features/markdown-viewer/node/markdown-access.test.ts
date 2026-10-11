import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostRef, LOCAL_HOST_REF } from '@emdash/core/primitives/host/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceIdentity } from '@core/features/workspaces/api/node/workspace-identity-service';
import { isPathInside, MarkdownAccess, MAX_MARKDOWN_BYTES } from './markdown-access';

// A 1x1 PNG, so an embedded image has real bytes to come back as a data URL.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let root: string;
let project: string;
let worktree: string;
let outside: string;
let access: MarkdownAccess;
/** False where the OS refuses to create a file symlink (Windows without developer mode). */
let fileLinks = true;

const ws = { projectId: 'p1', workspaceId: 'ws1' };

beforeAll(async () => {
  // The real path: a temp folder is often reached through a link or a short name.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'markdown-access-')));
  project = path.join(root, 'project');
  worktree = path.join(root, 'worktrees', 'task');
  outside = path.join(root, 'outside');
  await mkdir(path.join(project, 'docs', 'img'), { recursive: true });
  await mkdir(path.join(worktree, 'notes'), { recursive: true });
  await mkdir(path.join(worktree, 'folder.md'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, 'README.md'), '# Project\n');
  await writeFile(path.join(project, 'docs', 'plan.md'), '# Plan\n\n![shot](img/shot.png)\n');
  await writeFile(path.join(project, 'docs', 'img', 'shot.png'), PNG);
  await writeFile(path.join(project, 'docs', 'notes.txt'), 'not markdown');
  await writeFile(path.join(worktree, 'PLAN.md'), '# Worktree plan\n');
  await writeFile(path.join(worktree, 'notes', 'deep.md'), 'deep');
  await writeFile(path.join(worktree, 'big.md'), 'x'.repeat(MAX_MARKDOWN_BYTES + 1));
  await writeFile(path.join(outside, 'secret.md'), '# Secret\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await writeFile(path.join(outside, 'secret.png'), PNG);
  // A folder link inside the worktree that leads out of it (a junction on Windows).
  await symlink(outside, path.join(worktree, 'elsewhere'), 'junction');
  try {
    await symlink(path.join(outside, 'secret.txt'), path.join(worktree, 'alias.md'), 'file');
  } catch {
    fileLinks = false;
  }

  const identities: Record<string, WorkspaceIdentity> = {
    ws1: { workspaceId: 'ws1', host: LOCAL_HOST_REF, path: worktree, projectId: 'p1' },
    remote: {
      workspaceId: 'remote',
      host: hostRef('remote', 'ssh-1'),
      path: '/srv/repo',
      projectId: 'p1',
    },
    gone: {
      workspaceId: 'gone',
      host: LOCAL_HOST_REF,
      path: path.join(root, 'deleted'),
      projectId: 'p3',
    },
  };
  access = new MarkdownAccess({
    resolve: async (workspaceId) => identities[workspaceId] ?? null,
    resolveProject: async (projectId) =>
      projectId === 'p1'
        ? { workspaceId: 'repo', host: LOCAL_HOST_REF, path: project, projectId: 'p1' }
        : null,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function refusal(input: { path: string; from?: string }, workspace = ws): Promise<string> {
  const result = await access.resolveDocument({ ...workspace, ...input });
  if (result.success) throw new Error(`Expected ${input.path} to be refused`);
  return result.error.code;
}

describe('isPathInside', () => {
  it('accepts the root and what is under it', () => {
    expect(isPathInside('/repo', '/repo')).toBe(true);
    expect(isPathInside('/repo', '/repo/docs/plan.md')).toBe(true);
    expect(isPathInside('C:\\repo', 'C:\\repo\\docs\\plan.md')).toBe(true);
  });

  it('refuses a sibling whose name starts the same, another drive, and a relative path', () => {
    expect(isPathInside('/repo', '/repo-other/plan.md')).toBe(false);
    expect(isPathInside('/repo/docs', '/repo/plan.md')).toBe(false);
    expect(isPathInside('C:\\repo', 'D:\\repo\\plan.md')).toBe(false);
    expect(isPathInside('C:\\repo', 'C:\\repository\\plan.md')).toBe(false);
    expect(isPathInside('/repo', 'docs/plan.md')).toBe(false);
  });

  it('compares Windows paths without regard to case', () => {
    expect(isPathInside('C:\\Repo', 'c:\\repo\\Docs\\plan.md')).toBe(true);
  });
});

describe('MarkdownAccess.resolveDocument', () => {
  it("reads a relative path against the agent's working directory", async () => {
    const result = await access.resolveDocument({ ...ws, path: 'PLAN.md' });
    expect(result).toEqual({
      success: true,
      data: { path: path.join(worktree, 'PLAN.md'), name: 'PLAN.md' },
    });
    const nested = await access.resolveDocument({ ...ws, path: './notes/deep.md' });
    expect(nested.success && nested.data.path).toBe(path.join(worktree, 'notes', 'deep.md'));
  });

  it('allows an absolute path inside the project folder', async () => {
    const result = await access.resolveDocument({
      ...ws,
      path: path.join(project, 'docs', 'plan.md'),
    });
    expect(result.success && result.data.path).toBe(path.join(project, 'docs', 'plan.md'));
  });

  it('refuses a file outside both folders, absolute or by climbing out', async () => {
    expect(await refusal({ path: path.join(outside, 'secret.md') })).toBe('outside-roots');
    expect(await refusal({ path: '../../outside/secret.md' })).toBe('outside-roots');
    expect(await refusal({ path: path.join(worktree, '..', '..', 'outside', 'secret.md') })).toBe(
      'outside-roots'
    );
  });

  it('refuses a file reached through a link that leaves the folder', async () => {
    expect(await refusal({ path: 'elsewhere/secret.md' })).toBe('outside-roots');
  });

  it('refuses a Markdown name that is a link to another kind of file', async () => {
    if (!fileLinks) return;
    expect(await refusal({ path: 'alias.md' })).toBe('outside-roots');
  });

  it('refuses anything that is not Markdown, inside the folders or not', async () => {
    expect(await refusal({ path: path.join(project, 'docs', 'notes.txt') })).toBe('not-markdown');
    expect(await refusal({ path: path.join(outside, 'secret.txt') })).toBe('not-markdown');
    expect(await refusal({ path: path.join(project, 'docs', 'img', 'shot.png') })).toBe(
      'not-markdown'
    );
  });

  it('reports a missing file and a folder with a Markdown name', async () => {
    expect(await refusal({ path: 'nowhere.md' })).toBe('not-found');
    expect(await refusal({ path: 'folder.md' })).toBe('not-a-file');
  });

  it('refuses a Windows device path instead of failing on it', async () => {
    expect(isPathInside('C:\\repo', '\\\\.\\C:\\repo\\plan.md')).toBe(false);
    if (process.platform !== 'win32') return;
    expect(await refusal({ path: `\\\\.\\${path.join(worktree, 'PLAN.md')}` })).toBe(
      'outside-roots'
    );
  });

  it('reads the Git Bash spelling of a Windows path', async () => {
    if (process.platform !== 'win32') return;
    const drive = worktree.slice(0, 1).toLowerCase();
    const spelled = `/${drive}${worktree.slice(2).replaceAll('\\', '/')}/PLAN.md`;
    const result = await access.resolveDocument({ ...ws, path: spelled });
    expect(result.success && result.data.path).toBe(path.join(worktree, 'PLAN.md'));
  });

  it('refuses an empty path and one with a null byte', async () => {
    expect(await refusal({ path: '   ' })).toBe('invalid-path');
    expect(await refusal({ path: 'PLAN.md\0.txt' })).toBe('invalid-path');
  });

  it('refuses a workspace it does not know, one of another project, and a remote one', async () => {
    expect(await refusal({ path: 'PLAN.md' }, { projectId: 'p1', workspaceId: 'nope' })).toBe(
      'unknown-workspace'
    );
    expect(await refusal({ path: 'PLAN.md' }, { projectId: 'p2', workspaceId: 'ws1' })).toBe(
      'unknown-workspace'
    );
    expect(await refusal({ path: 'PLAN.md' }, { projectId: 'p3', workspaceId: 'gone' })).toBe(
      'unknown-workspace'
    );
    expect(await refusal({ path: 'PLAN.md' }, { projectId: 'p1', workspaceId: 'remote' })).toBe(
      'remote-workspace'
    );
  });

  it("reads a document's own references against the document's folder", async () => {
    const from = path.join(project, 'docs', 'plan.md');
    const sibling = await access.resolveDocument({ ...ws, path: '../README.md', from });
    expect(sibling.success && sibling.data.path).toBe(path.join(project, 'README.md'));
    // A leading slash means the workspace folder, as it does on a code host.
    const rooted = await access.resolveDocument({ ...ws, path: '/notes/deep.md', from });
    expect(rooted.success && rooted.data.path).toBe(path.join(worktree, 'notes', 'deep.md'));
    expect(await refusal({ path: '../../outside/secret.md', from })).toBe('outside-roots');
  });
});

describe('MarkdownAccess.readDocument', () => {
  it('returns the content of an allowed file', async () => {
    const result = await access.readDocument({ ...ws, path: path.join(worktree, 'PLAN.md') });
    expect(result).toEqual({
      success: true,
      data: { path: path.join(worktree, 'PLAN.md'), name: 'PLAN.md', content: '# Worktree plan\n' },
    });
  });

  it('checks the path again, so a kept path outside the folders reads nothing', async () => {
    const result = await access.readDocument({ ...ws, path: path.join(outside, 'secret.md') });
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe('outside-roots');
  });

  it('refuses a file over the size limit', async () => {
    const result = await access.readDocument({ ...ws, path: 'big.md' });
    expect(!result.success && result.error.code).toBe('too-large');
  });
});

describe('MarkdownAccess.readImage', () => {
  const from = () => path.join(project, 'docs', 'plan.md');

  it('returns an image beside the document as a data URL', async () => {
    const result = await access.readImage({ ...ws, from: from(), src: 'img/shot.png?raw=1' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.dataUrl).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`
    );
  });

  it('refuses an image outside the folders, a file that is not an image, and a URL', async () => {
    const escaped = await access.readImage({
      ...ws,
      from: from(),
      src: '../../outside/secret.png',
    });
    expect(!escaped.success && escaped.error.code).toBe('outside-roots');
    const text = await access.readImage({ ...ws, from: from(), src: 'notes.txt' });
    expect(!text.success && text.error.code).toBe('not-image');
    const remote = await access.readImage({
      ...ws,
      from: from(),
      src: 'https://example.com/a.png',
    });
    expect(!remote.success && remote.error.code).toBe('invalid-path');
  });
});
