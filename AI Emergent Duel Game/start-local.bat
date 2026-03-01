@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Node.js not found.
  echo [ERROR] Please install Node.js 18+ and run this script again.
  pause
  exit /b 1
)

echo [INFO] Starting backend+frontend server at http://localhost:8787
start "" "http://localhost:8787"
node server.js
