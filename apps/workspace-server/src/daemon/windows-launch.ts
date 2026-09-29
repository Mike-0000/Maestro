import { execFile } from 'node:child_process';
import {
  encodePowerShellCommand,
  formatWindowsCommandLine,
} from '@emdash/core/primitives/exec/api';
import { err, ok, type Result } from '@emdash/shared';

/**
 * Windows OpenSSH runs each session's processes inside a job object that is closed with the
 * session, and Node's `detached` spawn does not break away from it. A daemon started directly from
 * `start` would therefore die as soon as the desktop's control command returns. Asking WMI to
 * create the process makes the WMI provider host its parent, outside the session's job, while it
 * still runs as the connecting user.
 *
 * An SSH logon of an administrator is elevated, and a daemon it starts would create its named pipe
 * with an Administrators-only DACL that the same user's non-elevated desktop app cannot open. When
 * the caller is elevated, the script re-runs itself through `runas /trustlevel:0x20000` (a Basic
 * User SAFER token: same user, Administrators deny-only), so both can reach the daemon's pipe.
 * That hop is asynchronous, so the de-elevated copy reports through a result file. If it fails, the
 * daemon is created elevated as before and a `W ` line explains why.
 *
 * The script is constant. The command line, working directory, and the script's own encoding reach
 * it through environment variables, so no caller-controlled text is ever parsed as PowerShell.
 */
export const LAUNCH_OUTSIDE_SESSION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'function Invoke-EmdashLaunch {',
  "  $variables = New-Object 'System.Collections.Generic.List[string]'",
  '  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {',
  '    $name = [string]$entry.Key',
  "    if ($name.StartsWith('=') -or $name.StartsWith('EMDASH_WS_LAUNCH_')) { continue }",
  "    $variables.Add($name + '=' + [string]$entry.Value)",
  '  }',
  '  $startupClass = Get-CimClass -ClassName Win32_ProcessStartup',
  '  $startup = New-CimInstance -CimClass $startupClass -ClientOnly -Property @{',
  '    ShowWindow = [uint16]0',
  '    EnvironmentVariables = $variables.ToArray()',
  '  }',
  '  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
  '    CommandLine = $env:EMDASH_WS_LAUNCH_COMMAND_LINE',
  '    CurrentDirectory = $env:EMDASH_WS_LAUNCH_DIRECTORY',
  '    ProcessStartupInformation = $startup',
  '  }',
  "  return ('{0} {1}' -f [int]$result.ReturnValue, [int]$result.ProcessId)",
  '}',
  // The de-elevated copy: report through the result file, renamed into place so the elevated
  // copy never reads a partial write.
  '$resultPath = $env:EMDASH_WS_LAUNCH_RESULT',
  'if ($resultPath) {',
  "  try { $line = Invoke-EmdashLaunch } catch { $line = 'E ' + $_.Exception.Message }",
  "  [IO.File]::WriteAllText($resultPath + '.tmp', $line)",
  "  Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force",
  '  exit 0',
  '}',
  '$principal = New-Object Security.Principal.WindowsPrincipal(',
  '  [Security.Principal.WindowsIdentity]::GetCurrent()',
  ')',
  'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
  '  [Console]::Out.Write((Invoke-EmdashLaunch))',
  '  exit 0',
  '}',
  '$warning = $null',
  "$resultName = 'emdash-ws-launch-' + [guid]::NewGuid().ToString('N') + '.txt'",
  '$resultPath = Join-Path ([IO.Path]::GetTempPath()) $resultName',
  "$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
  "if ($powershell -match '[\\s\"]' -or $env:EMDASH_WS_LAUNCH_SELF -notmatch '^[A-Za-z0-9+/=]+$') {",
  "  $warning = 'the de-elevated launch command could not be formed'",
  '} else {',
  // runas takes one command line; it holds only a quote-free path and base64, so no quoting.
  "  $flags = ' -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '",
  '  $env:EMDASH_WS_LAUNCH_RESULT = $resultPath',
  '  try {',
  "    $runasOutput = & runas.exe '/trustlevel:0x20000' ($powershell + $flags + $env:EMDASH_WS_LAUNCH_SELF) 2>&1 | Out-String",
  '    $runasExit = $LASTEXITCODE',
  '  } finally {',
  '    Remove-Item Env:EMDASH_WS_LAUNCH_RESULT -ErrorAction SilentlyContinue',
  '  }',
  '  if ($runasExit -ne 0) {',
  "    $warning = 'runas /trustlevel failed (exit ' + $runasExit + '): ' + $runasOutput.Trim()",
  '  } else {',
  '    $deadline = [DateTime]::UtcNow.AddSeconds(40)',
  '    while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {',
  '      Start-Sleep -Milliseconds 100',
  '    }',
  '    if (Test-Path -LiteralPath $resultPath) {',
  '      $line = [IO.File]::ReadAllText($resultPath).Trim()',
  '      Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue',
  "      if ($line -match '^0 [1-9][0-9]*$') { [Console]::Out.Write($line); exit 0 }",
  "      $warning = 'the de-elevated launch reported: ' + $line",
  '    } else {',
  "      $warning = 'the de-elevated launch did not report back within 40 seconds'",
  '    }',
  '  }',
  '}',
  '$line = Invoke-EmdashLaunch',
  "$note = 'W The workspace server was started elevated, so a non-elevated app on this computer '",
  "$note += 'cannot connect to it: ' + $warning",
  '[Console]::Out.Write($line + [Environment]::NewLine + $note)',
].join('\n');

export type PowerShellRunner = (
  encodedCommand: string,
  env: NodeJS.ProcessEnv
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type OutsideSessionLauncher = (
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<Result<{ pid: number; warnings?: string[] }, string>>;

/** Win32_Process.Create return values worth naming in a diagnostic. */
const WIN32_PROCESS_CREATE_ERRORS: Record<number, string> = {
  2: 'access denied',
  3: 'insufficient privilege',
  8: 'unknown failure',
  9: 'path not found',
  21: 'invalid parameter',
};

export function createOutsideSessionLauncher(
  runPowerShell: PowerShellRunner = runWindowsPowerShell
): OutsideSessionLauncher {
  return async (argv, options) => {
    const encoded = encodePowerShellCommand(LAUNCH_OUTSIDE_SESSION_SCRIPT);
    let result: Awaited<ReturnType<PowerShellRunner>>;
    try {
      result = await runPowerShell(encoded, {
        ...options.env,
        EMDASH_WS_LAUNCH_COMMAND_LINE: formatWindowsCommandLine(argv),
        EMDASH_WS_LAUNCH_DIRECTORY: options.cwd,
        EMDASH_WS_LAUNCH_SELF: encoded,
      });
    } catch (error) {
      return err(`could not run powershell.exe: ${errorMessage(error)}`);
    }
    if (result.exitCode !== 0) {
      return err(
        `WMI process creation failed (exit ${result.exitCode}): ${
          result.stderr.trim() || 'no error output'
        }`
      );
    }
    const [first = '', ...rest] = result.stdout.trim().split(/\r?\n/u);
    const match = /^(\d+) (\d+)$/u.exec(first.trim());
    if (!match) return err(`unexpected WMI launcher output: ${result.stdout.trim() || '(empty)'}`);
    const warnings = rest
      .map((line) => line.trim())
      .filter((line) => line.startsWith('W '))
      .map((line) => line.slice(2));
    const returnValue = Number(match[1]);
    const pid = Number(match[2]);
    if (returnValue !== 0 || pid <= 0) {
      const reason = WIN32_PROCESS_CREATE_ERRORS[returnValue] ?? 'unexpected result';
      return err(`Win32_Process.Create returned ${returnValue} (${reason})`);
    }
    return ok(warnings.length > 0 ? { pid, warnings } : { pid });
  };
}

export const launchOutsideSessionJob: OutsideSessionLauncher = createOutsideSessionLauncher();

function runWindowsPowerShell(
  encodedCommand: string,
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        encodedCommand,
      ],
      { encoding: 'utf8', env, timeout: 60_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      }
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
