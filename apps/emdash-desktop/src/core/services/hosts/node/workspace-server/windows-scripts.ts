import { powerShellLiteral, wrapPowerShellScript } from '@emdash/core/primitives/exec/api';
import { WORKSPACE_SERVER_VERSION_PATTERN, type WindowsWorkspaceServerLayout } from './layout';

/**
 * Windows PowerShell 5.1 scripts that manage the workspace server over Windows OpenSSH. They run
 * through `formatPowerShellEncodedCommand`, so no remote shell parses them; every caller value is
 * embedded as a PowerShell single-quoted literal. Exit codes: 41 download failure (as install.sh),
 * 44 not installed, 45 invalid `current` pointer or endpoint record, 46 incomplete installation,
 * 47 pipe connection failure, 48 daemon not running.
 */

export const WINDOWS_NOT_INSTALLED_EXIT_CODE = 44;
export const WINDOWS_INVALID_POINTER_EXIT_CODE = 45;

/**
 * Defines `Open-EmdashStandardStream`, an unbuffered FileStream over a raw standard handle
 * (-10 stdin, -11 stdout). Under Windows OpenSSH, `[Console]::OpenStandardInput()` never returns
 * data or end-of-file, while a FileStream over the same handle does. PowerShell cannot P/Invoke
 * without compiling, so this calls the .NET Framework's own `GetStdHandle` binding.
 */
const STANDARD_STREAM_FUNCTION = [
  'function Open-EmdashStandardStream([int]$id, [IO.FileAccess]$access) {',
  "  $native = [object].Assembly.GetType('Microsoft.Win32.Win32Native')",
  '  $getStdHandle = $null',
  "  if ($native) { $getStdHandle = $native.GetMethod('GetStdHandle', [Reflection.BindingFlags]'NonPublic,Static') }",
  "  if (-not $getStdHandle) { throw 'This PowerShell cannot open its standard streams.' }",
  '  $handle = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($getStdHandle.Invoke($null, @($id)), $false)',
  '  # A buffer size of 1 disables buffering, so bridged bytes are never held back.',
  '  return New-Object IO.FileStream($handle, $access, 1, $false)',
  '}',
].join('\n');

/** Defines `Get-EmdashCurrentVersion`, which returns the selected version or `$null`. */
function currentVersionFunction(layout: WindowsWorkspaceServerLayout): string {
  return [
    'function Get-EmdashCurrentVersion {',
    `  $pointer = ${powerShellLiteral(layout.currentPointer)}`,
    '  if (-not [IO.File]::Exists($pointer)) { return $null }',
    '  $value = [IO.File]::ReadAllText($pointer).Trim()',
    `  if ($value -cnotmatch ${powerShellLiteral(WORKSPACE_SERVER_VERSION_PATTERN.source)}) {`,
    "    Write-EmdashError ('The workspace-server current pointer is invalid: ' + $value)",
    `    exit ${WINDOWS_INVALID_POINTER_EXIT_CODE}`,
    '  }',
    '  return $value',
    '}',
  ].join('\n');
}

/** Prints the selected version, or nothing when the workspace server is not installed. */
export function buildWindowsInstalledVersionScript(layout: WindowsWorkspaceServerLayout): string {
  return wrapPowerShellScript(
    [
      currentVersionFunction(layout),
      '$version = Get-EmdashCurrentVersion',
      'if ($version) {',
      `  $node = [IO.Path]::Combine(${powerShellLiteral(layout.versionsDirectory)}, $version, 'node.exe')`,
      '  if ([IO.File]::Exists($node)) { [Console]::Out.Write($version) }',
      '}',
      'exit 0',
    ].join('\n')
  );
}

/**
 * Runs `start`, `stop`, or `status` with the selected version's bundled node.exe. The launcher
 * `.cmd` is not used: a batch file would reintroduce cmd.exe argument parsing.
 */
export function buildWindowsDaemonControlScript(
  layout: WindowsWorkspaceServerLayout,
  action: 'start' | 'stop' | 'status'
): string {
  return wrapPowerShellScript(
    [
      currentVersionFunction(layout),
      // Decode node's UTF-8 output correctly; setting it can fail without a console, which only
      // affects non-ASCII characters in messages.
      'try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { }',
      '$version = Get-EmdashCurrentVersion',
      'if (-not $version) {',
      "  Write-EmdashError 'The workspace server is not installed.'",
      `  exit ${WINDOWS_NOT_INSTALLED_EXIT_CODE}`,
      '}',
      `$directory = [IO.Path]::Combine(${powerShellLiteral(layout.versionsDirectory)}, $version)`,
      "$node = [IO.Path]::Combine($directory, 'node.exe')",
      "$entrypoint = [IO.Path]::Combine($directory, 'dist', 'index.mjs')",
      'if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($entrypoint)) {',
      "  Write-EmdashError ('The workspace-server installation at ' + $directory + ' is incomplete.')",
      '  exit 46',
      '}',
      `& $node $entrypoint ${powerShellLiteral(action)} '--socket' ${powerShellLiteral(layout.socketPath)}`,
      'exit $LASTEXITCODE',
    ].join('\n')
  );
}

/** Written to the bridge's stderr once the named pipe is connected. */
export const WINDOWS_PIPE_BRIDGE_READY_MARKER = 'emdash-workspace-bridge-ready';

/** Pipe names the daemon writes into its endpoint record (see workspace-server daemon/endpoint). */
const PIPE_RECORD_PATTERN = String.raw`^\\\\\.\\pipe\\(emdash-workspace-server-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`;

/**
 * Relays the SSH channel's stdin/stdout to the daemon's named pipe. Windows OpenSSH cannot forward
 * Unix sockets, so this replaces streamlocal forwarding: the script reads the endpoint record at
 * the daemon's well-known path, connects to the recorded pipe, reports readiness on stderr, and
 * copies raw bytes in both directions until either side closes. Nothing else is written to stdout.
 */
export function buildWindowsPipeBridgeScript(recordPath: string): string {
  return wrapPowerShellScript(
    [
      `$recordPath = ${powerShellLiteral(recordPath)}`,
      'if (-not [IO.File]::Exists($recordPath)) {',
      "  Write-EmdashError ('The workspace server is not running (no endpoint record at ' + $recordPath + ').')",
      '  exit 48',
      '}',
      `$match = [Text.RegularExpressions.Regex]::Match([IO.File]::ReadAllText($recordPath).Trim(), ${powerShellLiteral(PIPE_RECORD_PATTERN)})`,
      'if (-not $match.Success) {',
      "  Write-EmdashError ('The workspace-server endpoint record at ' + $recordPath + ' is invalid.')",
      `  exit ${WINDOWS_INVALID_POINTER_EXIT_CODE}`,
      '}',
      "$pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $match.Groups[1].Value, " +
        '[IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)',
      'try {',
      '  $pipe.Connect(5000)',
      '} catch {',
      "  Write-EmdashError ('Could not connect to the workspace server pipe: ' + $_.Exception.Message)",
      '  exit 47',
      '}',
      STANDARD_STREAM_FUNCTION,
      '$stdin = Open-EmdashStandardStream -10 Read',
      '$stdout = Open-EmdashStandardStream -11 Write',
      `Write-EmdashError ${powerShellLiteral(WINDOWS_PIPE_BRIDGE_READY_MARKER)}`,
      '$upstream = $stdin.CopyToAsync($pipe)',
      '$downstream = $pipe.CopyToAsync($stdout)',
      '[void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($upstream, $downstream))',
      '$pipe.Dispose()',
      'exit 0',
    ].join('\n')
  );
}

const DOWNLOAD_CLIENT = [
  '[Net.ServicePointManager]::SecurityProtocol = ' +
    '[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
  '$client = New-Object Net.WebClient',
  '$client.Encoding = [Text.Encoding]::UTF8',
].join('\n');

/** Downloads the first channel pointer that exists and prints it. */
export function buildWindowsChannelPointerScript(pointerUrls: readonly string[]): string {
  return wrapPowerShellScript(
    [
      DOWNLOAD_CLIENT,
      `$urls = @(${pointerUrls.map(powerShellLiteral).join(', ')})`,
      "$failure = 'no URL'",
      'foreach ($url in $urls) {',
      '  try {',
      '    [Console]::Out.Write($client.DownloadString($url))',
      '    exit 0',
      '  } catch {',
      "    $failure = $url + ': ' + $_.Exception.Message",
      '  }',
      '}',
      "Write-EmdashError ('Could not download workspace-server metadata from ' + $failure)",
      'exit 41',
    ].join('\n')
  );
}

/** Execution policy set by Group Policy refused to run the downloaded installer. */
export const WINDOWS_EXECUTION_POLICY_EXIT_CODE = 43;

/**
 * Downloads the release's `install.ps1` to `installerPath`. Downloading and running are separate
 * SSH commands on purpose: one command that downloads a script and runs it in memory matches the
 * "download cradle" signature antivirus products (including Microsoft Defender) block at process
 * creation, so the installer is only ever run from a file.
 */
export function buildWindowsInstallerDownloadScript(options: {
  scriptUrl: string;
  installerPath: string;
}): string {
  return wrapPowerShellScript(
    [
      DOWNLOAD_CLIENT,
      `$scriptUrl = ${powerShellLiteral(options.scriptUrl)}`,
      `$installer = ${powerShellLiteral(options.installerPath)}`,
      'try {',
      '  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($installer))',
      '  $client.DownloadFile($scriptUrl, $installer)',
      '} catch {',
      "  Write-EmdashError ('Could not download ' + $scriptUrl + ': ' + $_.Exception.Message)",
      '  exit 41',
      '}',
      'exit 0',
    ].join('\n')
  );
}

/**
 * Runs a downloaded `install.ps1` for `layout` and deletes it. The command that runs this script
 * must bypass the process-scope execution policy (Windows clients default to Restricted); an
 * execution policy enforced by Group Policy still wins and is reported as exit 43.
 */
export function buildWindowsInstallerRunScript(options: {
  installerPath: string;
  source: WindowsInstallerSource;
  version: string;
  layout: WindowsWorkspaceServerLayout;
}): string {
  const { source } = options;
  const cleanup = ['  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue'];
  let sourceArguments: string;
  if (source.kind === 'url') {
    sourceArguments = `-BaseUrl ${powerShellLiteral(source.baseUrl)}`;
  } else {
    if (!SHA256_PATTERN.test(source.sha256)) throw new Error('Invalid workspace-server checksum');
    // install.ps1 reads `<BaseUrl>/<version>/<artifact>`; a file URI keeps that layout offline.
    sourceArguments = `-BaseUrl ([Uri]$bundle).AbsoluteUri -Sha256 ${powerShellLiteral(source.sha256)}`;
    cleanup.push(
      '  Remove-Item -LiteralPath $bundle -Recurse -Force -ErrorAction SilentlyContinue'
    );
  }
  return wrapPowerShellScript(
    [
      `$installer = ${powerShellLiteral(options.installerPath)}`,
      ...(source.kind === 'staged' ? [`$bundle = ${powerShellLiteral(source.directory)}`] : []),
      'try {',
      `  & $installer ${sourceArguments} ` +
        `-Version ${powerShellLiteral(options.version)} ` +
        `-InstallRoot ${powerShellLiteral(options.layout.root)}`,
      '  $code = $LASTEXITCODE',
      '} catch [System.Management.Automation.PSSecurityException] {',
      "  Write-EmdashError ('Group Policy sets a PowerShell execution policy that blocks the " +
        "Maestro installer script: ' + $_.Exception.Message)",
      `  $code = ${WINDOWS_EXECUTION_POLICY_EXIT_CODE}`,
      '} finally {',
      ...cleanup,
      '}',
      'exit $code',
    ].join('\n')
  );
}

/**
 * Where `install.ps1` reads the artifact: a release base URL, or a staging directory already
 * holding `<version>/<artifact>` (uploaded by Maestro) whose checksum the desktop supplies.
 */
export type WindowsInstallerSource =
  | { kind: 'url'; baseUrl: string }
  | { kind: 'staged'; directory: string; sha256: string };

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Best-effort removal of staged files and directories after an abandoned install. */
export function buildWindowsRemovePathsScript(paths: readonly string[]): string {
  return wrapPowerShellScript(
    [
      ...paths.map(
        (target) =>
          `Remove-Item -LiteralPath ${powerShellLiteral(target)} -Recurse -Force -ErrorAction SilentlyContinue`
      ),
      'exit 0',
    ].join('\n')
  );
}

/**
 * Receives exactly `length` bytes on stdin into `path`, verifying the SHA-256 before the file
 * appears under its final name. Reading a fixed length avoids depending on how the remote shell
 * forwards end-of-file; a short or corrupt upload exits 41 and leaves nothing behind.
 */
export function buildWindowsUploadScript(options: {
  path: string;
  length: number;
  sha256: string;
}): string {
  if (!Number.isSafeInteger(options.length) || options.length < 0) {
    throw new Error('Invalid upload length');
  }
  if (!SHA256_PATTERN.test(options.sha256)) throw new Error('Invalid upload checksum');
  return wrapPowerShellScript(
    [
      `$target = ${powerShellLiteral(options.path)}`,
      "$partial = $target + '.partial'",
      `$remaining = [long]${options.length}`,
      '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))',
      STANDARD_STREAM_FUNCTION,
      '$source = Open-EmdashStandardStream -10 Read',
      '$output = [IO.File]::Create($partial)',
      '$buffer = New-Object byte[] 65536',
      'try {',
      '  while ($remaining -gt 0) {',
      '    $read = $source.Read($buffer, 0, [int][Math]::Min([long]$buffer.Length, $remaining))',
      '    if ($read -le 0) { break }',
      '    $output.Write($buffer, 0, $read)',
      '    $remaining -= $read',
      '  }',
      '} finally {',
      '  $output.Dispose()',
      '}',
      '$actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()',
      `if ($remaining -ne 0 -or $actual -cne ${powerShellLiteral(options.sha256)}) {`,
      '  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue',
      "  Write-EmdashError ('Upload of ' + [IO.Path]::GetFileName($target) + ' was incomplete or corrupt')",
      '  exit 41',
      '}',
      'Move-Item -LiteralPath $partial -Destination $target -Force',
      'exit 0',
    ].join('\n')
  );
}
