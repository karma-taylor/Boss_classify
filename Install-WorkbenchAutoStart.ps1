$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $appDir "Start-WorkbenchServer.ps1"
$startupDir = [Environment]::GetFolderPath("Startup")
$startupFile = Join-Path $startupDir "ResuMatch Workbench Server.vbs"
$scriptPath = $serverScript.Replace('"', '""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & "$scriptPath" & Chr(34)
shell.Run command, 0, False
"@

[System.IO.File]::WriteAllText($startupFile, $vbs, [System.Text.Encoding]::ASCII)
Write-Output "已设置 Windows 登录后自动启动：$startupFile"
