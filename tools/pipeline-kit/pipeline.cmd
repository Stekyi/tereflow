@echo off
REM Tereflow pipeline: the same steps the app owner runs, on any Windows PC with Python 3.9+ and the Oracle wallet.
REM Nothing here calls an AI model. Every step is a fixed rule over the data.
setlocal
cd /d "%~dp0"
if not exist .env (
  echo No .env file. Copy env.example to .env and fill in your Oracle details first. See README.txt.
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo First run: creating a private Python environment...
  python -m venv .venv || (echo Python 3.9 or newer is needed. & exit /b 1)
  .venv\Scripts\python.exe -m pip install -q -r oracle\requirements.txt openpyxl || exit /b 1
)
set PYTHONPATH=%~dp0oracle
set PY=.venv\Scripts\python.exe
if "%~1"=="" goto help
if /i "%~1"=="status"       %PY% -m tereflow_oracle status & goto :eof
if /i "%~1"=="check"        %PY% -m tereflow_oracle check & goto :eof
if /i "%~1"=="load-inbox"   %PY% -u -m tereflow_oracle ingest-inbox %2 %3 & goto :eof
if /i "%~1"=="load-folder"  %PY% -u -m tereflow_oracle ingest-folder %2 %3 %4 & goto :eof
if /i "%~1"=="analytics"    %PY% -u -m tereflow_oracle analytics %2 %3 %4 %5 %6 & goto :eof
if /i "%~1"=="comtrade"     %PY% -u -m tereflow_oracle ingest %2 %3 %4 %5 %6 %7 %8 %9 & goto :eof
if /i "%~1"=="worldbank"    %PY% -u -m tereflow_oracle worldbank %2 %3 %4 & goto :eof
if /i "%~1"=="finance"      %PY% scripts\finance\bank_load.py %2 %3 %4 %5 %6 & goto :eof
if /i "%~1"=="finance-check" %PY% scripts\finance\bank_template.py check %2 %3 %4 & goto :eof
if /i "%~1"=="national"     %PY% scripts\national\national_load.py %2 %3 %4 %5 %6 & goto :eof
:help
echo Usage: pipeline.cmd COMMAND [options]
echo.
echo   status                      what the database holds
echo   check                       test the Oracle connection
echo   load-folder FOLDER          load collector CSVs from a local folder (e.g. tereflow-data\data), then recalculate
echo                               add --dry-run to check the files without loading
echo   load-inbox                  load the files uploaded in the admin "Send collected data" box
echo   analytics [--country ISO3]  recalculate the analysis for countries already loaded
echo   comtrade --country ISO3 --years 2023 2024   fetch from UN Comtrade straight into Oracle (needs COMTRADE_API_KEY)
echo   worldbank                   refresh World Bank indicators
echo   finance-check FILE.xlsx     check a bank workbook;  finance load FILE.xlsx [--dry-run] [--replace] loads it
echo   national load FILE.xlsx     load national statistics (see README)
exit /b 0
