$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Fail($message) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    Write-Host ""
    Write-Host "Press Enter to close this window."
    Read-Host | Out-Null
    exit 1
}

Write-Host "=== Deadlock Tournament Management Bot - Upgrade ===" -ForegroundColor Cyan
Write-Host "This brings both the Cloudflare Worker and the spreadsheet up to date."
Write-Host ""

# --- Check for Node.js, offer to install it if missing ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js isn't installed yet - this is needed to run the upgrade." -ForegroundColor Yellow
    Write-Host ""
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $choice = Read-Host "Install it automatically now? (Y/n)"
        if ($choice -eq '' -or $choice -match '^[Yy]') {
            Write-Host ""
            Write-Host "Installing Node.js (this can take a minute or two)..."
            winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            Write-Host ""
            Write-Host "Node.js is installed. Windows needs a fresh window to see it -" -ForegroundColor Yellow
            Write-Host "please close this window, then double-click run-upgrade.bat again." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Press Enter to close this window."
            Read-Host | Out-Null
            exit 0
        }
    }
    Write-Host "Opening the Node.js download page - install the LTS version, then run"
    Write-Host "run-upgrade.bat again."
    Start-Process "https://nodejs.org"
    Fail "Waiting on Node.js - nothing else to do here yet."
}

Write-Host "Found Node.js $(node --version)"
Write-Host ""

# --- Install dependencies ---
Write-Host "Installing what this installer needs (only happens once, may take a minute)..."
npm install
if ($LASTEXITCODE -ne 0) {
    Fail "That last step failed - see the messages above for what went wrong."
}

# --- Step 1: Cloudflare Worker ---
Write-Host ""
Write-Host "--- Step 1 of 2: Cloudflare Worker ---" -ForegroundColor Cyan
node upgrade.js
$workerOk = ($LASTEXITCODE -eq 0)
if (-not $workerOk) {
    Write-Host ""
    Write-Host "Worker upgrade did not finish - see the messages above." -ForegroundColor Red
}

# --- Step 2: Spreadsheet ---
Write-Host ""
Write-Host "--- Step 2 of 2: Spreadsheet ---" -ForegroundColor Cyan
node upgrade-sheet.js
$sheetOk = ($LASTEXITCODE -eq 0)
if (-not $sheetOk) {
    Write-Host ""
    Write-Host "Spreadsheet upgrade did not finish - see the messages above." -ForegroundColor Red
}

# --- Summary ---
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($workerOk) { Write-Host "Cloudflare Worker: done" -ForegroundColor Green } else { Write-Host "Cloudflare Worker: FAILED" -ForegroundColor Red }
if ($sheetOk) { Write-Host "Spreadsheet: done" -ForegroundColor Green } else { Write-Host "Spreadsheet: FAILED" -ForegroundColor Red }

if (-not ($workerOk -and $sheetOk)) {
    Fail "One or both steps failed - see above. It's safe to just double-click run-upgrade.bat again; anything that already succeeded won't be undone."
}

Write-Host ""
Write-Host "Press Enter to close this window."
Read-Host | Out-Null
