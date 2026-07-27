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
import { spawn } from "node:child_process";

import { createDiag } from "../../../../server/diagLogger.mjs";
import { setDefaultPart } from "../../../../server/parts_loader.mjs";
import { authenticate } from "../../../../yonban/core/functions/security/auth.mjs";
import { ideClient, resolveIdeMode } from "../../../../yonban/core/transport/ideClient.mjs";

const diag = createDiag("cli");

let _cliProcess = null;
let _workspace = "";
let _startedAt = null;
// [0723] CLI 容错(002拍板A方向:exit自动重启+崩溃熔断):
//   _manualStop 区分手动 stop(不重启)与异常退出(自动重启);
//   _crashTimes 滑动窗口熔断——60s 内异常退出 >3 次=反复崩溃(如端口被占/依赖损坏),停止自动重启防 crash loop,
//   留日志给前端 CLI 区诊断面,用户修因后可手动 restart(action 口不受熔断影响,且会清窗口)。
let _manualStop = false;
let _crashTimes = [];
const CRASH_WINDOW_MS = 60000;
const CRASH_MAX = 3;

// ── CLI↔YonBan 互斥：让位停机（凛倾 0726「cli就是要离线啊，不离线指令会不会互斥？会不会导致2个都开
//   占用内存和cpu」）──
// 此前互斥只做在**本体连接侧**（ideClient._syncConnections：有 YonBan 存活 → 目标集只含 YonBan，
//   CLI 不进池）。结果=CLI 进程照跑、照监听端口、照在注册表里、照占内存 CPU，只是没人连它——
//   互斥做了一半。进程生死本来就归本插件（它是 CLI 的宿主），故补这一半在此，不在 CLI 侧再写一套。
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
    return _ide.mode === "yonban" ? _ide.yonbans.length : 0;
  } catch (e) {
    diag.warn("互斥判定读注册表失败（保守不停 CLI）", { error: e.message });
    return 0;
  }
}

/** 互斥让位停机：与 stopCli 的区别是**不设 _manualStop**（保留自动恢复资格）、不计崩溃熔断。 */
function _parkCli(yonbanCount) {
  if (!_cliProcess) return;
  _mutexParked = true; // 先立 flag 再 kill：exit 回调异步到达，晚立会被判成异常退出触发自动重启
  try { _cliProcess.kill(); } catch { /* 已死 */ }
  _cliProcess = null;
  _startedAt = null;
  diag.log("CLI 让位停机（YonBan 在线）", { yonbanCount });
  _pushCliLog("log", `检测到 ${yonbanCount} 个 YonBan 实例在线，CLI 已让位停机（互斥：省内存/CPU + 防双执行端）；YonBan 全部关闭后自动恢复。`);
}

/** 互斥收敛（单一裁决入口，周期跑 + Load 时跑一次）：把「该不该有 CLI 进程」调到与注册表一致。 */
async function _reconcileCli() {
  const config = await loadConfig();
  if (config.autoStart === false || _manualStop || _userOverride) return; // 用户意志优先
  const _yb = _liveYonBanCount(); // 一次读，判定与日志共用同一快照
  if (_yb > 0) {
    if (_cliProcess) _parkCli(_yb);
    return;
  }
  // YonBan 全下线：只恢复**被互斥停掉**的 CLI（崩溃熔断/手动停的不在此路复活，各归其原状态机）
  if (!_cliProcess && _mutexParked) {
    diag.log("YonBan 全部下线，CLI 恢复启动（互斥解除）");
    const r = await startCli().catch((e) => ({ error: e.message }));
    // 只在真起来之后才清让位态：先清后起的写法一旦 spawn 失败就永久卡死
    //（!_cliProcess 且 !_mutexParked = 本函数下一拍什么都不做，没人再管它）。
    if (r && !r.error) {
      _mutexParked = false;
      _pushCliLog("log", "YonBan 全部下线，CLI 已自动恢复启动（互斥解除）。");
    } else {
      diag.warn("互斥恢复启动失败（保留让位态，下一拍重试）", { error: r?.error });
    }
  }
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
    cliServerPath: path.resolve(__projectRoot, "../../代码cli/server.mjs"),
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

async function startCli() {
  if (_cliProcess) return { already: true, ...getCliStatus() };
  _manualStop = false; // 任何启动口(手动 start/restart/autoStart)都解除手动停止态,恢复自动重启监护

  const { cliServerPath, filesSettingsPath } = await _paths();
  if (!fs.existsSync(cliServerPath)) {
    diag.warn("CLI server.mjs 不存在", { path: cliServerPath });
    return { error: "CLI server.mjs 不存在" };
  }

  const config = await loadConfig();
  // 工作区根不由本插件决定：CLI 进程读 beilu-files-settings.json canonical 单源并 fs.watch 热跟随
  //（用户在文件面板「打开文件夹」即改 CLI 工作区，零额外设置入口）。
  const spawnArgs = [cliServerPath, "--port", String(config.port), "--settings", filesSettingsPath];

  try {
    _cliProcess = spawn("node", spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
      // [0723] hintTexts 经 env 注入 CLI 子进程(禁硬编码单源):hints.mjs 读 BEILU_CLI_HINT_TEXTS 覆盖默认。
      //   config 改动需重启 CLI 生效(env 在启动时快照,前端提示已标)。避免命令行参数过长/JSON 转义问题。
      env: { ...process.env, BEILU_CLI_HINT_TEXTS: JSON.stringify(config.hintTexts || {}) },
    });

    _cliProcess.stdout?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) { console.log(`[beilu-cli] ${line}`); _pushCliLog("log", line); }
      // 「本体打开的同时必须拉起cli+必须进行连接」（凛倾 2026-07-22）：CLI listening 确认后
      // （发现文件已落盘，server.mjs:259 打此行）主动踢一次连接，不等 ideClient 重连退避（最长 60s）。
      // connect 幂等（已连/连接中直接 return），每次连接前 _resolveToken 重读注册表拿真实端口。
      if (line.includes("WS 服务器已启动") && !ideClient.isConnected) {
        try { ideClient.connect({ autoReconnect: true }); } catch (e) { diag.warn("踢 ideClient 连接失败", { error: e.message }); }
      }
    });
    _cliProcess.stderr?.on("data", (d) => {
      const line = d.toString().trim();
      if (line) { console.warn(`[beilu-cli] ${line}`); _pushCliLog("warn", line); }
    });
    _cliProcess.on("exit", (code) => {
      diag.log("CLI 后端退出", { code });
      _cliProcess = null;
      _startedAt = null;
      // [0723] 异常退出自动重启(002拍板A方向)。手动 stop/配置关闭不重启;熔断防 crash loop。
      // [0727 互斥] 让位停机也不重启：_parkCli 的 kill 走的正是本回调，漏判=杀了立刻又拉起来
      //   （每 15s 一轮 spawn→kill，比不做互斥更糟）。恢复由 _reconcileCli 在 YonBan 全下线后负责。
      if (_manualStop || _mutexParked || config.autoRestart === false) return;
      const _now = Date.now();
      _crashTimes = _crashTimes.filter((t) => _now - t < CRASH_WINDOW_MS);
      _crashTimes.push(_now);
      if (_crashTimes.length > CRASH_MAX) {
        diag.warn("CLI 崩溃熔断", { window: "60s", count: _crashTimes.length });
        _pushCliLog("warn", `CLI 60秒内异常退出 ${_crashTimes.length} 次，已熔断停止自动重启。请检查端口占用/依赖后手动重启。`);
        return;
      }
      diag.log("CLI 异常退出，自动重启", { code, attempt: _crashTimes.length });
      _pushCliLog("warn", `CLI 异常退出(code=${code})，1秒后自动重启（第 ${_crashTimes.length} 次）`);
      setTimeout(() => {
        if (_cliProcess || _manualStop) return;
        // [0727 互斥] 崩溃重启也要过同一份裁决：**每个"启动 CLI"的决策点都问同一个问题**
        //   （Load / 互斥恢复 / 崩溃重启 / 手动 start），否则这条路会在 YonBan 在线时把 CLI 拉起来，
        //   下一拍收敛再把它停掉——每 15s 一轮 spawn→kill 的空转。用户手动 start 的 override 不受此限。
        if (!_userOverride && _liveYonBanCount() > 0) {
          _mutexParked = true; // 转让位态：YonBan 全下线后由 _reconcileCli 负责拉回
          diag.log("CLI 异常退出但 YonBan 在线，转让位态不重启");
          _pushCliLog("log", "CLI 异常退出，但检测到 YonBan 在线 → 转让位态（互斥）；YonBan 全部关闭后自动拉起。");
          return;
        }
        startCli().catch((e) => diag.warn("自动重启失败", { error: e.message }));
      }, 1000);
    });
    _cliProcess.on("error", (err) => {
      diag.warn("CLI 后端启动失败", { error: err.message });
      _cliProcess = null;
      _startedAt = null;
    });

    _startedAt = Date.now();
    diag.log("CLI 后端已启动", { port: config.port, pid: _cliProcess.pid, settings: filesSettingsPath });
    return { started: true, port: config.port, pid: _cliProcess.pid };
  } catch (e) {
    diag.warn("CLI spawn 失败", { error: e.message });
    return { error: e.message };
  }
}

function stopCli() {
  _manualStop = true; // 先立 flag 再 kill:exit 事件异步到达,防手动停止被误判异常退出触发自动重启
  if (!_cliProcess) return { already: true };
  try {
    _cliProcess.kill();
  } catch { /* ignore */ }
  _cliProcess = null;
  _startedAt = null;
  diag.log("CLI 后端已停止");
  return { stopped: true };
}

async function restartCli() {
  stopCli();
  _crashTimes = []; // 手动 restart=用户已介入,清熔断窗口重新计数
  await new Promise((r) => setTimeout(r, 1000));
  return startCli();
}

/** 实际绑定端口/工作区从发现注册表按子进程 PID 反查（端口自增后 config.port ≠ 真值，注册表才是真值）。 */
function _readRegistryEntry() {
  if (!_cliProcess?.pid) return null;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".beilu", "ide_active_ports.json"), "utf-8"));
    if (!Array.isArray(registry)) return null;
    return registry.find((e) => e && e.pid === _cliProcess.pid) || null;
  } catch { return null; }
}

function getCliStatus() {
  const reg = _readRegistryEntry();
  return {
    running: !!_cliProcess,
    // [0727 互斥] 停机原因如实上报：没有这两个字段，让位停机在前端 CLI 卡片上与「崩了/没起来」
    //   长得一模一样，用户会去按重启（然后又被让位停）。parked=让位中且会自动恢复。
    parked: _mutexParked,
    parkedReason: _mutexParked ? "yonban-online" : null,
    userOverride: _userOverride,
    pid: _cliProcess?.pid || null,
    port: reg?.port ?? null,          // 实际绑定端口（listening 后注册表真值；null=未起/未注册完）
    workspace: reg?.workspace || _workspace || "",
    startedAt: _startedAt ? new Date(_startedAt).toISOString() : null,
    uptime: _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : 0,
  };
}

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
            _userOverride = true;
            _mutexParked = false;
            return restartCli();
          case "stop":
            _userOverride = false;
            return stopCli();
          case "start":
            _userOverride = true;
            _mutexParked = false;
            return startCli();
          case "setConfig":
            // 前端可编辑项唯一写点（端口/自动启动）。端口改动需重启 CLI 生效（前端提示）。
            return saveConfig(data);
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

    // 每次启动拉起 CLI（凛倾 2026-07-22「本体打开的同时必须拉起cli」）：
    // Load 由 server.mjs:384 fullLoadAllParts 在每次启动跑到；startCli 幂等（_cliProcess 存活即 return），
    // 多用户循环/懒加载重入不会重复 spawn。
    // ★ worker isolate 不 spawn：parts_set/模块态按 isolate 隔离，worker 里 Load 会重跑且 _cliProcess
    //   是空白副本——放行=每个 worker 再起一个 CLI 进程（端口自增多开）。子进程生命周期只归主进程。
    if (!globalThis.__BEILU_WORKER_ISOLATE) {
      const config = await loadConfig();
      if (config.autoStart === false) {
        diag.log("autoStart=false，跳过自动启动");
      } else if (_liveYonBanCount() > 0) {
        // 启动时 VSCode/YonBan 已经开着：直接进让位态，不做「先 spawn 再被互斥杀掉」的空转。
        _mutexParked = true;
        diag.log("Load 时已有 YonBan 在线，CLI 进让位态不启动");
        _pushCliLog("log", "启动时检测到 YonBan 在线，CLI 未启动（互斥让位）；YonBan 全部关闭后自动拉起。");
      } else {
        const result = await startCli();
        diag.log("Load startCli 结果", result);
      }
      // 互斥收敛周期（唯一裁决入口）：YonBan 上线→停 CLI，YonBan 全下线→拉回 CLI。
      //   unref：不因这个 timer 吊住进程退出（同 ideClient 重扫/绑定落盘范式）。
      if (!_mutexTimer) {
        _mutexTimer = setInterval(() => { void _reconcileCli(); }, MUTEX_INTERVAL);
        _mutexTimer.unref?.();
      }
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
    if (_mutexTimer) { clearInterval(_mutexTimer); _mutexTimer = null; }
    stopCli();
  },
};

export default pluginExport;
