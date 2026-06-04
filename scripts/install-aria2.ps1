param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$toolsDir = Join-Path $RootDir "tools"
$ariaDir = Join-Path $toolsDir "aria2"
$ariaExe = Join-Path $ariaDir "aria2c.exe"

if (Test-Path $ariaExe) {
  & $ariaExe --version | Select-Object -First 1
  exit 0
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qwin-aria2-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/aria2/aria2/releases/latest"
  $asset = $release.assets |
    Where-Object { $_.name -match "win-64bit.*\.zip$" } |
    Select-Object -First 1

  if (-not $asset) {
    throw "Could not find a Windows 64-bit aria2 release asset."
  }

  $zipPath = Join-Path $tempDir $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

  $downloadedExe = Get-ChildItem -Path $tempDir -Recurse -Filter "aria2c.exe" |
    Select-Object -First 1

  if (-not $downloadedExe) {
    throw "aria2c.exe was not found in the downloaded release."
  }

  New-Item -ItemType Directory -Force -Path $ariaDir | Out-Null
  Copy-Item -LiteralPath $downloadedExe.FullName -Destination $ariaExe -Force

  & $ariaExe --version | Select-Object -First 1
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
