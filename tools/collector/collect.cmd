@echo off
REM Tereflow collector launcher. Double-click, or run from a command prompt with arguments:
REM   collect.cmd --country EST FIN --years 2023 2024
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.9 or newer is needed. Install it from https://www.python.org/downloads/ and tick "Add to PATH".
  pause & exit /b 1
)
if not exist .venv (
  echo First run: setting up...
  python -m venv .venv || (echo Could not create the environment & pause & exit /b 1)
  .venv\Scripts\python -m pip install --quiet -r requirements.txt || (echo Install failed & pause & exit /b 1)
)
if "%COMTRADE_API_KEY%"=="" if exist comtrade_key.txt set /p COMTRADE_API_KEY=<comtrade_key.txt
if "%~1"=="" (
  if "%COMTRADE_API_KEY%"=="" (
    set /p COMTRADE_API_KEY=Paste your Comtrade API key ^(saved to comtrade_key.txt on this PC only^):
    >comtrade_key.txt echo %COMTRADE_API_KEY%
  )
  set /p CTRY=Countries ^(ISO3 codes separated by spaces, e.g. EST FIN^):
  set /p YRS=Years ^(e.g. 2023 2024, or leave empty for the last 3^):
  if defined YRS (set YARG=--years %YRS%) else (set YARG=)
  .venv\Scripts\python tereflow_collect.py --country %CTRY% %YARG%
) else (
  .venv\Scripts\python tereflow_collect.py %*
)
echo.
echo Done. Files are in the tereflow-data folder next to this script.
if "%~1"=="" pause