# ============================================================================
#  Start-Mimitale.ps1  --  Mimitale launcher
#
#  HOW TO RUN
#     double-click  Start-Mimitale.cmd      <- recommended
#     or, in an open console:  Start-Mimitale.cmd
#
#  ============================ IMPORTANT ====================================
#  THIS FILE IS ASCII-ONLY ON PURPOSE. DO NOT ADD ANY NON-ASCII CHARACTER.
#
#  Windows PowerShell 5.1 decides how to decode a .ps1 file partly from its byte
#  order mark. When that detection goes wrong it falls back to the system ANSI
#  code page (GBK on a Chinese Windows), the non-ASCII string literals get
#  mangled, their closing quotes get eaten, and the parser then reports bogus
#  errors like "unexpected token }" or "missing }" on later lines.
#
#  That is exactly what happened once already. All Chinese text therefore comes
#  from messages-utf8.txt, which is read with an EXPLICIT UTF-8 decoder below.
#  ===========================================================================
# ============================================================================

$ErrorActionPreference = 'Continue'

# --- console / child-process encoding -------------------------------------
# [Console]::OutputEncoding decides how PS 5.1 decodes what node/npm print.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { $Host.UI.RawUI.WindowTitle = 'Mimitale' } catch { }

# --- where are we? ---------------------------------------------------------
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) { $scriptRoot = (Get-Location).Path }
try { Set-Location -LiteralPath $scriptRoot } catch { }

# --- message table (ASCII fallback) ---------------------------------------
$M = @{
  'NODE_MISSING'   = '[ERROR] Node.js was not found.'
  'NODE_MISSING_1' = 'Install the LTS version from: https://nodejs.org'
  'NODE_MISSING_2' = 'Keep the default install options, then restart the PC'
  'NODE_MISSING_3' = 'and run this launcher again.'
  'NPM_MISSING'    = '[ERROR] node was found but npm was not. Reinstall Node.js.'
  'NO_PACKAGE'     = '[ERROR] package.json was not found in this folder.'
  'NO_PACKAGE_1'   = 'Folder tried:'
  'NO_PACKAGE_2'   = 'Keep this launcher in the same folder as main.js / package.json.'
  'FIRST_RUN'      = 'First run: downloading the Electron runtime (~100 MB). Please wait.'
  'FIRST_RUN_1'    = 'If it looks stuck for more than 5 minutes, press Ctrl+C and retry'
  'FIRST_RUN_2'    = 'on a different network, or configure the China npm mirrors.'
  'INSTALL_FAILED' = '[ERROR] Dependency install failed (npm exit code: {CODE}).'
  'INSTALL_TIPS'   = 'Things to try:'
  'INSTALL_TIP1'   = '  1) Switch to the China mirrors, then retry:'
  'INSTALL_TIP1A'  = '       npm config set registry https://registry.npmmirror.com'
  'INSTALL_TIP1B'  = '       npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/'
  'INSTALL_TIP2'   = '  2) Behind a corporate proxy: configure the npm proxy first.'
  'INSTALL_TIP3'   = '  3) Antivirus blocking: disable it temporarily and retry.'
  'INSTALL_OK'     = 'Dependencies installed.'
  'STARTING'       = 'Starting Mimitale ...'
  'STARTING_1'     = '(This console window is Mimitale log output. Do NOT close it -'
  'STARTING_2'     = ' closing it also shuts Mimitale down.)'
  'EXIT_ERR'       = '[ERROR] Mimitale exited with code {CODE}.'
  'EXIT_TIPS'      = 'For a more detailed error, run these in this folder:'
  'EXIT_TIPS_1'    = '    set MIMITALE_OPEN_DEVTOOLS=1'
  'EXIT_TIPS_2'    = '    npm start'
  'EXIT_TIPS_3'    = 'Then send the red errors from the DevTools Console panel.'
  'EXIT_OK'        = 'Mimitale closed normally.'
  'NO_MSG_FILE'    = '[warn] messages-utf8.txt is missing, showing English only.'
  'PRESS_ENTER'    = 'Press Enter to close this window'
  'VERSION'        = 'Node.js version:'
  'NPM_PATH'       = 'npm path:'
  'WORKDIR'        = 'Working folder:'
  'GUIDE'          = 'Setup guide: see the setup guide markdown file.'
}

# --- load Chinese messages (explicit UTF-8, ignore any BOM) ---------------
$msgFile = Join-Path $scriptRoot 'messages-utf8.txt'
$msgLoaded = $false
try {
  if (Test-Path -LiteralPath $msgFile) {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $lines = [System.IO.File]::ReadAllLines($msgFile, $utf8)
    foreach ($line in $lines) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      if ($line.TrimStart().StartsWith('#')) { continue }
      $idx = $line.IndexOf('|')
      if ($idx -lt 1) { continue }
      $key = $line.Substring(0, $idx).Trim()
      $val = $line.Substring($idx + 1)
      if ($key) { $M[$key] = $val }
    }
    $msgLoaded = $true
  }
} catch {
  $msgLoaded = $false
}

function T { param([string]$Key, [string]$A1, [string]$A2)
  $text = $M[$Key]
  if ($null -eq $text) { return $Key }
  if ($A1) { $text = $text.Replace('{CODE}', $A1).Replace('{TEXT}', $A1) }
  if ($A2) { $text = $text.Replace('{TEXT2}', $A2) }
  return $text
}

function Say { param([string]$Text, [string]$Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
}

function Wait-Exit { param([int]$Code = 1)
  Say ''
  Read-Host (T 'PRESS_ENTER')
  exit $Code
}

Clear-Host
Say '============================================' 'Cyan'
Say '  Mimitale' 'Cyan'
Say '============================================' 'Cyan'
Say ''

# ---------- 1. node + npm --------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say (T 'NODE_MISSING') 'Red'
  Say ''
  Say (T 'NODE_MISSING_1') 'Yellow'
  Say (T 'NODE_MISSING_2') 'Yellow'
  Say (T 'NODE_MISSING_3') 'Yellow'
  Wait-Exit 1
}

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) {
  Say (T 'NPM_MISSING') 'Red'
  Wait-Exit 1
}

$nodeVersion = (& node -v) 2>&1
Say ((T 'VERSION') + ' ' + $nodeVersion) 'Green'
Say ((T 'NPM_PATH') + ' ' + $npmCmd.Source) 'DarkGray'
Say ((T 'WORKDIR') + ' ' + $scriptRoot) 'DarkGray'

# ---------- 2. project sanity ---------------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot 'package.json'))) {
  Say ''
  Say (T 'NO_PACKAGE') 'Red'
  Say ((T 'NO_PACKAGE_1') + ' ' + $scriptRoot) 'Yellow'
  Say (T 'NO_PACKAGE_2') 'Yellow'
  Wait-Exit 1
}

# ---------- 3. install on first run ---------------------------------------
if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot 'node_modules\electron'))) {
  Say ''
  Say (T 'FIRST_RUN') 'Yellow'
  Say (T 'FIRST_RUN_1') 'DarkGray'
  Say (T 'FIRST_RUN_2') 'DarkGray'
  Say ''

  & $npmCmd.Source install
  if ($LASTEXITCODE -ne 0) {
    Say ''
    Say (T 'INSTALL_FAILED' ([string]$LASTEXITCODE)) 'Red'
    Say ''
    Say (T 'INSTALL_TIPS') 'Yellow'
    Say (T 'INSTALL_TIP1') 'Yellow'
    Say (T 'INSTALL_TIP1A') 'White'
    Say (T 'INSTALL_TIP1B') 'White'
    Say (T 'INSTALL_TIP2') 'Yellow'
    Say (T 'INSTALL_TIP3') 'Yellow'
    Wait-Exit 1
  }

  Say ''
  Say (T 'INSTALL_OK') 'Green'
}

# ---------- 4. start -------------------------------------------------------
Say ''
Say (T 'STARTING') 'Cyan'
Say (T 'STARTING_1') 'DarkGray'
Say (T 'STARTING_2') 'DarkGray'
Say ''

& $npmCmd.Source start

$code = $LASTEXITCODE
Say ''
if ($code -ne 0) {
  Say (T 'EXIT_ERR' ([string]$code)) 'Red'
  Say ''
  Say (T 'EXIT_TIPS') 'Yellow'
  Say (T 'EXIT_TIPS_1') 'White'
  Say (T 'EXIT_TIPS_2') 'White'
  Say (T 'EXIT_TIPS_3') 'DarkGray'
  Wait-Exit $code
}

Say (T 'EXIT_OK') 'Green'
if (-not $msgLoaded) { Say (T 'NO_MSG_FILE') 'DarkGray' }
Wait-Exit 0
