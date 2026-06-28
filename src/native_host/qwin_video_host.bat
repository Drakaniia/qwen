@echo off
setlocal

set "LOG_FILE=%TEMP%\qwin_host_debug.log"
echo [%DATE% %TIME%] Starting host... >> "%LOG_FILE%"

where python >nul 2>nul
if not %ERRORLEVEL%==0 (
  where py >nul 2>nul
  if not %ERRORLEVEL%==0 (
    echo [%DATE% %TIME%] ERROR: Python 3 not found >> "%LOG_FILE%"
    >&2 echo Python 3 was not found. Run scripts/install.sh and restart the browser.
    exit /b 1
  )
  echo [%DATE% %TIME%] Using py -3 (python not on PATH) >> "%LOG_FILE%"
  py -3 -u "%~dp0host.py"
  set EXIT_CODE=%ERRORLEVEL%
  echo [%DATE% %TIME%] Exit code: %EXIT_CODE% >> "%LOG_FILE%"
  exit /b %EXIT_CODE%
)

echo [%DATE% %TIME%] Using python >> "%LOG_FILE%"
python -u "%~dp0host.py"
set EXIT_CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] Exit code: %EXIT_CODE% >> "%LOG_FILE%"
exit /b %EXIT_CODE%
