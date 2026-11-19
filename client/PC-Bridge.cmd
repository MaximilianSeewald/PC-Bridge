@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Bitte installiere Node.js 22 oder neuer und starte PC-Bridge erneut.
  pause
  exit /b 1
)
node "%~dp0pc-bridge.mjs" %*
if errorlevel 1 pause
