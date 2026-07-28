@echo off
set "SCRIPT=%~dp0Start-Workbench.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
