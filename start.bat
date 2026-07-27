@echo off
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
if not exist node_modules\electron\dist\electron.exe (
  echo Installing dependencies and Electron binary...
  call npm install
  call node node_modules\electron\install.js
)
echo Starting EMSoder Desktop...
call npm start
