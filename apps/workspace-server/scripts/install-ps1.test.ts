import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installScript = resolve(appDirectory, 'install.ps1');
const version = '1.2.3';
const artifact = `emdash-workspace-server-${version}-win32-x64.zip`;
const timeout = 60_000;

// install.ps1 only runs on Windows PowerShell; the zip fixture uses the bsdtar shipped with Windows.
describe.runIf(process.platform === 'win32')('workspace-server install.ps1', () => {
  let directory: string;
  let mirror: string;
  let installRoot: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'emdash-install-ps1-'));
    mirror = join(directory, 'mirror');
    installRoot = join(directory, 'home', '.emdash', 'workspace-server');
    await writeArtifact(join(directory, 'artifact'), join(mirror, version));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function install(args: string[]) {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        installScript,
        ...args,
      ],
      { encoding: 'utf8', timeout }
    );
    return { status: result.status, stderr: result.stderr };
  }

  const baseUrl = () => pathToFileURL(mirror).href;

  it(
    'installs a pinned version and skips the download on a repeated run',
    async () => {
      const first = install([
        '-BaseUrl',
        baseUrl(),
        '-Version',
        version,
        '-InstallRoot',
        installRoot,
      ]);
      expect(first).toEqual({ status: 0, stderr: '' });
      expect(await readFile(join(installRoot, 'current'), 'utf8')).toBe(`${version}\n`);
      const versionDirectory = join(installRoot, 'versions', version);
      expect(await readFile(join(versionDirectory, 'dist', 'index.mjs'), 'utf8')).toBe(
        'export {};\n'
      );
      expect((await stat(join(versionDirectory, 'node.exe'))).isFile()).toBe(true);
      await expect(stat(join(installRoot, 'install.lock'))).rejects.toThrow();

      // A selected, complete version needs neither the archive nor its checksum.
      await rm(join(mirror, version, artifact));
      const second = install([
        '-BaseUrl',
        baseUrl(),
        '-Version',
        version,
        '-Sha256',
        'a'.repeat(64),
        '-InstallRoot',
        installRoot,
      ]);
      expect(second).toEqual({ status: 0, stderr: '' });
      expect(await readFile(join(installRoot, 'current'), 'utf8')).toBe(`${version}\n`);
    },
    timeout
  );

  it(
    'rejects a checksum mismatch without selecting the version',
    async () => {
      await writeFile(
        join(mirror, version, `${artifact}.sha256`),
        `${'b'.repeat(64)}  ${artifact}\n`
      );
      const result = install([
        '-BaseUrl',
        baseUrl(),
        '-Version',
        version,
        '-InstallRoot',
        installRoot,
      ]);
      expect(result.status).toBe(41);
      expect(result.stderr).toContain(`checksum verification failed for ${artifact}`);
      await expect(stat(join(installRoot, 'current'))).rejects.toThrow();
      await expect(stat(join(installRoot, 'versions', version))).rejects.toThrow();
      await expect(stat(join(installRoot, 'install.lock'))).rejects.toThrow();
    },
    timeout
  );

  it(
    'reports a missing artifact as a download failure',
    () => {
      const result = install([
        '-BaseUrl',
        baseUrl(),
        '-Version',
        '9.9.9',
        '-InstallRoot',
        installRoot,
      ]);
      expect(result.status).toBe(41);
      expect(result.stderr).toContain('could not download the checksum');
    },
    timeout
  );

  it(
    'refuses an incomplete existing version directory',
    async () => {
      await mkdir(join(installRoot, 'versions', version), { recursive: true });
      const result = install([
        '-BaseUrl',
        baseUrl(),
        '-Version',
        version,
        '-InstallRoot',
        installRoot,
      ]);
      expect(result.status).toBe(42);
      expect(result.stderr).toContain(
        `existing workspace-server ${version} installation is incomplete`
      );
    },
    timeout
  );

  it(
    'validates arguments before touching the install root',
    async () => {
      expect(install(['-BaseUrl', 'ftp://example.test', '-Version', version])).toMatchObject({
        status: 41,
        stderr: expect.stringContaining('base URL must use https, http, or file'),
      });
      expect(install(['-BaseUrl', baseUrl()])).toMatchObject({
        status: 42,
        stderr: expect.stringContaining('-Version is required'),
      });
      expect(install(['-BaseUrl', baseUrl(), '-Version', '1.2'])).toMatchObject({
        status: 41,
        stderr: expect.stringContaining("invalid workspace-server version '1.2'"),
      });
      expect(
        install(['-BaseUrl', baseUrl(), '-Version', version, '-InstallRoot', 'relative\\root'])
      ).toMatchObject({
        status: 42,
        stderr: expect.stringContaining('-InstallRoot must be an absolute path'),
      });
      await expect(stat(installRoot)).rejects.toThrow();
    },
    timeout
  );
});

/** Writes a zip shaped like the packaged artifact (one top-level directory) plus its sidecar. */
async function writeArtifact(workDirectory: string, versionDirectory: string): Promise<void> {
  const root = join(workDirectory, 'emdash-workspace-server');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(versionDirectory, { recursive: true });
  await writeFile(join(root, 'node.exe'), 'fixture node');
  await writeFile(join(root, 'dist', 'index.mjs'), 'export {};\n');
  const archivePath = join(versionDirectory, artifact);
  const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(
    tar,
    ['--format', 'zip', '-cf', archivePath, 'emdash-workspace-server'],
    { cwd: workDirectory, encoding: 'utf8' }
  );
  if (result.status !== 0) throw new Error(`could not create fixture zip: ${result.stderr}`);
  const checksum = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  await writeFile(`${archivePath}.sha256`, `${checksum}  ${artifact}\n`);
}
