import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MirrorSession, type MirrorState } from './mirror-session';
import { createWslMirrorAgents } from './wsl-agents';
import { WslMirrorService } from './wsl-mirror-service';

/**
 * The mirror against a real distro: a folder on the Windows disk and a folder on the distro's
 * own disk. Run with `EMDASH_TEST_WSL_DISTRO=<distro>`; skipped otherwise.
 */
const distro = process.env.EMDASH_TEST_WSL_DISTRO;

function inDistro(script: string, ...args: string[]): string {
  return execFileSync(
    'wsl.exe',
    ['-d', distro ?? '', '--cd', '~', '--exec', '/bin/sh', '-c', script, 'sh', ...args],
    { encoding: 'utf8' }
  ).trim();
}

function gitOnWindows(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function until(check: () => boolean, what: string, timeoutMs = 30_000): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Date.now() - started;
}

describe.skipIf(!distro || process.platform !== 'win32')('WSL mirror against a real distro', () => {
  const windowsPath = distro ? mkdtempSync(join(tmpdir(), 'maestro-mirror-wsl-')) : '';
  const linuxPath = distro ? inDistro('mktemp -d "$HOME/.maestro-mirror-test-XXXXXX"') : '';
  let session: MirrorSession | undefined;

  afterAll(async () => {
    await session?.stop();
    if (distro) inDistro('rm -rf "$1"', linuxPath);
    if (windowsPath) rmSync(windowsPath, { recursive: true, force: true });
  });

  it('keeps files and git state the same on both disks', { timeout: 180_000 }, async () => {
    const env = [
      '-c',
      'user.name=Mirror Test',
      '-c',
      'user.email=mirror@test.invalid',
      '-c',
      'core.autocrlf=false',
    ];
    gitOnWindows(windowsPath, 'init', '-q', '-b', 'main');
    writeFileSync(join(windowsPath, '.gitignore'), 'node_modules/\ndist/\n.env\n');
    mkdirSync(join(windowsPath, 'src', 'deep'), { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(
        join(windowsPath, 'src', `file${index}.ts`),
        `export const v${index} = ${index};\n`
      );
    }
    writeFileSync(join(windowsPath, 'src', 'deep', 'run.sh'), '#!/bin/sh\necho hi\n');
    gitOnWindows(windowsPath, 'add', '-A');
    gitOnWindows(windowsPath, ...env, 'commit', '-qm', 'first');
    // Uncommitted work, an ignored file worth keeping, and things each side keeps to itself.
    writeFileSync(join(windowsPath, 'src', 'file0.ts'), 'export const v0 = "uncommitted";\n');
    writeFileSync(join(windowsPath, '.env'), 'KEY=1\n');
    mkdirSync(join(windowsPath, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(windowsPath, 'node_modules', 'pkg', 'index.js'), 'windows only\n');

    // The copy starts as a clone, as "Run in WSL" makes it.
    const mount = inDistro('wslpath -a -u "$1"', windowsPath);
    inDistro(
      'rmdir "$2" && git -c safe.directory="$1" -c safe.directory="$1/.git" clone -q --no-hardlinks "$1" "$2"',
      mount,
      linuxPath
    );

    let saved: MirrorState | null = null;
    session = new MirrorSession({
      seed: true,
      createAgents: () =>
        createWslMirrorAgents({ windowsPath, distro: distro ?? '', linuxPath, preserve: ['.env'] }),
      loadState: async () => saved,
      saveState: async (state) => {
        saved = state;
      },
    });
    session.start();
    await session.whenSynced();

    expect(inDistro('cat "$1/src/file0.ts"', linuxPath)).toBe('export const v0 = "uncommitted";');
    expect(inDistro('cat "$1/.env"', linuxPath)).toBe('KEY=1');
    expect(inDistro('ls "$1/node_modules" 2>/dev/null | wc -l', linuxPath)).toBe('0');
    expect(inDistro('stat -f -c %T "$1"', linuxPath)).not.toBe('v9fs');
    // Both sides see the same single uncommitted change, and nothing else.
    expect(inDistro('git -C "$1" status --porcelain', linuxPath)).toBe('M src/file0.ts');
    expect(gitOnWindows(windowsPath, 'status', '--porcelain')).toBe('M src/file0.ts');

    // An edit in the distro reaches Windows, and one on Windows reaches the distro.
    inDistro('printf "from the distro\\n" > "$1/src/file1.ts"', linuxPath);
    const toWindows = await until(
      () => readFileSync(join(windowsPath, 'src', 'file1.ts'), 'utf8') === 'from the distro\n',
      'the distro edit to reach Windows'
    );
    writeFileSync(join(windowsPath, 'src', 'file2.ts'), 'from windows\n');
    const toDistro = await until(
      () => inDistro('cat "$1/src/file2.ts"', linuxPath) === 'from windows',
      'the Windows edit to reach the distro'
    );
    console.info(`mirror latency: distro→windows ${toWindows} ms, windows→distro ${toDistro} ms`);

    // A script made on Windows can be run in the distro.
    writeFileSync(join(windowsPath, 'tool.sh'), '#!/bin/sh\necho ran\n');
    await until(
      () => inDistro('[ -x "$1/tool.sh" ] && "$1/tool.sh" || true', linuxPath) === 'ran',
      'the new script to be runnable in the distro'
    );

    // Deleting in the distro deletes on Windows, kept aside in the repository's trash.
    inDistro('rm "$1/src/file3.ts"', linuxPath);
    await until(
      () => !existsSync(join(windowsPath, 'src', 'file3.ts')),
      'the deletion to reach Windows'
    );

    // A folder removed and made again in the distro is still watched afterwards.
    inDistro(
      'rm -rf "$1/src/deep" && mkdir "$1/src/deep" && echo again > "$1/src/deep/again.txt"',
      linuxPath
    );
    await until(
      () => existsSync(join(windowsPath, 'src', 'deep', 'again.txt')),
      'the remade folder to reach Windows'
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    inDistro('echo later > "$1/src/deep/later.txt"', linuxPath);
    await until(
      () => existsSync(join(windowsPath, 'src', 'deep', 'later.txt')),
      'a later file in the remade folder',
      5_000
    );

    // A rename that only changes case, which Windows cannot tell from the old name.
    inDistro('mv "$1/src/file4.ts" "$1/src/File4.ts"', linuxPath);
    await until(
      () => readdirSync(join(windowsPath, 'src')).includes('File4.ts'),
      'the case-only rename to reach Windows'
    );
    expect(readdirSync(join(windowsPath, 'src'))).not.toContain('file4.ts');

    // A commit made in the distro is a commit on Windows.
    inDistro(
      'cd "$1" && git add -A && git -c user.name=t -c user.email=t@t commit -qm second',
      linuxPath
    );
    const second = inDistro('git -C "$1" rev-parse HEAD', linuxPath);
    await until(
      () => gitOnWindows(windowsPath, 'rev-parse', 'HEAD') === second,
      'the commit to reach Windows'
    );
    await until(
      () => gitOnWindows(windowsPath, 'status', '--porcelain') === '',
      'a clean status on Windows'
    );

    // A branch made and committed to on Windows is checked out in the distro.
    gitOnWindows(windowsPath, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(windowsPath, 'feature.txt'), 'feature\n');
    gitOnWindows(windowsPath, 'add', '-A');
    gitOnWindows(windowsPath, ...env, 'commit', '-qm', 'third');
    const third = gitOnWindows(windowsPath, 'rev-parse', 'HEAD');
    await until(
      () => inDistro('git -C "$1" symbolic-ref --short HEAD', linuxPath) === 'feature',
      'the distro to follow the branch'
    );
    await until(
      () => inDistro('git -C "$1" rev-parse HEAD', linuxPath) === third,
      'the commit to reach the distro'
    );
    await until(
      () => inDistro('git -C "$1" status --porcelain', linuxPath) === '',
      'a clean status in the distro'
    );
    expect(session.status().conflicts).toEqual([]);
    expect(session.status().gitNote).toBeNull();
  });

  it('runs a remembered mirror through the service', { timeout: 120_000 }, async () => {
    const windows = mkdtempSync(join(tmpdir(), 'maestro-mirror-wsl-service-'));
    const linux = inDistro('mktemp -d "$HOME/.maestro-mirror-test-XXXXXX"');
    const data = mkdtempSync(join(tmpdir(), 'maestro-mirror-wsl-data-'));
    const mirrors = new WslMirrorService({
      directory: data,
      log: { info: () => {}, warn: () => {} },
    });
    try {
      writeFileSync(join(windows, 'notes.txt'), 'from windows\n');
      writeFileSync(join(windows, '.emdash.json'), '{"preservePatterns":["local.cfg"]}\n');
      const created = await mirrors.create({
        name: 'service',
        windowsPath: windows,
        distro: distro ?? '',
        linuxPath: linux,
      });
      const synced = await mirrors.waitUntilSynced(created.id, 60_000);
      expect(synced.status.phase).toBe('synced');
      expect(inDistro('cat "$1/notes.txt"', linux)).toBe('from windows');

      inDistro('printf "from the distro\\n" > "$1/reply.txt"', linux);
      await until(
        () => existsSync(join(windows, 'reply.txt')),
        'the distro file to reach Windows through the service'
      );
      expect(readFileSync(join(windows, 'reply.txt'), 'utf8')).toBe('from the distro\n');
    } finally {
      await mirrors.dispose();
      inDistro('rm -rf "$1"', linux);
      rmSync(windows, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});
