param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$SkipPip = $false
)

$ErrorActionPreference = "Stop"

function Resolve-PythonCommand {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    return @($py.Source, "-3")
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return @($python.Source)
  }

  throw "Python 3 is not installed or is not on PATH."
}

# ─── you-get (Python package) ────────────────────────────────────────────────

function Install-YouGet {
  Write-Output "Installing you-get (video downloader for Asian platforms)..."

  if (-not $SkipPip) {
    $pythonCommand = Resolve-PythonCommand
    $pythonArgs = @()
    if ($pythonCommand.Length -gt 1) {
      $pythonArgs = $pythonCommand[1..($pythonCommand.Length - 1)]
    }

    # Run pip and capture both output and exit code
    $pipOutput = & $pythonCommand[0] @pythonArgs -m pip install --upgrade you-get 2>&1
    $pipExitCode = $LASTEXITCODE

    if ($pipExitCode -eq 0) {
      Write-Output "you-get installed successfully."
      return $true
    } else {
      Write-Warning "Failed to install you-get via pip (exit code: $pipExitCode)."
      return $false
    }
  }
  return $false
}

# ─── lux (Go binary) ─────────────────────────────────────────────────────────

function Test-LuxExecutable {
  param([string]$Path)

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

function Resolve-WindowsAssetArchitecture {
  $architectures = @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) |
    Where-Object { $_ } |
    ForEach-Object { $_.ToUpperInvariant() }

  if ($architectures -contains "ARM64") {
    return "arm64"
  }
  if ($architectures -contains "X86") {
    return "386"
  }
  return "amd64"
}

function Install-Lux {
  Write-Output "Checking lux (Go-based video downloader)..."

  $toolsDir = Join-Path $RootDir "tools"
  $luxDir = Join-Path $toolsDir "lux"
  $luxExe = Join-Path $luxDir "lux.exe"

  # Check if already installed
  if (Test-Path $luxExe) {
    if (Test-LuxExecutable -Path $luxExe) {
      Write-Output "lux is already installed."
      return $true
    }
    Remove-Item -LiteralPath $luxDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Check PATH
  $pathLux = Get-Command lux -ErrorAction SilentlyContinue
  if ($pathLux) {
    try {
      if (Test-LuxExecutable -Path $pathLux.Source) {
        Write-Output "lux is already available on PATH."
        return $true
      }
    } catch { }
  }

  Write-Output "Downloading lux from GitHub..."

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qwin-lux-" + [guid]::NewGuid().ToString("N"))

  try {
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    $arch = Resolve-WindowsAssetArchitecture
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/iawia002/lux/releases/latest" -ErrorAction Stop

    # Try multiple asset name patterns for Windows
    $assetPatterns = @(
      "windows.*$arch.*\.zip$",
      "Windows.*$arch.*\.zip$",
      "windows.*\.zip$",
      "Windows.*\.zip$"
    )

    $asset = $null
    foreach ($pattern in $assetPatterns) {
      $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
      if ($asset) { break }
    }

    if (-not $asset) {
      throw "Could not find a Windows lux release asset for architecture: $arch"
    }

    Write-Output "  Downloading $($asset.name)..."
    $zipPath = Join-Path $tempDir $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -ErrorAction Stop

    Write-Output "  Extracting lux..."
    Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

    # Look for any .exe (could be lux.exe or lux_windows_amd64.exe, etc.)
    $downloadedExe = Get-ChildItem -Path $tempDir -Recurse -Filter "*.exe" | Select-Object -First 1
    if (-not $downloadedExe) {
      # Try any file named lux* without extension too
      $downloadedExe = Get-ChildItem -Path $tempDir -Recurse -Filter "lux*" | Where-Object { -not $_.PSIsContainer } | Select-Object -First 1
    }
    if (-not $downloadedExe) {
      throw "No executable was found in the downloaded lux release."
    }

    New-Item -ItemType Directory -Force -Path $luxDir | Out-Null
    Copy-Item -LiteralPath $downloadedExe.FullName -Destination $luxExe -Force

    if (-not (Test-LuxExecutable -Path $luxExe)) {
      Remove-Item -LiteralPath $luxExe -Force -ErrorAction SilentlyContinue
      throw "Downloaded lux binary is not valid for this platform."
    }

    Write-Output "lux $($release.tag_name) installed to tools/lux/."
    return $true
  } catch {
    Write-Warning "Failed to install lux: $($_.Exception.Message)"
    Write-Warning "lux will be unavailable as a fallback downloader."
    return $false
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ─── Main ────────────────────────────────────────────────────────────────────

Write-Output "=== Installing you-get & lux fallback downloaders ==="

$youGetOk = Install-YouGet
$luxOk = Install-Lux

Write-Output ""
if ($youGetOk) {
  Write-Output "you-get installed"
} else {
  Write-Output "you-get NOT installed"
}
if ($luxOk) {
  Write-Output "lux installed"
} else {
  Write-Output "lux NOT installed"
}

if ($youGetOk -or $luxOk) {
  Write-Output "you-get/lux installation complete."
} else {
  Write-Output "you-get/lux installation failed. Check the errors above."
}
