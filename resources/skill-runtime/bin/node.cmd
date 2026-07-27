@echo off
setlocal
set "RT=%~dp0.."
if exist "%RT%\node\node.exe" (
  "%RT%\node\node.exe" %*
  exit /b %errorlevel%
)
where.exe node >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where.exe node') do (
    "%%i" %*
    exit /b %errorlevel%
  )
)
if exist "%RT%\..\EMSoder.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RT%\..\EMSoder.exe" %*
  exit /b %errorlevel%
)
echo [EMSoder] node not found
exit /b 1
