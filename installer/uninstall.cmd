@echo off
rem Double-click launcher: runs uninstall.ps1 elevated (ExecutionPolicy Bypass). Extra arguments (e.g. -DryRun) are passed through.
setlocal
fltmc >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator rights...
    powershell.exe -NoProfile -Command "Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0uninstall.ps1\" %*'"
    exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
