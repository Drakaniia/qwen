@echo off
setlocal

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -u "%~dp0host.py"
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -u "%~dp0host.py"
  exit /b %ERRORLEVEL%
)

>&2 echo Python 3 was not found. Run scripts\install.bat and restart the browser.
exit /b 1
