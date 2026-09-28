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
 * The script is constant. The command line and working directory reach it through environment
 * variables, so no caller-controlled text is ever parsed as PowerShell.
 */
export const LAUNCH_OUTSIDE_SESSION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$commandLine = $env:EMDASH_WS_LAUNCH_COMMAND_LINE',
  '$directory = $env:EMDASH_WS_LAUNCH_DIRECTORY',
  "$variables = New-Object 'System.Collections.Generic.List[string]'",
  'foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {',
  '  $name = [string]$entry.Key',
  "  if ($name.StartsWith('=') -or $name.StartsWith('EMDASH_WS_LAUNCH_')) { continue }",
  "  $variables.Add($name + '=' + [string]$entry.Value)",
  '}',
  '$startupClass = Get-CimClass -ClassName Win32_ProcessStartup',
  '$startup = New-CimInstance -CimClass $startupClass -ClientOnly -Property @{',
  '  ShowWindow = [uint16]0',
  '  EnvironmentVariables = $variables.ToArray()',
  '}',
  '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
  '  CommandLine = $commandLine',
  '  CurrentDirectory = $directory',
  '  ProcessStartupInformation = $startup',
  '}',
  "[Console]::Out.Write(('{0} {1}' -f [int]$result.ReturnValue, [int]$result.ProcessId))",
].join('\n');

export type PowerShellRunner = (
  encodedCommand: string,
  env: NodeJS.ProcessEnv
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type OutsideSessionLauncher = (
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<Result<{ pid: number }, string>>;

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
    const match = /^(\d+) (\d+)$/u.exec(result.stdout.trim());
    if (!match) return err(`unexpected WMI launcher output: ${result.stdout.trim() || '(empty)'}`);
    const returnValue = Number(match[1]);
    const pid = Number(match[2]);
    if (returnValue !== 0 || pid <= 0) {
      const reason = WIN32_PROCESS_CREATE_ERRORS[returnValue] ?? 'unexpected result';
      return err(`Win32_Process.Create returned ${returnValue} (${reason})`);
    }
    return ok({ pid });
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
