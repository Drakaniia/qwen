param(
  [ValidateSet("chromium", "yandex", "all")]
  [string]$Target = "all",
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path $RootDir).Path
$distRoot = Join-Path $root "dist"
$templateDir = Join-Path $root "config\extension"
$sourceDir = Join-Path $root "src"
$bundlesDir = Join-Path $distRoot "bundled"

# Popup pages are Vite's job; content script + service worker stay esbuild/IIFE.
Push-Location $root
try {
  # Vite hashes its CSS/JS output and `emptyOutDir: false` is required (outDir is outside
  # root), so last build's hashed assets would otherwise linger and ship. Wipe first.
  Remove-Item -LiteralPath (Join-Path $bundlesDir "src\popup") -Recurse -Force -ErrorAction SilentlyContinue

  npx vite build
  if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
  node scripts/build-bundles.js --target all
  if ($LASTEXITCODE -ne 0) { throw "esbuild bundles failed" }
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

  # Only what the extension actually loads ships: the built popup pages (Vite HTML, JS
  # entries and hashed CSS), the two esbuild bundles and the native-host installers.
  # The Python host, __pycache__ and every unbundled .js module stay behind (spec §8).
  # Note: shared/qwin_overlay.css is deliberately NOT copied — the overlay's stylesheet
  # is inlined as a string into content.bundle.js and installed inside its shadow root
  # (the manifest's content_scripts.css key was removed in Phase 6).
  Copy-Item -LiteralPath (Join-Path $bundlesDir "src\popup") -Destination (Join-Path $targetDir "src\popup") -Recurse

  foreach ($bundle in @("src\content\content.bundle.js", "src\background\background.bundle.js")) {
    $dest = Join-Path $targetDir $bundle
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath (Join-Path $bundlesDir $bundle) -Destination $dest -Force
  }

  $bundledNativeHost = Join-Path $bundlesDir "src\native_host"
  if (Test-Path $bundledNativeHost) {
    $nativeHostDest = Join-Path $targetDir "src\native_host"
    New-Item -ItemType Directory -Force -Path $nativeHostDest | Out-Null
    Copy-Item -Path (Join-Path $bundledNativeHost "*") -Destination $nativeHostDest -Force
  }

  # Copy native-host config manifests
  $bundledConfig = Join-Path $bundlesDir "native-host"
  if (Test-Path $bundledConfig) {
    $configDest = Join-Path $targetDir "native-host"
    New-Item -ItemType Directory -Force -Path $configDest | Out-Null
    Copy-Item -Path (Join-Path $bundledConfig "*") -Destination $configDest -Force
    Write-Output "  Copied native-host assets to $Name"
  }

  Copy-Item -LiteralPath (Join-Path $templateDir $ManifestTemplate) -Destination (Join-Path $targetDir "manifest.json")

  # Toolbar/management icons the manifest points at by relative path. Static, so they
  # are not a Vite input — the manifest template owns them, like the manifest itself.
  Copy-Item -LiteralPath (Join-Path $templateDir "icons") -Destination (Join-Path $targetDir "icons") -Recurse
}

$targets = if ($Target -eq "all") {
  @("chromium", "yandex")
} else {
  @($Target)
}

foreach ($target in $targets) {
  if ($target -eq "yandex") {
    Copy-ExtensionTarget -Name "yandex" -ManifestTemplate "manifest.chromium.json"
  } else {
    Copy-ExtensionTarget -Name "chromium" -ManifestTemplate "manifest.chromium.json"
  }
}

Write-Output "Built extension target(s): $($targets -join ', ')"