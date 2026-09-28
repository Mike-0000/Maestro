param(
  [Parameter(Mandatory)][string]$JobPath,
  [switch]$Bootstrap
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Write-AtomicJson([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $json = ConvertTo-Json -InputObject $Value -Depth 12
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-InstallJournal([object]$Job, [string]$Phase, [hashtable]$Details = @{}) {
  $journalRoot = Join-Path $Job.stateRoot 'InstallJournals'
  $journalId = if ($Job.jobId) { $Job.jobId } else { $Job.candidateId }
  $journalPath = Join-Path $journalRoot "$journalId.json"
  Write-AtomicJson $journalPath @{
    version = 1
    candidateId = $Job.candidateId
    repositoryPath = $Job.repositoryPath
    installRoot = $Job.installRoot
    stageRoot = Join-Path (Split-Path $Job.installRoot -Parent) "Chorus.stage-$($Job.candidateId)"
    backupRoot = Join-Path (Split-Path $Job.installRoot -Parent) "Chorus.backup-$($Job.candidateId)"
    failedRoot = Join-Path (Split-Path $Job.installRoot -Parent) "Chorus.failed-$($Job.candidateId)"
    commit = $Job.commit
    buildId = $Job.buildId
    artifactDigest = $Job.artifactDigest
    nonce = $Job.nonce
    phase = $Phase
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    details = $Details
  }
}

function Start-DetachedWorker([string]$Path, [string]$ScriptPath) {
  $workerExe = (Get-Process -Id $PID).Path
  $escapedScript = $ScriptPath.Replace('"', '""')
  $escapedJob = $Path.Replace('"', '""')
  $commandLine = '"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -JobPath "{2}"' -f `
    $workerExe, $escapedScript, $escapedJob
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  if ($created.ReturnValue -ne 0) {
    throw "Windows could not detach the Chorus update worker (WMI $($created.ReturnValue))."
  }
}

function Assert-UnderDirectory([string]$Path, [string]$Root, [string]$Label) {
  $fullPath = Get-FullPath $Path
  $fullRoot = (Get-FullPath $Root) + '\'
  if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its expected state directory."
  }
  return $fullPath
}

function Get-TreeFiles([string]$Root) {
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Package root is a reparse point: $Root"
  }
  $files = @()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Package contains a reparse point: $($entry.FullName)"
      }
      if ($entry.PSIsContainer) {
        $pending.Push($entry.FullName)
      } else {
        $relative = $entry.FullName.Substring($Root.Length + 1).Replace('\', '/')
        $files += [pscustomobject]@{ Path = $relative; FullName = $entry.FullName }
      }
    }
  }
  return ,$files
}

function Assert-NoReparsePoints([string]$Root, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "$Label directory is missing."
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label root is a reparse point: $Root"
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push((Get-FullPath $Root))
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $($entry.FullName)"
      }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
    }
  }
}

function Assert-Package([string]$SourceRoot, [string]$ManifestPath, [string]$StateRoot, [string]$ExpectedDigest, [switch]$AllowRelocated) {
  $source = if ($AllowRelocated) { Get-FullPath $SourceRoot } else {
    Assert-UnderDirectory $SourceRoot (Join-Path $StateRoot 'Artifacts') 'Package path'
  }
  $manifestFile = Assert-UnderDirectory $ManifestPath (Join-Path $StateRoot 'Artifacts') 'Manifest path'
  $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  if (-not $AllowRelocated -and (Get-FullPath $manifest.artifactRoot) -ne $source) {
    throw 'Package manifest points to a different artifact directory.'
  }
  if ($AllowRelocated) {
    [void](Assert-UnderDirectory $manifest.artifactRoot (Join-Path $StateRoot 'Artifacts') 'Manifest artifact path')
  }
  if ($manifest.artifactDigest -ne $ExpectedDigest -or $manifest.commit -notmatch '^[a-f0-9]{40}$') {
    throw 'Package manifest does not match the scheduled delivery receipt.'
  }
  $manifestFiles = @($manifest.files)
  if ($manifestFiles.Count -eq 0) { throw 'Package manifest has no files.' }
  $actualFiles = Get-TreeFiles $source
  if ($actualFiles.Count -ne $manifestFiles.Count) { throw 'Package file inventory differs from its manifest.' }
  $actualByPath = @{}
  foreach ($file in $actualFiles) { $actualByPath[$file.Path] = $file.FullName }

  $digestBuilder = [Text.StringBuilder]::new()
  foreach ($file in $manifestFiles) {
    if ([IO.Path]::IsPathRooted($file.path) -or $file.path.Contains('..') -or $file.path.Contains('\')) {
      throw "Invalid relative path in package manifest: $($file.path)"
    }
    if (-not $actualByPath.ContainsKey([string]$file.path)) { throw "Package is missing $($file.path)." }
    $actualHash = (Get-FileHash -LiteralPath $actualByPath[[string]$file.path] -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $file.sha256) { throw "Package hash mismatch for $($file.path)." }
    [void]$digestBuilder.Append([string]$file.path).Append([char]0).Append($actualHash).Append("`n")
  }
  $digestBytes = [Text.Encoding]::UTF8.GetBytes($digestBuilder.ToString())
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $computedDigest = [BitConverter]::ToString($sha.ComputeHash($digestBytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($computedDigest -ne $ExpectedDigest) { throw 'Package tree digest does not match the scheduled receipt.' }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'Chorus.exe') -PathType Leaf)) {
    throw 'The validated package does not contain Chorus.exe.'
  }
  return $manifest
}

function Copy-Package([string]$Source, [string]$Destination) {
  Assert-NoReparsePoints $Source 'Copy source'
  New-Item -ItemType Directory -Path $Destination | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $Destination -Recurse -Force
  }
}

function Backup-Profile([string]$ProfileRoot, [string]$StateRoot, [string]$CandidateId) {
  if (-not (Test-Path -LiteralPath $ProfileRoot -PathType Container)) { return $null }
  Assert-NoReparsePoints $ProfileRoot 'Chorus profile'
  $backupRoot = Join-Path (Join-Path $StateRoot 'ProfileBackups') "$CandidateId-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $cacheNames = @('Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'lockfile')
  foreach ($entry in Get-ChildItem -LiteralPath $ProfileRoot -Force) {
    if ($cacheNames -notcontains $entry.Name) {
      Copy-Item -LiteralPath $entry.FullName -Destination $backupRoot -Recurse -Force
    }
  }
  return $backupRoot
}

function Get-AppExecutable([string]$Root) {
  foreach ($name in @('Maestro.exe', 'Chorus.exe')) {
    $path = Join-Path $Root $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  throw "Neither Maestro.exe nor Chorus.exe was found at $Root."
}

function Get-InstalledProcesses([string]$InstallRoot) {
  $prefix = (Get-FullPath $InstallRoot) + '\'
  return @(Get-Process -Name 'Maestro','Chorus' -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
    catch { $false }
  })
}

function Get-CancelMarker([object]$Job) {
  return "$($Job.JobPath).cancelled"
}

function Assert-InstallNotCancelled([object]$Job) {
  if (Test-Path -LiteralPath (Get-CancelMarker $Job)) {
    throw 'The user cancelled before installation began; the current Chorus installation is unchanged.'
  }
}

function Enter-InstallReplacement([object]$Job) {
  $pendingPath = "$($Job.JobPath).pending"
  $applyingPath = "$($Job.JobPath).applying"
  try {
    [IO.File]::Move($pendingPath, $applyingPath)
  } catch {
    Assert-InstallNotCancelled $Job
    throw 'The install request could not enter its replacement phase.'
  }
}

function Assert-NoLegacyInstaller {
  try {
    $processes = Get-CimInstance -ClassName Win32_Process
  } catch {
    throw 'Could not check for an older Chorus installer; replacement is blocked.'
  }
  $legacyPattern = '(?i)(^|[\\/\s"''])(install-chorus|apply-install)\.ps1(?=$|[\s"''])'
  foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID) { continue }
    if ([string]$process.CommandLine -match $legacyPattern) {
      throw 'An older Chorus install helper is still running; finish or cancel it before replacement.'
    }
  }
}

function Wait-ForChorusExit([string]$InstallRoot, [int]$TimeoutHours, [object]$Job) {
  $deadline = (Get-Date).AddHours($TimeoutHours)
  while (Get-InstalledProcesses $InstallRoot) {
    Assert-InstallNotCancelled $Job
    if ((Get-Date) -ge $deadline) { throw "Chorus did not exit within $TimeoutHours hours; install was not started." }
    Start-Sleep -Seconds 2
  }
  Assert-InstallNotCancelled $Job
}

function Assert-CanonicalBase([object]$Job) {
  $mainCommit = (& git.exe -C $Job.repositoryPath rev-parse --verify "$($Job.mainRef)^{commit}").Trim()
  if ($LASTEXITCODE -ne 0 -or $mainCommit -ne $Job.base) {
    throw 'The canonical Chorus branch moved while the worker waited; prepare and validate a fresh candidate.'
  }
}

function Invoke-Install([object]$Job) {
  $stateRoot = Get-FullPath $Job.stateRoot
  $expectedRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Chorus\Delivery\v1')
  if ($stateRoot -ne $expectedRoot) { throw 'Delivery state directory does not match the current Windows user.' }
  $installRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Programs\Chorus')
  if ((Get-FullPath $Job.installRoot) -ne $installRoot) { throw 'Install target is not the current user Chorus installation.' }
  [void](Get-AppExecutable $installRoot)
  if ($Job.candidateId -notmatch '^[a-f0-9-]{36}$' -or $Job.nonce -notmatch '^[a-f0-9-]{36}$') {
    throw 'Invalid candidate or launch identity in install job.'
  }
  if ($Job.base -notmatch '^[a-f0-9]{40}$' -or $Job.mainRef -notmatch '^refs/heads/[A-Za-z0-9._/-]+$' -or $Job.mainRef.Contains('..')) {
    throw 'Invalid integration base in install job.'
  }

  $artifactRoot = Assert-UnderDirectory $Job.artifactRoot (Join-Path $stateRoot 'Artifacts') 'Package path'
  $manifest = Assert-Package $artifactRoot $Job.manifestPath $stateRoot $Job.artifactDigest
  if (
    $manifest.commit -ne $Job.commit -or
    $manifest.buildId -ne $Job.buildId -or
    [int]$manifest.deliveryProtocol -ne 1
  ) {
    throw 'Build manifest does not match the selected candidate.'
  }
  Write-InstallJournal $Job 'verified'

  $mutex = [Threading.Mutex]::new($false, 'Local\ChorusDeliveryInstall')
  $ownsMutex = $false
  $stageRoot = Join-Path (Split-Path $installRoot -Parent) "Chorus.stage-$($Job.candidateId)"
  $backupRoot = Join-Path (Split-Path $installRoot -Parent) "Chorus.backup-$($Job.candidateId)"
  $failedRoot = Join-Path (Split-Path $installRoot -Parent) "Chorus.failed-$($Job.candidateId)"
  $movedOriginal = $false
  $movedCandidate = $false
  $started = $null
  try {
    try { $ownsMutex = $mutex.WaitOne([TimeSpan]::FromMinutes(1)) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another Chorus installation is already running.' }
    Wait-ForChorusExit $installRoot 12 $Job
    Assert-CanonicalBase $Job
    Assert-NoLegacyInstaller
    Assert-InstallNotCancelled $Job

    if (Test-Path -LiteralPath $stageRoot) { throw "Install staging directory already exists: $stageRoot" }
    if (Test-Path -LiteralPath $backupRoot) { throw "Install backup directory already exists: $backupRoot" }
    if (Test-Path -LiteralPath $failedRoot) { throw "Install failure directory already exists: $failedRoot" }
    Copy-Package $artifactRoot $stageRoot
    [void](Assert-Package $stageRoot $Job.manifestPath $stateRoot $Job.artifactDigest -AllowRelocated)
    $uninstaller = Join-Path $installRoot 'Uninstall Chorus.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      Copy-Item -LiteralPath $uninstaller -Destination $stageRoot
    }

    $profileBackup = Backup-Profile $Job.profileRoot $stateRoot $Job.candidateId
    $previousBuild = $null
    $previousProvenancePath = Join-Path $installRoot 'resources\build-provenance.json'
    if (Test-Path -LiteralPath $previousProvenancePath -PathType Leaf) {
      try {
        $previousProvenance = Get-Content -LiteralPath $previousProvenancePath -Raw | ConvertFrom-Json
        if (
          [int]$previousProvenance.deliveryProtocol -eq 1 -and
          $previousProvenance.commit -match '^[a-f0-9]{40}$' -and
          $previousProvenance.buildId -match '^[a-f0-9-]{36}$' -and
          $previousProvenance.version
        ) {
          $previousBuild = @{
            deliveryProtocol = 1
            commit = $previousProvenance.commit
            buildId = $previousProvenance.buildId
            version = $previousProvenance.version
          }
        }
      } catch { $previousBuild = $null }
    }
    Write-InstallJournal $Job 'staged' @{ profileBackup = $profileBackup }
    Assert-CanonicalBase $Job
    Assert-NoLegacyInstaller
    Write-InstallJournal $Job 'replacement-starting' @{ profileBackup = $profileBackup }
    Enter-InstallReplacement $Job
    Move-Item -LiteralPath $installRoot -Destination $backupRoot
    $movedOriginal = $true
    Write-InstallJournal $Job 'original-moved' @{ profileBackup = $profileBackup }
    Move-Item -LiteralPath $stageRoot -Destination $installRoot
    $movedCandidate = $true
    Write-InstallJournal $Job 'candidate-moved' @{ profileBackup = $profileBackup }

    $receiptRoot = Join-Path $expectedRoot 'startup-receipts'
    New-Item -ItemType Directory -Path $receiptRoot -Force | Out-Null
    $receiptPath = Join-Path $receiptRoot "$($Job.nonce).json"
    if (Test-Path -LiteralPath $receiptPath) { throw 'Startup receipt nonce already exists.' }
    $oldNonce = $env:CHORUS_UPDATE_LAUNCH_NONCE
    try {
      $env:CHORUS_UPDATE_LAUNCH_NONCE = $Job.nonce
      $started = Start-Process -FilePath (Get-AppExecutable $installRoot) -WorkingDirectory $installRoot -PassThru
    } finally {
      $env:CHORUS_UPDATE_LAUNCH_NONCE = $oldNonce
    }
    Write-InstallJournal $Job 'started' @{
      profileBackup = $profileBackup
      processId = $started.Id
    }

    $healthDeadline = (Get-Date).AddMinutes(5)
    $receipt = $null
    while ((Get-Date) -lt $healthDeadline) {
      if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        break
      }
      if ($started.HasExited) { throw "New Chorus exited before reporting startup health (exit $($started.ExitCode))." }
      Start-Sleep -Seconds 2
    }
    if (-not $receipt) { throw 'New Chorus did not report usable startup health within five minutes.' }
    if (
      $receipt.nonce -ne $Job.nonce -or
      $receipt.buildId -ne $Job.buildId -or
      $receipt.commit -ne $Job.commit -or
      $receipt.version -ne $manifest.version -or
      [int]$receipt.processId -ne $started.Id
    ) { throw 'Startup health receipt did not match the launched Chorus build.' }

    $health = @{
      nonce = $receipt.nonce
      commit = $receipt.commit
      buildId = $receipt.buildId
      artifactDigest = $Job.artifactDigest
      readyAt = $receipt.readyAt
      processId = [int]$receipt.processId
      backupRoot = $backupRoot
      profileBackup = $profileBackup
      previousBuild = $previousBuild
    }
    Write-InstallJournal $Job 'healthy' $health
    return @{ status = 'installed'; candidateId = $Job.candidateId; repositoryPath = $Job.repositoryPath; health = $health }
  } catch {
    $failure = $_.Exception.Message
    if ($movedCandidate) { Wait-ForChorusExit $installRoot 12 $Job }
    if ($movedCandidate -and (Test-Path -LiteralPath $installRoot)) {
      if (Test-Path -LiteralPath $failedRoot) { throw "Install failed ($failure), and rollback destination already exists: $failedRoot" }
      Move-Item -LiteralPath $installRoot -Destination $failedRoot
    }
    if ($movedOriginal -and (Test-Path -LiteralPath $backupRoot)) {
      Move-Item -LiteralPath $backupRoot -Destination $installRoot
      if (
        (Test-Path -LiteralPath (Join-Path $installRoot 'Maestro.exe') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $installRoot 'Chorus.exe') -PathType Leaf)
      ) {
        Start-Process -FilePath (Get-AppExecutable $installRoot) -WorkingDirectory $installRoot | Out-Null
      }
    }
    Write-InstallJournal $Job 'rolled-back' @{ error = $failure }
    throw $failure
  } finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Invoke-Rollback([object]$Job) {
  $stateRoot = Get-FullPath $Job.stateRoot
  $expectedRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Chorus\Delivery\v1')
  $installRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Programs\Chorus')
  $profileRoot = Get-FullPath (Join-Path $env:APPDATA 'chorus')
  if ($stateRoot -ne $expectedRoot -or (Get-FullPath $Job.installRoot) -ne $installRoot) {
    throw 'Rollback paths do not match the current Windows user Chorus installation.'
  }
  if ((Get-FullPath $Job.profileRoot) -ne $profileRoot -or $Job.restoreProfile -ne $true) {
    throw 'Rollback requires explicit permission to restore the matched pre-update profile.'
  }
  if ($Job.candidateId -notmatch '^[a-f0-9-]{36}$' -or $Job.nonce -notmatch '^[a-f0-9-]{36}$') {
    throw 'Invalid rollback identity.'
  }
  $backupRoot = Get-FullPath (Join-Path (Split-Path $installRoot -Parent) "Chorus.backup-$($Job.candidateId)")
  if ((Get-FullPath $Job.backupRoot) -ne $backupRoot) {
    throw 'Rollback backup path does not match the retained install tree.'
  }
  [void](Get-AppExecutable $backupRoot)
  [void](Get-AppExecutable $installRoot)
  if (-not $Job.previousBuild -or [int]$Job.previousBuild.deliveryProtocol -ne 1) {
    throw 'The previous install cannot report health; matched rollback is unavailable.'
  }
  $currentProvenancePath = Join-Path $installRoot 'resources\build-provenance.json'
  $previousProvenancePath = Join-Path $backupRoot 'resources\build-provenance.json'
  $currentProvenance = Get-Content -LiteralPath $currentProvenancePath -Raw | ConvertFrom-Json
  $previousProvenance = Get-Content -LiteralPath $previousProvenancePath -Raw | ConvertFrom-Json
  if (
    $currentProvenance.commit -ne $Job.commit -or
    $currentProvenance.buildId -ne $Job.buildId -or
    [int]$previousProvenance.deliveryProtocol -ne 1 -or
    $previousProvenance.commit -ne $Job.previousBuild.commit -or
    $previousProvenance.buildId -ne $Job.previousBuild.buildId -or
    $previousProvenance.version -ne $Job.previousBuild.version
  ) { throw 'Installed or retained build provenance changed; rollback is blocked.' }

  $profileBackup = $Job.profileBackup
  if ($profileBackup) {
    [void](Assert-UnderDirectory $profileBackup (Join-Path $stateRoot 'ProfileBackups') 'Profile backup path')
    if (-not (Test-Path -LiteralPath $profileBackup -PathType Container)) {
      throw 'The matched pre-update profile backup is missing.'
    }
  }
  $failedRoot = Join-Path (Split-Path $installRoot -Parent) "Chorus.rollback-failed-$($Job.candidateId)"
  if (Test-Path -LiteralPath $failedRoot) { throw "Rollback recovery directory already exists: $failedRoot" }
  $postProfileRoot = Join-Path (Join-Path $stateRoot 'ProfileBackups') "$($Job.candidateId)-post-rollback-$($Job.nonce)"
  $profileStage = Join-Path (Split-Path $profileRoot -Parent) "chorus.rollback-$($Job.nonce)"
  if (Test-Path -LiteralPath $postProfileRoot) { throw 'Rollback profile recovery directory already exists.' }
  if (Test-Path -LiteralPath $profileStage) { throw 'Rollback profile staging directory already exists.' }

  if ($profileBackup) { Copy-Package $profileBackup $profileStage }
  Write-InstallJournal $Job 'rollback-staged' @{
    failedRoot = $failedRoot
    postProfileRoot = $postProfileRoot
    profileStage = $profileStage
  }

  $mutex = [Threading.Mutex]::new($false, 'Local\ChorusDeliveryInstall')
  $ownsMutex = $false
  try {
    try { $ownsMutex = $mutex.WaitOne([TimeSpan]::FromHours(12)) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another Chorus installation owns the rollback target.' }
    Wait-ForChorusExit $installRoot 12 $Job
    Assert-NoLegacyInstaller
    Enter-InstallReplacement $Job
    Move-Item -LiteralPath $installRoot -Destination $failedRoot
    Write-InstallJournal $Job 'rollback-current-moved' @{
      failedRoot = $failedRoot
      postProfileRoot = $postProfileRoot
      profileStage = $profileStage
    }
    Move-Item -LiteralPath $backupRoot -Destination $installRoot
    Write-InstallJournal $Job 'rollback-previous-moved' @{
      failedRoot = $failedRoot
      postProfileRoot = $postProfileRoot
      profileStage = $profileStage
    }

    if (Test-Path -LiteralPath $profileRoot -PathType Container) {
      Move-Item -LiteralPath $profileRoot -Destination $postProfileRoot
    }
    if ($profileBackup) {
      Move-Item -LiteralPath $profileStage -Destination $profileRoot
    }
    Write-InstallJournal $Job 'rollback-profile-restored' @{
      failedRoot = $failedRoot
      postProfileRoot = $postProfileRoot
      profileStage = $profileStage
    }

    $receiptRoot = Join-Path $expectedRoot 'startup-receipts'
    New-Item -ItemType Directory -Path $receiptRoot -Force | Out-Null
    $receiptPath = Join-Path $receiptRoot "$($Job.nonce).json"
    $oldNonce = $env:CHORUS_UPDATE_LAUNCH_NONCE
    try {
      $env:CHORUS_UPDATE_LAUNCH_NONCE = $Job.nonce
      $started = Start-Process -FilePath (Get-AppExecutable $installRoot) -WorkingDirectory $installRoot -PassThru
    } finally {
      $env:CHORUS_UPDATE_LAUNCH_NONCE = $oldNonce
    }
    Write-InstallJournal $Job 'rollback-started' @{
      failedRoot = $failedRoot
      postProfileRoot = $postProfileRoot
      processId = $started.Id
    }

    $deadline = (Get-Date).AddMinutes(5)
    $receipt = $null
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        break
      }
      if ($started.HasExited) { throw "Restored Chorus exited before reporting startup health (exit $($started.ExitCode))." }
      Start-Sleep -Seconds 2
    }
    if (-not $receipt) { throw 'Restored Chorus did not report startup health within five minutes.' }
    if (
      $receipt.nonce -ne $Job.nonce -or
      $receipt.commit -ne $Job.previousBuild.commit -or
      $receipt.buildId -ne $Job.previousBuild.buildId -or
      $receipt.version -ne $Job.previousBuild.version -or
      [int]$receipt.processId -ne $started.Id
    ) { throw 'Rollback startup health did not match the retained Chorus build.' }

    $health = @{
      nonce = $receipt.nonce
      commit = $receipt.commit
      buildId = $receipt.buildId
      readyAt = $receipt.readyAt
      processId = [int]$receipt.processId
      retainedCurrentInstall = $failedRoot
      postUpdateProfile = if (Test-Path -LiteralPath $postProfileRoot) { $postProfileRoot } else { $null }
    }
    Write-InstallJournal $Job 'rolled-back' $health
    return @{ status = 'rolled-back'; candidateId = $Job.candidateId; repositoryPath = $Job.repositoryPath; health = $health }
  } catch {
    Write-InstallJournal $Job 'rollback-needs-recovery' @{ error = $_.Exception.Message }
    throw
  } finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

if ($Bootstrap) {
  $bootstrapStateRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Chorus\Delivery\v1')
  $bootstrapJobPath = Assert-UnderDirectory (Get-FullPath $JobPath) (Join-Path $bootstrapStateRoot 'InstallJobs') 'Install job'
  $bootstrapJob = Get-Content -LiteralPath $bootstrapJobPath -Raw | ConvertFrom-Json
  if ((Get-FullPath $bootstrapJob.stateRoot) -ne $bootstrapStateRoot) {
    throw 'Install job state directory does not match the current Windows user.'
  }
  [void](Assert-UnderDirectory $PSCommandPath (Join-Path $bootstrapStateRoot 'Worker') 'Worker path')
  Start-DetachedWorker $bootstrapJobPath $PSCommandPath
  exit 0
}

$job = $null
$resultPath = $null
$cancelledBeforeReplacement = $false
$expectedStateRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Chorus\Delivery\v1')
try {
  $jobFullPath = Assert-UnderDirectory (Get-FullPath $JobPath) (Join-Path $expectedStateRoot 'InstallJobs') 'Install job'
  $job = Get-Content -LiteralPath $jobFullPath -Raw | ConvertFrom-Json
  $job | Add-Member -NotePropertyName JobPath -NotePropertyValue $jobFullPath -Force
  $stateRoot = Get-FullPath $job.stateRoot
  if ($stateRoot -ne $expectedStateRoot) {
    throw 'Install job state directory does not match the current Windows user.'
  }
  [void](Assert-UnderDirectory $PSCommandPath (Join-Path $stateRoot 'Worker') 'Worker path')
  if ($job.workerDigest -notmatch '^[a-f0-9]{64}$' -or
      (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.workerDigest) {
    throw 'The detached install worker does not match its recorded content hash.'
  }
  $expectedProfileRoot = Get-FullPath (Join-Path $env:APPDATA 'chorus')
  if ((Get-FullPath $job.profileRoot) -ne $expectedProfileRoot) {
    throw 'Profile backup path is not the current user Chorus profile.'
  }
  $validCandidateId = [string]$job.candidateId -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  $validNonce = [string]$job.nonce -match '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  $validJobId = if ($job.mode -eq 'rollback') {
    [string]$job.jobId -match ('^rollback-' + [regex]::Escape([string]$job.candidateId) + '-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
  } elseif ($job.mode -eq 'install') {
    [string]$job.jobId -eq [string]$job.candidateId
  } else {
    $false
  }
  if (-not $validCandidateId -or -not $validNonce -or -not $validJobId) {
    throw 'Install job identity or mode is invalid.'
  }
  $resultPath = Join-Path (Join-Path $stateRoot 'InstallResults') "$($job.candidateId).json"
  $result = if ($job.mode -eq 'rollback') { Invoke-Rollback $job } else { Invoke-Install $job }
  Write-AtomicJson $resultPath $result
} catch {
  $errorText = $_.Exception.Message
  if ($job -and $job.candidateId -and $job.repositoryPath -and $job.stateRoot) {
    try {
      $stateRoot = Get-FullPath $job.stateRoot
      $resultPath = Join-Path (Join-Path $stateRoot 'InstallResults') "$($job.candidateId).json"
      $applyingMarker = if ($job.JobPath) { "$($job.JobPath).applying" } else { $null }
      if ($job.JobPath -and (Test-Path -LiteralPath (Get-CancelMarker $job)) -and -not (Test-Path -LiteralPath $applyingMarker)) {
        $cancelledBeforeReplacement = $true
        Write-AtomicJson $resultPath @{
          status = 'cancelled'
          candidateId = $job.candidateId
          repositoryPath = $job.repositoryPath
          recordedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
      } else {
        $failureStatus = if ($job.mode -eq 'rollback') {
          if ($applyingMarker -and (Test-Path -LiteralPath $applyingMarker)) {
            'rollback-needs-recovery'
          } else {
            'rollback-failed'
          }
        } elseif ($applyingMarker -and (Test-Path -LiteralPath $applyingMarker)) {
          $journalPath = Join-Path (Join-Path $stateRoot 'InstallJournals') "$($job.candidateId).json"
          $journalPhase = $null
          if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
            try {
              $journal = Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
              $journalPhase = $journal.phase
            } catch { }
          }
          if ($journalPhase -eq 'rolled-back') { 'failed' } else { 'install-needs-recovery' }
        } else {
          'failed'
        }
        Write-AtomicJson $resultPath @{
          status = $failureStatus
          candidateId = $job.candidateId
          repositoryPath = $job.repositoryPath
          error = $errorText
          recordedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
      }
    } catch { }
  }
  if ($cancelledBeforeReplacement) { exit 0 }
  exit 1
}
