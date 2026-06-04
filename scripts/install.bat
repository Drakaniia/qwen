@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "HOST_NAME=com.qwin.video_downloader"
set "CHROME_EXTENSION_ID=dbjddokdmkodnkiaccmbjagfalmmmkmi"
set "FIREFOX_EXTENSION_ID=qwin-video-downloader@example.com"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "HOST_SCRIPT=%ROOT_DIR%\src\native-host\host.py"
set "HOST_LAUNCHER=%ROOT_DIR%\src\native-host\qwin_video_host.bat"
set "NATIVE_DIR=%ROOT_DIR%\config\native-host"
set "CHROME_MANIFEST=%NATIVE_DIR%\%HOST_NAME%.chrome.json"
set "YANDEX_MANIFEST=%NATIVE_DIR%\%HOST_NAME%.yandex.json"
set "FIREFOX_MANIFEST=%NATIVE_DIR%\%HOST_NAME%.firefox.json"

echo Installing Qwin Video Downloader native helper...

if not exist "%HOST_SCRIPT%" (
  echo ERROR: src\native-host\host.py was not found.
  exit /b 1
)

if not exist "%HOST_LAUNCHER%" (
  echo ERROR: src\native-host\qwin_video_host.bat was not found.
  exit /b 1
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_CMD=py -3"
) else (
  where python >nul 2>nul
  if %ERRORLEVEL%==0 (
    set "PYTHON_CMD=python"
  ) else (
    echo ERROR: Python 3 is not installed or is not on PATH.
    echo Install Python 3 from https://www.python.org/downloads/windows/ and enable "Add python.exe to PATH".
    exit /b 1
  )
)

echo Installing or updating yt-dlp and bundled ffmpeg fallback with pip...
%PYTHON_CMD% -m pip install --upgrade pip yt-dlp imageio-ffmpeg
if %ERRORLEVEL% neq 0 (
  echo ERROR: pip could not install yt-dlp and imageio-ffmpeg.
  exit /b 1
)

where ffmpeg >nul 2>nul
if %ERRORLEVEL% neq 0 (
  where winget >nul 2>nul
  if !ERRORLEVEL! neq 0 (
    echo ffmpeg is not on PATH and winget is not available.
    echo The helper will use the imageio-ffmpeg binary installed by pip instead.
    goto InstallAria2
  )

  echo Installing ffmpeg with winget...
  winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements
  if !ERRORLEVEL! neq 0 (
    echo winget could not install ffmpeg.
    echo The helper will use the imageio-ffmpeg binary installed by pip instead.
  )
) else (
  echo ffmpeg is already installed.
)

:InstallAria2
echo Installing or checking portable aria2 fast downloader...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-aria2.ps1" -RootDir "%ROOT_DIR%"
if %ERRORLEVEL% neq 0 (
  echo aria2c could not be installed.
  echo Downloads will still work, but fast segmented mode will be unavailable.
)

:RegisterHost
if not exist "%NATIVE_DIR%" mkdir "%NATIVE_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; $chromePath = $env:CHROME_MANIFEST; $yandexPath = $env:YANDEX_MANIFEST; $firefoxPath = $env:FIREFOX_MANIFEST; $launcher = $env:HOST_LAUNCHER; $hostName = $env:HOST_NAME; $chromeId = $env:CHROME_EXTENSION_ID; $firefoxId = $env:FIREFOX_EXTENSION_ID; " ^
  "$chrome = [ordered]@{ name = $hostName; description = 'Qwin Video Downloader native host'; path = $launcher; type = 'stdio'; allowed_origins = @('chrome-extension://' + $chromeId + '/') }; " ^
  "$firefox = [ordered]@{ name = $hostName; description = 'Qwin Video Downloader native host'; path = $launcher; type = 'stdio'; allowed_extensions = @($firefoxId) }; " ^
  "$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false; " ^
  "[System.IO.File]::WriteAllText($chromePath, ($chrome | ConvertTo-Json -Depth 5), $utf8); " ^
  "[System.IO.File]::WriteAllText($yandexPath, ($chrome | ConvertTo-Json -Depth 5), $utf8); " ^
  "[System.IO.File]::WriteAllText($firefoxPath, ($firefox | ConvertTo-Json -Depth 5), $utf8)"
if %ERRORLEVEL% neq 0 (
  echo ERROR: Could not write native messaging manifest files.
  exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%CHROME_MANIFEST%" /f
if %ERRORLEVEL% neq 0 (
  echo ERROR: Could not register the Chrome native messaging host.
  exit /b 1
)

reg add "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%YANDEX_MANIFEST%" /f
if %ERRORLEVEL% neq 0 (
  echo ERROR: Could not register the Yandex Browser native messaging host.
  exit /b 1
)

reg add "HKCU\Software\Mozilla\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%FIREFOX_MANIFEST%" /f
if %ERRORLEVEL% neq 0 (
  echo ERROR: Could not register the Firefox native messaging host.
  exit /b 1
)

echo.
echo Native helper installed for Chrome, Firefox, and Yandex Browser.
echo Restart Chrome, Firefox, and Yandex Browser after loading or reloading the extension.
echo.
echo Chrome extension ID expected by the native host: %CHROME_EXTENSION_ID%
echo Yandex Browser uses the same Chromium extension ID: %CHROME_EXTENSION_ID%
echo Firefox extension ID expected by the native host: %FIREFOX_EXTENSION_ID%
echo.

endlocal
