# MikroTik Cloud Manager - production launcher (Windows)
#
# Starts the Next.js standalone server on 0.0.0.0:3000 with the environment
# from .env, and keeps it alive: if node exits (crash, DB outage, OOM) it is
# restarted automatically a few seconds later.
#
# Used by the Scheduled Task "MikroTik Cloud Manager" (runs hidden at logon)
# and safe to run manually: if the port is already in use it exits at once.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$LogDir = Join-Path $Root "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir "server.log"

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  try {
    if ((Get-Item $LogFile).Length -gt 5MB) {
      Move-Item $LogFile "$LogFile.1" -Force
    }
  } catch { }
}

# --- single instance guard -------------------------------------------------
try {
  $busy = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
} catch {
  $busy = @()
}
if ($busy.Count -gt 0) {
  Write-Log "port 3000 already in use (pid $($busy[0].OwningProcess)); nothing to do"
  exit 0
}

# --- load .env -------------------------------------------------------------
$envPath = Join-Path $Root ".env"
if (-not (Test-Path $envPath)) {
  Write-Log "ERROR: .env not found at $envPath"
  exit 1
}

foreach ($raw in Get-Content $envPath -Encoding UTF8) {
  $line = $raw.Trim()
  if ($line -eq "") { continue }
  if ($line.StartsWith("#")) { continue }
  if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $key = $matches[1]
    $val = $matches[2].Trim()
    if ($val.Length -ge 2) {
      $quoted = $val.StartsWith('"') -and $val.EndsWith('"')
      if ($quoted) { $val = $val.Substring(1, $val.Length - 2) }
    }
    [Environment]::SetEnvironmentVariable($key, $val, "Process")
  }
}

# --- runtime settings ------------------------------------------------------
$env:HOSTNAME = "0.0.0.0"
$env:PORT = "3000"
$env:NODE_ENV = "production"
# The UI falls back to HTTP polling instead of socket.io (port 3003 is not
# exposed publicly through the Tailscale funnel).
$env:NEXT_PUBLIC_SKIP_SOCKET = "1"

$Node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $Node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
}
if (-not $Node -or -not (Test-Path $Node)) {
  Write-Log "ERROR: node.exe not found"
  exit 1
}

$Server = Join-Path $Root ".next\standalone\server.js"
if (-not (Test-Path $Server)) {
  Write-Log "ERROR: $Server not found - run 'npm run build' first"
  exit 1
}

$nodeVersion = (& $Node -v)
Write-Log "starting server (node $nodeVersion) from $Root"

# --- run + auto-restart ----------------------------------------------------
$attempt = 0
while ($true) {
  $attempt++
  $started = Get-Date
  Write-Log "server start attempt #$attempt"
  try {
    & $Node $Server 2>&1 | ForEach-Object {
      Add-Content -Path $LogFile -Value ("    " + $_) -Encoding UTF8
    }
  } catch {
    Write-Log "node exited with error: $($_.Exception.Message)"
  }
  $ran = ((Get-Date) - $started).TotalSeconds
  Write-Log ("server stopped after {0:N0}s" -f $ran)
  if ($ran -lt 10) { Start-Sleep -Seconds 15 } else { Start-Sleep -Seconds 5 }
}
