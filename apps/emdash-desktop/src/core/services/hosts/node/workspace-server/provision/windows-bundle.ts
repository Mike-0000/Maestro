import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  decodePowerShellStderr,
  formatPowerShellEncodedCommand,
} from '@emdash/core/primitives/exec/api';
import type { SshClientProxy, SshExecResult } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { validateWorkspaceServerVersion } from '../layout';
import { buildWindowsUploadScript } from '../windows-scripts';

/** A file Maestro ships and copies to Windows hosts, with the facts the remote side verifies. */
export type BundledFile = {
  localPath: string;
  size: number;
  sha256: string;
};

/**
 * The win32-x64 workspace server packaged with the desktop app. Windows hosts install it from
 * this bundle instead of downloading release artifacts, so they work without a hosted release.
 */
export type WindowsWorkspaceServerBundle = {
  version: string;
  archiveName: string;
  archive: BundledFile;
  installScript: BundledFile;
};

const ARCHIVE_PATTERN = /^emdash-workspace-server-(.+)-win32-x64\.zip$/u;

/**
 * Reads the bundle directory (`install.ps1`, one `emdash-workspace-server-<v>-win32-x64.zip`,
 * and its `.sha256` sidecar). Returns undefined when the directory holds no bundle; throws when
 * a bundle is present but inconsistent, because installing it would fail on the remote anyway.
 */
export async function loadWindowsWorkspaceServerBundle(
  directory: string
): Promise<WindowsWorkspaceServerBundle | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const archives = names.filter((name) => ARCHIVE_PATTERN.test(name));
  if (archives.length === 0) return undefined;
  if (archives.length > 1) {
    throw new Error(`Expected one bundled Windows workspace server, found ${archives.join(', ')}`);
  }
  const archiveName = archives[0] as string;
  const version = validateWorkspaceServerVersion(ARCHIVE_PATTERN.exec(archiveName)?.[1] ?? '');

  const archive = await describeFile(path.join(directory, archiveName));
  const sidecar = await readFile(path.join(directory, `${archiveName}.sha256`), 'utf8');
  const [expected, name] = sidecar.trim().split(/\s+/u);
  if (expected?.toLowerCase() !== archive.sha256 || name?.replace(/^\*/u, '') !== archiveName) {
    throw new Error(`The bundled ${archiveName} does not match its checksum sidecar`);
  }
  return {
    version,
    archiveName,
    archive,
    installScript: await describeFile(path.join(directory, 'install.ps1')),
  };
}

/** Caches a successful bundle read; a failed read is retried on the next call. */
export function windowsBundleLoader(
  directory: string
): () => Promise<WindowsWorkspaceServerBundle | undefined> {
  let pending: Promise<WindowsWorkspaceServerBundle | undefined> | undefined;
  return () => {
    pending ??= loadWindowsWorkspaceServerBundle(directory).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

async function describeFile(localPath: string): Promise<BundledFile> {
  const [info, sha256] = await Promise.all([stat(localPath), sha256File(localPath)]);
  return { localPath, size: info.size, sha256 };
}

async function sha256File(localPath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(localPath), hash);
  return hash.digest('hex');
}

const MAX_UPLOAD_STDERR_BYTES = 16 * 1_024;

/**
 * Streams `file` to `remotePath` over an exec channel running buildWindowsUploadScript. The remote
 * script verifies length and checksum before renaming the file into place. The exec channel is
 * used instead of SFTP because administrators commonly disable the SFTP subsystem.
 */
export async function uploadFileToWindowsHost(
  proxy: Pick<SshClientProxy, 'openExecChannel'>,
  file: BundledFile,
  remotePath: string,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<SshExecResult> {
  const command = formatPowerShellEncodedCommand(
    buildWindowsUploadScript({ path: remotePath, length: file.size, sha256: file.sha256 })
  );
  options.signal?.throwIfAborted();
  const channel = await proxy.openExecChannel(command, { signal: options.signal });

  return await new Promise<SshExecResult>((resolve, reject) => {
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let exitCode: number | undefined;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      channel.destroy();
    };
    const timer = setTimeout(
      () => fail(new Error(`Upload timed out after ${Math.round(options.timeoutMs / 1_000)}s`)),
      options.timeoutMs
    );
    const onAbort = () => fail(options.signal?.reason ?? new Error('Upload aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    channel.on('data', () => {});
    channel.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_UPLOAD_STDERR_BYTES) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    channel.on('exit', (code: number | null) => {
      if (typeof code === 'number') exitCode = code;
    });
    channel.on('close', () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const text = decodePowerShellStderr(Buffer.concat(stderr).toString('utf8'));
      // A script that fails early closes the channel mid-stream; its exit code explains why.
      if (exitCode !== undefined && (exitCode !== 0 || failure === undefined)) {
        resolve({ exitCode, stdout: '', stderr: text });
      } else {
        reject(failure ?? new Error('The upload channel closed without an exit status'));
      }
    });

    pipeline(createReadStream(file.localPath), channel).catch((error: unknown) => {
      if (exitCode === undefined) fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
