# ============================================================================
#  Diagnose.ps1  --  Mimitale environment check
#
#  HOW TO RUN (in an already-open console, so the window cannot vanish):
#      cd /d "<the folder that holds this file>"
#      powershell -NoProfile -ExecutionPolicy Bypass -File Diagnose.ps1
#
#  It only READS information; it changes nothing.
#  It writes info-diagnose.txt next to itself. Send that file back.
#
#  ASCII-ONLY ON PURPOSE -- see the long explanation in Start-Mimitale.ps1.
#  Do not add non-ASCII characters to this file.
# ============================================================================

$ErrorActionPreference = 'Continue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) { $scriptRoot = (Get-Location).Path }
try { Set-Location -LiteralPath $scriptRoot } catch { }

$report = Join-Path $scriptRoot 'info-diagnose.txt'
$lines = New-Object System.Collections.Generic.List[string]

function Add-Line { param([string]$Text)
  $lines.Add($Text)
  Write-Host $Text
}

Add-Line '================ Mimitale diagnostics ================'
Add-Line ('Generated: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Add-Line ''

# ---------- system ----------
Add-Line '--- System ---'
try {
  Add-Line ('OS caption : ' + (Get-CimInstance Win32_OperatingSystem).Caption)
} catch {
  Add-Line 'OS caption : <failed to read>'
}
Add-Line ('OS version : ' + [System.Environment]::OSVersion.Version)
Add-Line ('64-bit OS  : ' + [System.Environment]::Is64BitOperatingSystem)
Add-Line ('CPU arch   : ' + $env:PROCESSOR_ARCHITECTURE)
Add-Line ''

# ---------- powershell ----------
Add-Line '--- PowerShell ---'
Add-Line ('PSVersion  : ' + $PSVersionTable.PSVersion.ToString())
Add-Line ('PSEdition  : ' + $PSVersionTable.PSEdition)
try { Add-Line ('Host exe   : ' + (Get-Process -Id $PID).Path) } catch { Add-Line 'Host exe   : <failed to read>' }
try { Add-Line ('Console CP : ' + [Console]::OutputEncoding.WebName) } catch { }
try {
  Add-Line 'Execution policy:'
  Add-Line ((Get-ExecutionPolicy -List | Out-String).TrimEnd())
} catch {
  Add-Line 'Execution policy: <failed to read>'
}
Add-Line ''

# ---------- node / npm ----------
Add-Line '--- Node.js / npm ---'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Add-Line ('node path  : ' + $node.Source)
  try {
    $v = (& node -v) 2>&1
    Add-Line ('node -v    : ' + ($v -join ' '))
    Add-Line ('node code  : ' + $LASTEXITCODE)
  } catch {
    Add-Line ('node -v    : FAILED - ' + $_.Exception.Message)
  }
} else {
  Add-Line 'node       : NOT FOUND (not installed, or not on PATH)'
}

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if ($npmCmd) {
  Add-Line ('npm path   : ' + $npmCmd.Source)
  try {
    $v = (& $npmCmd.Source -v) 2>&1
    Add-Line ('npm -v     : ' + ($v -join ' '))
    Add-Line ('npm code   : ' + $LASTEXITCODE)
  } catch {
    Add-Line ('npm -v     : FAILED - ' + $_.Exception.Message)
  }
} else {
  Add-Line 'npm        : NOT FOUND'
}
Add-Line ''

# ---------- project files ----------
Add-Line '--- Project files ---'
Add-Line ('Folder     : ' + $scriptRoot)
foreach ($f in 'package.json', 'main.js', 'preload.js', 'renderer\index.html', 'renderer\style.css', 'renderer\renderer.js', 'messages-utf8.txt') {
  $p = Join-Path $scriptRoot $f
  if (Test-Path -LiteralPath $p) { Add-Line ('  [OK]      ' + $f) } else { Add-Line ('  [MISSING] ' + $f) }
}
if (Test-Path -LiteralPath (Join-Path $scriptRoot 'node_modules\electron')) {
  Add-Line '  [OK]      node_modules\electron'
} else {
  Add-Line '  [MISSING] node_modules\electron  (npm install never succeeded)'
}
Add-Line ''

# ---------- encoding sanity check ----------
Add-Line '--- Encoding check ---'
$ps1 = Join-Path $scriptRoot 'Start-Mimitale.ps1'
if (Test-Path -LiteralPath $ps1) {
  $bytes = [System.IO.File]::ReadAllBytes($ps1)
  $nonAscii = 0
  foreach ($b in $bytes) { if ($b -gt 127) { $nonAscii++ } }
  Add-Line ('Start-Mimitale.ps1 bytes    : ' + $bytes.Length)
  Add-Line ('Start-Mimitale.ps1 non-ASCII: ' + $nonAscii + '  (must be 0)')
}
$msg = Join-Path $scriptRoot 'messages-utf8.txt'
if (Test-Path -LiteralPath $msg) {
  try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $first = [System.IO.File]::ReadAllLines($msg, $utf8)[0]
    Add-Line ('messages-utf8.txt line 1  : ' + $first)
  } catch {
    Add-Line 'messages-utf8.txt         : FAILED to decode as UTF-8'
  }
} else {
  Add-Line 'messages-utf8.txt         : MISSING'
}
Add-Line ''

# ---------- Mimitale data folder ----------
Add-Line '--- Mimitale data folder ---'
$dataDir = Join-Path $env:APPDATA 'Mimitale'
if (Test-Path -LiteralPath $dataDir) {
  Add-Line ('Exists: ' + $dataDir)
  Get-ChildItem -LiteralPath $dataDir -File -ErrorAction SilentlyContinue |
    ForEach-Object { Add-Line ('  ' + $_.Name + '  (' + $_.Length + ' bytes)') }
} else {
  Add-Line ('Does not exist: ' + $dataDir)
  Add-Line '(Mimitale has never started successfully on this machine)'
}
Add-Line ''

Add-Line '================ end ================'

try {
  $lines | Out-File -LiteralPath $report -Encoding UTF8
  Write-Host ''
  Write-Host ('Written to: ' + $report) -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host ('Could not write the report: ' + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ''
Read-Host 'Press Enter to close this window'
