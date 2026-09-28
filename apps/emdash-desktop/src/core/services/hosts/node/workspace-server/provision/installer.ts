import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { quoteArg } from '@emdash/core/primitives/exec/api';
import {
  channelPointerPath,
  parseChannelPointer,
  protocolMajor,
  type ReleaseChannel,
} from '@emdash/core/workspace-server';
import { execPowerShell } from '@core/primitives/ssh/api/node/remote-platform-probe';
import type { SshClientProxy, SshExecResult } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import {
  validateWorkspaceServerVersion,
  type PosixWorkspaceServerLayout,
  type WindowsWorkspaceServerLayout,
  type WorkspaceServerLayout,
} from '../layout';
import type { WorkspaceServerSshPort } from '../ports';
import {
  buildWindowsChannelPointerScript,
  buildWindowsInstalledVersionScript,
  buildWindowsInstallerDownloadScript,
  buildWindowsInstallerRunScript,
  buildWindowsRemovePathsScript,
  WINDOWS_INVALID_POINTER_EXIT_CODE,
  type WindowsInstallerSource,
} from '../windows-scripts';
import { uploadFileToWindowsHost, type WindowsWorkspaceServerBundle } from './windows-bundle';

export const DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL =
  'https://releases.emdash.sh/workspace-server';

export type WorkspaceServerInstallErrorCode =
  | 'unsupported-platform'
  | 'artifact-download-failed'
  | 'install-failed';

export class WorkspaceServerInstallError extends Error {
  readonly name = 'WorkspaceServerInstallError';

  constructor(
    readonly code: WorkspaceServerInstallErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type WorkspaceServerInstallerOptions = {
  ssh: WorkspaceServerSshPort;
  baseUrl?: string;
  releaseChannel?: ReleaseChannel;
  /**
   * The workspace server shipped with the desktop app for Windows hosts. When it resolves to a
   * bundle, Windows hosts install that version from an upload instead of the release channel.
   */
  windowsBundle?: () => Promise<WindowsWorkspaceServerBundle | undefined>;
};

export type WorkspaceServerInstallOptions = {
  connectionId: string;
  layout: WorkspaceServerLayout;
  signal?: AbortSignal;
  version?: string;
};

const installOptions = {
  timeoutMs: 5 * 60_000,
  maxStdoutBytes: 256 * 1_024,
  maxStderrBytes: 256 * 1_024,
} as const;

const metadataOptions = {
  timeoutMs: 10_000,
  maxStdoutBytes: 4_096,
  maxStderrBytes: 4_096,
} as const;

// Windows metadata commands include a cold powershell.exe start.
const windowsMetadataTimeoutMs = 30_000;

// The bundled archive is about 60 MB; allow slow links.
const windowsUploadTimeoutMs = 20 * 60_000;

export class WorkspaceServerInstaller {
  private readonly ssh: WorkspaceServerSshPort;
  private readonly baseUrl: string;
  private readonly releaseChannel: ReleaseChannel;
  private readonly windowsBundle: () => Promise<WindowsWorkspaceServerBundle | undefined>;

  constructor(options: WorkspaceServerInstallerOptions) {
    this.ssh = options.ssh;
    this.baseUrl = options.baseUrl ?? DEFAULT_WORKSPACE_SERVER_INSTALL_BASE_URL;
    this.releaseChannel = options.releaseChannel ?? 'stable';
    this.windowsBundle = options.windowsBundle ?? (async () => undefined);
  }

  async installedVersion(
    connectionId: string,
    layout: WorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const proxy = await this.ssh.ensureProxy(connectionId);
    return await this.installedVersionFromProxy(proxy, layout, signal);
  }

  async install(options: WorkspaceServerInstallOptions): Promise<void> {
    const selectedVersion =
      options.version ??
      (await this.availableVersion(options.connectionId, options.signal, options.layout.platform));
    const proxy = await this.ssh.ensureProxy(options.connectionId);
    const result =
      options.layout.platform === 'windows'
        ? await this.runWindowsInstaller(proxy, selectedVersion, options.layout, options.signal)
        : await proxy.execScript(
            buildWorkspaceServerInstallCommand(this.baseUrl, selectedVersion),
            {
              ...installOptions,
              signal: options.signal,
            }
          );
    if (result.exitCode !== 0) {
      const code =
        result.exitCode === 40
          ? 'unsupported-platform'
          : result.exitCode === 41
            ? 'artifact-download-failed'
            : 'install-failed';
      throw new WorkspaceServerInstallError(
        code,
        `Workspace-server installation failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      );
    }

    const installedVersion = await this.installedVersionFromProxy(
      proxy,
      options.layout,
      options.signal
    );
    if (installedVersion !== selectedVersion) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        installedVersion === undefined
          ? `Workspace-server installation did not select requested version ${selectedVersion}`
          : `Workspace-server installation installed ${installedVersion} instead of ${selectedVersion}`
      );
    }
  }

  /**
   * Installs from the desktop's bundle when it carries `version`, otherwise downloads
   * `install.ps1` into staging and runs it; see buildWindowsInstallerDownloadScript.
   */
  private async runWindowsInstaller(
    proxy: SshClientProxy,
    version: string,
    layout: WindowsWorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<SshExecResult> {
    const bundle = await this.loadWindowsBundle();
    if (bundle?.version === version) {
      return await this.installWindowsBundle(proxy, bundle, layout, signal);
    }
    const scripts = buildWindowsWorkspaceServerInstallScripts(
      this.baseUrl,
      version,
      layout,
      randomUUID()
    );
    const download = await execPowerShell(proxy, scripts.download, {
      ...metadataOptions,
      timeoutMs: installOptions.timeoutMs,
      signal,
    });
    if (download.exitCode !== 0) return download;
    return await execPowerShell(
      proxy,
      scripts.run,
      { ...installOptions, signal },
      { bypassExecutionPolicy: true }
    );
  }

  /** Uploads the bundled archive and `install.ps1` into staging, then runs it offline. */
  private async installWindowsBundle(
    proxy: SshClientProxy,
    bundle: WindowsWorkspaceServerBundle,
    layout: WindowsWorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<SshExecResult> {
    // install.ps1 would also return early, but only after the archive upload.
    if ((await this.installedVersionFromProxy(proxy, layout, signal)) === bundle.version) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const plan = windowsBundleInstallPlan(bundle, layout, randomUUID());
    const upload = async (file: WindowsWorkspaceServerBundle['archive'], remotePath: string) => {
      try {
        return await uploadFileToWindowsHost(proxy, file, remotePath, {
          timeoutMs: windowsUploadTimeoutMs,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw new WorkspaceServerInstallError(
          'artifact-download-failed',
          `Could not copy the workspace server to the host: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    };

    let started = false;
    try {
      const archive = await upload(bundle.archive, plan.archivePath);
      if (archive.exitCode !== 0) return archive;
      const installer = await upload(bundle.installScript, plan.installerPath);
      if (installer.exitCode !== 0) return installer;
      // The run script deletes the installer and the staged bundle itself.
      started = true;
      return await execPowerShell(
        proxy,
        plan.run,
        { ...installOptions, signal },
        { bypassExecutionPolicy: true }
      );
    } finally {
      if (!started && !signal?.aborted) {
        await execPowerShell(proxy, plan.cleanup, {
          ...metadataOptions,
          timeoutMs: windowsMetadataTimeoutMs,
        }).catch(() => undefined);
      }
    }
  }

  private async loadWindowsBundle(): Promise<WindowsWorkspaceServerBundle | undefined> {
    try {
      return await this.windowsBundle();
    } catch (error) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        `The workspace server bundled with Maestro is unusable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  private async installedVersionFromProxy(
    proxy: SshClientProxy,
    layout: WorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    return layout.platform === 'windows'
      ? await this.windowsInstalledVersion(proxy, layout, signal)
      : await this.posixInstalledVersion(proxy, layout, signal);
  }

  private async windowsInstalledVersion(
    proxy: SshClientProxy,
    layout: WindowsWorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const result = await execPowerShell(proxy, buildWindowsInstalledVersionScript(layout), {
      ...metadataOptions,
      timeoutMs: windowsMetadataTimeoutMs,
      signal,
    });
    if (result.exitCode === WINDOWS_INVALID_POINTER_EXIT_CODE) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        result.stderr.trim() || 'The managed workspace-server current pointer is invalid'
      );
    }
    if (result.exitCode !== 0) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        `Could not read the installed workspace-server version: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`
      );
    }
    const version = result.stdout.trim();
    if (!version) return undefined;
    try {
      return validateWorkspaceServerVersion(version);
    } catch (error) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        `The managed workspace-server current pointer is invalid: ${version}`,
        { cause: error }
      );
    }
  }

  private async posixInstalledVersion(
    proxy: SshClientProxy,
    layout: PosixWorkspaceServerLayout,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const result = await proxy.exec(
      { command: 'readlink', args: ['--', layout.currentLink] },
      { ...metadataOptions, signal }
    );
    if (result.exitCode !== 0) return undefined;

    const linkTarget = result.stdout.trim();
    const version = path.posix.basename(linkTarget);
    try {
      validateWorkspaceServerVersion(version);
    } catch (error) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        `The managed workspace-server current link is invalid: ${result.stdout.trim()}`,
        { cause: error }
      );
    }
    if (linkTarget !== `versions/${version}` && linkTarget !== layout.versionDirectory(version)) {
      throw new WorkspaceServerInstallError(
        'install-failed',
        `The managed workspace-server current link points outside versions/: ${linkTarget}`
      );
    }
    return version;
  }

  /**
   * Resolves the channel's current artifact version. The pointer is downloaded on the remote
   * machine, which is also the one that downloads the artifact.
   */
  async availableVersion(
    connectionId: string,
    signal?: AbortSignal,
    platform: WorkspaceServerLayout['platform'] = 'posix'
  ): Promise<string> {
    if (platform === 'windows') {
      const bundle = await this.loadWindowsBundle();
      if (bundle) return bundle.version;
    }
    const expectedProtocolMajor = protocolMajor();
    const proxy = await this.ssh.ensureProxy(connectionId);
    const result =
      platform === 'windows'
        ? await execPowerShell(
            proxy,
            buildWindowsChannelPointerScript(
              channelPointerUrls(this.baseUrl, this.releaseChannel, expectedProtocolMajor)
            ),
            { ...metadataOptions, timeoutMs: windowsMetadataTimeoutMs, signal }
          )
        : await proxy.execScript(
            buildWorkspaceServerChannelPointerCommand(
              this.baseUrl,
              this.releaseChannel,
              expectedProtocolMajor
            ),
            { ...metadataOptions, signal }
          );
    if (result.exitCode !== 0) {
      throw new WorkspaceServerInstallError(
        'artifact-download-failed',
        `Could not resolve the workspace-server ${this.releaseChannel} channel pointer: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`
      );
    }

    const pointer = parseChannelPointer(result.stdout, expectedProtocolMajor);
    if (!pointer.success) {
      const reason =
        pointer.error.type === 'invalid'
          ? pointer.error.reason
          : `expected protocol major ${pointer.error.expected}, received ${pointer.error.actual}`;
      throw new WorkspaceServerInstallError(
        'artifact-download-failed',
        `The workspace-server ${this.releaseChannel} channel pointer is invalid: ${reason}`
      );
    }
    return pointer.data.artifactVersion;
  }
}

/** The channel's pointer URL, followed by the stable pointer as the canary fallback. */
export function channelPointerUrls(
  baseUrl: string,
  channel: ReleaseChannel,
  expectedProtocolMajor: number
): [string, ...string[]] {
  const normalizedBaseUrl = ensureTrailingSlash(validateInstallBaseUrl(baseUrl));
  const pointerUrl = (pointerChannel: ReleaseChannel) =>
    new URL(channelPointerPath(pointerChannel, expectedProtocolMajor), normalizedBaseUrl).href;
  return channel === 'canary'
    ? [pointerUrl('canary'), pointerUrl('stable')]
    : [pointerUrl(channel)];
}

export function buildWorkspaceServerChannelPointerCommand(
  baseUrl: string,
  channel: ReleaseChannel,
  expectedProtocolMajor: number
): string {
  const [pointerUrl, fallbackUrl] = channelPointerUrls(baseUrl, channel, expectedProtocolMajor);
  const quotedPointerUrl = quoteArg(pointerUrl, 'posix');
  const stableFallbackUrl = fallbackUrl === undefined ? undefined : quoteArg(fallbackUrl, 'posix');
  const curlCommand = stableFallbackUrl
    ? `curl -fsSL -- ${quotedPointerUrl} 2>/dev/null || curl -fsSL -- ${stableFallbackUrl}`
    : `curl -fsSL -- ${quotedPointerUrl}`;
  const wgetCommand = stableFallbackUrl
    ? `wget -qO- -- ${quotedPointerUrl} 2>/dev/null || wget -qO- -- ${stableFallbackUrl}`
    : `wget -qO- -- ${quotedPointerUrl}`;
  return `set -eu
if command -v curl >/dev/null 2>&1; then
  ${curlCommand}
elif command -v wget >/dev/null 2>&1; then
  ${wgetCommand}
else
  echo "curl or wget is required to download workspace-server metadata" >&2
  exit 41
fi`;
}

export function buildWorkspaceServerInstallCommand(baseUrl: string, version: string): string {
  const normalizedBaseUrl = validateInstallBaseUrl(baseUrl);
  const selectedVersion = validateWorkspaceServerVersion(version);
  const scriptUrl = new URL(`${selectedVersion}/install.sh`, ensureTrailingSlash(normalizedBaseUrl))
    .href;
  const quotedScriptUrl = quoteArg(scriptUrl, 'posix');
  const quotedBaseUrl = quoteArg(normalizedBaseUrl, 'posix');
  const quotedVersion = quoteArg(selectedVersion, 'posix');
  return `set -eu
install_script=\${TMPDIR:-/tmp}/emdash-workspace-server-install-$$.sh
cleanup() { rm -f -- "$install_script"; }
trap cleanup EXIT HUP INT TERM
if ! curl -fsSL --output "$install_script" -- ${quotedScriptUrl}; then
  exit 41
fi
sh "$install_script" --base-url ${quotedBaseUrl} --version ${quotedVersion}`;
}

/**
 * The two Windows install steps: download `<base>/<version>/install.ps1` into the staging
 * directory, then run it for `layout`. `installerId` keeps concurrent installs apart.
 */
export function buildWindowsWorkspaceServerInstallScripts(
  baseUrl: string,
  version: string,
  layout: WindowsWorkspaceServerLayout,
  installerId: string
): { download: string; run: string } {
  const normalizedBaseUrl = validateInstallBaseUrl(baseUrl);
  const selectedVersion = validateWorkspaceServerVersion(version);
  if (!/^[0-9a-f-]{1,64}$/u.test(installerId)) {
    throw new Error(`Invalid installer id '${installerId}'`);
  }
  const installerPath = path.win32.join(
    layout.stagingDirectory,
    `install-${selectedVersion}-${installerId}.ps1`
  );
  return {
    download: buildWindowsInstallerDownloadScript({
      scriptUrl: new URL(`${selectedVersion}/install.ps1`, ensureTrailingSlash(normalizedBaseUrl))
        .href,
      installerPath,
    }),
    run: buildWindowsInstallerRunScript({
      installerPath,
      source: { kind: 'url', baseUrl: normalizedBaseUrl },
      version: selectedVersion,
      layout,
    }),
  };
}

/**
 * Remote paths for installing `bundle`: the archive goes to `<bundle dir>/<version>/<name>` so
 * install.ps1 finds it under a file URI base, next to a uniquely named installer copy.
 */
export function windowsBundleInstallPlan(
  bundle: WindowsWorkspaceServerBundle,
  layout: WindowsWorkspaceServerLayout,
  installerId: string
): { archivePath: string; installerPath: string; run: string; cleanup: string } {
  const version = validateWorkspaceServerVersion(bundle.version);
  if (!/^[0-9a-f-]{1,64}$/u.test(installerId)) {
    throw new Error(`Invalid installer id '${installerId}'`);
  }
  const directory = path.win32.join(layout.stagingDirectory, `bundle-${installerId}`);
  const installerPath = path.win32.join(
    layout.stagingDirectory,
    `install-${version}-${installerId}.ps1`
  );
  const source: WindowsInstallerSource = {
    kind: 'staged',
    directory,
    sha256: bundle.archive.sha256,
  };
  return {
    archivePath: path.win32.join(directory, version, bundle.archiveName),
    installerPath,
    run: buildWindowsInstallerRunScript({ installerPath, source, version, layout }),
    cleanup: buildWindowsRemovePathsScript([directory, installerPath]),
  };
}

function validateInstallBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new WorkspaceServerInstallError(
      'artifact-download-failed',
      'Workspace-server install base URL is invalid',
      { cause: error }
    );
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new WorkspaceServerInstallError(
      'artifact-download-failed',
      `Unsupported workspace-server install URL protocol '${url.protocol}'`
    );
  }
  return url.href.replace(/\/$/, '');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
