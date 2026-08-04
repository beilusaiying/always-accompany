# beilu-always-accompany launcher (PowerShell)
# Entry point: ensure deno is available, install/update deps when needed, then run the server.
# deno version is pinned to the locally installed copy (never auto-upgrade deno itself).
# 依赖安装/更新在清单核对不全（package.json dependencies 逐项对 node_modules）或显式 'init' 时触发；
# .noupdate 文件存在则跳过破坏性 git 更新。
# Exit code 131 = "graceful restart requested" by the server.

$ErrorActionPreference = 'Continue'
# 注：不要禁用控制台 QuickEdit(SetConsoleMode 清 0x40)——那会把鼠标事件改送进程，
# 连带滚轮翻页/点选/复制全部失效(2026-07-19 实测翻车,已回滚)。点选暂停输出属 conhost
# 原生行为(标题出现"选择"前缀,Esc 恢复),用启动提示行告知,不动控制台模式。
$PROJECT_DIR = Split-Path -Parent $PSScriptRoot
$env:BEILU_DIR = $PROJECT_DIR
# Silence deno's built-in "new version available" notice. We never auto-upgrade deno.
$env:DENO_NO_UPDATE_CHECK = '1'

# Portable runtime bleed-in: exe/便携启动器把 deno/git/node/python 放在项目上两级的
# runtime/ 目录。后端运行时会 shell out git（beilu-memory/lib/setDataActions.mjs:3418,3490
# execFileSync("git",...)）和 node/python，便携环境无系统级工具时必须先铺进 PATH，否则
# 后端 git/node 操作 ENOENT 崩。
$portableRuntimeDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PROJECT_DIR)) 'runtime'
$portableDenoActive = $false
if (Test-Path $portableRuntimeDir) {
	$portableDeno = Join-Path $portableRuntimeDir 'deno'
	if (Test-Path (Join-Path $portableDeno 'deno.exe')) {
		# 便携 deno 在场时它就是钦定运行时：包内 deno 版本与包内缓存/依赖布局配套（如 2.9.3 的
		# unref 语义），后面的用户级 ~/.deno/bin 前插必须让位，否则宿主机旧 deno 遮蔽包内 deno。
		$portableDenoActive = $true
		if ($env:PATH -notlike "*$portableDeno*") { $env:PATH = "$portableDeno;$env:PATH" }
	}
	$portableGit = Join-Path $portableRuntimeDir 'git/cmd'
	if ((Test-Path (Join-Path $portableGit 'git.exe')) -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
		$env:PATH = "$portableGit;$env:PATH"
	}
	$portableNode = Join-Path $portableRuntimeDir 'node'
	if ((Test-Path (Join-Path $portableNode 'node.exe')) -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
		$env:PATH = "$portableNode;$env:PATH"
	}
	$portablePython = Join-Path $portableRuntimeDir 'python'
	if ((Test-Path (Join-Path $portablePython 'python.exe')) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
		$env:PATH = "$portablePython;$env:PATH"
	}
}

# Packaged deno module cache: portable/installer builds ship the full deno cache inside the
# project as .deno_dir (remote modules + npm registry cache), so deno resolves fully offline
# and future cache growth lands inside the project and travels with it. An explicit user-set
# DENO_DIR always wins. npm registry pinning is NOT done here: the project-level .npmrc is
# the working mechanism (launcher-level NPM_CONFIG_REGISTRY proved ineffective, 2026-07-19).
$packagedDenoDir = Join-Path $PROJECT_DIR '.deno_dir'
if ((-not $env:DENO_DIR) -and (Test-Path $packagedDenoDir)) {
	$env:DENO_DIR = $packagedDenoDir
}

# Pin deno to the locally installed copy; never auto-upgrade.
# 便携包环境下跳过：便携 deno 已前插 PATH，此处再前插 ~/.deno/bin 会反向遮蔽包内 deno。
$denoBin = Join-Path $env:USERPROFILE '.deno\bin'
if ((-not $portableDenoActive) -and (Test-Path (Join-Path $denoBin 'deno.exe')) -and ($env:PATH -notlike "*$denoBin*")) {
	$env:PATH = "$denoBin;$env:PATH"
}
# deno 缺失时在线自举。
# 仅在便携/用户级都没有 deno 时作最后手段——无 deno 本就跑不了，故允许联网下载（离线约束:核心可离线运行,
# bootstrap 缺运行时可联网降级）。下到 ~/.deno/bin 并入 PATH。
# Mirror fault tolerance: direct github.com access is unreliable in some network environments, so try
# mirror prefixes one by one. The list can be overridden by a mirrors.txt (either at the project root
# or at the portable package root, one prefix per line); the built-in list is only a fallback.
function Get-GithubMirrorPrefixes {
	$prefixes = @('')  # empty prefix = direct connection first
	$candidates = @(
		(Join-Path $PROJECT_DIR 'mirrors.txt'),
		(Join-Path (Split-Path -Parent (Split-Path -Parent $PROJECT_DIR)) 'mirrors.txt')
	)
	$userList = @()
	foreach ($f in $candidates) {
		if (Test-Path $f) {
			$userList = Get-Content $f -Encoding UTF8 | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | ForEach-Object { $_.Trim().TrimEnd('/') + '/' }
			if ($userList.Count -gt 0) { break }
		}
	}
	if ($userList.Count -gt 0) { return $prefixes + $userList }
	return $prefixes + @('https://ghfast.top/', 'https://gh-proxy.com/')
}
if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
	Write-Host "  [beilu] deno not found, attempting online download..." -ForegroundColor Cyan
	# Old Windows PowerShell defaults to TLS 1.0 and GitHub requires TLS 1.2+; opt in explicitly.
	try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
	$denoArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
	$denoUrl = "https://github.com/denoland/deno/releases/download/v2.9.3/deno-${denoArch}-pc-windows-msvc.zip"
	$denoZip = Join-Path $env:TEMP 'beilu-deno-install.zip'
	foreach ($prefix in Get-GithubMirrorPrefixes) {
		try {
			Invoke-WebRequest -Uri ($prefix + $denoUrl) -OutFile $denoZip -UseBasicParsing
			if (Test-Path $denoZip) {
				New-Item -ItemType Directory -Force -Path $denoBin | Out-Null
				Expand-Archive -Path $denoZip -DestinationPath $denoBin -Force
				Remove-Item -Path $denoZip -Force -ErrorAction SilentlyContinue
				if ($env:PATH -notlike "*$denoBin*") { $env:PATH = "$denoBin;$env:PATH" }
				break
			}
		}
		catch { Write-Warning "  [beilu] deno download failed ($(if ($prefix) { $prefix } else { 'direct' })): $($_.Exception.Message)" }
	}
}
if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
	Write-Error "deno not found and online install failed. Expected at $denoBin\deno.exe or $portableRuntimeDir\deno\deno.exe"
	exit 1
}

# 读取服务端口（config.json port，默认 1314），供自动打开浏览器用
function Get-BeiluPort {
	$port = 1314
	$cfgPath = Join-Path $PROJECT_DIR 'data/config.json'
	if (Test-Path $cfgPath) {
		try {
			$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
			if ($cfg.port) { $port = [int]$cfg.port }
		}
		catch {}
	}
	return $port
}

# 后台轮询 /api/readiness，shellReady=true（页面可打开可登录）才自动打开浏览器。
# [D5 §2.4 2026-08-04] 原判据 /api/ping=200 只是 transport liveness——server 随后仍在做部件加载，
# 浏览器先开=黑屏窗口（01 §P1-3 实测 24-29s）。现等 shellReady；全量预加载已转后台不再阻塞基础聊天。
# 兼容：旧后端无 /api/readiness（404 抛错）时，连续多次 ping 可达仍 readiness 不可达 → 回退旧 ping 判据。
# 仅 keepalive 首启动调用一次，重启循环不重开（防每次 131 重启都弹新窗口）。
function Open-BrowserWhenReady {
	param([int]$Port = 1314)
	Start-Job -ScriptBlock {
		param($p)
		$elapsed = 0
		$pingOkButNoReadiness = 0
		# 600s: a first-run dependency install often exceeds 2 minutes; a 120s polling window gave up
		# before the server was ready, so the browser never auto-opened (timing pitfall).
		while ($elapsed -lt 600) {
			try {
				$r = Invoke-WebRequest -Uri "http://localhost:$p/api/readiness" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
				if ($r.StatusCode -eq 200) {
					$j = $null
					try { $j = $r.Content | ConvertFrom-Json } catch {}
					if ($j -and $j.shellReady) { Start-Process "http://localhost:$p"; return }
					$pingOkButNoReadiness = 0  # readiness 端点在但未就绪：继续等真实 shellReady
				}
			}
			catch {
				# readiness 不可达：可能服务未起，也可能是旧后端（无此端点 404）。用 ping 区分：
				# ping 连续 5 次 200 而 readiness 始终失败 → 旧后端，按旧判据打开。
				try {
					$r2 = Invoke-WebRequest -Uri "http://localhost:$p/api/ping" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
					if ($r2.StatusCode -eq 200) {
						$pingOkButNoReadiness++
						if ($pingOkButNoReadiness -ge 5) { Start-Process "http://localhost:$p"; return }
					}
				}
				catch { $pingOkButNoReadiness = 0 }
			}
			Start-Sleep -Seconds 1
			$elapsed++
		}
	} -ArgumentList $Port | Out-Null
}

function Start-Server {
	param([string[]]$ServerArgs)
	$v8Flags = '--expose-gc'
	$heapSizeMB = 100
	$configPath = Join-Path $PROJECT_DIR 'data/config.json'
	if (Test-Path $configPath) {
		try {
			$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
			$mb = [math]::Round([double]$cfg.prelaunch.heapSize / 1MB)
			if ($mb -gt 0) { $heapSizeMB = $mb }
		}
		catch {}
	}
	$totalRamMB = 4096
	try { $totalRamMB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch {}
	$maxOldMB = [math]::Min([math]::Floor($totalRamMB * 0.5), 4096)
	$v8Flags += ",--initial-heap-size=$heapSizeMB,--max-old-space-size=$maxOldMB"
	# 便携包（runtime\ 随包）时压成 manual：包内 node_modules 是构建期铺好的完整平铺树，
	# byonm 直接用它，零联网零重建；deno.json 保持 "auto" 不动——仓库是公共源，auto 服务
	# git clone 在线用户（deno 自动装依赖）。分发差异只活在启动器这一层，不改仓库配置。
	# （auto 在目标机上会无视随包树、静默重建 .deno store：十几万文件分钟级零输出=黑窗假死，
	# 2026-07-19 虚拟机实证；manual 旗标实测可覆盖配置且离线直解平铺树。）
	$nmFlag = @()
	if ($portableDenoActive) { $nmFlag = @('--node-modules-dir=manual') }
	deno run --allow-scripts --allow-all -c "$PROJECT_DIR/deno.json" @nmFlag --v8-flags="$v8Flags" "$PROJECT_DIR/src/server/index.mjs" @ServerArgs
}

# ── 安全源码更新 ───────────────────────
# 更新只允许 fast-forward，绝不 clean/reset；这样不会删除 P1/service/data、角色数据或用户安装的扩展。
# .noupdate 仍是显式总开关。已跟踪本地改动会阻止更新，避免把开发/用户配置写成“看似成功”的覆盖。
function Invoke-SafeGitUpdate {
	if (Test-Path (Join-Path $PROJECT_DIR '.noupdate')) {
		Write-Host "  [beilu] .noupdate 已启用，跳过源码更新" -ForegroundColor DarkYellow
		return
	}
	if ((-not (Test-Path (Join-Path $PROJECT_DIR '.git'))) -or (-not (Get-Command git -ErrorAction SilentlyContinue))) {
		return
	}
	$trackedChanges = git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=no
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "  [beilu] 无法读取 Git 工作区状态，已跳过源码更新"
		return
	}
	if ($trackedChanges) {
		Write-Warning "  [beilu] 检测到本地已跟踪改动，已跳过源码更新；不会覆盖本地文件"
		return
	}
	git -C "$PROJECT_DIR" fetch origin main --quiet
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "  [beilu] 无法获取远端更新，继续使用当前版本"
		return
	}
	$local = git -C "$PROJECT_DIR" rev-parse HEAD
	$remote = git -C "$PROJECT_DIR" rev-parse origin/main
	if (($LASTEXITCODE -ne 0) -or (-not $local) -or (-not $remote)) {
		Write-Warning "  [beilu] 无法确认版本，继续使用当前版本"
		return
	}
	if ($local -eq $remote) { return }
	$marker = Join-Path $PROJECT_DIR 'data\p1\.service-restart-required.json'
	try {
		New-Item -ItemType Directory -Path (Split-Path -Parent $marker) -Force | Out-Null
		@{ reason = 'application-update'; targetCommit = $remote; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $marker -Encoding UTF8
	}
	catch {
		Write-Warning "  [beilu] 无法写入 P1 重启标记，已取消源码更新以保持版本一致: $($_.Exception.Message)"
		return
	}
	Write-Host "  [beilu] 检测到新版本，执行 fast-forward 更新..." -ForegroundColor Cyan
	git -C "$PROJECT_DIR" pull --ff-only origin main
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "  [beilu] 更新未完成（可能与未跟踪用户文件冲突）；当前版本未被覆盖"
	}
}

# 依赖安装 / 更新（安全源码更新 + deno install）。
function Invoke-InstallOrUpdate {
	Invoke-SafeGitUpdate
	New-Item -Path (Join-Path $PROJECT_DIR 'node_modules') -ItemType Directory -Force -ErrorAction SilentlyContinue | Out-Null
	# 两段式安装 + 网络容错重试（最多 3 次，递增等待）。
	# 第一段裸 install 装 package.json 清单；第二段 --entrypoint 爬入口静态图并缓存远程模块。
	# 裸 install 不吃 --allow-all（会被解析成 global 安装用法报错），只带 --allow-scripts。
	$maxRetries = 3
	$installOk = $false
	for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
		if ($attempt -gt 1) {
			$wait = $attempt * 5
			Write-Host "  [beilu] 第 $attempt/$maxRetries 次重试（${wait}s 后）..." -ForegroundColor Yellow
			Start-Sleep -Seconds $wait
		}
		Write-Host "  [beilu] 安装依赖 (deno install)...$(if ($attempt -gt 1) { " [重试 $attempt/$maxRetries]" })" -ForegroundColor Cyan
		deno install --reload --allow-scripts -c "$PROJECT_DIR/deno.json"
		if ($LASTEXITCODE -eq 0) {
			Write-Host "  [beilu] 清单安装完成,继续入口图扫描..." -ForegroundColor Cyan
			# -q:第二段大多命中第一段的缓存,不静音会把弃用警告墙整面重刷一遍(看着像出错);真错误 -q 下照常显示。
			deno install -q --allow-scripts --allow-all -c "$PROJECT_DIR/deno.json" --entrypoint "$PROJECT_DIR/src/server/index.mjs"
		}
		if ($LASTEXITCODE -eq 0) { $installOk = $true; break }
		Write-Warning "  [beilu] 安装失败（第 $attempt 次）"
	}
	# Half-state guard: 半态清理 + 用户引导。
	if (-not $installOk) {
		Remove-Item -Path (Join-Path $PROJECT_DIR 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
		Write-Host ""
		Write-Host "  ========================================" -ForegroundColor Red
		Write-Host "  依赖安装失败（$maxRetries 次重试均未成功）" -ForegroundColor Red
		Write-Host "  ========================================" -ForegroundColor Red
		Write-Host ""
		Write-Host "  常见原因与解决方案:" -ForegroundColor Yellow
		Write-Host "    1. 网络问题 → 检查网络连接后重新启动" -ForegroundColor White
		Write-Host "    2. npm 镜像 → 编辑项目根目录 .npmrc 文件:" -ForegroundColor White
		Write-Host "       registry=https://registry.npmmirror.com/" -ForegroundColor Cyan
		Write-Host "    3. GitHub 镜像 → 创建项目根目录 mirrors.txt:" -ForegroundColor White
		Write-Host "       每行一个镜像前缀（如 https://ghfast.top/）" -ForegroundColor Cyan
		Write-Host "    4. 防火墙/代理 → 确认 deno 未被安全软件拦截" -ForegroundColor White
		Write-Host ""
		exit 1
	}
}

# Separate launcher directives (open/keepalive/init, consumed here) from server commands
# (run/shutdown/reboot, passed through). index.mjs MUST start with NO command args to
# run in server mode; 'open'/'keepalive' are launcher-only, not valid index.mjs commands.
$serverArgs = @()
$keepalive = $false
$openBrowser = $false
$forceInit = $false
foreach ($a in $args) {
	if ($a -eq 'keepalive') { $keepalive = $true }
	elseif ($a -eq 'open') { $openBrowser = $true }
	elseif ($a -eq 'init') { $forceInit = $true }
	else { $serverArgs += $a }
}

# 依赖完整性识别：按 package.json dependencies 清单逐项核对 node_modules（清单=全部 npm 引用的
# 单源，含 parts 动态加载件——deno install 静态爬取够不到动态链，靠清单才装得全）。
# 只认"目录存在"级探测（快、离线、junction/平铺两布局通吃）；版本正确性由安装期解析负责。
# 清单缺失/不可读 → 回退老判据"node_modules 存在与否"，不误触发重装。
function Get-MissingDeps {
	$pjPath = Join-Path $PROJECT_DIR 'package.json'
	if (-not (Test-Path $pjPath)) {
		if (Test-Path (Join-Path $PROJECT_DIR 'node_modules')) { return @() } else { return @('(node_modules missing)') }
	}
	try { $deps = (Get-Content $pjPath -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies }
	catch { if (Test-Path (Join-Path $PROJECT_DIR 'node_modules')) { return @() } else { return @('(node_modules missing)') } }
	if (-not $deps) { return @() }
	$missing = @()
	foreach ($depName in $deps.PSObject.Properties.Name) {
		if (-not (Test-Path (Join-Path $PROJECT_DIR "node_modules/$depName/package.json"))) { $missing += $depName }
	}
	return $missing
}

# 启动信息（排障用，借鉴 SillyTavern "Node version: ..."）
$denoVer = deno --version 2>$null | Select-Object -First 1
Write-Host "  [beilu] $denoVer | PowerShell $($PSVersionTable.PSVersion) | $([System.Environment]::OSVersion.VersionString)" -ForegroundColor DarkGray

# 依赖安装/更新触发：清单核对不全(全新 clone/半态安装) 或显式 'init'。全绿则跳过。
$missingDeps = @(Get-MissingDeps)
if ($forceInit -or ($missingDeps.Count -gt 0)) {
	if ($missingDeps.Count -gt 0) {
		Write-Host "  [beilu] 依赖识别: $($missingDeps.Count) 项缺失 -> $($missingDeps -join ', ')" -ForegroundColor Yellow
	}
	Invoke-InstallOrUpdate
}

# 只在首次启动前排一次浏览器打开任务；后续 131 重启不重开（轮询作业独立于 server 进程）
if ($openBrowser) {
	$beiluPort = Get-BeiluPort
	Open-BrowserWhenReady -Port $beiluPort
	# 反馈契约：等浏览器阶段此前零反馈——用户盯着日志不知道该等还是该动手。就绪判据+手动兜底
	# 前置打印（轮询作业在后台 Job 里，无法向本控制台补打）。
	# [D5] 判据=基础聊天壳就绪(shellReady)即开；扩展仍在后台准备，进入页面即可登录使用，无需等全部加载完。
	Write-Host "  [beilu] 基础界面就绪后浏览器会自动打开 http://localhost:$beiluPort（扩展在后台继续准备，不必等待）" -ForegroundColor Cyan
	Write-Host "  [beilu] 若就绪后约 30 秒浏览器仍未打开：手动在浏览器访问 http://localhost:$beiluPort（本窗口=服务本体，关窗即停）" -ForegroundColor Cyan
	Write-Host "  [beilu] 在本窗口点选文字会暂停显示（标题出现『选择』），按 Esc 即恢复，服务不受影响" -ForegroundColor Cyan
}

Start-Server -ServerArgs $serverArgs
if ($keepalive) {
	while ($LASTEXITCODE -eq 131) {
		Start-Server -ServerArgs $serverArgs
	}
}
exit $LASTEXITCODE
