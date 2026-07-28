$ErrorActionPreference = "Stop"

$appDirectory = Split-Path -Parent $PSScriptRoot
$extensionDirectory = Join-Path $appDirectory "browser-extension"
$distDirectory = Join-Path $appDirectory "dist"
$stagingDirectory = Join-Path $distDirectory "extension-staging"
$archivePath = Join-Path $distDirectory "resumatch-extension.zip"
$resolvedApp = [IO.Path]::GetFullPath($appDirectory).TrimEnd('\') + '\'

foreach ($target in @($stagingDirectory, $archivePath)) {
  $resolvedTarget = [IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($resolvedApp, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the project: $resolvedTarget"
  }
}

$manifest = Get-Content -LiteralPath (Join-Path $extensionDirectory "manifest.json") -Raw | ConvertFrom-Json
if (-not $manifest.icons.'128' -or -not (Test-Path -LiteralPath (Join-Path $extensionDirectory $manifest.icons.'128'))) {
  throw "manifest.json must reference an existing 128px PNG icon."
}

New-Item -ItemType Directory -Force -Path $distDirectory | Out-Null
Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

$files = @(
  "background.js",
  "content-script.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "telemetry.js",
  "workbench-launcher.html",
  "workbench-launcher.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
)

foreach ($relativePath in $files) {
  $source = Join-Path $extensionDirectory $relativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required extension file is missing: $relativePath"
  }
  $destination = Join-Path $stagingDirectory $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}

Compress-Archive -Path (Join-Path $stagingDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Created $archivePath"
