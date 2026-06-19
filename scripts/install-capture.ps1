param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$toolsDir = Join-Path $RootDir "tools"
$captureDir = Join-Path $toolsDir "capture"
$captureExe = Join-Path $captureDir "qwin-capture.exe"
$versionFile = Join-Path $captureDir "version.txt"

# ─── Helper: test if existing binary is valid ───────────────────────────────

function Test-CaptureExecutable {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return $false
  }

  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = "--version"
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -eq 0) {
      $version = ($stdout -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1).Trim()
      if ($version) { Write-Output $version }
      return $true
    }
    return $false
  } catch {
    return $false
  }
}

# ─── Resolve GitHub release asset ───────────────────────────────────────────

function Resolve-CaptureRelease {
  $repo = "qwin-video-downloader/qwin-capture"

  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -ErrorAction Stop
    $asset = $release.assets | Where-Object { $_.name -match "windows-amd64.*\.zip$" } | Select-Object -First 1

    if (-not $asset) {
      throw "Could not find a Windows amd64 qwin-capture release asset."
    }

    return @{
      version    = $release.tag_name -replace '^v', ''
      downloadUrl = $asset.browser_download_url
      assetName  = $asset.name
    }
  } catch {
    Write-Warning "Could not fetch release info from GitHub: $($_.Exception.Message)"
    return $null
  }
}

# ─── Check existing binary ──────────────────────────────────────────────────

if (Test-Path $captureExe) {
  if (Test-CaptureExecutable -Path $captureExe) {
    Write-Output "qwin-capture is already installed and working."
    exit 0
  } else {
    Write-Warning "Existing qwin-capture.exe is not runnable. Reinstalling..."
  }
}

# ─── Download from GitHub ───────────────────────────────────────────────────

$release = Resolve-CaptureRelease
if (-not $release) {
  Write-Warning "qwin-capture could not be downloaded from GitHub."
  Write-Warning "CDM capture and screen recording features will be unavailable."
  Write-Warning "You can manually build the binary from the qwin-capture repository."
  exit 1
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qwin-capture-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  $zipPath = Join-Path $tempDir $release.assetName
  Write-Output "Downloading qwin-capture $($release.version)..."
  Invoke-WebRequest -Uri $release.downloadUrl -OutFile $zipPath

  Write-Output "Extracting..."
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

  $downloadedExe = Get-ChildItem -Path $tempDir -Recurse -Filter "qwin-capture.exe" | Select-Object -First 1
  if (-not $downloadedExe) {
    throw "qwin-capture.exe was not found in the downloaded release."
  }

  New-Item -ItemType Directory -Force -Path $captureDir | Out-Null
  Copy-Item -LiteralPath $downloadedExe.FullName -Destination $captureExe -Force

  if (-not (Test-CaptureExecutable -Path $captureExe)) {
    Remove-Item -LiteralPath $captureExe -Force -ErrorAction SilentlyContinue
    throw "Downloaded qwin-capture.exe is not valid for this platform."
  }

  # Write version file
  Set-Content -Path $versionFile -Value $release.version -NoNewline -Encoding UTF8

  Write-Output "qwin-capture $($release.version) installed to tools/capture/."
} catch {
  Write-Warning "Failed to install qwin-capture: $($_.Exception.Message)"
  Write-Warning "CDM capture and screen recording features will be unavailable."
  exit 1
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
