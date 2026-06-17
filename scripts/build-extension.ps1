param(
  [ValidateSet("chromium", "firefox", "yandex", "all")]
  [string]$Target = "all",
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path $RootDir).Path
$distRoot = Join-Path $root "dist"
$templateDir = Join-Path $root "config\extension"
$sourceDir = Join-Path $root "src"
$bundlesDir = Join-Path $distRoot "bundled"

# Run esbuild once to produce all bundles into dist/bundled/
Push-Location $root
try {
  node scripts/build-bundles.js --target all
} finally {
  Pop-Location
}

function Copy-ExtensionTarget {
  param(
    [string]$Name,
    [string]$ManifestTemplate
  )

  $targetDir = Join-Path $distRoot $Name
  $resolvedDist = [System.IO.Path]::GetFullPath($distRoot)
  $resolvedTarget = [System.IO.Path]::GetFullPath($targetDir)

  if (-not $resolvedTarget.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the dist folder: $resolvedTarget"
  }

  if (Test-Path $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  # Copy source tree (HTML, CSS, and ESM .js files for reference)
  Copy-Item -LiteralPath $sourceDir -Destination (Join-Path $targetDir "src") -Recurse

  # Overlay esbuild bundles (content, background, popup)
  Copy-Item -Path (Join-Path $bundlesDir "src\*") -Destination (Join-Path $targetDir "src") -Recurse -Force

  Copy-Item -LiteralPath (Join-Path $templateDir $ManifestTemplate) -Destination (Join-Path $targetDir "manifest.json")
}

$targets = if ($Target -eq "all") {
  @("chromium", "firefox", "yandex")
} else {
  @($Target)
}

foreach ($target in $targets) {
  if ($target -eq "firefox") {
    Copy-ExtensionTarget -Name "firefox" -ManifestTemplate "manifest.firefox.json"
  } elseif ($target -eq "yandex") {
    Copy-ExtensionTarget -Name "yandex" -ManifestTemplate "manifest.chromium.json"
  } else {
    Copy-ExtensionTarget -Name "chromium" -ManifestTemplate "manifest.chromium.json"
  }
}

Write-Output "Built extension target(s): $($targets -join ', ')"
