param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
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

function Resolve-WindowsAssetArchitecture {
  $architectures = @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) |
    Where-Object { $_ } |
    ForEach-Object { $_.ToUpperInvariant() }

  if ($architectures -contains "ARM64") {
    return "win-arm64"
  }
  if ($architectures -contains "X86") {
    return "win-NT6.0-x86"
  }
  return "win-x64"
}

function Test-NM3U8Executable {
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
      $version = (($stdout -split "`r?`n") | Where-Object { $_ } | Select-Object -First 1)
      if ($version) { Write-Output $version }
      return $true
    }
    $details = (($stderr, $stdout) -join " ").Trim()
    Write-Warning "N_m3u8DL-RE.exe exited with status $($process.ExitCode). $details"
    return $false
  } catch {
    Write-Warning "N_m3u8DL-RE.exe is not runnable on this OS: $($_.Exception.Message)"
    return $false
  }
}

$pythonCommand = Resolve-PythonCommand
$pythonArgs = @()
if ($pythonCommand.Length -gt 1) {
  $pythonArgs = $pythonCommand[1..($pythonCommand.Length - 1)]
}
& $pythonCommand[0] @pythonArgs -m pip install --upgrade streamlink

$toolsDir = Join-Path $RootDir "tools"
$nM3u8Dir = Join-Path $toolsDir "n_m3u8dl-re"
$nM3u8Exe = Join-Path $nM3u8Dir "N_m3u8DL-RE.exe"

if (Test-Path $nM3u8Exe) {
  if (Test-NM3U8Executable -Path $nM3u8Exe) {
    exit 0
  }
  Remove-Item -LiteralPath $nM3u8Exe -Force -ErrorAction SilentlyContinue
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qwin-nm3u8dl-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest"
  $assetArch = Resolve-WindowsAssetArchitecture
  $assetPattern = "(?i)_" + [regex]::Escape($assetArch) + "_.*\.zip$"
  $asset = $release.assets |
    Where-Object { $_.name -match $assetPattern } |
    Select-Object -First 1

  if (-not $asset) {
    throw "Could not find a Windows N_m3u8DL-RE release asset for $assetArch."
  }

  $zipPath = Join-Path $tempDir $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

  $downloadedExe = Get-ChildItem -Path $tempDir -Recurse -Filter "N_m3u8DL-RE.exe" |
    Select-Object -First 1

  if (-not $downloadedExe) {
    throw "N_m3u8DL-RE.exe was not found in the downloaded release."
  }

  New-Item -ItemType Directory -Force -Path $nM3u8Dir | Out-Null
  Copy-Item -LiteralPath $downloadedExe.FullName -Destination $nM3u8Exe -Force

  if (-not (Test-NM3U8Executable -Path $nM3u8Exe)) {
    Remove-Item -LiteralPath $nM3u8Exe -Force -ErrorAction SilentlyContinue
    throw "Downloaded N_m3u8DL-RE.exe is not valid for this OS platform."
  }
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
