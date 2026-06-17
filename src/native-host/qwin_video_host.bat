@echo off
setlocal

set "LOG_FILE=%TEMP%\qwin_host_debug.log"
echo [%DATE% %TIME%] Starting host... >> "%LOG_FILE%"
echo [%DATE% %TIME%] PATH: %PATH% >> "%LOG_FILE%"

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  echo [%DATE% %TIME%] Using py -3 >> "%LOG_FILE%"
  py -3 -u "%~dp0host.py" 2>> "%LOG_FILE%"
  set "EXIT_CODE=%ERRORLEVEL%"
  echo [%DATE% %TIME%] Exit code: %EXIT_CODE% >> "%LOG_FILE%"
  exit /b %EXIT_CODE%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  echo [%DATE% %TIME%] Using python >> "%LOG_FILE%"
  python -u "%~dp0host.py" 2>> "%LOG_FILE%"
  set "EXIT_CODE=%ERRORLEVEL%"
  echo [%DATE% %TIME%] Exit code: %EXIT_CODE% >> "%LOG_FILE%"
  exit /b %EXIT_CODE%
)

echo [%DATE% %TIME%] ERROR: Python 3 not found >> "%LOG_FILE%"
>&2 echo Python 3 was not found. Run scripts\install.bat and restart the browser.
exit /b 1
