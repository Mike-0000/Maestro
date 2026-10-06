import { execFile } from 'node:child_process';
import {
  encodePowerShellCommand,
  formatWindowsCommandLine,
} from '@emdash/core/primitives/exec/api';
import { err, ok, type Result } from '@emdash/shared';

/** Creates the process through WMI and returns `<return value> <pid>`. Shared by both scripts. */
const CREATE_PROCESS_FUNCTION = [
  'function Invoke-EmdashCreate($commandLine, $directory, [string[]]$variables) {',
  '  $startupClass = Get-CimClass -ClassName Win32_ProcessStartup',
  '  $startup = New-CimInstance -CimClass $startupClass -ClientOnly -Property @{',
  '    ShowWindow = [uint16]0',
  '    EnvironmentVariables = $variables',
  '  }',
  '  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{',
  '    CommandLine = $commandLine',
  '    CurrentDirectory = $directory',
  '    ProcessStartupInformation = $startup',
  '  }',
  "  return ('{0} {1}' -f [int]$result.ReturnValue, [int]$result.ProcessId)",
  '}',
];

/** Where launch requests wait for the scheduled task that carries them out. */
const REQUEST_DIRECTORY =
  "Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'emdash-ws-launch'";

/**
 * Runs inside the one-shot scheduled task. A task receives no environment or arguments from the
 * caller, so it claims the request file the caller left (renaming it first, so a request is
 * launched once), creates the process, and reports through a result file renamed into place.
 * Requests older than two minutes are leftovers of a caller that died and are discarded.
 */
export const LAUNCH_TASK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  ...CREATE_PROCESS_FUNCTION,
  `$directory = ${REQUEST_DIRECTORY}`,
  "foreach ($spec in @(Get-ChildItem -LiteralPath $directory -Filter '*.spec' -File)) {",
  '  if ($spec.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddMinutes(-2)) {',
  '    Remove-Item -LiteralPath $spec.FullName -Force -ErrorAction SilentlyContinue',
  '    continue',
  '  }',
  "  $claimed = $spec.FullName + '.claimed'",
  '  try { Move-Item -LiteralPath $spec.FullName -Destination $claimed } catch { continue }',
  "  $resultPath = [IO.Path]::ChangeExtension($spec.FullName, '.result')",
  '  try {',
  '    $request = [IO.File]::ReadAllText($claimed) | ConvertFrom-Json',
  '    $variables = [string[]]$request.variables',
  '    $line = Invoke-EmdashCreate $request.commandLine $request.directory $variables',
  "  } catch { $line = 'E ' + $_.Exception.Message }",
  '  Remove-Item -LiteralPath $claimed -Force -ErrorAction SilentlyContinue',
  "  [IO.File]::WriteAllText($resultPath + '.tmp', $line)",
  "  Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force",
  '}',
].join('\n');

/**
 * Windows OpenSSH runs each session's processes inside a job object that is closed with the
 * session, and Node's `detached` spawn does not break away from it. A daemon started directly from
 * `start` would therefore die as soon as the desktop's control command returns. Asking WMI to
 * create the process makes the WMI provider host its parent, outside the session's job, while it
 * still runs as the connecting user.
 *
 * That is not enough on its own. `sshd` enforces the redirection-guard mitigation, every process
 * started from the session inherits it (through WMI and `runas` too), and a guarded process cannot
 * follow a junction that a non-administrator created: "The path cannot be traversed because it
 * contains an untrusted mount point". pnpm's `node_modules` and many agent CLI installs use such
 * junctions, so a guarded daemon cannot run agents or builds that work locally. An administrator's
 * SSH logon is also elevated, and its daemon would create a named pipe with an Administrators-only
 * DACL that the same user's non-elevated desktop app cannot open.
 *
 * So the script first asks Task Scheduler, which is outside the SSH session, to do the WMI create
 * from a one-shot task: with the user's interactive token when they are signed in (not elevated,
 * unguarded), otherwise with a background S4U token (unguarded, but elevated for administrators).
 * If neither works it falls back to the guarded launch and a `W ` line says so: through
 * `runas /trustlevel:0x20000` (a Basic User SAFER token: same user, Administrators deny-only) when
 * the caller is elevated, so a local app can still reach the pipe, or directly otherwise.
 *
 * Both scripts are constant. The command line, working directory, environment, and the scripts'
 * own encodings reach them through environment variables or the request file, so no
 * caller-controlled text is ever parsed as PowerShell.
 */
export const LAUNCH_OUTSIDE_SESSION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  ...CREATE_PROCESS_FUNCTION,
  // Leaves a request for the task, runs the task, and returns its result line. Throws when the
  // task never picked the request up (for example the user is not signed in).
  'function Invoke-EmdashTaskLaunch($request, $logonType, $powershell) {',
  `  $directory = ${REQUEST_DIRECTORY}`,
  '  New-Item -ItemType Directory -Force -Path $directory | Out-Null',
  "  $id = [guid]::NewGuid().ToString('N')",
  "  $specPath = Join-Path $directory ($id + '.spec')",
  "  $resultPath = Join-Path $directory ($id + '.result')",
  "  $taskName = 'emdash-ws-launch-' + $id",
  "  $flags = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '",
  '  try {',
  "    [IO.File]::WriteAllText($specPath + '.tmp', ($request | ConvertTo-Json -Compress))",
  "    Move-Item -LiteralPath ($specPath + '.tmp') -Destination $specPath -Force",
  '    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
  '    $argument = $flags + $env:EMDASH_WS_LAUNCH_TASK',
  '    $action = New-ScheduledTaskAction -Execute $powershell -Argument $argument',
  '    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel Limited',
  '    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
  '    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings',
  '    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null',
  '    Start-ScheduledTask -TaskName $taskName',
  '    $deadline = [DateTime]::UtcNow.AddSeconds(8)',
  '    while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {',
  '      Start-Sleep -Milliseconds 100',
  '    }',
  '    if (-not (Test-Path -LiteralPath $resultPath)) {',
  // Withdraw the request. If it is already gone the task claimed it, so the launch is under way
  // and must be waited for: starting another one would run two daemons.
  '      $withdrawn = $true',
  '      try {',
  "        Move-Item -LiteralPath $specPath -Destination ($specPath + '.withdrawn')",
  '      } catch { $withdrawn = $false }',
  "      if ($withdrawn) { throw 'the task did not start' }",
  '      $deadline = [DateTime]::UtcNow.AddSeconds(25)',
  '      while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {',
  '        Start-Sleep -Milliseconds 100',
  '      }',
  "      if (-not (Test-Path -LiteralPath $resultPath)) { return 'E the task did not report back' }",
  '    }',
  '    return [IO.File]::ReadAllText($resultPath).Trim()',
  '  } finally {',
  '    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue',
  "    foreach ($suffix in @('.spec', '.spec.tmp', '.spec.withdrawn', '.spec.claimed', '.result')) {",
  '      $leftover = Join-Path $directory ($id + $suffix)',
  '      Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue',
  '    }',
  '  }',
  '}',
  "$variables = New-Object 'System.Collections.Generic.List[string]'",
  'foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {',
  '  $name = [string]$entry.Key',
  "  if ($name.StartsWith('=') -or $name.StartsWith('EMDASH_WS_LAUNCH_')) { continue }",
  "  $variables.Add($name + '=' + [string]$entry.Value)",
  '}',
  '$request = [pscustomobject]@{',
  '  commandLine = $env:EMDASH_WS_LAUNCH_COMMAND_LINE',
  '  directory = $env:EMDASH_WS_LAUNCH_DIRECTORY',
  '  variables = $variables.ToArray()',
  '}',
  'function Invoke-EmdashDirectLaunch {',
  '  return Invoke-EmdashCreate $request.commandLine $request.directory $request.variables',
  '}',
  // The de-elevated copy: report through the result file, renamed into place so the elevated
  // copy never reads a partial write.
  '$resultPath = $env:EMDASH_WS_LAUNCH_RESULT',
  'if ($resultPath) {',
  "  try { $line = Invoke-EmdashDirectLaunch } catch { $line = 'E ' + $_.Exception.Message }",
  "  [IO.File]::WriteAllText($resultPath + '.tmp', $line)",
  "  Move-Item -LiteralPath ($resultPath + '.tmp') -Destination $resultPath -Force",
  '  exit 0',
  '}',
  '$principal = New-Object Security.Principal.WindowsPrincipal(',
  '  [Security.Principal.WindowsIdentity]::GetCurrent()',
  ')',
  '$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  "$powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
  "$encodedPattern = '^[A-Za-z0-9+/=]+$'",
  '$taskFailures = @()',
  'if ($env:EMDASH_WS_LAUNCH_TASK -notmatch $encodedPattern) {',
  "  $taskFailures += 'the task command could not be formed'",
  '} else {',
  "  foreach ($logonType in @('Interactive', 'S4U')) {",
  '    try {',
  '      $line = Invoke-EmdashTaskLaunch $request $logonType $powershell',
  "      if ($line -match '^0 [1-9][0-9]*$') {",
  '        [Console]::Out.Write($line)',
  "        if ($logonType -eq 'S4U' -and $elevated) {",
  "          $note = 'W The workspace server was started elevated because this user is not signed '",
  "          $note += 'in at the computer, so a non-elevated app on this computer cannot connect '",
  "          $note += 'to it.'",
  '          [Console]::Out.Write([Environment]::NewLine + $note)',
  '        }',
  '        exit 0',
  '      }',
  "      $taskFailures += $logonType + ' task reported: ' + $line",
  "    } catch { $taskFailures += $logonType + ' task: ' + $_.Exception.Message }",
  '  }',
  '}',
  "$guardNote = 'W The workspace server could not be started through Task Scheduler ('",
  "$guardNote += ($taskFailures -join '; ') + '). It was started from the SSH session instead, '",
  "$guardNote += 'where Windows blocks folder links (junctions) made by non-administrators, so '",
  "$guardNote += 'agents and builds may fail with an untrusted mount point error.'",
  'if (-not $elevated) {',
  '  [Console]::Out.Write((Invoke-EmdashDirectLaunch) + [Environment]::NewLine + $guardNote)',
  '  exit 0',
  '}',
  '$warning = $null',
  "$resultName = 'emdash-ws-launch-' + [guid]::NewGuid().ToString('N') + '.txt'",
  '$resultPath = Join-Path ([IO.Path]::GetTempPath()) $resultName',
  "if ($powershell -match '[\\s\"]' -or $env:EMDASH_WS_LAUNCH_SELF -notmatch $encodedPattern) {",
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
  '    $deadline = [DateTime]::UtcNow.AddSeconds(25)',
  '    while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {',
  '      Start-Sleep -Milliseconds 100',
  '    }',
  '    if (Test-Path -LiteralPath $resultPath) {',
  '      $line = [IO.File]::ReadAllText($resultPath).Trim()',
  '      Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue',
  "      if ($line -match '^0 [1-9][0-9]*$') {",
  '        [Console]::Out.Write($line + [Environment]::NewLine + $guardNote)',
  '        exit 0',
  '      }',
  "      $warning = 'the de-elevated launch reported: ' + $line",
  '    } else {',
  "      $warning = 'the de-elevated launch did not report back within 25 seconds'",
  '    }',
  '  }',
  '}',
  "$note = 'W The workspace server was started elevated, so a non-elevated app on this computer '",
  "$note += 'cannot connect to it: ' + $warning",
  '$newLine = [Environment]::NewLine',
  '[Console]::Out.Write((Invoke-EmdashDirectLaunch) + $newLine + $guardNote + $newLine + $note)',
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
        EMDASH_WS_LAUNCH_TASK: encodePowerShellCommand(LAUNCH_TASK_SCRIPT),
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
      { encoding: 'utf8', env, timeout: 90_000, windowsHide: true, maxBuffer: 256 * 1024 },
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
