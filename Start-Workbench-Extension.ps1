$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envLoader = Join-Path $appDir "scripts\Import-WorkbenchEnv.ps1"
. $envLoader
Import-WorkbenchEnvironment -AppDirectory $appDir
$appUrl = "http://127.0.0.1:8788"
$extensionDir = Join-Path $appDir "browser-extension"

Set-Location $appDir

function Fail($message) {
  Write-Host ""
  Write-Host "[ERROR] $message" -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to exit"
  exit 1
}

$chrome = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Fail "Chrome was not found."
}

if (-not (Test-Path (Join-Path $extensionDir "manifest.json"))) {
  Fail "Extension files are missing."
}

$serverReady = $false
try {
  $version = Invoke-RestMethod "$appUrl/api/system/version" -Headers @{ "X-Workbench-Token" = $env:WORKBENCH_API_TOKEN } -TimeoutSec 2
  $serverReady = [bool]$version.version
} catch {
  $serverReady = $false
}

if (-not $serverReady) {
  Write-Host "[SERVER] Starting local workbench..." -ForegroundColor Cyan
  & (Join-Path $appDir "Start-WorkbenchServer.ps1")
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try {
      $version = Invoke-RestMethod "$appUrl/api/system/version" -Headers @{ "X-Workbench-Token" = $env:WORKBENCH_API_TOKEN } -TimeoutSec 2
      if ($version.version) {
        $serverReady = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $serverReady) {
    Fail "Workbench server did not become ready."
  }
}

Write-Host "[CHROME] Closing current Chrome windows so the extension can load..." -ForegroundColor Yellow
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[OPEN] Starting Chrome with ResuMatch extension..." -ForegroundColor Green
Start-Process -FilePath $chrome -ArgumentList @(
  "--no-first-run",
  "--no-default-browser-check",
  "--load-extension=$extensionDir",
  $appUrl,
  "https://www.zhipin.com/web/geek/jobs"
)
