@echo off
setlocal
set "RT=%~dp0.."
if exist "%RT%\python\python.exe" (
  "%RT%\python\python.exe" %*
  exit /b %errorlevel%
)
where python >nul 2>&1
if %errorlevel%==0 (
  python %*
  exit /b %errorlevel%
)
echo [EMSoder] python not bundled. Set EMSODER_BUNDLE_PYTHON=1 when packing.
exit /b 1
