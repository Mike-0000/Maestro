import path from 'node:path';
import type { SupportedRemoteHost } from '@core/primitives/ssh/api/remote-platform';

type CommonWorkspaceServerLayout = {
  home: string;
  root: string;
  versionsDirectory: string;
  stagingDirectory: string;
  installLock: string;
  runDirectory: string;
  /** Daemon address passed as `--socket`; a named-pipe endpoint record on Windows. */
  socketPath: string;
  versionDirectory(version: string): string;
};

export type PosixWorkspaceServerLayout = CommonWorkspaceServerLayout & {
  platform: 'posix';
  /** Symlink to `versions/<version>`. */
  currentLink: string;
  versionLauncher(version: string): string;
  currentLauncher: string;
};

/**
 * Windows has no reliable unprivileged symlinks, so `current` is a text file holding the selected
 * version, and control commands run the version's bundled `node.exe` directly.
 */
export type WindowsWorkspaceServerLayout = CommonWorkspaceServerLayout & {
  platform: 'windows';
  /** Text file containing the selected version. */
  currentPointer: string;
  versionNodeExecutable(version: string): string;
  versionEntrypoint(version: string): string;
};

export type WorkspaceServerLayout = PosixWorkspaceServerLayout | WindowsWorkspaceServerLayout;

export function workspaceServerLayoutForHost(host: SupportedRemoteHost): WorkspaceServerLayout {
  return host.platform === 'windows'
    ? windowsWorkspaceServerLayout(host.home)
    : workspaceServerLayout(host.home);
}

export function workspaceServerLayout(home: string): PosixWorkspaceServerLayout {
  validateRemoteHome(home);
  const root = path.posix.join(home, '.emdash/workspace-server');
  const versionsDirectory = path.posix.join(root, 'versions');
  const currentLink = path.posix.join(root, 'current');

  return {
    platform: 'posix',
    home,
    root,
    versionsDirectory,
    currentLink,
    stagingDirectory: path.posix.join(root, 'staging'),
    installLock: path.posix.join(root, 'install.lock'),
    runDirectory: path.posix.join(root, 'run'),
    socketPath: path.posix.join(root, 'run/workspace.sock'),
    versionDirectory(version) {
      return path.posix.join(versionsDirectory, validateWorkspaceServerVersion(version));
    },
    versionLauncher(version) {
      return path.posix.join(
        versionsDirectory,
        validateWorkspaceServerVersion(version),
        'bin/emdash-workspace-server'
      );
    },
    currentLauncher: path.posix.join(currentLink, 'bin/emdash-workspace-server'),
  };
}

export function windowsWorkspaceServerLayout(home: string): WindowsWorkspaceServerLayout {
  validateWindowsRemoteHome(home);
  const root = path.win32.join(home, '.emdash', 'workspace-server');
  const versionsDirectory = path.win32.join(root, 'versions');
  const versionDirectory = (version: string) =>
    path.win32.join(versionsDirectory, validateWorkspaceServerVersion(version));

  return {
    platform: 'windows',
    home,
    root,
    versionsDirectory,
    currentPointer: path.win32.join(root, 'current'),
    stagingDirectory: path.win32.join(root, 'staging'),
    installLock: path.win32.join(root, 'install.lock'),
    runDirectory: path.win32.join(root, 'run'),
    socketPath: path.win32.join(root, 'run', 'workspace.sock'),
    versionDirectory,
    versionNodeExecutable(version) {
      return path.win32.join(versionDirectory(version), 'node.exe');
    },
    versionEntrypoint(version) {
      return path.win32.join(versionDirectory(version), 'dist', 'index.mjs');
    },
  };
}

/** SemVer without leading `v`; also evaluated by .NET regex in the Windows control scripts. */
export const WORKSPACE_SERVER_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function validateWorkspaceServerVersion(version: string): string {
  if (!WORKSPACE_SERVER_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid workspace-server version '${version}'`);
  }
  return version;
}

function validateRemoteHome(home: string): void {
  if (
    !path.posix.isAbsolute(home) ||
    home.includes('\0') ||
    home.includes('\n') ||
    home.includes('\r') ||
    path.posix.normalize(home) !== home ||
    (home.length > 1 && home.endsWith('/'))
  ) {
    throw new Error(`Invalid remote home directory '${home}'`);
  }
}

/** Accepts drive (`C:\Users\dev`) and UNC (`\\server\share\dev`) profile directories. */
function validateWindowsRemoteHome(home: string): void {
  const driveRoot = /^[A-Za-z]:\\$/u.test(home);
  if (
    !(/^[A-Za-z]:\\/u.test(home) || /^\\\\[^\\/?.][^\\/]*\\[^\\/]+/u.test(home)) ||
    /[\0\r\n"*:<>?|/]/u.test(home.slice(2)) ||
    path.win32.normalize(home) !== home ||
    (!driveRoot && home.endsWith('\\'))
  ) {
    throw new Error(`Invalid remote home directory '${home}'`);
  }
}
