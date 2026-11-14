@echo off
REM Tereflow National toolkit. Drag your filled workbook onto this file, or run:
REM   national.cmd check   FILE.xlsx
REM   national.cmd analyse FILE.xlsx
REM   national.cmd template
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
if "%~1"=="" (
  echo Usage: national.cmd check FILE.xlsx --frequency monthly ^| analyse FILE.xlsx --frequency monthly ^| template
  pause & exit /b 1
)
set "A=%~1"
if exist "%~1" if /i not "%~1"=="check" if /i not "%~1"=="analyse" if /i not "%~1"=="template" (
  echo Drag-and-drop needs the frequency. Run: national.cmd analyse "%~1" --frequency monthly
  pause & exit /b 0
)
.venv\Scripts\python national_tool.py %*
if "%~2"=="" pause