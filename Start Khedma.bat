@echo off
rem Double-click this file on Windows to start Khedma.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  start "" https://nodejs.org
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time setup: installing... about a minute
  call npm install --no-audit --no-fund
)

start "" http://localhost:3000
echo Starting Khedma - your browser will open automatically.
echo Keep this window open while using the app. Close it to stop.
call npm run dev
