param(
  [ValidateSet("all", "native", "extension", "build")]
  [string]$Suite = "all",
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $RootDir).Path

function Invoke-NativeTests {
  Push-Location $root
  try {
    python -m unittest discover -s tests\native-host -p test_*.py
  } finally {
    Pop-Location
  }
}

function Invoke-ExtensionTests {
  Push-Location $root
  try {
    node scripts/build-test-bundles.js
    Get-ChildItem tests\extension -Filter test_*.js | Sort-Object Name | ForEach-Object {
      node $_.FullName
    }
  } finally {
    Pop-Location
  }
}

function Invoke-BuildChecks {
  & (Join-Path $root "scripts\build-extension.ps1") -Target all -RootDir $root
}

if ($Suite -eq "native") {
  Invoke-NativeTests
} elseif ($Suite -eq "extension") {
  Invoke-ExtensionTests
} elseif ($Suite -eq "build") {
  Invoke-BuildChecks
} else {
  Invoke-NativeTests
  Invoke-ExtensionTests
  Invoke-BuildChecks
}
