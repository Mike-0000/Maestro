# Installs one pinned workspace-server version on Windows for the current user.
#
# Windows counterpart of install.sh with the same exit codes: 40 unsupported platform,
# 41 download or checksum failure, 42 install failure. Over Windows OpenSSH, Chorus downloads this
# file into the install root's staging directory and runs it with a process-scope
# `-ExecutionPolicy Bypass` (a Group Policy execution policy still applies). It never runs it from
# memory: antivirus products block download-and-execute one-liners. It is also safe to run by hand:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Version 0.1.8
#
# Layout (under %USERPROFILE%\.emdash\workspace-server unless -InstallRoot is given):
#   versions\<version>\   extracted artifact (node.exe, dist\index.mjs, bin\rg.exe, ...)
#   current               text file naming the selected version (no symlinks needed)
#   install.lock\         directory lock holding the installer's pid
param(
  [string]$BaseUrl = 'https://releases.emdash.sh/workspace-server',
  [string]$Version = '',
  [string]$Sha256 = '',
  [string]$InstallRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-InstallError([string]$message) {
  $bytes = [Text.Encoding]::UTF8.GetBytes('workspace-server install: ' + $message + "`n")
  $stream = [Console]::OpenStandardError()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

function Stop-Install([int]$code, [string]$message) {
  Write-InstallError $message
  exit $code
}

$BaseUrl = $BaseUrl.TrimEnd('/')
if ($BaseUrl -notmatch '^(https|http|file)://') {
  Stop-Install 41 'base URL must use https, http, or file'
}
if (-not $Version) { Stop-Install 42 '-Version is required' }
$versionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
if ($Version -cnotmatch $versionPattern) {
  Stop-Install 41 ("invalid workspace-server version '" + $Version + "'")
}

$build = [Environment]::OSVersion.Version.Build
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or $build -lt 17763) {
  Stop-Install 40 ('Windows 10 1809 / Windows Server 2019 (build 17763) or later is required; found build ' + $build)
}
$nativeArch = $env:PROCESSOR_ARCHITEW6432
if (-not $nativeArch) { $nativeArch = $env:PROCESSOR_ARCHITECTURE }
if (-not $nativeArch) {
  # Minimal environments can omit the variables; the machine environment always records them.
  $machineEnvironment = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  try {
    $nativeArch = (Get-ItemProperty -LiteralPath $machineEnvironment -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
  } catch { }
}
switch ($nativeArch) {
  'AMD64' { $arch = 'x64' }
  'ARM64' {
    if ($build -lt 22000) { Stop-Install 40 'Windows on ARM needs Windows 11 to run the x64 workspace server' }
    $arch = 'x64'
  }
  default { Stop-Install 40 ('unsupported Windows architecture ' + $nativeArch) }
}

if (-not $InstallRoot) {
  $profileDirectory = $env:USERPROFILE
  if (-not $profileDirectory -or -not [IO.Path]::IsPathRooted($profileDirectory)) {
    Stop-Install 42 'USERPROFILE must be an absolute path'
  }
  $InstallRoot = [IO.Path]::Combine($profileDirectory, '.emdash', 'workspace-server')
}
if (-not [IO.Path]::IsPathRooted($InstallRoot)) { Stop-Install 42 '-InstallRoot must be an absolute path' }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$client = New-Object Net.WebClient
$client.Encoding = [Text.Encoding]::UTF8

$artifact = 'emdash-workspace-server-' + $Version + '-win32-' + $arch + '.zip'
$artifactUrl = $BaseUrl + '/' + $Version + '/' + $artifact
if (-not $Sha256) {
  try {
    $checksums = $client.DownloadString($artifactUrl + '.sha256')
  } catch {
    Stop-Install 41 ('could not download the checksum for ' + $artifact + ': ' + $_.Exception.Message)
  }
  foreach ($line in ($checksums -split "`r?`n")) {
    $fields = $line.Trim() -split '\s+'
    if ($fields.Count -eq 2 -and $fields[1].TrimStart('*') -ceq $artifact) {
      $Sha256 = $fields[0]
      break
    }
  }
}
$Sha256 = $Sha256.ToLowerInvariant()
if ($Sha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-Install 41 ('invalid checksum for ' + $artifact) }

$versionsDirectory = Join-Path $InstallRoot 'versions'
$versionDirectory = Join-Path $versionsDirectory $Version
$currentPointer = Join-Path $InstallRoot 'current'
$stagingDirectory = Join-Path $InstallRoot 'staging'
$staging = Join-Path $stagingDirectory ('.install-' + $Version + '-' + $PID)
$archive = Join-Path $stagingDirectory ($artifact + '.' + $PID)
$nextPointer = Join-Path $InstallRoot ('.current-' + $Version + '-' + $PID)
$lock = Join-Path $InstallRoot 'install.lock'
$lockPidFile = Join-Path $lock 'pid'

function Test-Installation([string]$directory) {
  return (Test-Path -LiteralPath (Join-Path $directory 'node.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path (Join-Path $directory 'dist') 'index.mjs') -PathType Leaf)
}

function Select-CurrentVersion {
  [IO.File]::WriteAllText($nextPointer, $Version + "`n", (New-Object Text.UTF8Encoding $false))
  if ([IO.File]::Exists($currentPointer)) {
    [IO.File]::Replace($nextPointer, $currentPointer, [NullString]::Value)
  } else {
    [IO.File]::Move($nextPointer, $currentPointer)
  }
}

foreach ($directory in @($InstallRoot, $versionsDirectory, $stagingDirectory, (Join-Path $InstallRoot 'run'))) {
  [void][IO.Directory]::CreateDirectory($directory)
}

$attempt = 0
while ($true) {
  try {
    [void](New-Item -ItemType Directory -Path $lock -ErrorAction Stop)
    break
  } catch {
    $lockPid = $null
    try { $lockPid = [int]([IO.File]::ReadAllText($lockPidFile).Trim()) } catch { }
    if ($lockPid -and -not (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
      continue
    }
    $attempt += 1
    if ($attempt -ge 120) { Stop-Install 42 'timed out waiting for install lock' }
    Start-Sleep -Milliseconds 250
  }
}

# Returns the process exit code; runs while holding the install lock.
function Install-SelectedVersion {
  [IO.File]::WriteAllText($lockPidFile, [string]$PID)

  $current = $null
  if ([IO.File]::Exists($currentPointer)) { $current = [IO.File]::ReadAllText($currentPointer).Trim() }
  if ($current -ceq $Version -and (Test-Installation $versionDirectory)) { return 0 }

  if (Test-Path -LiteralPath $versionDirectory) {
    if (-not (Test-Installation $versionDirectory)) {
      Write-InstallError ('existing workspace-server ' + $Version + ' installation is incomplete')
      return 42
    }
    Select-CurrentVersion
    return 0
  }

  try {
    $client.DownloadFile($artifactUrl, $archive)
  } catch {
    Write-InstallError ('could not download ' + $artifact + ': ' + $_.Exception.Message)
    return 41
  }
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $Sha256) {
    Write-InstallError ('checksum verification failed for ' + $artifact)
    return 41
  }

  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
  } catch {
    Write-InstallError ('could not extract ' + $artifact + ': ' + $_.Exception.Message)
    return 42
  }
  # Archives hold one top-level directory, like the tar.gz artifacts (tar --strip-components=1).
  $entries = @(Get-ChildItem -LiteralPath $staging -Force)
  $extracted = $staging
  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $extracted = $entries[0].FullName }
  if (-not (Test-Installation $extracted)) {
    Write-InstallError 'artifact is missing node.exe or dist\index.mjs'
    return 42
  }

  [IO.Directory]::Move($extracted, $versionDirectory)
  Select-CurrentVersion
  return 0
}

$exitCode = 42
try {
  $exitCode = Install-SelectedVersion
} catch {
  Write-InstallError $_.Exception.Message
} finally {
  foreach ($path in @($staging, $archive, $nextPointer)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
}
exit $exitCode
