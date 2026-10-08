# Agent Sell Stuff poster -- register the Facebook auto-post loop as a logon task.
#
# Installs local deps (playwright JS only -- we drive the REAL installed Chrome
# via channel:'chrome', so the bundled browsers are skipped), then registers
# SellStuffPoster to run at logon under a restart supervisor.
#
#   .\install.ps1             install deps + register + start
#   .\install.ps1 -Status     task state, halt state, recent log
#   .\install.ps1 -Resume     clear a checkpoint HALT and restart the loop
#   .\install.ps1 -Uninstall  remove the task
#
# Sign-in is separate and human-only:  node login.mjs

param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$TaskName = 'SellStuffPoster'
$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Poster   = Join-Path $Root 'poster.mjs'
$Vbs      = Join-Path $Root 'run-hidden.vbs'
$Cmd      = Join-Path $Root 'run-poster.cmd'
$LogFile  = Join-Path $Root 'logs\poster.log'
$HaltFile = Join-Path $Root 'logs\HALTED'
$Profile  = Join-Path $env:USERPROFILE '.sellstuff-chrome'
if ($env:SELLSTUFF_PROFILE_DIR) { $Profile = $env:SELLSTUFF_PROFILE_DIR }

if ($Status) {
  $autostart = 'NONE -- run install.ps1'
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null; $autostart = "scheduled task $TaskName" } catch { }
  if (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\SellStuffPoster.vbs')) {
    $autostart = 'Startup folder (SellStuffPoster.vbs)'
  }
  Write-Host "Autostart: $autostart"

  if (Test-Path $HaltFile) {
    Write-Host "`n*** LANE HALTED ***" -ForegroundColor Red
    Get-Content $HaltFile
    Write-Host "Clear it with:  .\install.ps1 -Resume"
  } else {
    Write-Host "`nLane: running (no halt file)"
  }

  Write-Host "`nChrome profile : $Profile $(if (Test-Path $Profile) { '(exists)' } else { '(MISSING -- run: node login.mjs)' })"
  # @() so a single match still reports 1 -- an unwrapped scalar printed blank,
  # which read as "the loop is dead" when it was running fine.
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*poster.mjs*' })
  Write-Host "poster.mjs processes: $($procs.Count)$(if ($procs.Count -eq 0) { '  <-- NOT RUNNING' } elseif ($procs.Count -gt 1) { '  <-- TOO MANY, they will race' })"
  # -Encoding UTF8: the log is UTF-8 and holds en dashes (Facebook's condition
  # labels), which Get-Content otherwise renders as mojibake.
  if (Test-Path $LogFile) { Write-Host "`n--- last 20 log lines ---"; Get-Content $LogFile -Tail 20 -Encoding UTF8 }
  return
}

$StartupVbsPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\SellStuffPoster.vbs'

if ($Uninstall) {
  schtasks /Delete /TN $TaskName /F 2>$null
  if (Test-Path $StartupVbsPath) { Remove-Item $StartupVbsPath -Force; Write-Host "Removed Startup entry." }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*poster.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "SellStuffPoster removed and stopped."
  return
}

if ($Resume) {
  if (Test-Path $HaltFile) { Remove-Item $HaltFile -Force; Write-Host "Halt cleared." }
  else { Write-Host "No halt file -- nothing to clear." }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*poster.mjs*' }).Count
  if (-not $running) { Start-Process wscript.exe -ArgumentList "`"$Vbs`"" }
  Write-Host "SellStuffPoster resumed."
  return
}

# --- preflight --------------------------------------------------------------
if (-not (Test-Path $Poster)) { throw "poster.mjs not found at $Poster" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH.' }

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) {
  Write-Warning "Google Chrome not found at $chrome -- the poster drives the real Chrome and will fail without it."
}

$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile)) {
  throw "Missing $envFile -- copy .env.example to .env and fill in SELLSTUFF_WORKER_URL and SELLSTUFF_ADMIN_KEY."
}
foreach ($k in 'SELLSTUFF_WORKER_URL', 'SELLSTUFF_ADMIN_KEY') {
  if (-not (Select-String -Path $envFile -Pattern "^$k=.+" -Quiet)) { throw "$k missing from $envFile" }
}

# --- deps -------------------------------------------------------------------
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: we never launch bundled Chromium. Real
# Chrome only -- a stock Chromium build is both detectable and not the browser
# your Facebook session lives in.
Write-Host "`n--- installing deps (playwright, no bundled browsers) ---"
Push-Location $Root
try {
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force (Join-Path $Root 'logs') | Out-Null

# --- launcher ---------------------------------------------------------------
# Two files on purpose: a .cmd owns the quoting (node
# lives under "Program Files") and the .vbs only exists to run it with no
# console. ASCII on both -- cmd and cscript read ANSI and a BOM breaks them.
# ping, not timeout: timeout.exe needs a console and there isn't one here.
@"
@echo off
cd /d "$Root"
:loop
"$node" "$Poster" >> "$LogFile" 2>&1
echo [supervisor] poster exited, restarting in 30s >> "$LogFile"
ping -n 31 127.0.0.1 > nul
goto loop
"@ | Set-Content -Path $Cmd -Encoding ASCII

@"
' Launches the poster loop with no visible console window.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Root"
sh.Run """$Cmd""", 0, False
"@ | Set-Content -Path $Vbs -Encoding ASCII

# --- register ---------------------------------------------------------------
# Preferred: a scheduled task. But on many machines schtasks /Create returns
# "Access is denied" for an ONLOGON task unless elevated. The Startup folder
# achieves the same thing with no elevation at all, and the restart supervisor
# already lives in run-poster.cmd, so nothing is lost.
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$StartupVbs = Join-Path $StartupDir 'SellStuffPoster.vbs'
$usedTask = $false

# Try the scheduled task, but it must never be able to fail the install.
# Two traps here:
#   - schtasks /Create is often denied unelevated (/Query is fine).
#   - PS 5.1 wraps a native exe's stderr as a NativeCommandError, which
#     $ErrorActionPreference='Stop' then treats as TERMINATING even though we
#     are checking $LASTEXITCODE ourselves. So the redirect happens inside cmd,
#     where PowerShell never sees the stream at all.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  cmd /c "schtasks /Create /TN $TaskName /TR ""wscript.exe \""$Vbs\"""" /SC ONLOGON /RL LIMITED /F >nul 2>nul"
  if ($LASTEXITCODE -eq 0) { $usedTask = $true }
} catch { }
$ErrorActionPreference = $prevEAP

if ($usedTask) {
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force }   # never both, or two pollers race
  Write-Host "Registered scheduled task $TaskName."
} else {
  Write-Host "schtasks needs elevation here -- using the Startup folder instead (no admin required)."
  Copy-Item $Vbs $StartupVbs -Force
  Write-Host "Installed $StartupVbs"
}

# Do NOT auto-start here: the Chrome profile has to be signed in first, and a
# poster that claims an item it cannot post just bounces it back with an alert.
Write-Host "`n$TaskName registered (starts at logon)."
Write-Host "  poster  : $Poster"
Write-Host "  profile : $Profile"
Write-Host "  log     : $LogFile"

# Auto-start ONLY if the profile is genuinely signed in. Checking that the
# profile DIRECTORY exists is not the same test -- login.mjs creates the folder
# on its first launch whether or not anyone actually signed in.
$signedIn = $false
Push-Location $Root
try { $signedIn = ((& node login.mjs --check) -join ' ') -match 'LOGGED IN' } catch { } finally { Pop-Location }

if ($signedIn) {
  # Kill any existing loop first so /Run or a manual launch can't leave two
  # pollers racing for the same claim.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*poster.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if ($usedTask) { schtasks /Run /TN $TaskName | Out-Null }
  else { Start-Process wscript.exe -ArgumentList "`"$Vbs`"" }

  Start-Sleep -Seconds 4
  $n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*poster.mjs*' }).Count
  Write-Host "`nProfile signed in. Started -- poster.mjs processes: $n"
  Write-Host "Check with:  .\install.ps1 -Status"
} else {
  Write-Host "`nNEXT: sign the profile in once ->  node login.mjs" -ForegroundColor Yellow
  Write-Host "      (task is registered but not started -- re-run install.ps1, or reboot, afterwards)"
}
