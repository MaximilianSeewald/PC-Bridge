@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Bitte installiere Node.js 22 oder neuer.
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0portable-device.mjs" "%~dp0pc-bridge.config.json"
) else (
  node "%~dp0portable-device.mjs" "%~1"
)
set "pc_bridge_status=%ERRORLEVEL%"
if not "%pc_bridge_status%"=="0" pause
exit /b %pc_bridge_status%
