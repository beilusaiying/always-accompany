/**
 * command-tools.ts -- 终端命令执行工具（run_command + run_script）。
 *
 * ═══════════════════════════════════════════════════════════════
 *  功能链：AI 通过 IDE 执行终端命令
 * ═══════════════════════════════════════════════════════════════
 *
 * 传导链路：
 *   beilu AI 决定执行命令（如 npm install / python script.py）
 *     → beilu 后端 ideClient.mjs 发 WS {type:"tool_call", tool:"run_command", params:{command:"npm install"}}
 *     → IdeWsServer.handleMessage case "tool_call"
 *     → extension.ts onToolCall → ToolExecutor.execute(req)
 *     → 【本模块】runCommand(params)
 *       → COMMAND_BLACKLIST 安全检查（严重破坏类永禁：rm -rf / format / 擦盘改引导 / 推公共仓库等）
 *       → 两种模式：
 *         a) 一次性执行（默认）：cp.exec 跑完返回
 *         b) 持久会话（session=true）：复用长驻 cmd.exe/sh，cd 等状态跨调用保持
 *       → GBK 解码（Windows cmd 内置命令输出 GBK）
 *       → 智能截断（保留头尾，中间摘要）
 *     → {exitCode, stdout, stderr, truncated?} 回传给 beilu 后端
 *     → AI 看到命令输出，决定下一步
 *
 *   run_script 的传导链：
 *     AI 需要跑多行脚本（避免 cmd 内联引号地狱）
 *       → tool_call run_script {lang:"python", code:"import os\nprint(os.getcwd())"}
 *       → 【本模块】runScript(params)
 *         → 脚本源码落临时文件（绕开 python -c "..." 的引号转义问题）
 *         → 委托 runCommand 执行 `python "临时文件路径"`
 *         → 跑完删除临时文件
 *       → 结果同 runCommand
 *
 * 安全机制：
 *   - COMMAND_BLACKLIST：正则拦截严重破坏类命令（本体 commandGate.mjs 为权威源，纵深防御独立副本；
 *     0715 重分级：系统设置类 shutdown/reg/netsh 等已降档到本体灰名单审批，不在本副本）
 *   - normalizeGitInvocations：折叠 git -C/-c 等全局选项，堵绕过黑名单的向量
 *   - 持久会话串行锁：防并发 sentinel 交错
 *   - 持久会话输出上限（用户可调，缺省 10MB，params.output_limit_mb 由后端按安全设置注入，钳 1-100）：防 O(n²) concat 撑爆内存
 *
 * 相交：
 *   ← ToolExecutor.ts（注册 run_command/run_script handler）
 *   → tool-infra.ts（COMMAND_BLACKLIST, normalizeGitInvocations, resolveWorkspacePath, getWorkspaceRoot, truncateOutput）
 *   → constants.ts（COMMAND_DEFAULT_TIMEOUT_MS, TASKKILL_TIMEOUT_MS, 截断阈值）
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  COMMAND_BLACKLIST, normalizeGitInvocations,
  resolveWorkspacePath, getWorkspaceRoot, truncateOutput,
  wbT, wbD, // [窗口id 0726] 会话池白盒线路（与 代码cli wb.mjs 孪生，console 桥→ConsoleCapture→本体 monitor）
} from "../tool-infra";
import {
  COMMAND_DEFAULT_TIMEOUT_MS, TASKKILL_TIMEOUT_MS,
  STDOUT_TRUNCATE_THRESHOLD, STDOUT_HEAD_KEEP, STDOUT_TAIL_KEEP,
  STDERR_TRUNCATE_THRESHOLD, STDERR_HEAD_KEEP,
} from "../../constants";
import {
  startCommandWatchdog,
  type CommandWatchdogProgress,
} from "./process-telemetry";

type CommandRuntimeContext = {
  runtimePolicy?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (progress: CommandWatchdogProgress) => void;
};

// ═══════════════════════════════════════════════════════════════
// 持久 shell 会话池（2026-07-26 shell 优化·多线指令池，与 代码cli/tools/command-tools.mjs 孪生同改）
// 原模块级单例 + busy 锁：多条对话线绑定同一窗口并发 session 命令时第二条被拒「正忙」。
// 改按会话键的池：key = 会话键（[窗口id 0726] 派生见 runCommand session 分支：显式 session_key →
// 指令信封窗口 id(_window_id) → 默认单会话），每条线各自长驻 shell 互不排挤；无键 = "__default__"。
// 资源防护：容量上限（满时逐出最久未用的空闲会话，busy 的不杀）+ 闲置 TTL 回收。
// 白盒线路：session:route/create/busy/evict/poolFull/reap/outputLimit/spawnFail（tool-infra wbT/wbD）。
// ═══════════════════════════════════════════════════════════════

const SESSION_KEY_DEFAULT = "__default__";
const SESSION_POOL_MAX = 8;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

interface ShellSessionEntry {
  proc: cp.ChildProcess | null;
  cwd: string;
  busy: boolean;
  lastUsedAt: number;
}

const _shellSessions = new Map<string, ShellSessionEntry>();
let _sessionReaper: ReturnType<typeof setInterval> | null = null;

function _killProc(proc: cp.ChildProcess | null): void {
  if (!proc || proc.exitCode !== null) return;
  const isWin = process.platform === "win32";
  if (isWin && proc.pid) {
    cp.exec(`taskkill /PID ${proc.pid} /T /F`, { timeout: TASKKILL_TIMEOUT_MS }, () => {});
  } else {
    try { proc.kill("SIGKILL"); } catch {}
  }
}

/** 等待进程树终止动作完成；不能把“已发 kill”伪报成“已终止”。 */
function killProcAndWait(proc: cp.ChildProcess | null): Promise<{
  attempted: boolean;
  stopped: boolean;
  error: string | null;
}> {
  if (!proc || proc.exitCode !== null) {
    return Promise.resolve({ attempted: false, stopped: true, error: null });
  }
  if (process.platform === "win32" && proc.pid) {
    return new Promise((resolve) => {
      cp.execFile(
        "taskkill.exe",
        ["/PID", String(proc.pid), "/T", "/F"],
        { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true },
        (error) => resolve({
          attempted: true,
          stopped: !error,
          error: error ? String(error.message || error) : null,
        }),
      );
    });
  }
  try {
    proc.kill("SIGKILL");
    return Promise.resolve({ attempted: true, stopped: true, error: null });
  } catch (error) {
    return Promise.resolve({
      attempted: true,
      stopped: false,
      error: String(error instanceof Error ? error.message : error),
    });
  }
}

/** 从会话池摘除指定进程并等待整棵进程树终止，避免“已发 kill”被误报为“已停止”。 */
async function removeAndKillShellSession(
  key: string,
  proc: cp.ChildProcess | null,
): Promise<{ attempted: boolean; stopped: boolean; error: string | null }> {
  const entry = _shellSessions.get(key);
  if (entry?.proc === proc) _shellSessions.delete(key);
  if (_shellSessions.size === 0 && _sessionReaper) {
    clearInterval(_sessionReaper);
    _sessionReaper = null;
  }
  return killProcAndWait(proc);
}

/** 销毁长驻 shell 会话：带 key 只销毁该会话；不带 key 销毁全池（插件 dispose / 切 workspace 调用方语义不变） */
export function disposeShellSession(key?: string): void {
  if (typeof key === "string" && key) {
    const entry = _shellSessions.get(key);
    _shellSessions.delete(key);
    if (entry) { entry.busy = false; _killProc(entry.proc); entry.proc = null; }
  } else {
    for (const entry of _shellSessions.values()) { entry.busy = false; _killProc(entry.proc); entry.proc = null; }
    _shellSessions.clear();
  }
  if (_shellSessions.size === 0 && _sessionReaper) { clearInterval(_sessionReaper); _sessionReaper = null; }
}

/** 闲置回收表：超 TTL 未用的空闲会话销毁；池空即停表（unref 不阻扩展宿主退出） */
function _ensureSessionReaper(): void {
  if (_sessionReaper) return;
  _sessionReaper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of [..._shellSessions]) {
      if (!entry.busy && now - entry.lastUsedAt > SESSION_IDLE_TTL_MS) { wbT("cmd", "session:reap", { key, idleMin: Math.round((now - entry.lastUsedAt) / 60000) }); disposeShellSession(key); }
    }
    if (_shellSessions.size === 0 && _sessionReaper) { clearInterval(_sessionReaper); _sessionReaper = null; }
  }, 60 * 1000);
  (_sessionReaper as unknown as { unref?: () => void }).unref?.();
}

/** GBK 解码：先试 utf8，有替换字符则改用 GBK（Windows cmd 内置命令输出 GBK） */
function decodeBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) { return ""; }
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\ufffd")) { return utf8; }
  try { return new TextDecoder("gbk").decode(buf); } catch { return utf8; }
}

/** 执行终端命令 */
export async function runCommand(
  params: Record<string, unknown>,
  context: CommandRuntimeContext = {},
): Promise<unknown> {
  const command = params.command as string;
  if (!command) throw new Error("缺少 command 参数");

  const _normCommand = normalizeGitInvocations(command);
  const blocked = COMMAND_BLACKLIST.find(re => re.test(command) || re.test(_normCommand));
  if (blocked) {
    return { success: false, error: `🛡️ YonBan 安全拦截: 命令匹配黑名单规则 ${blocked.source}`, blocked: true };
  }

  const cwd = (params.cwd as string)
    ? resolveWorkspacePath(params.cwd as string)
    : getWorkspaceRoot();

  const timeout = (params.timeout as number) || COMMAND_DEFAULT_TIMEOUT_MS;

  if (params.session === true) {
    // [窗口id 0726] 会话键派生（与 代码cli/tools/command-tools.mjs 孪生）：显式 session_key 优先（覆盖口）→
    // 池入口识别的窗口/线 id（ToolExecutor 落 params._window_id，源头=指令信封 chatid）→ 无 id 默认单会话。
    // __noChat_ 合成键（无 chat 回合每轮唯一）不作会话键——每轮新开 shell 会丢会话态。
    // output_limit_mb：后端 replyHandler 按用户安全设置注入（覆盖 AI 自带值）；此处只消费+钳制兜底
    const _widRaw = params._window_id;
    const _sessKey = (typeof params.session_key === "string" && params.session_key)
      ? params.session_key
      : ((typeof _widRaw === "string" && _widRaw && !_widRaw.startsWith("__noChat_")) ? _widRaw : "");
    // 白盒：窗口id链路执行端落点——本条 session 命令路由到哪条会话线、键来自哪个源
    wbT("cmd", "session:route", { key: _sessKey || SESSION_KEY_DEFAULT, src: params.session_key ? "explicit" : (_sessKey ? "window" : "default") });
    return _runInSession(command, cwd, timeout, _sessKey, params.output_limit_mb, context);
  }

  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const actualCommand = isWin
      ? `chcp 65001 >nul 2>&1 & ${command}`
      : command;

    let outputBytes = 0;
    let stdoutPreviewBytes = 0;
    let stderrPreviewBytes = 0;
    const stdoutPreview: Buffer[] = [];
    const stderrPreview: Buffer[] = [];
    let watchdog: { stop(): void } | null = null;
    let abortListener: (() => void) | null = null;
    let child: cp.ChildProcess | null = null;

    const capturePreview = (
      chunks: Buffer[],
      chunk: Buffer | string,
      currentBytes: number,
    ): number => {
      const limit = 64 * 1024;
      if (currentBytes >= limit) return currentBytes;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const keep = buf.subarray(0, Math.max(0, limit - currentBytes));
      if (keep.length) chunks.push(keep);
      return currentBytes + keep.length;
    };
    const onStdoutActivity = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      stdoutPreviewBytes = capturePreview(stdoutPreview, chunk, stdoutPreviewBytes);
    };
    const onStderrActivity = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      stderrPreviewBytes = capturePreview(stderrPreview, chunk, stderrPreviewBytes);
    };
    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      watchdog?.stop();
      watchdog = null;
      child?.stdout?.off("data", onStdoutActivity);
      child?.stderr?.off("data", onStderrActivity);
      if (abortListener && context.signal) context.signal.removeEventListener("abort", abortListener);
      abortListener = null;
    };
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = async (
      kind: "stalled" | "aborted" | "timeout",
      telemetry: CommandWatchdogProgress | null = null,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      const kill = await killProcAndWait(child);
      const stdout = decodeBuffer(Buffer.concat(stdoutPreview));
      const stderr = decodeBuffer(Buffer.concat(stderrPreview));
      if (kind === "stalled") {
        resolve({
          success: false,
          command,
          exitCode: -1,
          stdout,
          stderr,
          error: "command_stalled",
          errorCode: "command_stalled",
          stalled: true,
          stall: telemetry,
          processTermination: kill,
        });
        return;
      }
      if (kind === "aborted") {
        resolve({
          success: false,
          command,
          exitCode: -1,
          stdout,
          stderr,
          error: "command_aborted",
          errorCode: "command_aborted",
          aborted: true,
          processTermination: kill,
        });
        return;
      }
      resolve({
        success: false,
        command,
        exitCode: -1,
        stdout,
        stderr,
        error: `Command timed out after ${timeout}ms`,
        errorCode: "command_timeout",
        timedOut: true,
        processTermination: kill,
      });
    };

    child = cp.exec(
      actualCommand,
      {
        cwd,
        timeout: 0,
        maxBuffer: 1024 * 1024,
        shell: isWin ? "cmd.exe" : "/bin/sh",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        encoding: "buffer" as BufferEncoding,
      },
      (error, stdoutRaw, stderrRaw) => {
        if (settled) { return; }
        const stdoutStr = decodeBuffer(stdoutRaw as unknown as Buffer);
        const stderrStr = decodeBuffer(stderrRaw as unknown as Buffer);
        const _errCode = (error as { code?: unknown } | null)?.code;
        const _isMaxBuffer = !!error &&
          (_errCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(error.message || ""));
        const exitCode = error && !_isMaxBuffer ? (error.code ?? 1) : 0;
        const commandSuccess = !error && exitCode === 0;
        let warning = "";
        if (exitCode === 0 && stderrStr.length > 0) {
          const lower = stderrStr.toLowerCase();
          if (lower.includes("error") || lower.includes("failed") || lower.includes("not found") || lower.includes("permission denied")) {
            warning = "exitCode=0但stderr含错误信息，命令可能未完全成功";
          }
        }
        let finalStdout = stdoutStr;
        const stdoutTruncated = stdoutStr.length > STDOUT_TRUNCATE_THRESHOLD;
        if (stdoutTruncated) {
          const head = stdoutStr.substring(0, STDOUT_HEAD_KEEP);
          const tail = stdoutStr.substring(stdoutStr.length - STDOUT_TAIL_KEEP);
          const totalLines = stdoutStr.split("\n").length;
          const headLines = head.split("\n").length;
          const tailLines = tail.split("\n").length;
          const skipped = totalLines - headLines - tailLines;
          finalStdout = head + `\n\n... (省略${skipped}行，共${totalLines}行) ...\n\n` + tail;
        }
        const stderrTruncated = stderrStr.length > STDERR_TRUNCATE_THRESHOLD;
        finish({
          success: commandSuccess,
          command,
          exitCode,
          stdout: finalStdout,
          stderr: stderrTruncated ? stderrStr.substring(0, STDERR_HEAD_KEEP) + "\n...(stderr已截断)" : stderrStr,
          ...(!commandSuccess ? {
            error: _isMaxBuffer
              ? "Command output exceeded the 1MB execution buffer"
              : `Command exited with code ${exitCode}`,
            errorCode: _isMaxBuffer ? "command_output_limit" : "command_exit_nonzero",
          } : {}),
          ...(stdoutTruncated || stderrTruncated || _isMaxBuffer ? {
            truncated: true,
            stdoutBytes: stdoutStr.length,
            stderrBytes: stderrStr.length,
            ...(_isMaxBuffer ? { maxBufferExceeded: true } : {}),
            truncatedHint: _isMaxBuffer
              ? "输出超过缓冲上限(1MB)，执行被中止且结果不完整。如需完整内容，把命令输出重定向到文件后 read_file 分段读取。"
              : "输出已截断（>5000字符保留头尾）。如需完整内容，把命令输出重定向到文件后 read_file 分段读取。",
          } : {}),
          ...(warning ? { warning } : {}),
        });
      },
    );

    child.stdout?.on("data", onStdoutActivity);
    child.stderr?.on("data", onStderrActivity);

    if (child.pid) {
      watchdog = startCommandWatchdog({
        rootPid: child.pid,
        runtimePolicy: context.runtimePolicy,
        readOutputBytes: () => outputBytes,
        onProgress: context.onProgress,
        onStall: (progress) => {
          if (progress.watchdogAction === "terminate") void terminate("stalled", progress);
        },
      });
    }

    if (context.signal) {
      abortListener = () => { void terminate("aborted"); };
      context.signal.addEventListener("abort", abortListener, { once: true });
      if (context.signal.aborted) {
        abortListener();
        return;
      }
    }

    if (timeout > 0 && child.pid) {
      killTimer = setTimeout(() => { void terminate("timeout"); }, timeout);
    }
  });
}

/**
 * run_script：把脚本源码落成系统临时文件，用对应解释器执行，跑完删除临时文件。
 * 彻底绕开 run_command 在 cmd.exe 下的「内联引号地狱」。
 */
export async function runScript(
  params: Record<string, unknown>,
  context: CommandRuntimeContext = {},
): Promise<unknown> {
  const lang = params.lang as string;
  const code = params.code as string;
  if (!lang) throw new Error("缺少 lang 参数（python|node|powershell|bash）");
  if (typeof code !== "string" || code.length === 0) throw new Error("缺少 code 参数（脚本源码字符串）");

  const SCRIPT_SPEC: Record<string, { ext: string; cmd: (file: string) => string }> = {
    python:     { ext: ".py",  cmd: (f) => `python "${f}"` },
    node:       { ext: ".js",  cmd: (f) => `node "${f}"` },
    powershell: { ext: ".ps1", cmd: (f) => `powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"` },
    bash:       { ext: ".sh",  cmd: (f) => `bash "${f}"` },
  };

  const spec = SCRIPT_SPEC[lang];
  if (!spec) throw new Error(`不支持的 lang: "${lang}"（仅 python|node|powershell|bash）`);

  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const scriptFile = path.join(os.tmpdir(), `yonban_script_${rand}${spec.ext}`);

  try {
    fs.writeFileSync(scriptFile, code, { encoding: "utf-8" });
  } catch (e) {
    return { success: false, lang, error: `写入临时脚本失败: ${e instanceof Error ? e.message : String(e)}`, scriptFile };
  }

  try {
    const runParams: Record<string, unknown> = { command: spec.cmd(scriptFile) };
    if (params.cwd !== undefined) runParams.cwd = params.cwd;
    if (params.timeout !== undefined) runParams.timeout = params.timeout;
    const result = await runCommand(runParams, context);
    if (result && typeof result === "object") {
      return { ...(result as Record<string, unknown>), lang, scriptFile };
    }
    return result;
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

/**
 * 持久会话执行（池版）：按会话键复用各自长驻 shell 进程，跨多次 run_command 保持 cwd/env/shell 状态。
 * 命令完成判定用 sentinel 标记。busy 锁降为 per-key（同线串行、跨线并行）。
 * @param sessionKey 会话键（后端按 chatid 注入）；空=SESSION_KEY_DEFAULT
 */
function _runInSession(
  command: string,
  cwd: string,
  timeout: number,
  sessionKey: string,
  outputLimitMb?: unknown,
  context: CommandRuntimeContext = {},
): Promise<unknown> {
  const isWin = process.platform === "win32";
  // key = 会话键（=窗口/线 id，见 runCommand session 分支派生）：本函数内白盒埋点全部带它，
  // 执行端日志才能按线归属（多窗口下不带 key 的日志分不清是哪条线，0726 与 CLI 侧孪生）。
  const key = sessionKey || SESSION_KEY_DEFAULT;
  // [0726 会话输出上限可调] 单源=用户 command_config.json（replyHandler 注入）；无注入（分身/外部
  // 直调）→ 缺省 10MB；执行端钳 1-100 兜底（防任何路径传离谱值）。超限销毁本会话（熔断语义）。
  const _outMb = Math.min(Math.max(Number(outputLimitMb) || 10, 1), 100);
  const _outLimitBytes = _outMb * 1024 * 1024;

  let entry = _shellSessions.get(key);
  if (entry && entry.busy) {
    wbD("cmd", "session:busy", false, "本线上一条 session 命令未结束", { key });
    return Promise.resolve({ command, success: false, error: "持久会话正忙（本会话线上一条 session 命令未结束），请串行调用", busy: true, sessionKey: key });
  }

  // 容量上限：新键且池满 → 逐出最久未用的空闲会话；全在忙 → 拒绝（绝不杀在跑命令的 shell）
  if (!entry && _shellSessions.size >= SESSION_POOL_MAX) {
    let _oldestKey: string | null = null;
    let _oldestAt = Infinity;
    for (const [k, e] of _shellSessions) {
      if (!e.busy && e.lastUsedAt < _oldestAt) { _oldestAt = e.lastUsedAt; _oldestKey = k; }
    }
    if (_oldestKey != null) { wbT("cmd", "session:evict", { evicted: _oldestKey, for: key, pool: _shellSessions.size }); disposeShellSession(_oldestKey); }
    else { wbD("cmd", "session:poolFull", false, `${SESSION_POOL_MAX} 条全在执行中`, { for: key }); return Promise.resolve({ command, success: false, error: `持久会话池已满（${SESSION_POOL_MAX} 条全在执行中），请稍后重试或改用非 session 执行`, busy: true }); }
  }

  const PROMPT_TOKEN = "__YBP__";

  if (!entry || !entry.proc || entry.proc.exitCode !== null) {
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/Q", "/K", `prompt ${PROMPT_TOKEN}& chcp 65001>nul`] : [];
    let _proc: cp.ChildProcess;
    try {
      _proc = cp.spawn(shell, args, {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
    } catch (e) {
      _shellSessions.delete(key);
      wbD("cmd", "session:spawnFail", false, (e as Error).message, { key });
      return Promise.resolve({ command, success: false, error: `无法启动持久 shell: ${(e as Error).message}` });
    }
    entry = { proc: _proc, cwd, busy: false, lastUsedAt: Date.now() };
    _shellSessions.set(key, entry);
    wbT("cmd", "session:create", { key, pool: _shellSessions.size });
    // exit/error：仅当池里该键仍指向本进程才摘除（防新会话被旧进程尾事件误删）
    _proc.on("exit", () => { if (_shellSessions.get(key)?.proc === _proc) _shellSessions.delete(key); });
    _proc.on("error", () => { if (_shellSessions.get(key)?.proc === _proc) _shellSessions.delete(key); });
    _ensureSessionReaper();
  }

  const proc = entry.proc;
  if (!proc || !proc.stdin || !proc.stdout) {
    disposeShellSession(key);
    return Promise.resolve({
      command,
      success: false,
      error: "持久 shell 缺少 stdin/stdout",
      errorCode: "command_session_stream_unavailable",
      session: true,
      sessionKey: key,
    });
  }
  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const _entry = entry;

  const uuid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const sentinel = `__YBSESS_${uuid}__`;
  const re = new RegExp(`${sentinel} EXIT=(-?\\d+) CWD=([^\\r\\n]*)`);
  const marker = isWin
    ? `echo ${sentinel} EXIT=%errorlevel% CWD=%cd%`
    : `echo "${sentinel} EXIT=$? CWD=$PWD"`;

  _entry.busy = true;
  _entry.lastUsedAt = Date.now();

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: { stop(): void } | null = null;
    let abortListener: (() => void) | null = null;
    let outputBytes = 0;

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      watchdog?.stop();
      watchdog = null;
      stdout.off("data", onData);
      proc.stderr?.off("data", onErr);
      if (abortListener && context.signal) context.signal.removeEventListener("abort", abortListener);
      abortListener = null;
      const _cur = _shellSessions.get(key);
      if (_cur && _cur.proc === proc) { _cur.busy = false; _cur.lastUsedAt = Date.now(); }
    };

    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const terminateAndFinish = async (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      const processTermination = await removeAndKillShellSession(key, proc);
      resolve({ ...result, processTermination });
    };

    let totalBytes = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      outputBytes += chunk.length;
      if (totalBytes > _outLimitBytes) {
        wbD("cmd", "session:outputLimit", false, `超 ${_outMb}MB 熔断销毁`, { key });
        void terminateAndFinish({
          command,
          success: false,
          exitCode: -1,
          stdout: truncateOutput(decodeBuffer(Buffer.concat(chunks))),
          stderr: "",
          error: `Session output exceeded ${_outMb}MB（本会话已销毁；上限可在安全设置面板调整，或把输出重定向到文件后 read_file 分段读）`,
          errorCode: "command_output_limit",
          session: true,
          sessionKey: key,
        });
        return;
      }
      const text = decodeBuffer(Buffer.concat(chunks));
      const m = text.match(re);
      if (!m) return;
      const exitCode = parseInt(m[1], 10);
      const newCwd = (m[2] || "").trim();
      if (newCwd) _entry.cwd = newCwd;
      let out = text.substring(0, m.index as number);
      out = out.split(PROMPT_TOKEN).join("");
      out = out.replace(/^\s*Active code page:.*$/gm, "");
      out = out.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const outTruncated = out.length > STDOUT_TRUNCATE_THRESHOLD;
      const commandSuccess = exitCode === 0;
      finish({
        success: commandSuccess,
        command,
        exitCode,
        stdout: truncateOutput(out),
        stderr: "",
        ...(!commandSuccess ? {
          error: `Command exited with code ${exitCode}`,
          errorCode: "command_exit_nonzero",
        } : {}),
        session: true,
        sessionKey: key,
        cwd: _entry.cwd,
        ...(outTruncated ? {
          truncated: true,
          stdoutBytes: out.length,
          truncatedHint: "会话输出已截断（>5000字符保留头尾）。如需完整内容，把命令输出重定向到文件后 read_file 分段读取。",
        } : {}),
      });
    };

    const onErr = (chunk: Buffer) => {
      chunks.push(chunk);
      outputBytes += chunk.length;
    };

    stdout.on("data", onData);
    proc.stderr?.on("data", onErr);

    if (proc.pid) {
      watchdog = startCommandWatchdog({
        rootPid: proc.pid,
        runtimePolicy: context.runtimePolicy,
        readOutputBytes: () => outputBytes,
        onProgress: context.onProgress,
        onStall: (progress) => {
          if (progress.watchdogAction !== "terminate" || settled) return;
          void terminateAndFinish({
            success: false,
            command,
            exitCode: -1,
            stdout: truncateOutput(decodeBuffer(Buffer.concat(chunks))),
            stderr: "",
            error: "command_stalled",
            errorCode: "command_stalled",
            stalled: true,
            stall: progress,
            session: true,
            sessionKey: key,
          });
        },
      });
    }

    if (context.signal) {
      abortListener = () => {
        if (settled) return;
        void terminateAndFinish({
          success: false,
          command,
          exitCode: -1,
          stdout: truncateOutput(decodeBuffer(Buffer.concat(chunks))),
          stderr: "",
          error: "command_aborted",
          errorCode: "command_aborted",
          aborted: true,
          session: true,
          sessionKey: key,
        });
      };
      context.signal.addEventListener("abort", abortListener, { once: true });
      if (context.signal.aborted) {
        abortListener();
        return;
      }
    }

    if (timeout > 0) {
      killTimer = setTimeout(() => {
        if (settled) return;
        void terminateAndFinish({
          command,
          success: false,
          exitCode: -1,
          stdout: truncateOutput(decodeBuffer(Buffer.concat(chunks))),
          stderr: "",
          error: `Session command timed out after ${timeout}ms（本会话已销毁）`,
          errorCode: "command_timeout",
          timedOut: true,
          session: true,
          sessionKey: key,
        });
      }, timeout);
    }

    try {
      stdin.write(command + "\r\n" + marker + "\r\n");
    } catch (e) {
      void terminateAndFinish({
        command,
        success: false,
        exitCode: -1,
        stdout: truncateOutput(decodeBuffer(Buffer.concat(chunks))),
        stderr: "",
        error: `持久 shell 写入失败: ${e instanceof Error ? e.message : String(e)}（本会话已销毁）`,
        errorCode: "command_session_write_failed",
        session: true,
        sessionKey: key,
      });
    }
  });
}
