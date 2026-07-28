$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $appDir "Start-WorkbenchServer.ps1"
$appUrl = "http://127.0.0.1:8788"

function Fail($message) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($message, "ResuMatch 启动失败", "OK", "Error") | Out-Null
  exit 1
}

try {
  & $serverScript
} catch {
  Fail $_.Exception.Message
}

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-RestMethod "$appUrl/api/system/version" -TimeoutSec 2
    if ($response.version) {
      Start-Process $appUrl
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 400
  }
}

Fail "本地服务没有在 20 秒内启动。请查看 logs\\workbench-error.log。"
