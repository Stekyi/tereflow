@echo off
REM One-off catch-up for the Nordic and Baltic countries that the Comtrade daily quota cut short. Safe to run again: finished country-years are skipped.
cd /d "%~dp0oracle"
set PYTHONPATH=.
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set stamp=%%I
python -u -m tereflow_oracle ingest --country DNK LVA LTU ISL >> "..\logs\nordic-%stamp%.log" 2>&1