/**
 * [beilu-cli] — CLI 工具后端插件（无头 YonBan 的本体侧宿主）。
 * 管理 CLI server 子进程生命周期：本体启动时按 config.autoStart spawn，退出时 kill。
 *
 * 定位（凛倾 2026-07-22 拍板）：CLI 只是工具插件——对话/API/生成/安全裁决全在本体，
 * 本插件只做：①子进程生命周期 ②运行配置单源（data/beilu-cli-config.json）③状态查询。
 * 设置与管理层全部走本体前端编辑（后端管理面板 conn-cli-settings 区经 config/getdata|setdata）。
 *
 * 链路：Load → config.autoStart 判定 → spawn node server.mjs --port <config> --settings <beilu-files-settings.json>
 *   → CLI server listening 后写发现文件（数组注册表/per-port token/port:token）+ stdout「WS 服务器已启动」
 *   → 本插件捕获该行主动踢 ideClient.connect（不等重连退避）→ 42 工具可用
 *   Load 另做：setDefaultPart 永久注册（plugin-host:175 范式）+ 注册 config REST 端点（beilu-files:2648 范式）
 *   Unload → kill 子进程
 *
 * ★ spawn 必须在 Load 不能在 Init：parts_loader 的 Init 由磁盘 parts_init 门控=跨进程 install-once
 *   （loadPartBase:883，装完落 true 后每次重启永久跳过）；Load 才是每次启动都跑的钩子
 *   （server.mjs:384 fullLoadAllParts 启动即全量完整加载）。旧版 spawn 放 Init → 首装那次能起、
 *   之后每次重启 CLI 都不拉起（凛倾 2026-07-22「本体打开的同时必须拉起cli」断点根因）。
 *
 * 影响：spawn node 子进程；写 data/beilu-cli-config.json；子进程写 ~/.beilu 发现文件
 * 相交：→ ideClient.mjs（WS 客户端按发现协议连 CLI server）
 *       → ideConnPanel.mjs（前端 CLI 卡片/设置面板，经 sendAction 门面走本端点）
 *       → beilu-files（工作区根 canonical 单源：spawn 传 settings 路径，CLI 进程 fs.watch 热跟随）
 */
import info from "./info.json" with { type: "json" };
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFile, spawn } from "node:child_process";
import { on_shutdown } from "npm:on-shutdown";

import { createDiag } from "../../../../server/diagLogger.mjs";
import { setDefaultPart } from "../../../../server/parts_loader.mjs";
import { authenticate } from "../../../../yonban/core/functions/security/auth.mjs";
import { ideClient, resolveIdeMode } from "../../../../yonban/core/transport/ideClient.mjs";

const diag = createDiag("cli");

let _cliProcess = null;
let _cliOwner = null;
let _cliGeneration = 0;
let _workspace = "";
let _startedAt = null;
let _lifecycleState = "stopped";
let _lastLifecycleError = null;
let _lifecycleQueue = Promise.resolve();
let _unloading = false;
let _restartTicket = null;
let _recoveryTicket = null;
let _recoveryAttempt = 0;
let _recoveryLastError = null;
let _recoveryNextAt = null;
// [0723] CLI 容错(002拍板A方向:exit自动重启+崩溃熔断):
//   _manualStop 区分手动 stop(不重启)与异常退出(自动重启);
//   _crashTimes 滑动窗口熔断——60s 内异常退出 >3 次=反复崩溃(如端口被占/依赖损坏),停止自动重启防 crash loop,
//   留日志给前端 CLI 区诊断面,用户修因后可手动 restart(action 口不受熔断影响,且会清窗口)。
let _manualStop = false;
let _crashTimes = [];
const CRASH_WINDOW_MS = 60000;
const CRASH_MAX = 3;
const PROCESS_STOP_TIMEOUT_MS = 10000;
const PROCESS_HEALTH_TIMEOUT_MS = 15000;
const AUTO_RESTART_DELAY_MS = 1000;
const RECOVERY_BACKOFF_MIN_MS = 1000;
const RECOVERY_BACKOFF_MAX_MS = 15000;

// ── CLI↔YonBan 运行策略 ──
// 默认并存：ideClient 同时连接 CLI 与全部 YonBan，并由会话绑定决定实际执行端。
// 可选互斥：用户关闭 coexistWithYonban 后，本插件才负责让 CLI 进程向 YonBan 让位。
// 三态而非两态：_manualStop（用户手动停，互斥不得替他恢复）/ _mutexParked（互斥让位停，YonBan 全下线
//   后自动恢复）/ _userOverride（YonBan 在线时用户仍手动 start/restart = 显式要 CLI，互斥不得再停它，
//   否则用户点了启动、15 秒后被无声杀掉）。用户意志 > 互斥。
// 裁决规则不在本文件实现：读 ideClient.partitionActiveIdeInstances（与连接目标集同一份分区），
//   避免「谁算 YonBan」两处各写一遍。
let _mutexParked = false;
let _userOverride = false;
let _mutexTimer = null;
// 与 ideClient RESCAN_INTERVAL(15s) 同节拍：两边看同一张注册表，节拍一致才不会出现
// 「本体已剪掉 CLI 连接但进程还在跑」的长窗口（差一拍最多晚一拍，不会永久错位）。
const MUTEX_INTERVAL = 15000;

/** 让位判定：注册表里存活 YonBan 的个数（>0 = CLI 该离线）。读不到注册表返回 0=不敢停
 *  （宁可多跑一个进程，也不能把纯本体场景下的唯一执行端误停——那会让 AI 直接失去所有工具）。
 *  返回个数而不是布尔：调用方要把个数写进日志，返回布尔会逼它二次读注册表，
 *  两次读之间实例可能已变（日志里出现"0 个 YonBan 在线所以停了 CLI"这种自相矛盾的话）。 */
function _liveYonBanCount() {
  try {
    // 走分类器单点：CLI 该不该让位，与"当前是哪套 IDE 系统"是同一个判断，不另写一份
    const _ide = resolveIdeMode();
    return Array.isArray(_ide.yonbans) ? _ide.yonbans.length : 0;
  } catch (e) {
    diag.warn("互斥判定读注册表失败（保守不停 CLI）", { error: e.message });
    return 0;
  }
}

function _serializeLifecycle(operation) {
  const run = _lifecycleQueue.then(operation, operation);
  _lifecycleQueue = run.catch(() => {});
  return run;
}

function _isCurrentOwner(owner) {
  return !!owner && _cliOwner === owner && _cliProcess === owner.child;
}

function _cancelRestartTimer() {
  if (!_restartTicket) return;
  clearTimeout(_restartTicket.timer);
  _restartTicket = null;
}

function _cancelRecoveryTimer({ reset = false } = {}) {
  if (_recoveryTicket) {
    clearTimeout(_recoveryTicket.timer);
    _recoveryTicket = null;
  }
  _recoveryNextAt = null;
  if (reset) {
    _recoveryAttempt = 0;
    _recoveryLastError = null;
  }
}

function _clearOwnerHealthWatch(owner) {
  if (owner?.healthPollTimer) {
    clearInterval(owner.healthPollTimer);
    owner.healthPollTimer = null;
  }
}

function _settleOwnerHealth(owner, healthy, detail = null) {
  if (!owner || owner.healthSettled) return;
  owner.healthSettled = true;
  _clearOwnerHealthWatch(owner);
  if (healthy) owner.resolveHealth(detail || true);
  else owner.rejectHealth(detail instanceof Error ? detail : new Error(String(detail || "cli_not_healthy")));
}

function _createProcessOwner(child, config, intent) {
  let resolveClose;
  let resolveHealth;
  let rejectHealth;
  return {
    child,
    config,
    intent,
    generation: ++_cliGeneration,
    expectedStopReason: null,
    exitCode: null,
    exitSignal: null,
    error: null,
    closed: false,
    healthy: false,
    listeningSeen: false,
    healthSettled: false,
    healthPollTimer: null,
    shutdownSent: false,
    stdinError: null,
    stdoutTail: "",
    closePromise: new Promise((resolve) => { resolveClose = resolve; }),
    healthPromise: new Promise((resolve, reject) => {
      resolveHealth = resolve;
      rejectHealth = reject;
    }),
    resolveClose,
    resolveHealth,
    rejectHealth,
  };
}

function _readRegistryEntryForPid(pid) {
  if (!pid) return null;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".beilu", "ide_active_ports.json"), "utf-8"));
    if (!Array.isArray(registry)) return null;
    return registry.find((entry) => entry && entry.pid === pid) || null;
  } catch {
    return null;
  }
}

function _isOwnerConnected(owner) {
  if (!_isCurrentOwner(owner) || !owner.listeningSeen) return false;
  const registryEntry = _readRegistryEntryForPid(owner.child.pid);
  const port = Number(registryEntry?.port);
  if (!Number.isInteger(port)) return false;
  const conn = ideClient?._conns?.get?.(port);
  return !!(conn && conn.connected && conn.ws?.readyState === 1);
}

function _watchOwnerHealth(owner) {
  if (!_isCurrentOwner(owner) || owner.healthSettled || owner.healthPollTimer) return;
  const check = () => {
    if (!_isCurrentOwner(owner)) {
      _settleOwnerHealth(owner, false, "cli_owner_replaced");
      return;
    }
    if (!_isOwnerConnected(owner)) return;
    owner.healthy = true;
    _lifecycleState = "running";
    _lastLifecycleError = null;
    _settleOwnerHealth(owner, true, { generation: owner.generation });
  };
  check();
  if (!owner.healthSettled) {
    owner.healthPollTimer = setInterval(check, 50);
    owner.healthPollTimer.unref?.();
  }
}

function _waitWithTimeout(promise, timeoutMs, errorCode) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function _finalizeOwnerClose(owner, code, signal) {
  if (!owner || owner.closed) return;
  owner.closed = true;
  owner.exitCode = code;
  owner.exitSignal = signal;
  _clearOwnerHealthWatch(owner);
  _settleOwnerHealth(owner, false, owner.error || "cli_closed_before_healthy");
  owner.resolveClose({ code, signal });

  // 旧 child 的迟到 close 只完成它自己的 promise，不能触碰新 owner、全局状态或重启调度。
  if (!_isCurrentOwner(owner)) return;

  _cliOwner = null;
  _cliProcess = null;
  _startedAt = null;

  if (owner.expectedStopReason) {
    if (owner.expectedStopReason === "mutex-park") _lifecycleState = "parked";
    else if (owner.expectedStopReason === "spawn-error") _lifecycleState = "spawn_error";
    else if (owner.expectedStopReason === "startup-failed") _lifecycleState = "health_timeout";
    else _lifecycleState = "stopped";
    return;
  }

  _lifecycleState = "crashed";
  _lastLifecycleError = owner.error?.message || `cli_exit_${code ?? "unknown"}`;
  if (_manualStop || _mutexParked || owner.config.autoRestart === false || _unloading) return;

  const now = Date.now();
  _crashTimes = _crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
  _crashTimes.push(now);
  if (_crashTimes.length > CRASH_MAX) {
    _lifecycleState = "circuit_open";
    diag.warn("CLI 崩溃熔断", { window: "60s", count: _crashTimes.length });
    _pushCliLog("warn", `CLI 60秒内异常退出 ${_crashTimes.length} 次，已熔断停止自动重启。请检查端口占用/依赖后手动重启。`);
    return;
  }

  _scheduleAutoRestart(owner, code);
}

function _scheduleAutoRestart(owner, code) {
  _cancelRestartTimer();
  const ticket = {
    ownerGeneration: owner.generation,
    dueAt: Date.now() + AUTO_RESTART_DELAY_MS,
    timer: null,
  };
  _lifecycleState = "restart_wait";
  diag.log("CLI 异常退出，自动重启", { code, attempt: _crashTimes.length, generation: owner.generation });
  _pushCliLog("warn", `CLI 异常退出(code=${code})，1秒后自动重启（第 ${_crashTimes.length} 次）`);
  ticket.timer = setTimeout(() => {
    if (_restartTicket !== ticket) return;
    _restartTicket = null;
    void _serializeLifecycle(async () => {
      if (_cliProcess || _manualStop || _unloading) return;
      const latestConfig = await loadConfig();
      if (latestConfig.autoRestart === false) {
        _lifecycleState = "crashed";
        return;
      }
      if (latestConfig.coexistWithYonban === false && !_userOverride && _liveYonBanCount() > 0) {
        _mutexParked = true;
        _lifecycleState = "parked";
        diag.log("CLI 异常退出但 YonBan 在线，转让位态不重启");
        _pushCliLog("log", "CLI 异常退出，但检测到 YonBan 在线 → 转让位态（互斥）；YonBan 全部关闭后自动拉起。");
        return;
      }
      const result = await startCli({ intent: "auto-restart" });
      if (result?.error) {
        _lastLifecycleError = result.error;
        diag.warn("自动重启失败", { error: result.error });
      }
    });
  }, AUTO_RESTART_DELAY_MS);
  ticket.timer.unref?.();
  _restartTicket = ticket;
}

async function _stopOwner(owner, reason, timeoutMs = PROCESS_STOP_TIMEOUT_MS) {
  if (!owner || owner.closed) return { stopped: true, already: true };
  owner.expectedStopReason = reason;
  _clearOwnerHealthWatch(owner);
  if (!owner.shutdownSent) {
    owner.shutdownSent = true;
    const stdin = owner.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) {
      stdin.once("error", (error) => { owner.stdinError = error; });
      try { stdin.end("shutdown\n"); }
      catch (error) { owner.stdinError = error; }
    } else {
      owner.stdinError = new Error("cli_shutdown_stdin_unavailable");
    }
  }

  try {
    await _waitWithTimeout(owner.closePromise, timeoutMs, "process_stop_timeout");
    const cleanExit = owner.exitCode === 0 && owner.exitSignal == null;
    return {
      stopped: true,
      generation: owner.generation,
      graceful: cleanExit,
      exitCode: owner.exitCode,
      signal: owner.exitSignal,
      ...(!cleanExit ? { error: `cli_shutdown_exit_${owner.exitCode ?? "unknown"}${owner.exitSignal ? `_signal_${owner.exitSignal}` : ""}` } : {}),
      ...(owner.stdinError ? { protocolError: owner.stdinError.message } : {}),
    };
  } catch (error) {
    if (_isCurrentOwner(owner)) {
      _lifecycleState = "stop_timeout";
      _lastLifecycleError = error.message;
    }
    const pid = owner.child.pid || null;
    let forceError = null;
    if (process.platform === "win32" && pid) {
      forceError = await new Promise((resolve) => {
        execFile(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { timeout: PROCESS_STOP_TIMEOUT_MS, windowsHide: true },
          (taskkillError) => resolve(taskkillError || null),
        );
      });
    } else {
      try { owner.child.kill("SIGKILL"); }
      catch (killError) { forceError = killError; }
    }

    try {
      await _waitWithTimeout(owner.closePromise, PROCESS_STOP_TIMEOUT_MS, "process_force_stop_timeout");
    } catch (closeError) {
      forceError = forceError || closeError;
    }

    const stopped = owner.closed;
    if (!stopped && _isCurrentOwner(owner)) {
      _lifecycleState = "stop_timeout";
      _lastLifecycleError = forceError?.message || "process_force_stop_timeout";
    }
    return {
      stopped,
      forced: true,
      graceful: false,
      error: forceError?.message || (stopped ? "process_stop_timeout_forced" : "process_force_stop_timeout"),
      generation: owner.generation,
      pid,
      exitCode: owner.exitCode,
      signal: owner.exitSignal,
      ...(owner.stdinError ? { protocolError: owner.stdinError.message } : {}),
    };
  }
}

/** 互斥让位停机：与 stopCli 的区别是**不设 _manualStop**（保留自动恢复资格）、不计崩溃熔断。 */
async function _parkCli(yonbanCount) {
  if (!_cliOwner) return { already: true };
  _mutexParked = true; // 先立 flag 再 kill：exit 回调异步到达，晚立会被判成异常退出触发自动重启
  _cancelRestartTimer();
  const owner = _cliOwner;
  const result = await _stopOwner(owner, "mutex-park");
  if (!result.stopped || result.graceful !== true) {
    diag.warn("CLI 让位停机超时", { yonbanCount, ...result });
    return result;
  }
  diag.log("CLI 让位停机（YonBan 在线）", { yonbanCount });
  _pushCliLog("log", `检测到 ${yonbanCount} 个 YonBan 实例在线，CLI 已让位停机（互斥：省内存/CPU + 防双执行端）；YonBan 全部关闭后自动恢复。`);
  return result;
}

/** 互斥收敛（单一裁决入口，周期跑 + Load 时跑一次）：把「该不该有 CLI 进程」调到与注册表一致。 */
async function _reconcileCli() {
  const config = await loadConfig();
  if (config.coexistWithYonban !== false || config.autoStart === false || _manualStop || _userOverride) return; // 用户意志优先
  const _yb = _liveYonBanCount(); // 一次读，判定与日志共用同一快照
  if (_yb > 0) {
    _cancelRecoveryTimer();
    if (_cliProcess) await _parkCli(_yb);
    return;
  }
  // YonBan 全下线：只恢复**被互斥停掉**的 CLI（崩溃熔断/手动停的不在此路复活，各归其原状态机）
  if (!_cliProcess && _mutexParked) await _resumeParkedCli("mutex-release");
}

function _scheduleParkedRecovery() {
  if (_recoveryTicket || !_mutexParked || _manualStop || _unloading) return;
  const delayMs = Math.min(
    RECOVERY_BACKOFF_MAX_MS,
    RECOVERY_BACKOFF_MIN_MS * (2 ** Math.max(0, _recoveryAttempt - 1)),
  );
  const ticket = {
    attempt: _recoveryAttempt,
    dueAt: Date.now() + delayMs,
    timer: null,
  };
  _recoveryNextAt = ticket.dueAt;
  _lifecycleState = "recovery_wait";
  ticket.timer = setTimeout(() => {
    if (_recoveryTicket !== ticket) return;
    _recoveryTicket = null;
    _recoveryNextAt = null;
    void _serializeLifecycle(() => _resumeParkedCli("recovery-backoff"));
  }, delayMs);
  ticket.timer.unref?.();
  _recoveryTicket = ticket;
}

async function _resumeParkedCli(source) {
  if (!_mutexParked || _cliProcess || _manualStop || _unloading) return { skipped: true };
  const config = await loadConfig();
  if (config.autoStart === false) return { skipped: true, reason: "auto_start_disabled" };
  if (config.coexistWithYonban === false && !_userOverride && _liveYonBanCount() > 0) {
    _lifecycleState = "parked";
    return { skipped: true, reason: "yonban_online" };
  }

  _cancelRecoveryTimer();
  _recoveryAttempt += 1;
  diag.log("CLI 恢复启动", { source, attempt: _recoveryAttempt });
  const result = await startCli({ intent: "recovery" }).catch((error) => ({ error: error.message }));
  if (result?.healthy === true) {
    _mutexParked = false;
    _cancelRecoveryTimer({ reset: true });
    return result;
  }

  _recoveryLastError = result?.error || "cli_recovery_failed";
  _lastLifecycleError = _recoveryLastError;
  diag.warn("CLI 恢复启动失败（保留可恢复态）", {
    source,
    attempt: _recoveryAttempt,
    error: _recoveryLastError,
  });
  _scheduleParkedRecovery();
  return { ...result, recoveryPending: true };
}

function _stopMutexTimer() {
  if (!_mutexTimer) return;
  clearInterval(_mutexTimer);
  _mutexTimer = null;
}

function _startMutexTimer() {
  if (_mutexTimer) return;
  _mutexTimer = setInterval(() => { void _serializeLifecycle(() => _reconcileCli()); }, MUTEX_INTERVAL);
  _mutexTimer.unref?.();
}

/** 应用 CLI/YonBan 并存策略：并存时拆掉互斥定时器并恢复被互斥停掉的 CLI；互斥时立即收敛。 */
async function _applyCoexistPolicy(config) {
  if (config.coexistWithYonban !== false) {
    _stopMutexTimer();
    const wasParked = _mutexParked;
    if (wasParked && config.autoStart !== false && !_manualStop && !_cliProcess) {
      const result = await _resumeParkedCli("coexist-enabled");
      diag.log("CLI/YonBan 并存已开启，恢复 CLI", result);
    }
    return;
  }
  _startMutexTimer();
  await _reconcileCli();
}

// ── CLI 后端日志环形缓冲（单独后端显示+白盒，凛倾 0722）──
// stdout/stderr 桥在手，此处留最近 N 行随 GetData 下发给前端 CLI 区渲染；
// [wb:cli.*] 白盒行同在 stdout 流内=一并可见（后端 console→monitor hook 通道不变，这是第二消费点非双写）。
const MAX_CLI_LOG = 200;
const _cliLogs = [];
function _pushCliLog(level, line) {
  _cliLogs.push({ t: Date.now(), level, line: line.length > 500 ? line.slice(0, 500) + "…" : line });
  if (_cliLogs.length > MAX_CLI_LOG) _cliLogs.splice(0, _cliLogs.length - MAX_CLI_LOG);
}

// ── 运行配置单源：data/beilu-cli-config.json（前端可编辑项全部在此，禁散写）──
// [0723] hintTexts 禁硬编码单源（why: 002原话「禁止硬编码,用户可设置一切」）:
//   CLI 侧 hints.mjs 原 _defaults 硬编码 9 条提示文本→迁到此配置单源,前端可编辑,
//   startCli 时经 env(BEILU_CLI_HINT_TEXTS) 注入 CLI 子进程,hints.mjs 读 env 覆盖默认。
//   空串的 3 条(read/write_file_success/fuzzy_edit_fallback)不进配置(空=无提示)。
const DEFAULT_CONFIG = {
  port: 8931,
  autoStart: true,
  autoRestart: true, // [0723] CLI 容错(002拍板A方向):异常退出自动重启;手动 stop 不触发;熔断见 exit 回调
  coexistWithYonban: true,
  hintTexts: {
    search_files_no_match: "没有找到匹配项。尝试调整搜索模式或扩大搜索范围。",
    search_by_name_no_match: "没有找到匹配的文件名。尝试使用更宽泛的模式。",
    run_command_timeout: "命令执行超时。考虑缩小操作范围或增加超时。",
    error_path_outside: "路径不在工作区内，已拒绝。所有文件操作必须在工作区目录下。",
    error_file_too_large: "文件过大，已跳过。",
    error_command_blocked: "该命令被安全策略阻止。",
    error_special_chars: "命令或路径含特殊字符（&|<>^等），cmd.exe 可能解析失败。请尝试用引号包裹路径，或转义特殊符号。",
  },
};

async function _paths() {
  const { __projectRoot, getFilesSettingsPath } = await import("../../../../yonban/core/functions/memory/storage_mod/storage.mjs");
  return {
    projectRoot: __projectRoot,
    // [0731 CLI 收进本体] 原指向仓库外 ../../代码cli/（作者机器盘面布局，git clone 用户必缺 →
    //   「CLI server.mjs 不存在」）。CLI 本体已迁入本插件 server/ 子目录，随仓库/发布物分发。
    cliServerPath: path.resolve(__projectRoot, "src/public/parts/plugins/beilu-cli/server/server.mjs"),
    configPath: path.resolve(__projectRoot, "data", "beilu-cli-config.json"),
    filesSettingsPath: getFilesSettingsPath(),
  };
}

async function loadConfig() {
  try {
    const { configPath } = await _paths();
    if (fs.existsSync(configPath)) {
      const j = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return { ...DEFAULT_CONFIG, ...j };
    }
  } catch (e) { diag.warn("读 config 失败，用默认", { error: e.message }); }
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(patch) {
  const { configPath } = await _paths();
  const cur = await loadConfig();
  const next = { ...cur };
  if (patch && typeof patch === "object") {
    if (Number.isInteger(patch.port) && patch.port > 0 && patch.port < 65536) next.port = patch.port;
    if (typeof patch.autoStart === "boolean") next.autoStart = patch.autoStart;
    if (typeof patch.autoRestart === "boolean") next.autoRestart = patch.autoRestart;
    if (typeof patch.coexistWithYonban === "boolean") next.coexistWithYonban = patch.coexistWithYonban;
    // [0723] hintTexts 部分更新:只接受 string 值(Postel's Law 接收宽容),merge 不整体替换
    if (patch.hintTexts && typeof patch.hintTexts === "object") {
      const clean = {};
      for (const [k, v] of Object.entries(patch.hintTexts)) {
        if (typeof v === "string") clean[k] = v;
      }
      next.hintTexts = { ...(next.hintTexts || {}), ...clean };
    }
  }
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf-8");
  } catch (e) {
    diag.warn("写 config 失败", { error: e.message });
    return { success: false, error: e.message };
  }
  return { success: true, config: next };
}

// ── 子进程生命周期 ──

async function startCli({ intent = "start" } = {}) {
  if (_unloading) return { error: "plugin_unloading", ...getCliStatus() };
  if (_cliOwner) {
    return {
      already: true,
      healthy: _cliOwner.healthy,
      generation: _cliOwner.generation,
      ...getCliStatus(),
    };
  }
  _cancelRestartTimer();
  _manualStop = false; // 任何启动口(手动 start/restart/autoStart)都解除手动停止态,恢复自动重启监护

  const { cliServerPath, filesSettingsPath } = await _paths();
  if (!fs.existsSync(cliServerPath)) {
    diag.warn("CLI server.mjs 不存在", { path: cliServerPath });
    _lifecycleState = "spawn_error";
    _lastLifecycleError = "cli_server_missing";
    return { error: "CLI server.mjs 不存在" };
  }

  const config = await loadConfig();
  // 工作区根不由本插件决定：CLI 进程读 beilu-files-settings.json canonical 单源并 fs.watch 热跟随
  //（用户在文件面板「打开文件夹」即改 CLI 工作区，零额外设置入口）。
  const spawnArgs = [cliServerPath, "--port", String(config.port), "--settings", filesSettingsPath];

  try {
    const child = spawn("node", spawnArgs, {
      // stdin pipe 是父子进程的内部关停协议：所有 stop 先发 shutdown+EOF，超时才强制终止。
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      // [0723] hintTexts 经 env 注入 CLI 子进程(禁硬编码单源):hints.mjs 读 BEILU_CLI_HINT_TEXTS 覆盖默认。
      //   config 改动需重启 CLI 生效(env 在启动时快照,前端提示已标)。避免命令行参数过长/JSON 转义问题。
      env: { ...process.env, BEILU_CLI_HINT_TEXTS: JSON.stringify(config.hintTexts || {}) },
    });

    const owner = _createProcessOwner(child, config, intent);
    _cliOwner = owner;
    _cliProcess = child;
    _startedAt = Date.now();
    _lifecycleState = "starting";
    _lastLifecycleError = null;

    child.stdout?.on("data", (d) => {
      if (!_isCurrentOwner(owner)) return;
      const line = d.toString().trim();
      if (line) { console.log(`[beilu-cli] ${line}`); _pushCliLog("log", line); }
      owner.stdoutTail = `${owner.stdoutTail}${line}`.slice(-1000);
      // 「本体打开的同时必须拉起cli+必须进行连接」（凛倾 2026-07-22）：CLI listening 确认后
      // （发现文件已落盘，server.mjs:259 打此行）主动踢一次连接，不等 ideClient 重连退避（最长 60s）。
      // connect 会重新同步完整目标集；即使 YonBan 已连接，也必须立即发现刚启动的 CLI。
      if (!owner.listeningSeen && owner.stdoutTail.includes("WS 服务器已启动")) {
        owner.listeningSeen = true;
        try { ideClient.connect({ autoReconnect: true }); } catch (e) { diag.warn("踢 ideClient 连接失败", { error: e.message }); }
        _watchOwnerHealth(owner);
      }
    });
    child.stderr?.on("data", (d) => {
      if (!_isCurrentOwner(owner)) return;
      const line = d.toString().trim();
      if (line) { console.warn(`[beilu-cli] ${line}`); _pushCliLog("warn", line); }
    });
    child.on("exit", (code, signal) => {
      owner.exitCode = code;
      owner.exitSignal = signal;
      if (_isCurrentOwner(owner)) {
        diag.log("CLI 后端 exit", { code, signal, generation: owner.generation });
      }
    });
    child.on("close", (code, signal) => {
      if (_isCurrentOwner(owner)) {
        diag.log("CLI 后端 close", { code, signal, generation: owner.generation });
      }
      _finalizeOwnerClose(owner, code, signal);
    });
    child.on("error", (error) => {
      owner.error = error;
      if (!owner.healthy) owner.expectedStopReason = owner.expectedStopReason || "spawn-error";
      _settleOwnerHealth(owner, false, error);
      if (!_isCurrentOwner(owner)) return;
      _lifecycleState = "spawn_error";
      _lastLifecycleError = error.message;
      diag.warn("CLI 后端启动失败", { error: error.message, generation: owner.generation });
    });

    diag.log("CLI 后端进程已创建，等待连接健康", {
      port: config.port,
      pid: child.pid,
      generation: owner.generation,
      settings: filesSettingsPath,
    });

    try {
      await _waitWithTimeout(owner.healthPromise, PROCESS_HEALTH_TIMEOUT_MS, "cli_health_timeout");
      return {
        started: true,
        healthy: true,
        port: _readRegistryEntryForPid(child.pid)?.port ?? config.port,
        pid: child.pid,
        generation: owner.generation,
      };
    } catch (error) {
      if (_isCurrentOwner(owner)) {
        _lastLifecycleError = error.message;
        _lifecycleState = error.message === "cli_health_timeout" ? "health_timeout" : "spawn_error";
      }
      owner.expectedStopReason = owner.expectedStopReason || "startup-failed";
      const stopResult = await _stopOwner(owner, owner.expectedStopReason);
      return {
        error: error.message,
        generation: owner.generation,
        stopResult,
      };
    }
  } catch (e) {
    _lifecycleState = "spawn_error";
    _lastLifecycleError = e.message;
    diag.warn("CLI spawn 失败", { error: e.message });
    return { error: e.message };
  }
}

async function stopCli() {
  _manualStop = true; // 先立 flag 再 kill:exit 事件异步到达,防手动停止被误判异常退出触发自动重启
  _mutexParked = false;
  _cancelRestartTimer();
  _cancelRecoveryTimer({ reset: true });
  const owner = _cliOwner;
  if (!owner) {
    _lifecycleState = "stopped";
    return { already: true };
  }
  _lifecycleState = "stopping";
  const result = await _stopOwner(owner, "manual-stop");
  if (result.stopped && result.graceful === true) diag.log("CLI 后端已 graceful 停止", { generation: owner.generation });
  else diag.warn("CLI 后端停止未完成 graceful 契约", result);
  return result;
}

async function restartCli() {
  _manualStop = true;
  _cancelRestartTimer();
  _cancelRecoveryTimer();
  const previousOwner = _cliOwner;
  if (previousOwner) {
    _lifecycleState = "stopping";
    const stopResult = await _stopOwner(previousOwner, "restart");
    if (!stopResult.stopped || stopResult.graceful !== true) return stopResult;
  }
  _crashTimes = []; // 手动 restart=用户已介入,清熔断窗口重新计数
  return startCli({ intent: "manual-restart" });
}

/** 实际绑定端口/工作区从发现注册表按子进程 PID 反查（端口自增后 config.port ≠ 真值，注册表才是真值）。 */
function _readRegistryEntry() {
  return _readRegistryEntryForPid(_cliProcess?.pid);
}

function getCliStatus() {
  const reg = _readRegistryEntry();
  return {
    running: !!_cliProcess,
    healthy: !!_cliOwner?.healthy,
    lifecycleState: _lifecycleState,
    generation: _cliOwner?.generation ?? _cliGeneration,
    lastError: _lastLifecycleError,
    restartScheduledAt: _restartTicket?.dueAt ? new Date(_restartTicket.dueAt).toISOString() : null,
    recovery: {
      pending: !!(_mutexParked && !_cliOwner),
      attempt: _recoveryAttempt,
      lastError: _recoveryLastError,
      nextRetryAt: _recoveryNextAt ? new Date(_recoveryNextAt).toISOString() : null,
    },
    // [0727 互斥] 停机原因如实上报：没有这两个字段，让位停机在前端 CLI 卡片上与「崩了/没起来」
    //   长得一模一样，用户会去按重启（然后又被让位停）。parked=让位中且会自动恢复。
    parked: _mutexParked,
    parkedReason: _mutexParked ? (_recoveryLastError ? "recovery-pending" : "yonban-online") : null,
    userOverride: _userOverride,
    pid: _cliProcess?.pid || null,
    port: reg?.port ?? null,          // 实际绑定端口（listening 后注册表真值；null=未起/未注册完）
    workspace: reg?.workspace || _workspace || "",
    startedAt: _startedAt ? new Date(_startedAt).toISOString() : null,
    uptime: _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : 0,
  };
}

function _shutdownPluginCli() {
  _unloading = true;
  _stopMutexTimer();
  _cancelRestartTimer();
  _cancelRecoveryTimer({ reset: true });
  return _serializeLifecycle(() => stopCli());
}

// 本体进程关停与 Part Unload 共用同一条串行 stop 链，避免绕过子进程 graceful protocol。
on_shutdown(() => _shutdownPluginCli());

const pluginExport = {
  info,
  interfaces: {
    config: {
      async SetData(data) {
        const action = (data && typeof data === "object") ? data._action : data;
        switch (action) {
          // [0727 互斥] 手动 start/restart = 用户显式要 CLI（哪怕 YonBan 在线）→ 立 _userOverride，
          //   互斥收敛不再动它；否则用户点了启动、下一拍(≤15s)被无声杀掉，看起来像"启动按钮坏了"。
          //   手动 stop 撤销 override（回归自动裁决），与 _manualStop 各管一件事：
          //   _manualStop=别自动重启它，_userOverride=别互斥停它。
          case "restart":
            return _serializeLifecycle(async () => {
              _userOverride = true;
              const wasParked = _mutexParked;
              const result = await restartCli();
              if (result?.healthy === true) {
                _mutexParked = false;
                _cancelRecoveryTimer({ reset: true });
              } else {
                _mutexParked = wasParked;
                if (wasParked) _scheduleParkedRecovery();
              }
              return result;
            });
          case "stop":
            return _serializeLifecycle(async () => {
              _userOverride = false;
              return stopCli();
            });
          case "start":
            return _serializeLifecycle(async () => {
              _userOverride = true;
              const wasParked = _mutexParked;
              const result = await startCli({ intent: "manual-start" });
              if (result?.healthy === true) {
                _mutexParked = false;
                _cancelRecoveryTimer({ reset: true });
              } else {
                _mutexParked = wasParked;
                if (wasParked) _scheduleParkedRecovery();
              }
              return result;
            });
          case "setConfig":
            // 前端可编辑项唯一写点（端口/自动启动）。端口改动需重启 CLI 生效（前端提示）。
            return _serializeLifecycle(async () => {
              const result = await saveConfig(data);
              if (result.success && typeof data?.coexistWithYonban === "boolean") {
                await _applyCoexistPolicy(result.config);
              }
              return result;
            });
          default:
            return { error: `未知操作: ${action}` };
        }
      },
      async GetData() {
        // 聚合快照：status（运行时真值）+ config（可编辑项）+ logs（后端日志/白盒尾窗）——前端 CLI 设置区单次拉全
        return { status: getCliStatus(), config: await loadConfig(), logs: _cliLogs.slice(-100) };
      },
    },
  },

  async Init({ router, username }) {
    // install-once 钩子（磁盘 parts_init 门控，装完永久跳过）——不放任何每次启动都要跑的逻辑。
    // spawn 在 Load（见文件头 ★），这里只留痕。
    diag.log("Init（install-once）", { username });
  },

  async Load({ router, username }) {
    diag.log("Load", { username });
    _unloading = false;

    // 每次启动拉起 CLI（凛倾 2026-07-22「本体打开的同时必须拉起cli」）：
    // Load 由 server.mjs:384 fullLoadAllParts 在每次启动跑到；startCli 幂等（_cliProcess 存活即 return），
    // 多用户循环/懒加载重入不会重复 spawn。
    // ★ worker isolate 不 spawn：parts_set/模块态按 isolate 隔离，worker 里 Load 会重跑且 _cliProcess
    //   是空白副本——放行=每个 worker 再起一个 CLI 进程（端口自增多开）。子进程生命周期只归主进程。
    if (!globalThis.__BEILU_WORKER_ISOLATE) {
      await _serializeLifecycle(async () => {
        const config = await loadConfig();
        if (config.autoStart === false) {
          diag.log("autoStart=false，跳过自动启动");
        } else if (config.coexistWithYonban === false && _liveYonBanCount() > 0) {
          // 启动时 VSCode/YonBan 已经开着：直接进让位态，不做「先 spawn 再被互斥杀掉」的空转。
          _mutexParked = true;
          _lifecycleState = "parked";
          diag.log("Load 时已有 YonBan 在线，CLI 进让位态不启动");
          _pushCliLog("log", "启动时检测到 YonBan 在线，CLI 未启动（互斥让位）；YonBan 全部关闭后自动拉起。");
        } else {
          const result = await startCli({ intent: "load" });
          diag.log("Load startCli 结果", result);
        }
        // 仅互斥模式启收敛周期：YonBan 上线→停 CLI，YonBan 全下线→拉回 CLI。
        if (config.coexistWithYonban === false) _startMutexTimer();
      });
    }

    // 永久注册（plugin-host:175 范式）：进 defaultParts 后重启由 shallowLoadAllDefaultParts
    // 正常装载，不再依赖 endpoints.mjs bootstrap 兜底。
    try { setDefaultPart(username, "plugins", "beilu-cli"); } catch (e) { diag.warn("setDefaultPart 失败", { error: e.message }); }

    // config REST 端点（beilu-files:2648 范式：插件自注册 + authenticate 鉴权）。
    // 前端统一走 sendAction 门面 → /api/parts/plugins:beilu-cli/config/getdata|setdata。
    if (router) {
      router.get(
        "/api/parts/plugins\\:beilu-cli/config/getdata",
        authenticate,
        async (req, res) => {
          try {
            res.json(await pluginExport.interfaces.config.GetData());
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );
      router.post(
        "/api/parts/plugins\\:beilu-cli/config/setdata",
        authenticate,
        async (req, res) => {
          try {
            const result = await pluginExport.interfaces.config.SetData(req.body);
            res.json(result || { success: true });
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );
    }
  },

  async Unload() {
    diag.log("Unload");
    // 配对拆链：起了 timer 就要拆（Unload 后本模块态作废，留着 interval 会对着空 _cliProcess 空转，
    //   重载后还会再起第二个）。
    await _shutdownPluginCli();
  },
};

export default pluginExport;
