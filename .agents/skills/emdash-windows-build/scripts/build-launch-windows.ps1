param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '../../../..')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This script must run under native Windows PowerShell or pwsh, not inside WSL.'
}

$root = (Resolve-Path -LiteralPath $RepoRoot).Path
if ($root.Contains("'")) {
  throw "The checkout path contains an apostrophe (Vite cannot build from it). Follow SKILL.md to make a clean-path scratch worktree; rerun with -RepoRoot <scratch-path>."
}

$appDir = Join-Path $root 'apps/emdash-desktop'
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'electron-builder.config.ts'))) {
  throw "Not an Emdash desktop checkout: $root"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm is required on the Windows PATH.'
}

$id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
# Keep packaging output outside the checkout: Electron extraction/rename can hit EPERM
# when the output lives under the app's release directory on Windows.
$outputDir = Join-Path (Split-Path $root -Parent) "emdash-win-package-$id"
$profileDir = Join-Path $env:LOCALAPPDATA "emdash-build-profiles/$id"
$localConfig = Join-Path $appDir "electron-builder.local-$id.config.ts"

Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules/.modules.yaml'))) {
  & pnpm install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }
}

& pnpm run build
if ($LASTEXITCODE -ne 0) { throw "pnpm run build failed ($LASTEXITCODE)" }

# Keep the publisher's release config intact. Unsigned directory output is for local testing only.
Set-Content -LiteralPath $localConfig -Encoding UTF8 -Value @'
import base from './electron-builder.config.ts';
export default { ...base, win: { ...base.win, azureSignOptions: undefined } };
'@
try {
  Set-Location -LiteralPath $appDir
  & pnpm exec electron-builder --win --dir --publish never --config $localConfig "--config.directories.output=$outputDir"
  if ($LASTEXITCODE -ne 0) { throw "Unsigned Windows packaging failed ($LASTEXITCODE)" }
}
finally {
  Remove-Item -LiteralPath $localConfig -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $outputDir 'win-unpacked/Emdash.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Windows executable not found: $exe" }
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$env:EMDASH_USER_DATA_DIR = $profileDir
$env:EMDASH_DB_FILE = Join-Path $profileDir 'emdash4.db'
$env:EMDASH_LOG_FILE = Join-Path $profileDir 'emdash.log'
$env:TELEMETRY_ENABLED = 'false'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$process = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
Start-Sleep -Seconds 12
$process.Refresh()
if ($process.HasExited) { throw "Built Emdash exited early with code $($process.ExitCode). Log: $env:EMDASH_LOG_FILE" }

Write-Host "Windows build launched (PID $($process.Id))"
Write-Host "Executable: $exe"
Write-Host "Isolated profile: $profileDir"
Write-Host "Window title: $($process.MainWindowTitle) (handle $($process.MainWindowHandle))"
if ($process.MainWindowHandle -eq 0 -or -not (Test-Path -LiteralPath $env:EMDASH_DB_FILE)) {
  throw "Emdash is running, but its window or scratch database is not ready. Inspect $env:EMDASH_LOG_FILE"
}
