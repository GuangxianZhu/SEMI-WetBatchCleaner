@echo off
setlocal
cd /d "%~dp0"

rem Check for updates on main before starting.
rem Skipped when git is missing, the folder is not a git clone, the branch is not main, or GitHub is unreachable.
where git >nul 2>nul
if errorlevel 1 goto start
if not exist ".git" goto start
set BRANCH=
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
if /i not "%BRANCH%"=="main" (
    echo Current branch is %BRANCH%, not main - skipping update.
    goto start
)
echo Checking for updates on main...
git pull --ff-only origin main
if errorlevel 1 (
    echo Update skipped: offline, or local changes conflict with main.
    echo Starting the local version.
)

:start
if not exist "output\*.html" (
    echo The offline page was not found in the output folder.
    pause
    exit /b 1
)
for %%f in ("output\*.html") do start "" "%%f"
endlocal
