@echo off
chcp 65001 >nul
setlocal
echo ============================================================
echo   AwesomeOS — ChromeOS-Grade Desktop & v11 CAS Launcher
echo ============================================================
set "SHELL_HTML=%~dp0shell\awesomeos-shell.html"
if not exist "%SHELL_HTML%" set "SHELL_HTML=https://awesome-os.github.io/"

if exist "D:\Sectium\sectium.exe" (
  echo [OK] Launching AwesomeOS via Sovereign Sectium Appliance...
  start "" "D:\Sectium\sectium.exe" "--app=%SHELL_HTML%"
  exit /b 0
)
if exist "%LOCALAPPDATA%\AwesomeOS\SectiumBrowser\sectium-browser.exe" (
  echo [OK] Launching AwesomeOS via Sectium Browser...
  start "" "%LOCALAPPDATA%\AwesomeOS\SectiumBrowser\sectium-browser.exe" "--app=%SHELL_HTML%"
  exit /b 0
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  echo [OK] Launching AwesomeOS Desktop Shell (chromeless app mode)...
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "--app=%SHELL_HTML%"
  exit /b 0
)
start "" "%SHELL_HTML%"
