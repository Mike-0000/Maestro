import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MirrorStatus } from '../api/types';
import { MIRROR_AGENT_SOURCE } from './mirror-agent-source';
import { createWorkerAgent } from './mirror-agents';
import { MirrorSession, type MirrorState } from './mirror-session';

/**
 * Two folders on this computer stand in for the Windows folder (`a`) and the copy in the
 * distro (`b`). Both agents are the real program; `b` reaches `a` by its path, as the distro
 * reaches the Windows folder through the drive mount.
 */

const sessions: MirrorSession[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folders(): { a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), 'maestro-mirror-'));
  roots.push(root);
  const a = join(root, 'a');
  const b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  return { a, b };
}

function write(root: string, rel: string, content: string): void {
  const target = join(root, ...rel.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function read(root: string, rel: string): string | null {
  const target = join(root, ...rel.split('/'));
  try {
    return readFileSync(target, 'utf8');
  } catch {
    // Not there, or a folder.
    return null;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function trashed(root: string): string[] {
  const trash = join(root, '.git', 'maestro-mirror', 'trash');
  if (!existsSync(trash)) return [];
  const found: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), next);
      else found.push(next);
    }
  };
  for (const stamp of readdirSync(trash)) visit(join(trash, stamp), '');
  return found;
}

type Started = {
  session: MirrorSession;
  status: () => MirrorStatus;
  saved: () => MirrorState | null;
};

function start(
  a: string,
  b: string,
  options: { seed?: boolean; state?: MirrorState | null; preserve?: string[] } = {}
): Started {
  let saved: MirrorState | null = options.state ?? null;
  const session = new MirrorSession({
    seed: options.seed ?? true,
    createAgents: async () => ({
      a: {
        agent: createWorkerAgent(MIRROR_AGENT_SOURCE),
        init: { root: a, preserve: options.preserve ?? ['.env'] },
      },
      b: {
        agent: createWorkerAgent(MIRROR_AGENT_SOURCE),
        // The per-folder watching the distro uses, so it is exercised here too.
        init: { root: b, peerRoot: a, watchMode: 'tree', preserve: options.preserve ?? ['.env'] },
      },
    }),
    loadState: async () => saved,
    saveState: async (state) => {
      saved = state;
    },
    timing: { debounceMs: 40, retryMinMs: 100, saveMs: 0, gitCheckMs: 2_000 },
  });
  sessions.push(session);
  session.start();
  return { session, status: () => session.status(), saved: () => saved };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('MirrorSession', { timeout: 60_000 }, () => {
  it('makes the copy match the Windows folder on the first run', async () => {
    const { a, b } = folders();
    write(a, 'src/one.ts', 'one');
    write(a, 'src/deep/two.ts', 'two');
    write(a, 'node_modules/pkg/index.js', 'not mirrored');
    write(b, 'src/one.ts', 'stale');
    write(b, 'left-over.txt', 'only in the copy');

    const { session, status } = start(a, b);
    await session.whenSynced();

    expect(read(b, 'src/one.ts')).toBe('one');
    expect(read(b, 'src/deep/two.ts')).toBe('two');
    expect(read(b, 'left-over.txt')).toBeNull();
    expect(read(b, 'node_modules/pkg/index.js')).toBeNull();
    expect(read(a, 'src/one.ts')).toBe('one');
    expect(status().files).toBe(2);
  });

  it('carries edits, new files and deletions both ways', async () => {
    const { a, b } = folders();
    write(a, 'keep.txt', 'v1');
    write(a, 'gone.txt', 'x');
    const { session } = start(a, b);
    await session.whenSynced();

    write(a, 'keep.txt', 'v2 from windows');
    write(b, 'new/in/copy.txt', 'from the distro');
    rmSync(join(b, 'gone.txt'));

    await until(() => read(b, 'keep.txt') === 'v2 from windows', 'the edit to reach the copy');
    await until(
      () => read(a, 'new/in/copy.txt') === 'from the distro',
      'the new file to reach Windows'
    );
    await until(() => read(a, 'gone.txt') === null, 'the deletion to reach Windows');

    write(b, 'keep.txt', 'v3 from the distro');
    rmSync(join(a, 'new'), { recursive: true });
    await until(() => read(a, 'keep.txt') === 'v3 from the distro', 'the edit to reach Windows');
    await until(() => !existsSync(join(b, 'new')), 'the removed folder to leave the copy');
  });

  it('keeps both versions when a file changed on both sides', async () => {
    const { a, b } = folders();
    git(a, 'init', '-q');
    write(a, 'shared.txt', 'base');
    git(b, 'init', '-q');
    const first = start(a, b);
    await first.session.whenSynced();
    await first.session.stop();

    write(a, 'shared.txt', 'the windows change');
    write(b, 'shared.txt', 'the distro change, newer');
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(b, 'shared.txt'), later, later);

    const second = start(a, b, { seed: false, state: first.saved() });
    await second.session.whenSynced();

    expect(read(a, 'shared.txt')).toBe('the distro change, newer');
    expect(read(b, 'shared.txt')).toBe('the distro change, newer');
    expect(trashed(a)).toContain('shared.txt');
    expect(second.status().conflicts.map((conflict) => conflict.path)).toContain('shared.txt');
  });

  it('never deletes when its record is lost', async () => {
    const { a, b } = folders();
    write(a, 'only-a.txt', 'a');
    write(b, 'only-b.txt', 'b');
    write(a, 'both.txt', 'same');
    write(b, 'both.txt', 'same');

    const { session } = start(a, b, { seed: false, state: null });
    await session.whenSynced();

    expect(read(b, 'only-a.txt')).toBe('a');
    expect(read(a, 'only-b.txt')).toBe('b');
    expect(read(a, 'both.txt')).toBe('same');
  });

  it('carries a deletion made while the mirror was stopped', async () => {
    const { a, b } = folders();
    write(a, 'stay.txt', 's');
    write(a, 'leave.txt', 'l');
    const first = start(a, b);
    await first.session.whenSynced();
    await first.session.stop();

    rmSync(join(a, 'leave.txt'));
    const second = start(a, b, { seed: false, state: first.saved() });
    await second.session.whenSynced();

    expect(read(b, 'leave.txt')).toBeNull();
    expect(read(b, 'stay.txt')).toBe('s');
  });

  it('carries a rename that only changes the case of a name', async () => {
    const { a, b } = folders();
    write(a, 'Readme.txt', 'text');
    const { session } = start(a, b);
    await session.whenSynced();

    renameSync(join(b, 'Readme.txt'), join(b, 'readme.txt'));
    await until(() => readdirSync(a).includes('readme.txt'), 'the new name to reach Windows');
    expect(readdirSync(a)).not.toContain('Readme.txt');
    expect(read(a, 'readme.txt')).toBe('text');
  });

  it('follows a folder that is replaced by a file, and the other way round', async () => {
    const { a, b } = folders();
    write(a, 'thing/child.txt', 'child');
    write(a, 'other', 'a file');
    const { session } = start(a, b);
    await session.whenSynced();

    rmSync(join(b, 'thing'), { recursive: true });
    write(b, 'thing', 'now a file');
    rmSync(join(a, 'other'));
    write(a, 'other/inside.txt', 'now a folder');

    await until(() => read(a, 'thing') === 'now a file', 'the file to replace the folder');
    await until(
      () => read(b, 'other/inside.txt') === 'now a folder',
      'the folder to replace the file'
    );
  });

  it('keeps watching a folder that was removed and made again', async () => {
    const { a, b } = folders();
    write(a, 'pkg/one.txt', '1');
    const { session } = start(a, b);
    await session.whenSynced();

    rmSync(join(b, 'pkg'), { recursive: true });
    mkdirSync(join(b, 'pkg'));
    write(b, 'pkg/two.txt', '2');
    await until(() => read(a, 'pkg/two.txt') === '2', 'the first file in the new folder');
    await until(() => read(a, 'pkg/one.txt') === null, 'the old file to go');

    // Later changes in the new folder are still seen at once, not at the next full read.
    await new Promise((resolve) => setTimeout(resolve, 500));
    write(b, 'pkg/three.txt', '3');
    await until(() => read(a, 'pkg/three.txt') === '3', 'a later file in the new folder', 5_000);
  });

  it('stops instead of deleting everything when one side is suddenly empty', async () => {
    const { a, b } = folders();
    for (let index = 0; index < 12; index += 1) write(a, `src/file${index}.txt`, `${index}`);
    const first = start(a, b);
    await first.session.whenSynced();
    await first.session.stop();

    // The copy is lost, as when a distro is reset.
    rmSync(join(b, 'src'), { recursive: true });
    const second = start(a, b, { seed: false, state: first.saved() });
    await until(() => second.status().phase === 'error', 'the mirror to stop');

    expect(second.status().error).toMatch(/in the distro is empty or missing/);
    expect(read(a, 'src/file0.txt')).toBe('0');
    expect(read(a, 'src/file11.txt')).toBe('11');
  });

  it('leaves out what git ignores, except the files worth keeping', async () => {
    const { a, b } = folders();
    git(a, 'init', '-q');
    write(a, '.gitignore', 'dist/\n*.log\n.env\n');
    write(a, 'src/app.ts', 'app');
    write(a, 'dist/app.js', 'built on windows');
    write(a, 'debug.log', 'log');
    write(a, '.env', 'KEY=1');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'init');
    execFileSync('git', ['clone', '-q', a, b]);
    write(b, 'dist/app.js', 'built in the distro');

    const { session } = start(a, b);
    await session.whenSynced();

    expect(read(b, 'src/app.ts')).toBe('app');
    expect(read(b, '.env')).toBe('KEY=1');
    expect(read(b, 'debug.log')).toBeNull();
    // Each side keeps its own build output.
    expect(read(b, 'dist/app.js')).toBe('built in the distro');
    expect(read(a, 'dist/app.js')).toBe('built on windows');

    write(b, 'dist/other.js', 'more output');
    write(b, 'src/new.ts', 'new');
    await until(() => read(a, 'src/new.ts') === 'new', 'the new source file to reach Windows');
    expect(read(a, 'dist/other.js')).toBeNull();
  });

  it('mirrors commits, branches and the checked-out branch', async () => {
    const { a, b } = folders();
    git(a, 'init', '-q', '-b', 'main');
    write(a, 'file.txt', 'one\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'first');
    git(a, 'branch', 'side');
    execFileSync('git', ['clone', '-q', a, b]);

    const { session, status } = start(a, b);
    await session.whenSynced();
    // The clone holds the Windows folder's branches as "remote" ones; those are not real.
    await until(() => git(b, 'for-each-ref', 'refs/remotes') === '', 'stand-in remote refs to go');
    expect(git(b, 'rev-parse', 'side')).toBe(git(a, 'rev-parse', 'side'));
    expect(git(a, 'for-each-ref', 'refs/remotes')).toBe('');

    // A commit made in the distro shows up on Windows as a commit, not as loose changes.
    write(b, 'file.txt', 'one\ntwo\n');
    write(b, 'added.txt', 'added\n');
    git(b, 'add', '-A');
    git(b, 'commit', '-qm', 'second');
    const second = git(b, 'rev-parse', 'HEAD');
    await until(() => git(a, 'rev-parse', 'HEAD') === second, 'the commit to reach Windows');
    await until(() => read(a, 'added.txt') === 'added\n', 'the committed file to reach Windows');
    await until(() => git(a, 'status', '--porcelain') === '', 'a clean status on Windows');

    // Switching branch on Windows switches it in the distro.
    git(a, 'checkout', '-q', '-b', 'feature');
    write(a, 'feature.txt', 'f\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'third');
    const third = git(a, 'rev-parse', 'HEAD');
    await until(
      () => git(b, 'symbolic-ref', '--short', 'HEAD') === 'feature',
      'the distro to follow the branch'
    );
    await until(() => git(b, 'rev-parse', 'HEAD') === third, 'the commit to reach the distro');
    await until(() => git(b, 'status', '--porcelain') === '', 'a clean status in the distro');
    expect(git(b, 'rev-parse', 'main')).toBe(second);
    expect(status().gitNote).toBeNull();
  });

  it('reports a branch that has different commits on each side and loses neither', async () => {
    const { a, b } = folders();
    git(a, 'init', '-q', '-b', 'main');
    write(a, 'file.txt', 'one\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'first');
    execFileSync('git', ['clone', '-q', a, b]);
    const first = start(a, b);
    await first.session.whenSynced();
    await first.session.stop();

    write(a, 'windows.txt', 'w\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'on windows');
    const onWindows = git(a, 'rev-parse', 'HEAD');
    write(b, 'distro.txt', 'd\n');
    git(b, 'add', '-A');
    git(b, 'commit', '-qm', 'in the distro');
    const inDistro = git(b, 'rev-parse', 'HEAD');

    const second = start(a, b, { seed: false, state: first.saved() });
    await second.session.whenSynced();
    await until(
      () => second.status().conflicts.some((conflict) => conflict.kind === 'branch'),
      'the diverged branch to be reported'
    );

    expect(git(a, 'rev-parse', 'main')).toBe(onWindows);
    expect(git(b, 'rev-parse', 'main')).toBe(inDistro);
    expect(git(a, 'rev-parse', 'refs/maestro-mirror/conflict/heads/main')).toBe(inDistro);
    expect(git(b, 'rev-parse', 'refs/maestro-mirror/conflict/heads/main')).toBe(onWindows);
    // Both sides' files are there, so the merge can be made on either.
    expect(read(a, 'distro.txt')).toBe('d\n');
    expect(read(b, 'windows.txt')).toBe('w\n');
  });
});
