@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "LOG=%~dp0pack-log.txt"
echo. > "%LOG%"
call :log ========================================
call :log   EMSoder Desktop - pack win-unpacked
call :log   dir: %CD%
call :log   time: %DATE% %TIME%
call :log ========================================

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CUSTOM_DIR={{ version }}
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_GET_USE_PROXY=0

where node >nul 2>&1
if errorlevel 1 (
  call :log [ERROR] Node.js not found. Install from https://nodejs.org then retry.
  goto :fail
)
where npm >nul 2>&1
if errorlevel 1 (
  call :log [ERROR] npm not found. Reinstall Node.js with npm.
  goto :fail
)

for /f "delims=" %%v in ('node -v') do call :log Node %%v
for /f "delims=" %%v in ('npm -v') do call :log npm %%v

echo.
echo [1/6] Check dependencies...
if not exist "node_modules\electron\dist\electron.exe" (
  call :log electron binary missing, npm install...
  call npm install
  if errorlevel 1 (
    call :log npm install failed
    goto :fail
  )
  call node node_modules\electron\install.js
  if errorlevel 1 (
    call :log electron install.js failed
    goto :fail
  )
) else (
  call :log electron binary OK
)

if not exist "node_modules\electron-builder\package.json" (
  call :log installing electron-builder...
  call npm install --save-dev electron-builder
  if errorlevel 1 (
    call :log electron-builder install failed
    goto :fail
  )
) else (
  call :log electron-builder OK
)

if not exist "node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release\conpty.node" (
  call :log node-pty native missing, fix-pty...
  call node ".\scripts\fix-pty.js"
)

echo.
echo [2/6] Sync skills into resources\bundled-skills...
call :log sync-bundled-skills
call node ".\scripts\sync-bundled-skills.js"
if errorlevel 1 (
  call :log skill sync failed
  goto :fail
)

echo.
echo [3/6] Sync skill CLI runtime into resources\skill-runtime...
call :log sync-skill-runtime
call node ".\scripts\sync-skill-runtime.js"
if errorlevel 1 (
  call :log skill-runtime sync failed - continuing
)

echo.
echo [4/6] Clean old dist...
if exist "dist" (
  call :log remove dist\
  rmdir /s /q "dist" 2>nul
)

echo.
echo [5/6] Building win-unpacked folder (fast start for friends)...
call :log start electron-builder --dir
set npm_config_build_from_source=false
REM --dir = only unpacked dir, no portable single-exe unpack delay
call node ".\node_modules\electron-builder\cli.js" --win --x64 --dir -c.npmRebuild=false -c.electronDist=node_modules/electron/dist
if errorlevel 1 (
  call :log win-unpacked build failed
  echo.
  echo Build failed. Try:
  echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo   npm run fix-electron
  echo   npm run fix-pty
  echo   then pack.bat again
  echo Check pack-log.txt
  goto :fail
)

if not exist "dist\win-unpacked\EMSoder.exe" (
  call :log EMSoder.exe missing after pack
  goto :fail
)

echo.
echo [6/6] Zip win-unpacked for sharing...
call :log zip win-unpacked
set "ZIPOUT=%CD%\dist\EMSoder-win-unpacked.zip"
if exist "%ZIPOUT%" del /f /q "%ZIPOUT%" >nul 2>&1
powershell -NoProfile -Command "Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath 'dist\EMSoder-win-unpacked.zip' -Force"
if errorlevel 1 (
  call :log zip failed - folder still OK in dist\win-unpacked
) else (
  call :log zip OK: %ZIPOUT%
)

echo.
echo ========================================
echo SUCCESS. Share with friends:
echo.
echo   1) Folder:  dist\win-unpacked\     ^(double-click EMSoder.exe^)
echo   2) Zip:     dist\EMSoder-win-unpacked.zip  ^(extract then run^)
echo.
echo This is FASTER than portable.exe ^(no silent unpack on each launch^).
echo Do NOT share your API keys.
echo Log: pack-log.txt
echo ========================================
echo.
start "" explorer "%CD%\dist"
echo Press any key to close...
pause >nul
exit /b 0

:fail
echo.
echo ========================================
echo FAILED. See pack-log.txt for details.
echo Full log path:
echo   %LOG%
echo ========================================
echo.
type "%LOG%"
echo.
echo Press any key to close...
pause >nul
exit /b 1

:log
echo %*
>> "%LOG%" echo %*
goto :eof
