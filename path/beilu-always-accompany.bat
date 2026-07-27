@echo off
chcp 65001 >nul
powershell.exe -noprofile -nologo -ExecutionPolicy Bypass -File "%~dp0beilu-always-accompany.ps1" %*
if %ERRORLEVEL% NEQ 0 if %ERRORLEVEL% NEQ 255 pause
exit /b %ERRORLEVEL%
