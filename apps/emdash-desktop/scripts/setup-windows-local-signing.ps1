<#
.SYNOPSIS
  One-time setup so local Windows builds (installers and the delivery-installed app) are
  Authenticode-signed and trusted on this machine.

.DESCRIPTION
  Idempotent. Reuses or creates a self-signed code-signing certificate in CurrentUser\My with a
  non-exportable key, trusts its public half in LocalMachine\Root and LocalMachine\TrustedPublisher
  (elevating once if needed), and records the thumbprint in
  %LOCALAPPDATA%\Chorus\Signing\windows-signing.json, which electron-builder.config.ts reads.

  The certificate is an end-entity cert limited to the Code Signing EKU, so trusting it cannot vouch
  for TLS or other certificates. It is trusted on this machine only; other machines still see an
  unknown publisher. Remove with -Uninstall.
#>
param(
  [switch]$Uninstall,
  # Internal: the elevated half that edits the machine stores.
  [string]$TrustCertificate,
  [string]$UntrustThumbprint
)

$ErrorActionPreference = 'Stop'
$FriendlyName = 'Chorus Local Code Signing'
$SigningDir = Join-Path $env:LOCALAPPDATA 'Chorus\Signing'
$ConfigPath = Join-Path $SigningDir 'windows-signing.json'
$CerPath = Join-Path $SigningDir 'chorus-local-code-signing.cer'
$MachineStores = @('Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher')

if ($TrustCertificate) {
  foreach ($store in $MachineStores) { Import-Certificate -FilePath $TrustCertificate -CertStoreLocation $store | Out-Null }
  exit 0
}
if ($UntrustThumbprint) {
  foreach ($store in $MachineStores) { Remove-Item -Path (Join-Path $store $UntrustThumbprint) -ErrorAction SilentlyContinue }
  exit 0
}

function Invoke-Elevated([string[]]$Arguments) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"") + $Arguments
  $process = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $argList
  if ($process.ExitCode -ne 0) { throw "Elevated certificate store update failed ($($process.ExitCode))." }
}

function Test-MachineTrust([string]$Thumbprint) {
  foreach ($store in $MachineStores) {
    if (-not (Test-Path (Join-Path $store $Thumbprint))) { return $false }
  }
  return $true
}

$existing = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.FriendlyName -eq $FriendlyName -and $_.HasPrivateKey })

if ($Uninstall) {
  foreach ($cert in $existing) {
    if (Test-MachineTrust $cert.Thumbprint) { Invoke-Elevated @('-UntrustThumbprint', $cert.Thumbprint) }
    Remove-Item -Path (Join-Path 'Cert:\CurrentUser\My' $cert.Thumbprint)
  }
  Remove-Item -Path $ConfigPath, $CerPath -ErrorAction SilentlyContinue
  Write-Output 'Removed local Windows signing identity.'
  exit 0
}

$cert = $existing | Where-Object { $_.NotAfter -gt (Get-Date).AddDays(30) } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert `
    -Subject 'CN=Chorus Local Code Signing, O=Chorus (local)' -FriendlyName $FriendlyName `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
    -KeyUsage DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=0') `
    -NotAfter (Get-Date).AddYears(5) -CertStoreLocation Cert:\CurrentUser\My
}

New-Item -ItemType Directory -Force $SigningDir | Out-Null
Export-Certificate -Cert $cert -FilePath $CerPath | Out-Null
if (-not (Test-MachineTrust $cert.Thumbprint)) { Invoke-Elevated @('-TrustCertificate', "`"$CerPath`"") }
if (-not (Test-MachineTrust $cert.Thumbprint)) { throw 'Certificate is still not trusted by this machine.' }

[IO.File]::WriteAllText($ConfigPath, (@{ certificateSha1 = $cert.Thumbprint } | ConvertTo-Json))
Write-Output "Windows builds will be signed with $($cert.Subject) ($($cert.Thumbprint)), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))."
