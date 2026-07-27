@echo off
setlocal
set "RT=%~dp0.."
echo === EMSoder skill-runtime doctor ===
echo ROOT=%RT%
echo.
echo [bundled node]
if exist "%RT%\node\node.exe" ("%RT%\node\node.exe" -v) else (echo missing)
echo [bundled python]
if exist "%RT%\python\python.exe" ("%RT%\python\python.exe" -V) else (echo missing)
echo [PATH tools]
where node 2>nul
where python 2>nul
where firecrawl 2>nul
where mmx 2>nul
where tvly 2>nul
echo.
echo [bin]
dir /b "%~dp0"
