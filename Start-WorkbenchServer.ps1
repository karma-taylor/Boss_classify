$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envLoader = Join-Path $appDir "scripts\Import-WorkbenchEnv.ps1"
. $envLoader
Import-WorkbenchEnvironment -AppDirectory $appDir
$port = 8788
$appUrl = "http://127.0.0.1:$port"
$logsDir = Join-Path $appDir "logs"
$outLog = Join-Path $logsDir "workbench-output.log"
$errorLog = Join-Path $logsDir "workbench-error.log"

function Test-WorkbenchReady {
  try {
    $response = Invoke-RestMethod "$appUrl/api/system/version" -Headers @{ "X-Workbench-Token" = $env:WORKBENCH_API_TOKEN } -TimeoutSec 2
    return [bool]$response.version
  } catch {
    return $false
  }
}

if (Test-WorkbenchReady) {
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $owner -or $owner.ProcessName -ne "node") {
    throw "端口 $port 正被 $($owner.ProcessName) 占用，无法启动 ResuMatch。"
  }
  Stop-Process -Id $owner.Id -Force
  Start-Sleep -Milliseconds 500
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "未找到 Node.js。请安装 Node 22 LTS 后再启动 ResuMatch。"
}

if (-not (Test-Path (Join-Path $appDir "node_modules"))) {
  throw "依赖未安装。请在工作台目录运行 npm install。"
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$startOptions = @{
  FilePath = $node.Source
  ArgumentList = @("src/server.js")
  WorkingDirectory = $appDir
  WindowStyle = "Hidden"
  RedirectStandardOutput = $outLog
  RedirectStandardError = $errorLog
}
Start-Process @startOptions
