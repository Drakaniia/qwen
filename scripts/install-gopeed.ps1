param(
    [string]$RootDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $RootDir) {
    $RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}

Write-Host "Installing or updating Gopeed download manager..." -ForegroundColor Cyan

# Check if Go is installed
$goLocation = Get-Command "go" -ErrorAction SilentlyContinue
if (-not $goLocation) {
    Write-Host "Go is not installed. Gopeed requires Go 1.21+." -ForegroundColor Yellow
    Write-Host "Install Go from https://go.dev/dl/ and run this script again." -ForegroundColor Yellow
    Write-Host "Alternatively, you can manually download Gopeed from:" -ForegroundColor Yellow
    Write-Host "  https://github.com/GopeedLab/gopeed/releases" -ForegroundColor Yellow
    exit 1
}

# Check Go version (need 1.21+)
try {
    $goVersion = (go version | Select-String -Pattern "go(\d+\.\d+)").Matches.Groups[1].Value
    $versionMajor = [int]($goVersion.Split('.')[0])
    $versionMinor = [int]($goVersion.Split('.')[1])
    if ($versionMajor -eq 1 -and $versionMinor -lt 21) {
        Write-Host "Go version $goVersion is too old. Gopeed requires Go 1.21+." -ForegroundColor Yellow
        Write-Host "Update Go from https://go.dev/dl/ and run this script again." -ForegroundColor Yellow
        exit 1
    }
} catch {
    Write-Host "Could not determine Go version. Assuming Go is recent enough." -ForegroundColor Yellow
}

Write-Host "Installing Gopeed via 'go install'..." -ForegroundColor Green
Write-Host "  go install github.com/GopeedLab/gopeed/cmd/gopeed@latest" -ForegroundColor Gray

try {
    $output = go install github.com/GopeedLab/gopeed/cmd/gopeed@latest 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Gopeed installation failed:" -ForegroundColor Red
        Write-Host $output -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Gopeed installation failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Gopeed installed successfully!" -ForegroundColor Green

# Verify installation
try {
    $gopeedOutput = & gopeed --help 2>&1
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2) {
        Write-Host "Gopeed is ready to use." -ForegroundColor Green
    }
} catch {
    # gopeed --help might fail on Windows, but the binary should be on GOPATH/bin
    $gopath = go env GOPATH
    $gopeedExe = Join-Path $gopath "bin\gopeed.exe"
    if (Test-Path $gopeedExe) {
        Write-Host "Gopeed binary found at: $gopeedExe" -ForegroundColor Green
        Write-Host ""
        Write-Host "Note: You may need to add Go's bin directory to your PATH:" -ForegroundColor Yellow
        Write-Host "  $gopath\bin" -ForegroundColor Cyan
    } else {
        Write-Host "Gopeed was installed but the binary could not be found." -ForegroundColor Yellow
        Write-Host "Check your GOPATH/bin directory." -ForegroundColor Yellow
        exit 1
    }
}

# Optionally set QWIN_GOPEED environment variable
$gopath = go env GOPATH
$defaultGopeed = Join-Path $gopath "bin\gopeed.exe"
if (Test-Path $defaultGopeed) {
    [Environment]::SetEnvironmentVariable("QWIN_GOPEED", $defaultGopeed, "User")
    Write-Host "Set QWIN_GOPEED environment variable to: $defaultGopeed" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Gopeed integration complete! Restart your browser for changes to take effect." -ForegroundColor Green
