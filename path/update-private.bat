@echo off
setlocal
cd /d "%~dp0.."

git diff --quiet --ignore-submodules -- || goto :dirty
git diff --cached --quiet --ignore-submodules -- || goto :dirty

git remote get-url private >nul 2>&1
if errorlevel 1 goto :no_remote

echo Updating from private/main with fast-forward only...
git pull --ff-only private main
if errorlevel 1 goto :failed
echo Private update complete.
pause
exit /b 0

:dirty
echo Local tracked changes detected. Private update was not started.
pause
exit /b 2

:no_remote
echo Git remote "private" is not configured in this working copy.
pause
exit /b 3

:failed
echo Private update failed. Existing files were not force-reset.
pause
exit /b 4
