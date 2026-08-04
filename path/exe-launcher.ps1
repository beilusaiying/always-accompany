# always-accompany launcher v4 (2026-07-19, ASCII only: ps12exe/PS5.1 encoding pipelines
# break on non-ASCII sources). Source lives in the repo on purpose: the old exe's embedded
# script was once lost with only the binary left.
#
# Design by linqing: the exe checks prerequisites, downloads the project when missing,
# then opens run.bat IN ITS OWN WINDOW via Start-Process and closes itself.
#
# WHY Start-Process and never `& run.bat` (v1-v3 regression, diagnosed 2026-07-19):
# a ps12exe binary runs the whole script inside a PowerShell pipeline
# ("$PSEXEInput|PSEXEMainFunction ...|Out-String -Stream", programFrames/default.cs),
# so any child started inline (`&`) has stdout piped into that pipeline instead of the
# console, and native stderr is held back until the pipeline ends. A long-running server
# therefore boots INVISIBLY: the window shows nothing and looks dead (reproduced: child
# alive at 8s, 0 bytes visible). Start-Process bypasses the pipeline entirely - the child
# gets a fresh real console window, and this exe can exit. run.bat holds its own window
# open on failure (pause), so error feedback survives the handover.
#
# The project launch chain owns runtime PATH bleed-in (probes runtime\ two levels above
# the project root = this exe's folder) and DENO_DIR (probes .deno_dir inside the project).
# Duplicating any of that here would split the wiring.
#
# Feedback contract (linqing: "no feedback = errors by guesswork"): every phase is echoed
# AND appended to launcher.log next to the exe; failures keep this window open.
#
# Build (Windows PowerShell 5.1 with the ps12exe module):
#   Import-Module ps12exe
#   ps12exe -inputFile path\exe-launcher.ps1 -outputFile always-accompany.exe -iconFile src\public\pages\favicon.ico

$ErrorActionPreference = 'Continue'
# UTF-8 console: git/tool output can contain UTF-8; the default GBK codepage garbles it.
try { chcp 65001 | Out-Null } catch {}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# Inside a ps12exe binary $PSScriptRoot is empty (no script file on disk), so locate the exe
# through the process main module; when debugging the raw .ps1 the main module is
# powershell/pwsh, so fall back to three levels above this file (it lives in app\<repo>\path\).
$mainModule = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
if ($mainModule -and ($mainModule -notmatch 'powershell|pwsh')) { $BASE = Split-Path -Parent $mainModule }
else { $BASE = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) }

$LOG = Join-Path $BASE 'launcher.log'
function Say([string]$msg) {
	$line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
	Write-Host $line
	try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
}
function Fail([string]$msg) {
	Say "ERROR: $msg"
	Read-Host 'Press Enter to exit'
	exit 1
}
try { Set-Content -Path $LOG -Value '' -Encoding UTF8 } catch {}
Say "always-accompany launcher v4 | base: $BASE"

$APP = Join-Path (Join-Path $BASE 'app') 'always-accompany'

# -- 1. prerequisites: portable runtimes must be on disk (they only come from the installer;
# nothing at runtime can recreate them). Probe inner files too: a directory that exists but
# lost its payload (seen: python.exe present, stdlib gone) breaks silently much later.
$runtimeChecks = @(
	@{ Name = 'runtime deno';          Path = Join-Path $BASE 'runtime\deno\deno.exe' },
	@{ Name = 'runtime git';           Path = Join-Path $BASE 'runtime\git\cmd\git.exe' },
	@{ Name = 'runtime node';          Path = Join-Path $BASE 'runtime\node\node.exe' },
	@{ Name = 'runtime node (npm)';    Path = Join-Path $BASE 'runtime\node\npm.cmd' },
	@{ Name = 'runtime python';        Path = Join-Path $BASE 'runtime\python\python.exe' },
	@{ Name = 'runtime python stdlib'; Path = Join-Path $BASE 'runtime\python\Lib\encodings\__init__.py' }
)
$missing = @($runtimeChecks | Where-Object { -not (Test-Path $_.Path) })
if ($missing.Count -gt 0) {
	Say "prerequisite check FAILED - $($missing.Count) item(s) missing:"
	foreach ($m in $missing) { Say "  MISSING: $($m.Name) -> $($m.Path)" }
	Fail "the package is incomplete (moved exe out of its folder / interrupted install?). Re-run the installer."
}
Say "prerequisite check OK (runtime deno/git/node/python)"

# -- 2. download when the project is missing. Start-Process (not inline) so git's progress
# is visible in its own right; -Wait because run.bat cannot start before the clone is done.
if (-not ((Test-Path (Join-Path $APP 'run.bat')) -and (Test-Path (Join-Path $APP 'path\beilu-always-accompany.bat')))) {
	Say "project missing at $APP - downloading from GitHub (a window shows the progress) ..."
	$env:PATH = (Join-Path $BASE 'runtime\git\cmd') + ';' + $env:PATH
	$parent = Split-Path -Parent $APP
	if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
	$p = Start-Process -FilePath (Join-Path $BASE 'runtime\git\cmd\git.exe') `
		-ArgumentList '-c', 'core.autocrlf=false', 'clone', 'https://github.com/beilusaiying/beilu-always-accompany.git', "`"$APP`"" `
		-Wait -PassThru
	if (-not (Test-Path (Join-Path $APP 'run.bat'))) {
		Fail "download failed (git exit $($p.ExitCode)). Check the network and run again."
	}
	Say "download done."
}

# -- 3. offline payload presence (informational: the project chain self-heals these online;
# offline users get the chain's own clear error, so this exe only warns and continues) --
if (-not (Test-Path (Join-Path $APP 'node_modules'))) { Say "note: node_modules missing - the launch chain will try an online install" }
if (-not (Test-Path (Join-Path $APP '.deno_dir'))) { Say "note: .deno_dir missing - deno will fetch modules online on first run" }

# -- 4. open run.bat in its own console window, then close. The new window owns the whole
# launch chain from here; on failure run.bat pauses so the window stays readable.
Say "opening run.bat in its own window; this launcher window closes itself now."
Start-Process -FilePath (Join-Path $APP 'run.bat') -WorkingDirectory $APP
exit 0
