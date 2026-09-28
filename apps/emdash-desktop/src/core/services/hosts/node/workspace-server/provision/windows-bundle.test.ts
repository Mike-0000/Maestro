import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { decodePowerShellStderr, encodePowerShellCommand } from '@emdash/core/primitives/exec/api';
import type { ClientChannel } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { windowsWorkspaceServerLayout } from '../layout';
import { WorkspaceServerInstaller } from './installer';
import {
  loadWindowsWorkspaceServerBundle,
  uploadFileToWindowsHost,
  windowsBundleLoader,
  type BundledFile,
} from './windows-bundle';

const installScriptSource = path.resolve(
  import.meta.dirname,
  '../../../../../../../../workspace-server/install.ps1'
);
const version = '1.2.3';
const archiveName = `emdash-workspace-server-${version}-win32-x64.zip`;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'emdash-ws-bundle-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function writeBundle(target: string, archive: Buffer): Promise<void> {
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, archiveName), archive);
  await writeFile(
    path.join(target, `${archiveName}.sha256`),
    `${sha256(archive)}  ${archiveName}\n`
  );
  await writeFile(path.join(target, 'install.ps1'), 'exit 0\n');
}

describe('loadWindowsWorkspaceServerBundle', () => {
  it('describes the archive and installer with their checksums', async () => {
    await writeBundle(directory, Buffer.from('archive bytes'));

    await expect(loadWindowsWorkspaceServerBundle(directory)).resolves.toEqual({
      version,
      archiveName,
      archive: {
        localPath: path.join(directory, archiveName),
        size: 13,
        sha256: sha256('archive bytes'),
      },
      installScript: {
        localPath: path.join(directory, 'install.ps1'),
        size: 7,
        sha256: sha256('exit 0\n'),
      },
    });
  });

  it('reports no bundle for a missing or empty directory', async () => {
    await expect(
      loadWindowsWorkspaceServerBundle(path.join(directory, 'missing'))
    ).resolves.toBeUndefined();
    await expect(loadWindowsWorkspaceServerBundle(directory)).resolves.toBeUndefined();
  });

  it('rejects an archive that does not match its sidecar', async () => {
    await writeBundle(directory, Buffer.from('archive bytes'));
    await writeFile(path.join(directory, archiveName), 'tampered');

    await expect(loadWindowsWorkspaceServerBundle(directory)).rejects.toThrow(
      'does not match its checksum sidecar'
    );
  });

  it('rejects ambiguous bundles and invalid versions', async () => {
    await writeBundle(directory, Buffer.from('archive bytes'));
    await writeFile(path.join(directory, 'emdash-workspace-server-1.2.4-win32-x64.zip'), 'another');
    await expect(loadWindowsWorkspaceServerBundle(directory)).rejects.toThrow('found');

    const invalid = path.join(directory, 'invalid');
    await mkdir(invalid);
    await writeFile(path.join(invalid, 'emdash-workspace-server-1.2-win32-x64.zip'), 'x');
    await expect(loadWindowsWorkspaceServerBundle(invalid)).rejects.toThrow();
  });

  it('caches a successful read and retries a failed one', async () => {
    await writeBundle(directory, Buffer.from('archive bytes'));
    await writeFile(path.join(directory, archiveName), 'tampered');
    const load = windowsBundleLoader(directory);

    await expect(load()).rejects.toThrow('checksum sidecar');
    await writeBundle(directory, Buffer.from('archive bytes'));
    const first = await load();
    expect(first?.version).toBe(version);
    await rm(path.join(directory, archiveName));
    await expect(load()).resolves.toBe(first);
  });
});

/** An exec channel stand-in: records stdin, then reports `exitCode` once stdin ends. */
function recordingChannel(exitCode: number, stderr = '') {
  const chunks: Buffer[] = [];
  const stderrStream = new PassThrough();
  const channel = new Writable({
    emitClose: false,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      callback();
      setImmediate(() => {
        stderrStream.end(stderr);
        channel.emit('exit', exitCode);
        channel.emit('close');
      });
    },
  });
  return {
    channel: Object.assign(channel, { stderr: stderrStream }) as unknown as ClientChannel,
    received: () => Buffer.concat(chunks),
  };
}

function decodeCommand(command: string): string {
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('uploadFileToWindowsHost', () => {
  async function localFile(bytes: Buffer): Promise<BundledFile> {
    const localPath = path.join(directory, 'payload.zip');
    await writeFile(localPath, bytes);
    return { localPath, size: bytes.length, sha256: sha256(bytes) };
  }

  it('streams the file to an encoded upload script and returns its result', async () => {
    const bytes = Buffer.alloc(300_000, 7);
    const file = await localFile(bytes);
    const { channel, received } = recordingChannel(0);
    const openExecChannel = vi.fn(async () => channel);

    const result = await uploadFileToWindowsHost(
      { openExecChannel },
      file,
      String.raw`C:\Users\O'Brien\.emdash\workspace-server\staging\x.zip`,
      { timeoutMs: 10_000 }
    );

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(received().equals(bytes)).toBe(true);
    const [command] = openExecChannel.mock.calls[0] as unknown as [string];
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = decodeCommand(command);
    expect(script).toContain(
      String.raw`$target = 'C:\Users\O''Brien\.emdash\workspace-server\staging\x.zip'`
    );
    expect(script).toContain('$remaining = [long]300000');
    expect(script).toContain(`'${file.sha256}'`);
    expect(command.endsWith(encodePowerShellCommand(script))).toBe(true);
  });

  it('reports the remote failure with decoded stderr', async () => {
    const file = await localFile(Buffer.from('bytes'));
    const { channel } = recordingChannel(
      41,
      '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Upload of x.zip was incomplete or corrupt_x000D__x000A_</S></Objs>'
    );

    await expect(
      uploadFileToWindowsHost({ openExecChannel: async () => channel }, file, 'C:\\x.zip', {
        timeoutMs: 10_000,
      })
    ).resolves.toEqual({
      exitCode: 41,
      stdout: '',
      stderr: 'Upload of x.zip was incomplete or corrupt',
    });
  });

  it('times out a stalled channel', async () => {
    const file = await localFile(Buffer.from('bytes'));
    // Never acknowledges a write, like a remote that stopped reading.
    const stalled = Object.assign(new Writable({ write() {} }), {
      stderr: new PassThrough(),
    }) as unknown as ClientChannel;

    await expect(
      uploadFileToWindowsHost({ openExecChannel: async () => stalled }, file, 'C:\\x.zip', {
        timeoutMs: 50,
      })
    ).rejects.toThrow('timed out');
  });
});

describe('WorkspaceServerInstaller with a Windows bundle', () => {
  const layout = windowsWorkspaceServerLayout(String.raw`C:\Users\dev`);
  const bundle = {
    version,
    archiveName,
    archive: { localPath: 'unused', size: 1, sha256: 'a'.repeat(64) },
    installScript: { localPath: 'unused', size: 1, sha256: 'b'.repeat(64) },
  };

  it('selects the bundled version for Windows hosts without reading the channel', async () => {
    const ensureProxy = vi.fn();
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy },
      windowsBundle: async () => bundle,
    });

    await expect(installer.availableVersion('ssh-1', undefined, 'windows')).resolves.toBe(version);
    expect(ensureProxy).not.toHaveBeenCalled();
  });

  it('does not upload when the bundled version is already installed', async () => {
    const execScript = vi.fn(async () => ({ exitCode: 0, stdout: version, stderr: '' }));
    const openExecChannel = vi.fn();
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: async () => ({ execScript, openExecChannel }) as never },
      windowsBundle: async () => bundle,
    });

    await installer.install({ connectionId: 'ssh-1', layout });

    expect(openExecChannel).not.toHaveBeenCalled();
  });

  it('reports an unusable bundle as an install failure', async () => {
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: vi.fn() },
      windowsBundle: async () => {
        throw new Error('sidecar mismatch');
      },
    });

    await expect(installer.availableVersion('ssh-1', undefined, 'windows')).rejects.toMatchObject({
      code: 'install-failed',
      message: 'The workspace server bundled with Maestro is unusable: sidecar mismatch',
    });
  });
});

/**
 * A proxy that runs Windows OpenSSH's default-shell behavior locally: every command line goes
 * through `cmd.exe /d /c`, and exec channels carry stdin to it.
 */
function localWindowsProxy(): SshClientProxy {
  const run = (command: string) =>
    spawn('cmd.exe', ['/d', '/c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    async execScript(command: string) {
      const result = spawnSync('cmd.exe', ['/d', '/c', command], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    },
    async openExecChannel(command: string) {
      const child = run(command);
      child.stdin.on('error', () => undefined);
      child.stdout.resume();
      const channel = new Writable({
        emitClose: false,
        write(chunk: Buffer, _encoding, callback) {
          child.stdin.write(chunk, callback);
        },
        final(callback) {
          child.stdin.end(callback);
        },
      });
      child.on('close', (code) => {
        channel.emit('exit', code);
        channel.emit('close');
      });
      return Object.assign(channel, { stderr: child.stderr }) as unknown as ClientChannel;
    },
  } as Partial<SshClientProxy> as SshClientProxy;
}

describe.runIf(process.platform === 'win32')('bundled Windows install end to end', () => {
  async function fixtureArchive(): Promise<Buffer> {
    const work = path.join(directory, 'artifact');
    const root = path.join(work, 'emdash-workspace-server');
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'node.exe'), 'fixture node');
    await writeFile(path.join(root, 'dist', 'index.mjs'), 'export {};\n');
    const archivePath = path.join(directory, 'fixture.zip');
    const tar = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    const result = spawnSync(
      tar,
      ['--format', 'zip', '-cf', archivePath, 'emdash-workspace-server'],
      {
        cwd: work,
        encoding: 'utf8',
      }
    );
    if (result.status !== 0) throw new Error(`could not create fixture zip: ${result.stderr}`);
    return await readFile(archivePath);
  }

  it('uploads the bundle, installs it with the real install.ps1, and skips a reinstall', async () => {
    const bundleDirectory = path.join(directory, 'bundle');
    await writeBundle(bundleDirectory, await fixtureArchive());
    await writeFile(path.join(bundleDirectory, 'install.ps1'), await readFile(installScriptSource));
    const home = path.join(directory, "O'Brien & Co %USERNAME% #1");
    await mkdir(home);
    const layout = windowsWorkspaceServerLayout(home);
    const proxy = localWindowsProxy();
    const openExecChannel = vi.spyOn(proxy, 'openExecChannel');
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: async () => proxy },
      baseUrl: 'https://unreachable.invalid/workspace-server',
      windowsBundle: windowsBundleLoader(bundleDirectory),
    });

    await expect(installer.availableVersion('ssh-1', undefined, 'windows')).resolves.toBe(version);
    await installer.install({ connectionId: 'ssh-1', layout });

    expect(await readFile(layout.currentPointer, 'utf8')).toBe(`${version}\n`);
    expect(await readFile(layout.versionEntrypoint(version), 'utf8')).toBe('export {};\n');
    expect(openExecChannel).toHaveBeenCalledTimes(2);
    // The run script removed the uploaded installer and the staged archive.
    const staging = await import('node:fs/promises').then((fs) =>
      fs.readdir(layout.stagingDirectory)
    );
    expect(staging).toEqual([]);

    await installer.install({ connectionId: 'ssh-1', layout });
    expect(openExecChannel).toHaveBeenCalledTimes(2);
  }, 180_000);

  it('reports a corrupt upload and cleans up staging', async () => {
    const bundleDirectory = path.join(directory, 'bundle');
    await writeBundle(bundleDirectory, await fixtureArchive());
    const home = path.join(directory, 'home');
    await mkdir(home);
    const layout = windowsWorkspaceServerLayout(home);
    const proxy = localWindowsProxy();
    const bundle = await loadWindowsWorkspaceServerBundle(bundleDirectory);
    if (!bundle) throw new Error('fixture bundle missing');
    const installer = new WorkspaceServerInstaller({
      ssh: { ensureProxy: async () => proxy },
      // The desktop's view of the archive disagrees with the bytes it sends.
      windowsBundle: async () => ({
        ...bundle,
        archive: { ...bundle.archive, sha256: 'f'.repeat(64) },
      }),
    });

    const failure = await installer
      .install({ connectionId: 'ssh-1', layout })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'artifact-download-failed' });
    expect(decodePowerShellStderr((failure as Error).message)).toContain('incomplete or corrupt');
    const staging = await import('node:fs/promises').then((fs) =>
      fs.readdir(layout.stagingDirectory)
    );
    expect(staging).toEqual([]);
  }, 180_000);
});
