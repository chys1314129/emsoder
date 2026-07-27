@echo off
setlocal EnableExtensions
set "RT=%~dp0.."
set "ENTRY=%RT%\node_modules\mmx-cli\dist\mmx.mjs"
if not exist "%ENTRY%" (
  echo [EMSoder] missing %ENTRY%
  exit /b 1
)
REM 1) bundled portable Node
if exist "%RT%\node\node.exe" (
  "%RT%\node\node.exe" "%ENTRY%" %*
  exit /b %errorlevel%
)
REM 2) system Node
where node >nul 2>&1
if %errorlevel%==0 (
  node "%ENTRY%" %*
  exit /b %errorlevel%
)
REM 3) Electron as Node (portable / installed app next to resources)
if exist "%RT%\..\EMSoder.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RT%\..\EMSoder.exe" "%ENTRY%" %*
  exit /b %errorlevel%
)
if exist "%RT%\..\..\EMSoder.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RT%\..\..\EMSoder.exe" "%ENTRY%" %*
  exit /b %errorlevel%
)
echo [EMSoder] No Node runtime. Re-run pack with sync-skill-runtime (bundles node).
exit /b 1
