param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '../../../..'),
  # Where builds are kept (one folder per build, for rollback).
  [string]$ReleasesDir = 'C:\Github\chorus-releases',
  # Install an existing unpacked build (a chorus-releases\<build>\win-unpacked folder) instead of
  # building one. Use this to roll back.
  [string]$AppDir = '',
  # Install an existing NSIS installer instead of building one.
  [string]$InstallerPath = '',
  # Build and install through an NSIS installer (slower) instead of mirroring the unpacked app.
  [switch]$Installer,
  # Unpacked builds are ~900 MB; older ones beyond this many are deleted after a build.
  [int]$KeepBuilds = 3,
  # Build even with uncommitted changes (the build-info records it as dirty).
  [switch]$AllowDirty,
  # Close running Chorus instead of waiting for the user to quit it. Ends every agent and
  # terminal running inside Chorus, including a Claude session that launched this script.
  [switch]$CloseRunning,
  # Build only; do not install.
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This script must run under native Windows PowerShell or pwsh.'
}

if (-not $InstallerPath -and -not $AppDir) {
  $root = (Resolve-Path -LiteralPath $RepoRoot).Path
  if ($root.Contains("'")) {
    throw "The checkout path contains an apostrophe (Vite cannot build from it): $root. Build from C:\Github\chorus or a worktree under C:\Github\chorus-worktrees."
  }
  $appDir = Join-Path $root 'apps/emdash-desktop'
  if (-not (Test-Path -LiteralPath (Join-Path $appDir 'electron-builder.config.ts'))) {
    throw "Not a Chorus desktop checkout: $root"
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required on PATH.' }

  $dirty = (& git -C $root status --porcelain --untracked-files=no)
  if ($dirty -and -not $AllowDirty) {
    throw "Uncommitted changes in $root. Commit them first, or pass -AllowDirty."
  }
  $sha = (& git -C $root rev-parse --short HEAD).Trim()
  $branch = (& git -C $root branch --show-current).Trim()

  $id = (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$sha"
  $outputDir = Join-Path $ReleasesDir $id
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

  Set-Location -LiteralPath $root
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules/.modules.yaml'))) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }
  }
  & pnpm run build
  if ($LASTEXITCODE -ne 0) { throw "pnpm run build failed ($LASTEXITCODE)" }

  # Output outside the checkout: packaging under apps/emdash-desktop/release can hit EPERM.
  # The default `dir` target skips building and compressing an NSIS installer (~1 min); the
  # unpacked app is mirrored straight into the install directory instead.
  $target = if ($Installer) { 'nsis' } else { 'dir' }
  Set-Location -LiteralPath $appDir
  & pnpm exec electron-builder --win $target --x64 --publish never --config electron-builder.config.ts "--config.directories.output=$outputDir"
  $packExit = $LASTEXITCODE
  # Packaging runs with %SystemDrive% unset, so Windows writes a literal "%SystemDrive%" cache
  # folder into the app directory; it is never part of the build.
  Remove-Item -LiteralPath (Join-Path $appDir '%SystemDrive%') -Recurse -Force -ErrorAction SilentlyContinue
  if ($packExit -ne 0) { throw "Packaging failed ($packExit)" }

  if ($Installer) {
    $InstallerPath = Get-ChildItem -LiteralPath $outputDir -Filter '*.exe' |
      Where-Object { $_.Name -notmatch 'Uninstall' } |
      Select-Object -First 1 -ExpandProperty FullName
    if (-not $InstallerPath) { throw "No installer found in $outputDir" }
    # win-unpacked is only an intermediate; the installer is what we keep.
    Remove-Item -LiteralPath (Join-Path $outputDir 'win-unpacked') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Installer: $InstallerPath"
  } else {
    $AppDir = Join-Path $outputDir 'win-unpacked'
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'Chorus.exe'))) { throw "No Chorus.exe in $AppDir" }
    Write-Host "Unpacked app: $AppDir"
  }
  Set-Content -LiteralPath (Join-Path $outputDir 'build-info.txt') -Encoding UTF8 -Value @(
    "commit: $sha",
    "branch: $branch",
    "dirty: $([bool]$dirty)",
    "target: $target",
    "built: $(Get-Date -Format o)"
  )

  # Keep the newest unpacked builds for rollback; logs, build-info and profile backups stay.
  Get-ChildItem -LiteralPath $ReleasesDir -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'win-unpacked') } |
    Sort-Object Name -Descending |
    Select-Object -Skip $KeepBuilds |
    ForEach-Object {
      Remove-Item -LiteralPath (Join-Path $_.FullName 'win-unpacked') -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "Pruned old unpacked build: $($_.Name)"
    }
}

if ($AppDir) {
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'resources\app.asar'))) { throw "Not an unpacked Chorus build: $AppDir" }
  $AppDir = (Resolve-Path -LiteralPath $AppDir).Path
  $source = "-AppDir `"$AppDir`""
  $log = Join-Path (Split-Path $AppDir) 'install.log'
} else {
  if (-not (Test-Path -LiteralPath $InstallerPath)) { throw "Installer not found: $InstallerPath" }
  $source = "-InstallerPath `"$InstallerPath`""
  $log = Join-Path (Split-Path $InstallerPath) 'install.log'
}
if ($BuildOnly) { return }

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Chorus'
$helper = Join-Path $PSScriptRoot 'apply-install.ps1'
$helperArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$helper`" $source -InstallDir `"$installDir`" -LogPath `"$log`""
if ($CloseRunning) { $helperArgs += ' -CloseRunning' }

# Start the helper through WMI so it is not a child of Chorus: Chorus ends its terminals' process
# trees when it quits, which would otherwise kill the helper before it installs.
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "powershell.exe $helperArgs"
}
if ($result.ReturnValue -ne 0) { throw "Could not start the install helper (WMI $($result.ReturnValue))" }

Write-Host "Install helper started (PID $($result.ProcessId)). Log: $log"
if ($CloseRunning) {
  Write-Host 'It is closing Chorus now, then installs and relaunches it.'
} else {
  Write-Host 'It installs as soon as Chorus is fully quit, then relaunches it.'
}
