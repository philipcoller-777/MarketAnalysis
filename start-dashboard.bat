@echo off
setlocal
cd /d "%~dp0"

REM Optional: set MARKET_PYTHON to a real interpreter path for PDF generation.
REM set MARKET_PYTHON=C:\APPS_NEW\DeepTutor\.venv\Scripts\python.exe

REM Start the dashboard on a fresh port so stale older server processes do not hijack the browser.
set "PORT=8799"
set "HOST=127.0.0.1"
set "DASHBOARD_URL=http://%HOST%:%PORT%/"

start "" powershell -NoProfile -WindowStyle Hidden -Command "$url='%DASHBOARD_URL%'; for($i=0; $i -lt 40; $i++){ Start-Sleep -Milliseconds 500; try { $json = Invoke-RestMethod -Uri ($url + 'api/status?ticker=XLM') -UseBasicParsing -TimeoutSec 2; if ($json.savedPipeline -or $json.activeJob -or $json.latestSaved) { Start-Process $url; exit 0 } } catch {} }"

node ui\server.js
