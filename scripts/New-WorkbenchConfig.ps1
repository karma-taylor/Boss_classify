param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ExtensionId,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$appDirectory = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $appDirectory ".env"

if ((Test-Path -LiteralPath $envFile) -and -not $Force) {
  throw ".env already exists. Use -Force only when you intentionally want to replace this machine's token."
}

$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  # GetBytes works in both Windows PowerShell 5.1 and newer PowerShell versions.
  $rng.GetBytes($bytes)
} finally {
  $rng.Dispose()
}
$token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")

@(
  "# Generated for this local ResuMatch installation. Do not share this file.",
  "WORKBENCH_EXTENSION_IDS=$ExtensionId",
  "WORKBENCH_API_TOKEN=$token",
  "ENABLE_CLOUD_AI=false"
) | Set-Content -LiteralPath $envFile -Encoding ascii

Write-Output "Created $envFile"
Write-Output "Paste this token once into the ResuMatch extension popup and the workbench token prompt:"
Write-Output $token
