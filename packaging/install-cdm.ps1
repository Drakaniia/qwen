<#
.SYNOPSIS
  Detect and copy the Widevine CDM from an installed browser.

.DESCRIPTION
  Searches Chrome, Edge, Brave, and Yandex Browser user data directories
  for a Widevine CDM installation. If found, copies the CDM DLL and
  manifest to the specified target directory and writes a status.json.

.PARAMETER TargetDir
  Directory to copy the CDM files into (e.g., C:\Program Files\Qwin\tools\cdm).

.EXAMPLE
  .\install-cdm.ps1 -TargetDir "C:\Program Files\Qwin\tools\cdm"
#>

param(
  [Parameter(Mandatory = $true)]
  [string]$TargetDir
)

$ErrorActionPreference = "Stop"

# Ensure target directory exists
if (-not (Test-Path $TargetDir)) {
  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$found = $false
$status = $null

# Browser search paths (in priority order)
$candidates = @(
  @{ Path = Join-Path $localAppData "Google\Chrome\User Data\WidevineCdm"; Source = "chrome" }
  @{ Path = Join-Path $localAppData "Google\Chrome Beta\User Data\WidevineCdm"; Source = "chrome-beta" }
  @{ Path = Join-Path $localAppData "Google\Chrome SxS\User Data\WidevineCdm"; Source = "chrome-canary" }
  @{ Path = Join-Path $localAppData "Microsoft\Edge\User Data\WidevineCdm"; Source = "edge" }
  @{ Path = Join-Path $localAppData "BraveSoftware\Brave-Browser\User Data\WidevineCdm"; Source = "brave" }
  @{ Path = Join-Path $localAppData "Yandex\YandexBrowser\User Data\WidevineCdm"; Source = "yandex" }
  @{ Path = Join-Path $localAppData "Chromium\User Data\WidevineCdm"; Source = "chromium" }
)

foreach ($candidate in $candidates) {
  $base = $candidate.Path
  if (-not (Test-Path $base)) { continue }

  # Find the version directory (named like "4.10.2710.0")
  $verDir = Get-ChildItem $base -Directory | Where-Object { $_.Name -match '^\d+\.' } | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $verDir) { continue }

  $dllPath = Join-Path $verDir.FullName "widevinecdm.dll"
  if (-not (Test-Path $dllPath)) { continue }

  # Found it — copy files
  Write-Host "Found Widevine CDM in $($candidate.Source): version $($verDir.Name)"

  Copy-Item -Path $dllPath -Destination (Join-Path $TargetDir "widevinecdm.dll") -Force

  $manifestPath = Join-Path $verDir.FullName "manifest.json"
  if (Test-Path $manifestPath) {
    Copy-Item -Path $manifestPath -Destination (Join-Path $TargetDir "manifest.json") -Force
  }

  Set-Content -Path (Join-Path $TargetDir "version.txt") -Value $verDir.Name -Encoding UTF8

  $status = @{
    cdmAvailable = $true
    cdmVersion   = $verDir.Name
    cdmSource    = $candidate.Source
    cdmPath      = $TargetDir
    l1Only       = $false
    error        = ""
    installedAt  = (Get-Date -Format "o")
  }
  $found = $true
  break
}

if (-not $found) {
  Write-Host "Widevine CDM not found in any installed browser." -ForegroundColor Yellow
  Write-Host "DRM content decryption will be unavailable." -ForegroundColor Yellow
  Write-Host "Tip: Play DRM content (e.g., Netflix, Disney+) in Chrome first, then re-run this script." -ForegroundColor Yellow

  $status = @{
    cdmAvailable = $false
    cdmVersion   = ""
    cdmSource    = ""
    cdmPath      = $TargetDir
    l1Only       = $false
    error        = "No browser-bundled Widevine CDM found. Play DRM content in Chrome first."
    installedAt  = (Get-Date -Format "o")
  }
}

# Write status.json
$status | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $TargetDir "status.json") -Encoding UTF8

if ($found) {
  Write-Host "Widevine CDM installed to $TargetDir" -ForegroundColor Green
}
