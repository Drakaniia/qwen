@echo off
setlocal

rem Single temp log dir, shared with the host fallback in log_utils.resolve_log_path.
if not exist "%TEMP%\qwin_logs" mkdir "%TEMP%\qwin_logs"
set "LOG_FILE=%TEMP%\qwin_logs\qwin_host_debug.log"
echo [%DATE% %TIME%] Starting host... >> "%LOG_FILE%"
echo [%DATE% %TIME%] Launcher: %~f0 modified %~t0 >> "%LOG_FILE%"

rem ── Try native PyInstaller .exe first ────────────────────────────────────
if exist "%~dp0qwin-host.exe" (
  echo [%DATE% %TIME%] Using native qwin-host.exe >> "%LOG_FILE%"
  "%~dp0qwin-host.exe"
  set EXIT_CODE=%ERRORLEVEL%
  echo [%DATE% %TIME%] Exit code: %EXIT_CODE% >> "%LOG_FILE%"
  exit /b %EXIT_CODE%
)

echo [%DATE% %TIME%] qwin-host.exe not found, trying Python... >> "%LOG_FILE%"

rem ── Fallback: try Python ─────────────────────────────────────────────────
rem No literal parentheses inside this if-block: cmd parses an unquoted "(" inside a
rem parenthesised block as a nested group, which silently truncates the block and skips
rem every line after it - including the `python` launch below. Verified by repro; this
rem comment is load-bearing, do not "restore" the parentheses.
where python >nul 2>nul
if not %ERRORLEVEL%==0 (
  where py >nul 2>nul
  if not %ERRORLEVEL%==0 (
    echo [%DATE% %TIME%] ERROR: Python 3 not found >> "%LOG_FILE%"
    >&2 echo Python 3 was not found. Run scripts/install.sh and restart the browser.
    exit /b 1
  )
  echo [%DATE% %TIME%] Using py -3, python not on PATH >> "%LOG_FILE%"
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
