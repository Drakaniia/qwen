param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$RunInit = $false
)

$ErrorActionPreference = "Stop"

$toolsDir = Join-Path $RootDir "tools"
$cdmDir = Join-Path $toolsDir "cdm"
$cdmDll = Join-Path $cdmDir "widevinecdm.dll"
$cdmManifest = Join-Path $cdmDir "manifest.json"
$versionFile = Join-Path $cdmDir "version.txt"
$statusFile = Join-Path $cdmDir "status.json"

# Known-compatible CDM versions for key extraction.
# These versions have been validated to work with the CDP-based proxy approach.
$COMPATIBLE_VERSIONS = @(
  "4.10.2710.0",
  "4.10.2830.0",
  "4.10.2557.0"
)

# The pinned fallback version to download if Chrome's CDM is incompatible.
$FALLBACK_VERSION = "4.10.2710.0"

# ─── Write status file for Python/Go host to read ───────────────────────────

function Write-CdmStatus {
  param(
    [bool]$Available,
    [string]$Version = "",
    [string]$Source = "",
    [bool]$L1Only = $false,
    [string]$Error = ""
  )

  $status = @{
    cdmAvailable = $Available
    cdmVersion   = $Version
    cdmSource    = $Source
    cdmPath      = $cdmDir
    l1Only       = $L1Only
    error        = $Error
    installedAt  = (Get-Date -Format "o")
  }

  $utf8 = New-Object System.Text.UTF8Encoding $false
  $json = $status | ConvertTo-Json -Depth 3
  [System.IO.File]::WriteAllText($statusFile, $json, $utf8)
}

# ─── Detect Chrome's bundled Widevine CDM ───────────────────────────────────

function Find-ChromeWidevineCdm {
  $chromeCandidates = @(
    # Chrome stable
    "$env:LOCALAPPDATA\Google\Chrome\User Data\WidevineCdm",
    # Chrome Beta
    "$env:LOCALAPPDATA\Google\Chrome Beta\User Data\WidevineCdm",
    # Chrome Canary
    "$env:LOCALAPPDATA\Google\Chrome SxS\User Data\WidevineCdm",
    # Chromium
    "$env:LOCALAPPDATA\Chromium\User Data\WidevineCdm",
    # Microsoft Edge
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data\WidevineCdm",
    # Brave
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data\WidevineCdm",
    # Yandex Browser
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\User Data\WidevineCdm"
  )

  foreach ($basePath in $chromeCandidates) {
    if (-not (Test-Path $basePath)) {
      continue
    }

    # Each CDM version is stored in a subdirectory named after the version.
    $versionDirs = Get-ChildItem -Path $basePath -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending

    foreach ($versionDir in $versionDirs) {
      $dllPath = Join-Path $versionDir.FullName "widevinecdm.dll"
      $manifestPath = Join-Path $versionDir.FullName "manifest.json"

      if (-not (Test-Path $dllPath)) {
        continue
      }

      $sourceName = if ($versionDir.FullName -match "Google\\Chrome") { "chrome" } else { "chromium" }
      return @{
        version    = $versionDir.Name
        dllPath    = $dllPath
        manifestPath = $manifestPath
        source     = $sourceName
      }
    }
  }

  return $null
}

# ─── Validate CDM version against compatible list ───────────────────────────

function Test-CompatibleVersion {
  param([string]$Version)
  return $COMPATIBLE_VERSIONS -contains $Version
}

# ─── Download a pinned Widevine CDM ─────────────────────────────────────────

function Install-FallbackCdm {
  param([string]$Version)

  # Note: This URL is illustrative. In practice, the CDM binary comes from
  # Chrome's installer package or an archive of known CDM releases.
  # The actual source URL will be determined during implementation.
  $fallbackUrl = "https://github.com/qwin-video-downloader/cdm-binaries/releases/download/v$Version/widevinecdm-windows-amd64.zip"

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qwin-cdm-" + [guid]::NewGuid().ToString("N"))

  try {
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    $zipPath = Join-Path $tempDir "widevinecdm.zip"
    Write-Output "Downloading Widevine CDM $Version (standalone fallback)..."
    
    try {
      Invoke-WebRequest -Uri $fallbackUrl -OutFile $zipPath -ErrorAction Stop
    } catch {
      Write-Warning "Could not download standalone CDM: $($_.Exception.Message)"
      return $false
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

    $downloadedDll = Get-ChildItem -Path $tempDir -Recurse -Filter "widevinecdm.dll" | Select-Object -First 1
    if (-not $downloadedDll) {
      Write-Warning "widevinecdm.dll was not found in the downloaded CDM package."
      return $false
    }

    New-Item -ItemType Directory -Force -Path $cdmDir | Out-Null
    Copy-Item -LiteralPath $downloadedDll.FullName -Destination $cdmDll -Force

    # Copy manifest.json if it exists in the download
    $downloadedManifest = Get-ChildItem -Path $tempDir -Recurse -Filter "manifest.json" | Select-Object -First 1
    if ($downloadedManifest) {
      Copy-Item -LiteralPath $downloadedManifest.FullName -Destination $cdmManifest -Force
    }

    Set-Content -Path $versionFile -Value $Version -NoNewline -Encoding UTF8
    return $true
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ─── Post-install CDM init (optional) ────────────────────────────────────────

function Invoke-CdmInit {
  param([string]$TargetDir)

  Write-Output "Attempting to initialize CDM with native host (if running)..."
  $nativeHostDir = Join-Path $PSScriptRoot ".." "src" "native-host"
  $pythonCode = @"
import sys, json
sys.path.insert(0, r"$($nativeHostDir -replace '\\', '/')")
try:
    from capture_manager import cdm_init, get_capture_manager
    mgr = get_capture_manager()
    if mgr.is_running:
        r = cdm_init(r"$($TargetDir -replace '\\', '/')")
        print(json.dumps(r))
    else:
        print('{"status":"skipped","message":"Native host not running. CDM will init on next startup."}')
except Exception as e:
    print(json.dumps({"status":"error","error":str(e)}))
"@
  $result = python -c $pythonCode 2>&1
  Write-Output "CDM init result: $result"
}

# ─── Main ────────────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

Write-Output "Detecting Widevine CDM..."

$chromeCdm = Find-ChromeWidevineCdm

if ($chromeCdm) {
  Write-Output "Found Chrome's Widevine CDM: version $($chromeCdm.version)"

  if (Test-CompatibleVersion -Version $chromeCdm.version) {
    Write-Output "CDM version $($chromeCdm.version) is compatible."

    New-Item -ItemType Directory -Force -Path $cdmDir | Out-Null
    Copy-Item -LiteralPath $chromeCdm.dll -Destination $cdmDll -Force
    if (Test-Path $chromeCdm.manifestPath) {
      Copy-Item -LiteralPath $chromeCdm.manifestPath -Destination $cdmManifest -Force
    }
    Set-Content -Path $versionFile -Value $chromeCdm.version -NoNewline -Encoding UTF8

    Write-CdmStatus -Available $true -Version $chromeCdm.version -Source $chromeCdm.source
    Write-Output "Widevine CDM installed to tools/cdm/ (source: Chrome)."

    if ($RunInit) {
      Invoke-CdmInit -TargetDir $cdmDir
    }
    exit 0
  } else {
    Write-Output "Chrome's CDM version $($chromeCdm.version) is not in the compatible list."
    Write-Output "Compatible versions: $($COMPATIBLE_VERSIONS -join ', ')"
    Write-Output "Downloading a known-compatible standalone CDM v$FALLBACK_VERSION..."

    if (Install-FallbackCdm -Version $FALLBACK_VERSION) {
      Write-CdmStatus -Available $true -Version $FALLBACK_VERSION -Source "fallback-download"
      Write-Output "Widevine CDM $FALLBACK_VERSION installed to tools/cdm/ (source: fallback download)."

      if ($RunInit) {
        Invoke-CdmInit -TargetDir $cdmDir
      }
      exit 0
    }
    } else {
      Write-Warning "Could not install a compatible CDM."
      Write-CdmStatus -Available $false -Error "Chrome CDM version $($chromeCdm.version) incompatible, and fallback download failed."
      exit 1
    }
  }
} else {
  Write-Output "No Chrome-based browser with Widevine CDM was found."
  Write-Output "Downloading a known-compatible standalone CDM v$FALLBACK_VERSION..."

  if (Install-FallbackCdm -Version $FALLBACK_VERSION) {
    Write-CdmStatus -Available $true -Version $FALLBACK_VERSION -Source "fallback-download"
    Write-Output "Widevine CDM $FALLBACK_VERSION installed to tools/cdm/ (source: fallback download)."

    if ($RunInit) {
      Invoke-CdmInit -TargetDir $cdmDir
    }
    exit 0
  } else {
    Write-Warning "Could not find or download a Widevine CDM."
    Write-Warning "CDM-proxy key extraction will be unavailable. Screen recording fallback only."
    Write-CdmStatus -Available $false -Error "No Chrome-bundled CDM found and fallback download failed."
    exit 1
  }
}
