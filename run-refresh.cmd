@echo off
REM Daily refresh: incremental Oracle ingest (also refreshes analytics), then rebuild the KV page snapshots.
cd /d "%~dp0"
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set stamp=%%I
set LOG=logs\refresh-%stamp%.log
cd oracle
set PYTHONPATH=.
REM Keep Oracle's active-country list in step with the admin tick boxes, or the sandbox rejects a country the app shows as active.
python -m tereflow_oracle sync-countries >> "..\%LOG%" 2>&1
REM Monthly first (cheap: World totals only), yearly after. A quota stop in one does not block the other.
python -u -m tereflow_oracle ingest-monthly --country GHA NGA TGO CIV LBR CHN USA --years 2021 2022 2023 2024 2025 >> "..\%LOG%" 2>&1
python -m tereflow_oracle ingest --incremental >> "..\%LOG%" 2>&1
if errorlevel 1 (echo ingest failed, retrying once >> "..\%LOG%" & python -m tereflow_oracle ingest --incremental >> "..\%LOG%" 2>&1)
if errorlevel 1 (echo ingest failed twice, rebuilding snapshots from what Oracle holds >> "..\%LOG%")
python -m tereflow_oracle analytics >> "..\%LOG%" 2>&1
if errorlevel 1 (echo analytics failed, retrying once >> "..\%LOG%" & python -m tereflow_oracle analytics >> "..\%LOG%" 2>&1)
REM World Bank indicators are annual; refreshing nightly is cheap and keeps new countries filled in.
python -m tereflow_oracle worldbank >> "..\%LOG%" 2>&1
cd ..
call npm run snapshots >> "%LOG%" 2>&1
exit /b %errorlevel%
