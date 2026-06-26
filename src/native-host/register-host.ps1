<#
.SYNOPSIS
  Register Qwin native messaging host for a specific browser.

.DESCRIPTION
  Writes the Windows registry key and native messaging manifest JSON file
  for the Qwin Video Downloader native messaging host. Runs silently with
  no visible console window.

.PARAMETER Browser
  Browser name: chrome, edge, brave, yandex, chromium, firefox

.PARAMETER ManifestPath
  Full path to the native messaging manifest JSON file.

.PARAMETER HostName
  Native messaging host name (default: com.qwin.video_downloader).

.PARAMETER InstallDir
  Directory where the native host launcher (.bat) is installed.

.EXAMPLE
  .\register-host.ps1 -Browser yandex -ManifestPath "C:\Users\Me\AppData\Local\Qwin\native-host\com.qwin.video_downloader.yandex.json" -InstallDir "C:\Users\Me\AppData\Local\Qwin\native-host"
#>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("chrome", "edge", "brave", "yandex", "chromium", "firefox")]
  [string]$Browser,

  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [string]$HostName = "com.qwin.video_downloader",

  [string]$ExtensionId = $(if ($env:QWIN_EXTENSION_ID) { $env:QWIN_EXTENSION_ID } else { "dbjddokdmkodnkiaccmbjagfalmmmkmi" }),

  [string]$FirefoxExtensionId = $(if ($env:QWIN_FIREFOX_EXTENSION_ID) { $env:QWIN_FIREFOX_EXTENSION_ID } else { "qwin-video-downloader@example.com" })
)

$ErrorActionPreference = "Stop"

# ── Registry path lookup ──────────────────────────────────────────────────
$registryPaths = @{
  chrome   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  edge     = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  brave    = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
  yandex   = "HKCU:\Software\Yandex\YandexBrowser\NativeMessagingHosts\$HostName"
  chromium = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
  firefox  = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
}

$registryKey = $registryPaths[$Browser]
if (-not $registryKey) {
  Write-Error "Unknown browser: $Browser"
  exit 1
}

$launcherPath = Join-Path $InstallDir "qwin_video_host.bat"

# ── Write the manifest JSON ───────────────────────────────────────────────
if ($Browser -eq "firefox") {
  $manifest = [ordered]@{
    name               = $HostName
    description        = "Qwin Video Downloader native host"
    path               = $launcherPath
    type               = "stdio"
    allowed_extensions = @($FirefoxExtensionId)
  }
} else {
  $manifest = [ordered]@{
    name            = $HostName
    description     = "Qwin Video Downloader native host"
    path            = $launcherPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 5), $utf8NoBom)

# ── Write the registry key ────────────────────────────────────────────────
# Ensure the parent key exists
$parentKey = Split-Path $registryKey -Parent
if (-not (Test-Path $parentKey)) {
  $null = New-Item -Path $parentKey -Force
}

if (Test-Path $registryKey) {
  Set-Item -Path $registryKey -Value $ManifestPath
} else {
  $null = New-Item -Path $registryKey -Value $ManifestPath -Force
}

Write-Output "Registered $HostName for $Browser at $registryKey"
exit 0
