@echo off
setlocal
set "RT=%~dp0.."
if exist "%RT%\node\npm.cmd" (
  call "%RT%\node\npm.cmd" %*
  exit /b %errorlevel%
)
where npm >nul 2>&1
if %errorlevel%==0 (
  npm %*
  exit /b %errorlevel%
)
echo [EMSoder] npm not found in skill-runtime\node
exit /b 1
