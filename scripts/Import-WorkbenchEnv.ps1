function Import-WorkbenchEnvironment {
  param([Parameter(Mandatory = $true)][string]$AppDirectory)

  $envFile = Join-Path $AppDirectory ".env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing .env. Copy .env.example, then set the extension ID and WORKBENCH_API_TOKEN."
  }

  foreach ($line in Get-Content -LiteralPath $envFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -notmatch "^([A-Z0-9_]+)=(.*)$") {
      throw "Invalid .env entry: $trimmed"
    }
    $name = $Matches[1]
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }

  if (-not $env:WORKBENCH_EXTENSION_IDS -or -not $env:WORKBENCH_API_TOKEN) {
    throw ".env must set WORKBENCH_EXTENSION_IDS and WORKBENCH_API_TOKEN."
  }
}
