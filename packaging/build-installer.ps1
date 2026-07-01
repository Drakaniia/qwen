<#
.SYNOPSIS
  Build the Qwin Video Downloader self-contained Windows installer.

.DESCRIPTION
  This script runs the full build pipeline:
    1. Bundle JS (esbuild)
    2. Build extension targets (chromium, firefox, yandex)
    3. Build Go companion binary (qwin-capture.exe)
    4. Build PyInstaller native host (qwin-host.exe)
    5. Download external tools (aria2c, N_m3u8DL-RE, lux)
    6. Package .crx extension (requires .pem key)
    7. Stage all artifacts in installer-source/
    8. Compile Inno Setup installer

.PARAMETER SkipPyInstaller
  Skip the PyInstaller build (use if already built).

.PARAMETER SkipGo
  Skip the Go binary build (use if already built).

.PARAMETER SkipTools
  Skip downloading external tool binaries (use if already downloaded).

.PARAMETER SkipCrx
  Skip .crx packaging (produce unsigned .crx or skip entirely).

.PARAMETER PemKey
  Path to the .pem private key for .crx signing.

.PARAMETER InnoSetupPath
  Path to ISCC.exe (Inno Setup compiler). Defaults to common install locations.

.PARAMETER PythonCmd
  Python command to use for PyInstaller. Defaults to "python".

.PARAMETER OutputDir
  Output directory for the final installer. Defaults to "dist".

.EXAMPLE
  .\packaging\build-installer.ps1

.EXAMPLE
  .\packaging\build-installer.ps1 -SkipPyInstaller -SkipGo -PemKey "key.pem"
#>

param(
  [switch]$SkipPyInstaller,
  [switch]$SkipGo,
  [switch]$SkipTools,
  [switch]$SkipCrx,
  [string]$PemKey = "",
  [string]$InnoSetupPath = "",
  [string]$PythonCmd = "python",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

# ── Resolve paths ──────────────────────────────────────────────────────────
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
$distDir = if ($OutputDir) { (Resolve-Path $OutputDir).Path } else { Join-Path $rootDir "dist" }
$stagingDir = Join-Path $scriptDir "installer-source"

# ── Version ────────────────────────────────────────────────────────────────
$manifestPath = Join-Path $rootDir "manifest.json"
$manifestJson = Get-Content $manifestPath -Raw | ConvertFrom-Json
$appVersion = $manifestJson.version
Write-Host "═══ Qwin Video Downloader v$appVersion — Build Installer ═══" -ForegroundColor Cyan

# ── Check prerequisites ────────────────────────────────────────────────────
$missing = @()
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) { $missing += "Node.js (node)" }
if (-not (Get-Command "go" -ErrorAction SilentlyContinue)) { $missing += "Go (go)" }
if (-not (Get-Command $PythonCmd -ErrorAction SilentlyContinue)) { $missing += "Python ($PythonCmd)" }

# Check for Inno Setup
if (-not $InnoSetupPath) {
  $isccCandidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 5\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 5\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "${env:LOCALAPPDATA}\Inno Setup 6\ISCC.exe"
  )
  foreach ($candidate in $isccCandidates) {
    if (Test-Path $candidate) {
      $InnoSetupPath = $candidate
      break
    }
  }
}
if (-not $InnoSetupPath -or -not (Test-Path $InnoSetupPath)) {
  if (Get-Command "ISCC.exe" -ErrorAction SilentlyContinue) {
    $InnoSetupPath = (Get-Command "ISCC.exe").Source
  } else {
    $missing += "Inno Setup 6 (ISCC.exe)"
  }
}

if ($missing.Count -gt 0) {
  Write-Host "ERROR: Missing prerequisites:" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "  - $m" -ForegroundColor Red }
  exit 1
}

# Clean and prepare staging directories
$stagingDirs = @(
  "extension",
  "native-host",
  "tools\aria2",
  "tools\n_m3u8dl-re",
  "tools\capture",
  "tools\cdm",
  "tools\lux",
  "native-manifests"
)

foreach ($d in $stagingDirs) {
  $path = Join-Path $stagingDir $d
  if (-not (Test-Path $path)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
}

# ============================================================================
# Step 1: Build JS bundles (esbuild)
# ============================================================================
Write-Host "`n[1/8] Building JS bundles (esbuild)..." -ForegroundColor Yellow
Push-Location $rootDir
try {
  node scripts/build-bundles.js --target all
  if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
  Write-Host "  ✓ JS bundles built" -ForegroundColor Green
} finally {
  Pop-Location
}

# ============================================================================
# Step 2: Build extension targets
# ============================================================================
Write-Host "`n[2/8] Building extension targets..." -ForegroundColor Yellow
& (Join-Path $rootDir "scripts\build-extension.ps1") -Target all -RootDir $rootDir
if ($LASTEXITCODE -ne 0) { throw "Extension build failed" }
Write-Host "  ✓ Extension targets built" -ForegroundColor Green

# ============================================================================
# Step 3: Package .crx (if .pem key provided)
# ============================================================================
Write-Host "`n[3/8] Packaging .crx extension..." -ForegroundColor Yellow
$crxPath = Join-Path $stagingDir "extension\qwin-video-downloader.crx"
$chromiumDist = Join-Path $distDir "chromium"

if (-not $SkipCrx -and $PemKey -and (Test-Path $PemKey)) {
  # Try to use Chrome to pack the extension
  $chromeCandidates = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
  )
  $chromeExe = $null
  foreach ($c in $chromeCandidates) {
    if (Test-Path $c) { $chromeExe = $c; break }
  }
  if (Get-Command "chrome.exe" -ErrorAction SilentlyContinue) {
    $chromeExe = (Get-Command "chrome.exe").Source
  }

  if ($chromeExe) {
    Write-Host "  Packing .crx with Chrome..." -ForegroundColor Gray
    & $chromeExe --pack-extension="$chromiumDist" --pack-extension-key="$PemKey"
    $packedCrx = Join-Path (Split-Path $chromiumDist -Parent) "chromium.crx"
    if (Test-Path $packedCrx) {
      Move-Item -Path $packedCrx -Destination $crxPath -Force
      Write-Host "  ✓ .crx signed and packaged" -ForegroundColor Green
    } else {
      Write-Host "  ⚠ Chrome packing did not produce .crx file" -ForegroundColor Yellow
      $SkipCrx = $true
    }
  } else {
    Write-Host "  ⚠ Chrome not found, cannot pack .crx" -ForegroundColor Yellow
    $SkipCrx = $true
  }
} else {
  Write-Host "  ⚠ Skipping .crx packaging (no .pem key or --SkipCrx)" -ForegroundColor Yellow
  $SkipCrx = $true

  # Copy the unpacked extension folder instead
  $extDest = Join-Path $stagingDir "extension\chromium"
  if (Test-Path $extDest) { Remove-Item -Path $extDest -Recurse -Force }
  Copy-Item -Path $chromiumDist -Destination $extDest -Recurse -Force
  Write-Host "  ✓ Unpacked extension staged (for manual 'Load Unpacked')" -ForegroundColor Green
}

# Also stage Firefox extension
$firefoxDist = Join-Path $distDir "firefox"
$firefoxDest = Join-Path $stagingDir "extension\firefox"
if (Test-Path $firefoxDest) { Remove-Item -Path $firefoxDest -Recurse -Force }
if (Test-Path $firefoxDist) {
  Copy-Item -Path $firefoxDist -Destination $firefoxDest -Recurse -Force
}

# ============================================================================
# Step 4: Build Go companion binary (qwin-capture.exe)
# ============================================================================
Write-Host "`n[4/8] Building Go companion binary..." -ForegroundColor Yellow
if (-not $SkipGo) {
  $goSourceDir = Join-Path $rootDir "go"
  $goOutputPath = Join-Path $stagingDir "tools\capture\qwin-capture.exe"

  Push-Location $goSourceDir
  try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -ldflags="-s -w" -o $goOutputPath .
    if ($LASTEXITCODE -eq 0 -and (Test-Path $goOutputPath)) {
      Write-Host "  ✓ qwin-capture.exe built ($((Get-Item $goOutputPath).Length / 1MB) MB)" -ForegroundColor Green
    } else {
      throw "Go build failed"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "  ⚠ Skipping Go build (--SkipGo)" -ForegroundColor Yellow
}

# ============================================================================
# Step 5: Build PyInstaller native host (qwin-host.exe)
# ============================================================================
Write-Host "`n[5/8] Building PyInstaller native host..." -ForegroundColor Yellow
if (-not $SkipPyInstaller) {
  $pyiOutputPath = Join-Path $stagingDir "native-host\qwin-host.exe"
  $specPath = Join-Path $scriptDir "pyinstaller.spec"

  Push-Location $rootDir
  try {
    & $PythonCmd -m PyInstaller $specPath --distpath (Join-Path $stagingDir "native-host") --workpath (Join-Path $rootDir "build\pyinstaller")
    if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $stagingDir "native-host\qwin-host.exe"))) {
      Write-Host "  ✓ qwin-host.exe built ($((Get-Item (Join-Path $stagingDir 'native-host\qwin-host.exe')).Length / 1MB) MB)" -ForegroundColor Green
    } else {
      throw "PyInstaller build failed"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "  ⚠ Skipping PyInstaller (--SkipPyInstaller)" -ForegroundColor Yellow
}

# ============================================================================
# Step 6: Download external tool binaries
# ============================================================================
Write-Host "`n[6/8] Downloading external tools..." -ForegroundColor Yellow
if (-not $SkipTools) {
  # ── aria2c ───────────────────────────────────────────────────────────────
  $aria2Dir = Join-Path $stagingDir "tools\aria2"
  $aria2Exe = Join-Path $aria2Dir "aria2c.exe"
  if (-not (Test-Path $aria2Exe)) {
    Write-Host "  Downloading aria2c..." -ForegroundColor Gray
    $aria2Url = "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip"
    $aria2Zip = Join-Path $env:TEMP "aria2.zip"
    try {
      Invoke-WebRequest -Uri $aria2Url -OutFile $aria2Zip -UseBasicParsing
      Expand-Archive -Path $aria2Zip -DestinationPath (Join-Path $env:TEMP "aria2") -Force
      $foundAria2 = Get-ChildItem -Path (Join-Path $env:TEMP "aria2") -Recurse -Filter "aria2c.exe" | Select-Object -First 1
      if ($foundAria2) {
        Copy-Item -Path $foundAria2.FullName -Destination $aria2Exe -Force
        Write-Host "  ✓ aria2c.exe downloaded" -ForegroundColor Green
      }
      Remove-Item -Path $aria2Zip -Force
    } catch {
      Write-Host "  ⚠ Failed to download aria2c: $_" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  ✓ aria2c.exe already present" -ForegroundColor Green
  }

  # ── N_m3u8DL-RE ──────────────────────────────────────────────────────────
  $nm3u8Dir = Join-Path $stagingDir "tools\n_m3u8dl-re"
  $nm3u8Exe = Join-Path $nm3u8Dir "N_m3u8DL-RE.exe"
  if (-not (Test-Path $nm3u8Exe)) {
    Write-Host "  Downloading N_m3u8DL-RE..." -ForegroundColor Gray
    try {
      $ghApi = "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest"
      $releaseJson = Invoke-RestMethod -Uri $ghApi -UseBasicParsing
      $asset = $releaseJson.assets | Where-Object { $_.name -match "win-x64" -and $_.name -match "\.zip$" } | Select-Object -First 1
      if ($asset) {
        $nm3u8Zip = Join-Path $env:TEMP "n_m3u8dl-re.zip"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $nm3u8Zip -UseBasicParsing
        Expand-Archive -Path $nm3u8Zip -DestinationPath (Join-Path $env:TEMP "n_m3u8dl-re") -Force
        $found = Get-ChildItem -Path (Join-Path $env:TEMP "n_m3u8dl-re") -Recurse -Filter "N_m3u8DL-RE.exe" | Select-Object -First 1
        if ($found) {
          Copy-Item -Path $found.FullName -Destination $nm3u8Exe -Force
          Write-Host "  ✓ N_m3u8DL-RE.exe downloaded" -ForegroundColor Green
        }
        Remove-Item -Path $nm3u8Zip -Force
      }
    } catch {
      Write-Host "  ⚠ Failed to download N_m3u8DL-RE: $_" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  ✓ N_m3u8DL-RE.exe already present" -ForegroundColor Green
  }

  # ── lux ──────────────────────────────────────────────────────────────────
  $luxDir = Join-Path $stagingDir "tools\lux"
  $luxExe = Join-Path $luxDir "lux.exe"
  if (-not (Test-Path $luxExe)) {
    Write-Host "  Building lux via go install..." -ForegroundColor Gray
    try {
      $env:GOOS = "windows"
      $env:GOARCH = "amd64"
      $gopath = (go env GOPATH).Trim()
      $luxBuilt = Join-Path $gopath "bin\lux.exe"

      # Clean up old build
      if (Test-Path $luxBuilt) { Remove-Item -Path $luxBuilt -Force }

      go install github.com/iawia002/lux@latest
      if (Test-Path $luxBuilt) {
        Copy-Item -Path $luxBuilt -Destination $luxExe -Force
        Write-Host "  ✓ lux.exe built via go install" -ForegroundColor Green
      } else {
        Write-Host "  ⚠ lux binary not found after go install" -ForegroundColor Yellow
      }
    } catch {
      Write-Host "  ⚠ Failed to build lux: $_" -ForegroundColor Yellow
    }
  } else {
    Write-Host "  ✓ lux.exe already present" -ForegroundColor Green
  }
} else {
  Write-Host "  ⚠ Skipping tool downloads (--SkipTools)" -ForegroundColor Yellow
}

# ============================================================================
# Step 7: Stage native messaging manifests
# ============================================================================
Write-Host "`n[7/8] Staging native messaging manifests..." -ForegroundColor Yellow
$nativeManifestsDir = Join-Path $stagingDir "native-manifests"

$hostName = "com.qwin.video_downloader"
$chromeId = "dbjddokdmkodnkiaccmbjagfalmmmkmi"
$firefoxId = "qwin-video-downloader@example.com"
$launcherPath = "{app}\native-host\qwin_video_host.bat"

$chromeManifest = @{
  name            = $hostName
  description     = "Qwin Video Downloader native host"
  path            = $launcherPath
  type            = "stdio"
  allowed_origins = @("chrome-extension://$chromeId/")
} | ConvertTo-Json -Depth 5

$firefoxManifest = @{
  name               = $hostName
  description        = "Qwin Video Downloader native host"
  path               = $launcherPath
  type               = "stdio"
  allowed_extensions = @($firefoxId)
} | ConvertTo-Json -Depth 5

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $nativeManifestsDir "$hostName.chrome.json"), $chromeManifest, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $nativeManifestsDir "$hostName.yandex.json"), $chromeManifest, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $nativeManifestsDir "$hostName.firefox.json"), $firefoxManifest, $utf8NoBom)

Write-Host "  ✓ Native messaging manifests written" -ForegroundColor Green

# ============================================================================
# Step 8: Compile Inno Setup installer
# ============================================================================
Write-Host "`n═══ Compiling Inno Setup installer... ═══" -ForegroundColor Cyan
$issPath = Join-Path $scriptDir "qwin-installer.iss"
$finalInstaller = Join-Path $distDir "Qwin-Video-Downloader-v$appVersion-Setup.exe"

# Remove old installer if it exists
if (Test-Path $finalInstaller) { Remove-Item -Path $finalInstaller -Force }

Push-Location $scriptDir
try {
  & $InnoSetupPath "/dMyAppVersion=$appVersion" $issPath
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# ============================================================================
# Final output
# ============================================================================
if (Test-Path $finalInstaller) {
  $sizeMB = [math]::Round((Get-Item $finalInstaller).Length / 1MB, 1)
  Write-Host "`n═══ SUCCESS ═══" -ForegroundColor Green
  Write-Host "  Installer: $finalInstaller" -ForegroundColor Green
  Write-Host "  Size: $sizeMB MB" -ForegroundColor Green
  Write-Host "  Version: $appVersion" -ForegroundColor Green
} else {
  Write-Host "`nERROR: Installer was not created at expected path: $finalInstaller" -ForegroundColor Red
  exit 1
}
