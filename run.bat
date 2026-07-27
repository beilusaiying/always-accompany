: '"
@echo off
title always accompany
rem Switch this console to the UTF-8 codepage: deno/server logs are UTF-8 with ANSI colors and the
rem default GBK codepage garbles both. Everything in this console (cmd /c bat -> powershell -> deno)
rem inherits the codepage. CJK paths go through cmd's internal Unicode parsing, unaffected.
chcp 65001 >nul
goto Batch
"'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SH_EXEC=$(command -v sh)
"$SH_EXEC" "$SCRIPT_DIR/run.sh" "$@"
exit 0

:Batch
if "%1"=="" (
	cmd /c "%~dp0/path/beilu-always-accompany.bat" open keepalive
) else (
	cmd /c "%~dp0/path/beilu-always-accompany.bat" %*
)
if %ERRORLEVEL% NEQ 0 if %ERRORLEVEL% NEQ 255 pause
exit /b %ERRORLEVEL%
@echo on
