/**
 * Remote operating-system capability probe results for SSH machines.
 *
 * The probe identifies the remote OS without assuming a shell: POSIX hosts answer `uname -s`, and
 * Windows OpenSSH hosts answer a Windows PowerShell script (see WINDOWS_PLATFORM_PROBE_SCRIPT)
 * whatever their configured default shell. Parsing and requirement checks are pure so both the
 * machine connection test and workspace-server provisioning report the same diagnostics.
 */

/** Oldest Windows build with the OpenSSH Server optional feature: Windows 10 1809 / Server 2019. */
export const MIN_WINDOWS_BUILD = 17_763;
/** Windows 11: the first build that runs x64 programs on ARM64 under emulation. */
export const MIN_WINDOWS_ARM64_BUILD = 22_000;

export type RemotePlatformIssue = {
  severity: 'error' | 'warning';
  code:
    | 'constrained-language'
    | 'powershell-too-old'
    | 'windows-too-old'
    | 'unsupported-architecture'
    | 'arm64-emulation'
    | 'home-unavailable'
    | 'git-missing';
  message: string;
};

export type PosixRemotePlatform = {
  os: 'posix';
  /** `uname -s`, for example `Linux` or `Darwin`. */
  kernel: string;
  home: string;
};

export type WindowsRemotePlatform = {
  os: 'windows';
  /** The PowerShell language mode; anything but FullLanguage blocks the remaining checks. */
  languageMode: string;
  home?: string;
  /** `PROCESSOR_ARCHITECTURE` of the native OS, for example `AMD64` or `ARM64`. */
  architecture?: string;
  osVersion?: string;
  osBuild?: number;
  powerShellVersion?: string;
  gitPath?: string;
};

export type RemotePlatformInfo = PosixRemotePlatform | WindowsRemotePlatform;

/** Serializable result shown by the machine connection test. */
export type RemotePlatformSummary = {
  os: RemotePlatformInfo['os'];
  description: string;
  issues: RemotePlatformIssue[];
};

/** A remote host that passed every blocking requirement. */
export type SupportedRemoteHost =
  | { platform: 'posix'; home: string }
  | { platform: 'windows'; home: string; architecture: 'x64' | 'arm64' };

export class RemotePlatformUnsupportedError extends Error {
  readonly name = 'RemotePlatformUnsupportedError';

  constructor(readonly issues: RemotePlatformIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
  }
}

/** `uname -s` values reported by Unix environments that run on a Windows kernel. */
export function isWindowsUnameKernel(kernel: string): boolean {
  return /^(?:cygwin|mingw|msys)/i.test(kernel.trim());
}

export const WINDOWS_PROBE_MARKER = 'emdash-probe=1';

/**
 * Windows PowerShell 5.1 script printing `key=value` lines. Under Constrained Language mode only
 * the language mode is reported (static .NET calls are blocked) and the script exits 3. Output is
 * written as UTF-8 bytes because the console output encoding is not configurable without a console.
 */
export const WINDOWS_PLATFORM_PROBE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$mode = [string]$ExecutionContext.SessionState.LanguageMode',
  "if ($mode -ne 'FullLanguage') {",
  `  Write-Output '${WINDOWS_PROBE_MARKER}'`,
  "  Write-Output ('language=' + $mode)",
  '  exit 3',
  '}',
  "$ErrorActionPreference = 'Stop'",
  '$homePath = $env:USERPROFILE',
  "if (-not $homePath) { $homePath = [Environment]::GetFolderPath('UserProfile') }",
  '$arch = $env:PROCESSOR_ARCHITEW6432',
  'if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }',
  // Minimal environments can omit the variables; the machine environment always records them.
  'if (-not $arch) {',
  '  try {',
  "    $machineEnvironment = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'",
  '    $arch = (Get-ItemProperty -LiteralPath $machineEnvironment -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE',
  '  } catch { }',
  '}',
  '$os = [Environment]::OSVersion.Version',
  '$git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue |',
  '  Select-Object -First 1',
  '$lines = @(',
  `  '${WINDOWS_PROBE_MARKER}',`,
  "  ('language=' + $mode),",
  "  ('home=' + $homePath),",
  "  ('arch=' + $arch),",
  "  ('os-version=' + $os.ToString()),",
  "  ('os-build=' + $os.Build),",
  "  ('ps-version=' + $PSVersionTable.PSVersion.ToString())",
  ')',
  "if ($git) { $lines += ('git=' + $git.Path) }",
  '$bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")',
  '$stdout = [Console]::OpenStandardOutput()',
  '$stdout.Write($bytes, 0, $bytes.Length)',
  '$stdout.Flush()',
].join('\n');

/** Parses the Windows probe output, or returns undefined when it did not come from the probe. */
export function parseWindowsPlatformProbe(stdout: string): WindowsRemotePlatform | undefined {
  const values = new Map<string, string>();
  let marked = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line === WINDOWS_PROBE_MARKER) {
      marked = true;
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim());
  }
  const languageMode = values.get('language');
  if (!marked || !languageMode) return undefined;

  const build = Number(values.get('os-build'));
  const info: WindowsRemotePlatform = { os: 'windows', languageMode };
  const home = values.get('home');
  if (home) info.home = home;
  const architecture = values.get('arch');
  if (architecture) info.architecture = architecture;
  const osVersion = values.get('os-version');
  if (osVersion) info.osVersion = osVersion;
  if (Number.isInteger(build) && build > 0) info.osBuild = build;
  const powerShellVersion = values.get('ps-version');
  if (powerShellVersion) info.powerShellVersion = powerShellVersion;
  const gitPath = values.get('git');
  if (gitPath) info.gitPath = gitPath;
  return info;
}

/** Requirement checks; any `error` issue blocks installing the workspace server. */
export function evaluateRemotePlatform(info: RemotePlatformInfo): RemotePlatformIssue[] {
  if (info.os === 'posix') return [];
  if (info.languageMode !== 'FullLanguage') {
    return [
      {
        severity: 'error',
        code: 'constrained-language',
        message:
          `PowerShell runs in ${info.languageMode} mode for this account, usually because ` +
          'AppLocker or Windows Defender Application Control enforces it. Chorus needs ' +
          'FullLanguage mode to set up the machine; ask an administrator to allow it for this ' +
          'account.',
      },
    ];
  }

  const issues: RemotePlatformIssue[] = [];
  if (!info.home || !isWindowsAbsolutePath(info.home)) {
    issues.push({
      severity: 'error',
      code: 'home-unavailable',
      message:
        'The remote account has no usable profile directory (USERPROFILE). Sign in to the ' +
        'machine once with this account so Windows creates its profile.',
    });
  }
  if (!isPowerShellAtLeast51(info.powerShellVersion)) {
    issues.push({
      severity: 'error',
      code: 'powershell-too-old',
      message:
        `Windows PowerShell 5.1 or later is required (found ${info.powerShellVersion ?? 'unknown'}). ` +
        'Install Windows Management Framework 5.1.',
    });
  }
  if (info.osBuild === undefined || info.osBuild < MIN_WINDOWS_BUILD) {
    issues.push({
      severity: 'error',
      code: 'windows-too-old',
      message:
        'Windows 10 version 1809 or Windows Server 2019 (build 17763) or later is required ' +
        `(found ${info.osBuild === undefined ? 'an unknown build' : `build ${info.osBuild}`}).`,
    });
  }
  const architecture = normalizeWindowsArchitecture(info.architecture);
  if (architecture === undefined) {
    issues.push({
      severity: 'error',
      code: 'unsupported-architecture',
      message:
        `The ${info.architecture ?? 'unknown'} processor architecture is not supported; Chorus ` +
        'needs 64-bit Windows (x64, or ARM64 on Windows 11).',
    });
  } else if (architecture === 'arm64') {
    const emulationAvailable = (info.osBuild ?? 0) >= MIN_WINDOWS_ARM64_BUILD;
    issues.push({
      severity: emulationAvailable ? 'warning' : 'error',
      code: 'arm64-emulation',
      message: emulationAvailable
        ? 'Windows on ARM runs the x64 workspace server under emulation.'
        : 'Windows on ARM needs Windows 11, which runs the x64 workspace server under emulation.',
    });
  }
  if (!info.gitPath) {
    issues.push({
      severity: 'warning',
      code: 'git-missing',
      message:
        'Git was not found on the PATH that SSH sessions see. Install Git for Windows so Chorus ' +
        'can clone repositories and create worktrees, then reconnect.',
    });
  }
  return issues;
}

/** Narrows a probed host to one the workspace server supports, or throws every blocking issue. */
export function requireSupportedRemoteHost(info: RemotePlatformInfo): SupportedRemoteHost {
  const blocking = evaluateRemotePlatform(info).filter((issue) => issue.severity === 'error');
  if (blocking.length > 0) throw new RemotePlatformUnsupportedError(blocking);
  if (info.os === 'posix') return { platform: 'posix', home: info.home };
  const architecture = normalizeWindowsArchitecture(info.architecture);
  if (!info.home || !architecture) {
    throw new Error('Remote Windows probe passed its checks without a home or architecture');
  }
  return { platform: 'windows', home: info.home, architecture };
}

export function summarizeRemotePlatform(info: RemotePlatformInfo): RemotePlatformSummary {
  return {
    os: info.os,
    description: describeRemotePlatform(info),
    issues: evaluateRemotePlatform(info),
  };
}

export function describeRemotePlatform(info: RemotePlatformInfo): string {
  if (info.os === 'posix') return info.kernel === 'Darwin' ? 'macOS' : info.kernel;
  if (info.languageMode !== 'FullLanguage') return `Windows (PowerShell ${info.languageMode})`;
  const parts = [
    info.osBuild === undefined ? 'Windows' : `Windows build ${info.osBuild}`,
    info.architecture ? `(${info.architecture})` : undefined,
    info.powerShellVersion ? `· PowerShell ${info.powerShellVersion}` : undefined,
  ];
  return parts.filter((part) => part !== undefined).join(' ');
}

function normalizeWindowsArchitecture(value: string | undefined): 'x64' | 'arm64' | undefined {
  switch (value?.toUpperCase()) {
    case 'AMD64':
      return 'x64';
    case 'ARM64':
      return 'arm64';
    default:
      return undefined;
  }
}

function isPowerShellAtLeast51(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2]) >= 1);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\\/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
}
