@echo off
setlocal
cd /d "%~dp0"

REM Optional: set MARKET_PYTHON to a real interpreter path for PDF generation.
REM set MARKET_PYTHON=C:\APPS_NEW\DeepTutor\.venv\Scripts\python.exe

REM Start the dashboard on a fresh port so stale older server processes do not hijack the browser.
set "PORT=8799"
set "HOST=127.0.0.1"
set "DASHBOARD_URL=http://%HOST%:%PORT%/"

REM Stop any older dashboard server that is already bound to this port.
REM Without this, rerunning the batch file can keep using stale backend code.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port='%PORT%'; $pattern=':' + [regex]::Escape($port) + '\s+.*LISTENING\s+(\d+)$'; netstat -ano | Select-String $pattern | ForEach-Object { if ($_.Line -match 'LISTENING\s+(\d+)$') { $pidToStop=[int]$Matches[1]; if ($pidToStop -ne $PID) { Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue } } }"

start "" powershell -NoProfile -WindowStyle Hidden -Command "$url='%DASHBOARD_URL%'; for($i=0; $i -lt 40; $i++){ Start-Sleep -Milliseconds 500; try { $json = Invoke-RestMethod -Uri ($url + 'api/status?ticker=XLM') -UseBasicParsing -TimeoutSec 2; if ($json.savedPipeline -or $json.activeJob -or $json.latestSaved) { Start-Process $url; exit 0 } } catch {} }"

node ui\server.js
