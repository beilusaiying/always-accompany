#!/usr/bin/env bash
# beilu-always-accompany launcher (bash) — mirrors beilu-always-accompany.ps1
# Ensure deno is available, install/update deps when needed, then run the server.
# 依赖安装/更新在清单核对不全（package.json dependencies 逐项对 node_modules）或显式 'init' 时触发；
# .noupdate 存在则跳过安全源码更新。
# deno pinned to the local copy. Exit code 131 = "graceful restart requested" by the server.

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
export BEILU_DIR="$PROJECT_DIR"
export DENO_NO_UPDATE_CHECK=1

# Portable runtime bleed-in: 便携启动器把 deno/git/node/python 放在项目上两级的 runtime/。
# 后端运行时会 shell out git（beilu-memory/lib/setDataActions.mjs execFileSync("git",...)），
# 便携环境无系统级工具时必须先铺进 PATH，否则后端 git 操作崩。
PORTABLE_RUNTIME="$(cd -- "$PROJECT_DIR/../.." 2>/dev/null && pwd -P)/runtime"
# 便携包时压 manual：包内 node_modules 是构建期铺好的完整平铺树，byonm 直用，零联网零重建。
# deno.json 保持 "auto"（仓库=公共源，auto 服务 git clone 在线用户）；分发差异只活在启动器层。
BEILU_NM_FLAG=""
if [ -d "$PORTABLE_RUNTIME" ] && [ -x "$PORTABLE_RUNTIME/deno/deno" ]; then
	BEILU_NM_FLAG="--node-modules-dir=manual"
fi
if [ -d "$PORTABLE_RUNTIME" ]; then
	if [ -x "$PORTABLE_RUNTIME/deno/deno" ] && ! command -v deno >/dev/null 2>&1; then export PATH="$PORTABLE_RUNTIME/deno:$PATH"; fi
	if [ -x "$PORTABLE_RUNTIME/git/bin/git" ] && ! command -v git >/dev/null 2>&1; then export PATH="$PORTABLE_RUNTIME/git/bin:$PATH"; fi
	if [ -x "$PORTABLE_RUNTIME/node/node" ] && ! command -v node >/dev/null 2>&1; then export PATH="$PORTABLE_RUNTIME/node:$PATH"; fi
	if [ -x "$PORTABLE_RUNTIME/python/python" ] && ! command -v python >/dev/null 2>&1; then export PATH="$PORTABLE_RUNTIME/python:$PATH"; fi
fi

# Packaged deno module cache: 便携/安装器版把完整 deno 缓存随包放在项目内 .deno_dir，
# 指向它即可全离线解析；缓存增量也落包内随包迁移。用户显式设置的 DENO_DIR 优先。
if [ -z "$DENO_DIR" ] && [ -d "$PROJECT_DIR/.deno_dir" ]; then
	export DENO_DIR="$PROJECT_DIR/.deno_dir"
fi

# Pin deno to local copy; never auto-upgrade.
if ! command -v deno >/dev/null 2>&1; then
	if [ -x "$HOME/.deno/bin/deno" ]; then export PATH="$HOME/.deno/bin:$PATH"; fi
fi
# deno 缺失时在线自举。仅在便携/用户级都没有 deno 时作最后手段——
# 无 deno 本就跑不了，故允许联网安装（离线约束:核心可离线运行,bootstrap 缺运行时可联网降级）。
if ! command -v deno >/dev/null 2>&1; then
	echo "  [beilu] 未找到 deno，尝试在线安装 (deno.land/install.sh)..."
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL https://deno.land/install.sh | sh || echo "  [beilu] deno 在线安装失败" >&2
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- https://deno.land/install.sh | sh || echo "  [beilu] deno 在线安装失败" >&2
	fi
	[ -x "$HOME/.deno/bin/deno" ] && export PATH="$HOME/.deno/bin:$PATH"
fi
if ! command -v deno >/dev/null 2>&1; then
	echo "deno not found and online install failed (expected at ~/.deno/bin/deno)" >&2
	exit 1
fi

# 读取服务端口（config.json port，默认 1314）
get_beilu_port() {
	port=1314
	cfg="$PROJECT_DIR/data/config.json"
	if [ -f "$cfg" ]; then
		p=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$cfg" 2>/dev/null | grep -o '[0-9]*$' | head -n1)
		if [ -n "$p" ]; then port="$p"; fi
	fi
	echo "$port"
}

# 后台轮询 /api/ping 就绪后自动打开浏览器。
open_browser_when_ready() {
	_p="$1"
	(
		_elapsed=0
		while [ "$_elapsed" -lt 600 ]; do
			if curl -fsS -m 2 "http://localhost:$_p/api/ping" >/dev/null 2>&1; then
				if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$_p" >/dev/null 2>&1
				elif command -v open >/dev/null 2>&1; then open "http://localhost:$_p" >/dev/null 2>&1
				fi
				exit 0
			fi
			sleep 1
			_elapsed=$((_elapsed + 1))
		done
	) &
}

start_server() {
	_v8flags="--expose-gc"
	_heap_mb=100
	_cfg="$PROJECT_DIR/data/config.json"
	if [ -f "$_cfg" ]; then
		_h=$(grep -o '"heapSize"[[:space:]]*:[[:space:]]*[0-9]*' "$_cfg" 2>/dev/null | grep -o '[0-9]*$' | head -n1)
		if [ -n "$_h" ] && [ "$_h" -gt 0 ] 2>/dev/null; then _heap_mb=$((_h / 1048576)); fi
	fi
	_total_ram_mb=4096
	if [ -f /proc/meminfo ]; then
		_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
		[ -n "$_kb" ] && _total_ram_mb=$((_kb / 1024))
	elif command -v sysctl >/dev/null 2>&1; then
		_bytes=$(sysctl -n hw.memsize 2>/dev/null)
		[ -n "$_bytes" ] && _total_ram_mb=$((_bytes / 1048576))
	fi
	_max_old_mb=$((_total_ram_mb / 2))
	[ "$_max_old_mb" -gt 4096 ] && _max_old_mb=4096
	_v8flags="$_v8flags,--initial-heap-size=$_heap_mb,--max-old-space-size=$_max_old_mb"
	# $BEILU_NM_FLAG 不加引号：空时须消失为零参数而非空字符串参数
	deno run --allow-scripts --allow-all -c "$PROJECT_DIR/deno.json" $BEILU_NM_FLAG --v8-flags="$_v8flags" "$PROJECT_DIR/src/server/index.mjs" "$@"
}

# ── 安全源码更新 ───────────────────────
# 与 Windows 启动链保持同一契约：只允许 fast-forward，不执行 clean/reset；
# 网络失败、分叉或已跟踪文件被修改时保留当前版本，用户未跟踪数据不参与更新覆盖。
safe_git_update() {
	if [ -f "$PROJECT_DIR/.noupdate" ]; then
		echo "  [beilu] .noupdate 已启用，跳过源码更新"
		return 0
	fi
	if [ ! -d "$PROJECT_DIR/.git" ] || ! command -v git >/dev/null 2>&1; then
		return 0
	fi

	if ! _tracked_changes=$(git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=no); then
		echo "  [beilu] 警告：无法读取 Git 工作区状态，已跳过源码更新" >&2
		return 0
	fi
	if [ -n "$_tracked_changes" ]; then
		echo "  [beilu] 警告：检测到本地已跟踪改动，已跳过更新；不会覆盖本地文件" >&2
		return 0
	fi
	if ! git -C "$PROJECT_DIR" fetch origin main --quiet; then
		echo "  [beilu] 警告：无法获取远端更新，继续使用当前版本" >&2
		return 0
	fi
	if ! _local=$(git -C "$PROJECT_DIR" rev-parse HEAD) || ! _remote=$(git -C "$PROJECT_DIR" rev-parse origin/main); then
		echo "  [beilu] 警告：无法确认版本，继续使用当前版本" >&2
		return 0
	fi
	[ "$_local" = "$_remote" ] && return 0

	_marker="$PROJECT_DIR/data/p1/.service-restart-required.json"
	_marker_tmp="${_marker}.tmp"
	_created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
	if ! mkdir -p "$(dirname "$_marker")" ||
		! printf '{"reason":"application-update","targetCommit":"%s","createdAt":"%s"}\n' "$_remote" "$_created_at" > "$_marker_tmp" ||
		! mv -f "$_marker_tmp" "$_marker"; then
		rm -f "$_marker_tmp"
		echo "  [beilu] 警告：无法写入 P1 重启标记，已取消源码更新以保持版本一致" >&2
		return 0
	fi

	echo "  [beilu] 检测到新版本，执行 fast-forward 更新..."
	if ! git -C "$PROJECT_DIR" pull --ff-only origin main; then
		echo "  [beilu] 警告：更新未完成（可能与未跟踪用户文件冲突）；当前版本未被覆盖" >&2
	fi
}

# 依赖安装 / 更新（安全源码更新 + deno install）。
install_or_update() {
	safe_git_update
	mkdir -p "$PROJECT_DIR/node_modules"
	# 两段式安装 + 网络容错重试（最多 3 次，递增等待）。
	# 第一段裸 install 装 package.json 清单；第二段 --entrypoint 爬入口静态图并缓存远程模块。
	_max_retries=3
	_attempt=1
	_install_ok=0
	while [ "$_attempt" -le "$_max_retries" ]; do
		if [ "$_attempt" -gt 1 ]; then
			_wait=$((_attempt * 5))
			echo "  [beilu] 第 $_attempt/$_max_retries 次重试（${_wait}s 后）..."
			sleep "$_wait"
		fi
		echo "  [beilu] 安装依赖 (deno install)...$([ "$_attempt" -gt 1 ] && echo " [重试 $_attempt/$_max_retries]")"
		deno install --reload --allow-scripts -c "$PROJECT_DIR/deno.json" &&
		echo "  [beilu] 清单安装完成,继续入口图扫描..." &&
		deno install -q --allow-scripts --allow-all -c "$PROJECT_DIR/deno.json" --entrypoint "$PROJECT_DIR/src/server/index.mjs"
		if [ $? -eq 0 ]; then _install_ok=1; break; fi
		echo "  [beilu] 安装失败（第 $_attempt 次）" >&2
		_attempt=$((_attempt + 1))
	done
	if [ "$_install_ok" -ne 1 ]; then
		rm -rf "$PROJECT_DIR/node_modules"
		echo "" >&2
		echo "  ========================================" >&2
		echo "  依赖安装失败（$_max_retries 次重试均未成功）" >&2
		echo "  ========================================" >&2
		echo "" >&2
		echo "  常见原因与解决方案:" >&2
		echo "    1. 网络问题 → 检查网络连接后重新启动" >&2
		echo "    2. npm 镜像 → 编辑项目根目录 .npmrc 文件:" >&2
		echo "       registry=https://registry.npmmirror.com/" >&2
		echo "    3. GitHub 镜像 → 创建项目根目录 mirrors.txt:" >&2
		echo "       每行一个镜像前缀（如 https://ghfast.top/）" >&2
		echo "    4. 防火墙/代理 → 确认 deno 未被安全软件拦截" >&2
		echo "" >&2
		exit 1
	fi
}

# Separate launcher directives (open/keepalive/init, consumed here) from server
# commands (run/shutdown/reboot, passed through). Server starts with NO command
# args for server mode; 'open'/'keepalive'/'init' are launcher-only.
keepalive=0
openbrowser=0
forceinit=0
serverargs=""
for a in "$@"; do
	case "$a" in
		keepalive) keepalive=1 ;;
		open) openbrowser=1 ;;
		init) forceinit=1 ;;
		*) serverargs="$serverargs $a" ;;
	esac
done

# 依赖完整性识别：按 package.json dependencies 清单逐项核对 node_modules（清单=全部 npm 引用的
# 单源，含 parts 动态加载件——deno install 静态爬取够不到动态链，靠清单才装得全）。
# 只认"目录存在"级探测；版本正确性由安装期解析负责。清单缺失/不可读 → 回退老判据。
missing_deps() {
	[ -f "$PROJECT_DIR/package.json" ] || { [ -d "$PROJECT_DIR/node_modules" ] || echo "(node_modules missing)"; return; }
	deno eval --no-config '
		const pj = JSON.parse(await Deno.readTextFile(Deno.args[0] + "/package.json"));
		const missing = [];
		for (const name of Object.keys(pj.dependencies ?? {})) {
			try { await Deno.stat(Deno.args[0] + "/node_modules/" + name + "/package.json"); }
			catch { missing.push(name); }
		}
		if (missing.length) console.log(missing.join(", "));
	' "$PROJECT_DIR" 2>/dev/null || { [ -d "$PROJECT_DIR/node_modules" ] || echo "(node_modules missing)"; }
}

# 启动信息（排障用）
echo "  [beilu] $(deno --version 2>/dev/null | head -1) | $(uname -s) $(uname -m)"

# 依赖安装/更新触发：清单核对不全(全新 clone/半态安装) 或显式 init。全绿则跳过。
MISSING_DEPS="$(missing_deps)"
if [ "$forceinit" -eq 1 ] || [ -n "$MISSING_DEPS" ]; then
	[ -n "$MISSING_DEPS" ] && echo "  [beilu] 依赖识别: 缺失 -> $MISSING_DEPS"
	install_or_update
fi

# 只在首启动前排一次浏览器打开任务；后续 131 重启不重开
if [ "$openbrowser" -eq 1 ]; then
	beilu_port="$(get_beilu_port)"
	open_browser_when_ready "$beilu_port"
	# 反馈契约：等浏览器阶段前置打印就绪判据+手动兜底（轮询在后台子 shell，无法回打本控制台）。
	echo "  [beilu] 下方出现『服务器已启动』即就绪，浏览器会自动打开 http://localhost:$beilu_port"
	echo "  [beilu] 若就绪后约 30 秒浏览器仍未打开：手动在浏览器访问 http://localhost:$beilu_port（本窗口=服务本体，关窗即停）"
fi

# shellcheck disable=SC2086
start_server $serverargs
code=$?
if [ "$keepalive" -eq 1 ]; then
	while [ "$code" -eq 131 ]; do
		# shellcheck disable=SC2086
		start_server $serverargs
		code=$?
	done
fi
exit "$code"
