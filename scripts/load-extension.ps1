# Load Qwin extension into Yandex Browser
param()

$yandex = "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe"
$extPath = "C:\Users\Qwenzy\Desktop\qwin\dist\yandex"
$profileDir = "C:\Users\Qwenzy\AppData\Local\Yandex\YandexBrowser\User Data"

Write-Host "Closing any running Yandex Browser instances..." -ForegroundColor Cyan
Get-Process -Name "browser" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "Launching Yandex Browser with Qwin extension..." -ForegroundColor Cyan
Write-Host "Extension path: $extPath" -ForegroundColor Gray

$args = @(
    "--load-extension=$extPath",
    "--no-first-run",
    "--no-default-browser-check"
)

Start-Process -FilePath $yandex -ArgumentList $args

Write-Host "Yandex Browser launched with Qwin extension loaded!" -ForegroundColor Green
Write-Host ""
Write-Host "To verify:" -ForegroundColor Yellow
Write-Host "  1. Open browser://extensions in Yandex" -ForegroundColor Yellow
Write-Host "  2. Look for 'Qwin Video Downloader' in the list" -ForegroundColor Yellow
Write-Host "  3. If not shown, enable 'Developer mode' (toggle in top-right)" -ForegroundColor Yellow
Write-Host "     and click 'Load unpacked', then select: $extPath" -ForegroundColor Yellow
