@echo off
REM Daily refresh: incremental Oracle ingest (also refreshes analytics), then rebuild the KV page snapshots.
cd /d "%~dp0"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set stamp=%%I
set LOG=logs\refresh-%stamp%.log
cd oracle
set PYTHONPATH=.
python -m tereflow_oracle ingest --incremental >> "..\%LOG%" 2>&1
if errorlevel 1 (echo ingest failed, skipping snapshots >> "..\%LOG%" & exit /b 1)
python -m tereflow_oracle analytics >> "..\%LOG%" 2>&1
cd ..
call npm run snapshots >> "%LOG%" 2>&1
exit /b %errorlevel%
