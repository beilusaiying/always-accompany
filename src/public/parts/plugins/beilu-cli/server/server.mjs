/**
 * server.mjs — beilu-cli WS 服务器（无头 YonBan：纯工具执行后端）
 *
 * 定位（凛倾 2026-07-22 拍板）：CLI 只是工具插件——对话/API/生成/安全裁决全在本体，
 * 本进程只承接本体 ideClient 的 tool_call 并执行。到达这里的调用已过本体五级安全门
 * （replyHandler 命令闸 → B3 规则 → 审批门 → gateToolExecution → 指纹），本进程零裁决、零审批。
 *
 * 链路：本体 beilu-cli 插件 spawn 本进程 → listening 后写 token/端口注册（发现协议）
 *   → 本体 ideClient resolveIdeWsToken 读注册表连入 → hello 握手（workspaceFolders=canonical 根）
 *   → tool_call → executor.execute → tool_result（结构化，与 YonBan ToolCallResult 同形）
 *
 * 发现协议（逐字段对齐 YonBan IdeWsServer.ts:130-184，本体 ideClient.mjs:351 resolveIdeWsToken 消费）：
 *   ~/.beilu/ide_active_ports.json  数组 [{port,pid,time,workspace}]，PID 存活过滤
 *   ~/.beilu/ide_ws_token_<port>    per-port 纯 token（多实例不互踩）
 *   ~/.beilu/ide_ws_token           全局 "port:token"（回退路径）
 *   <workspace>/.beilu/_ws_token    工作区 "port:token"（旧路径兼容）
 *   全部只在 wss "listening" 确认绑定端口后写——绝不广播未绑定端口（YonBan U2/D3 教训）。
 *
 * 工作区根单源：beilu-files-settings.json _global.workspaceRoot（--settings 注入路径），
 *   与本体 ideClient._readCanonicalWorkspace / beilu-files 沙箱同源；fs.watch 跟随变更
 *   （用户在文件面板「打开文件夹」→ 本进程热切根 + broadcastStatus → 本体 reconcile 幂等）。
 *   --workspace 仅作显式覆盖（测试用），缺省走 settings。
 *
 * 用法：node server.mjs [--port 8931] [--settings <beilu-files-settings.json>] [--workspace <覆盖根>]
 */
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ToolExecutor } from "./executor.mjs";
import { setPathGuards } from "./infra.mjs";
import { wbT, wbD } from "./wb.mjs";

// 版本单源 package.json（YonBan extension.ts:69 同范式——消散落硬编码版本串）
const CLI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version || "0.0.0";
  } catch { return "0.0.0"; }
})();

// ═══════════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaultVal;
}

const BASE_PORT = parseInt(getArg("port", "8931"), 10);
const SETTINGS_PATH = getArg("settings", "");
const WS_PATH = "/ide";
const MAX_PORT_RETRIES = 10;

// ═══════════════════════════════════════════════════════════════
// 工作区根：canonical 单源（beilu-files-settings.json）
// 与本体 ideClient._readCanonicalWorkspace 同口径：_global.workspaceRoot 优先，
// "." 视为旧占位无效；相对值 resolve 锚项目根（= settings 所在 data/ 的父目录）。
// ═══════════════════════════════════════════════════════════════

function readCanonicalWorkspace() {
  if (!SETTINGS_PATH) return "";
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const root = typeof j._global?.workspaceRoot === "string" ? j._global.workspaceRoot
      : typeof j.workspaceRoot === "string" ? j.workspaceRoot : "";
    if (!root || root === ".") return "";
    if (path.isAbsolute(root)) return root;
    const projectRoot = path.dirname(path.dirname(path.resolve(SETTINGS_PATH)));
    return path.resolve(projectRoot, root);
  } catch { return ""; }
}

function resolveWorkspace() {
  const explicit = getArg("workspace", "");
  if (explicit) return path.resolve(explicit);
  const canonical = readCanonicalWorkspace();
  if (canonical) return canonical;
  return process.cwd();
}

/** 路径屏蔽纵深数据源：settings 各用户键 blockedPaths 并集（从严）。anchor=项目根（与本体 resolve 同锚）。 */
function readBlockedPathsUnion() {
  if (!SETTINGS_PATH) return { blocked: [], anchor: "" };
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const union = new Set();
    for (const v of Object.values(j)) {
      if (v && typeof v === "object" && Array.isArray(v.blockedPaths)) {
        for (const b of v.blockedPaths) if (typeof b === "string" && b.trim()) union.add(b.trim());
      }
    }
    return { blocked: [...union], anchor: path.dirname(path.dirname(path.resolve(SETTINGS_PATH))) };
  } catch { return { blocked: [], anchor: "" }; }
}

let WORKSPACE = resolveWorkspace();

// ═══════════════════════════════════════════════════════════════
// Token + 端口注册（发现协议——listening 后才落盘）
// ═══════════════════════════════════════════════════════════════

const TOKEN_DIR = path.join(os.homedir(), ".beilu");
const activePortsFile = path.join(TOKEN_DIR, "ide_active_ports.json");
const TOKEN = crypto.randomBytes(16).toString("hex");

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 本 CLI 实例编号（凛倾 0726「直接把 yonban 里面做一个小装置，会发送编号，然后本体进行识别」——
 * CLI 是同一发现协议的另一个实例，同样自报编号，不让本体去猜）。
 * 【契约】与 YonBan IdeWsServer.instanceId 同型两段式：`cli_<稳定段>_<进程段>`
 *   · 稳定段 = ~/.beilu/cli_instance_key 持久值（同 YonBan 的 workspaceState uuid 角色）——
 *     本体重启 CLI / CLI 换端口后仍能认出「还是那个 CLI」，据此把旧绑定回迁
 *     （ideClient bind:reattach 按 instanceId 认回，见 ideClient.mjs:606-633）。
 *   · 进程段 = 本次进程随机值，保证不同进程编号不撞。
 * 【why 缺了会怎样】此前 CLI 只写 {port,pid,time,workspace,type}，无编号：
 *   本体只能退回「端口即身份」——换端口就认不回、＋号下拉的 option value 退化成端口号、
 *   按编号重绑的自愈路径对 CLI 整条失效。
 */
function resolveCliInstanceId() {
  let stable = "";
  try {
    const keyFile = path.join(TOKEN_DIR, "cli_instance_key");
    if (fs.existsSync(keyFile)) stable = fs.readFileSync(keyFile, "utf-8").trim();
    if (!/^[0-9a-f]{8,}$/.test(stable)) {
      stable = crypto.randomBytes(4).toString("hex");
      if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
      fs.writeFileSync(keyFile, stable, "utf-8");
    }
  } catch {
    stable = "anon"; // 读写不了 home 目录：退化成不稳定编号，仍保证唯一（同 YonBan 无工作区时的 anon）
  }
  return `cli_${stable}_${crypto.randomBytes(4).toString("hex")}`;
}

const INSTANCE_ID = resolveCliInstanceId();

/** 读注册表（数组格式）。旧 CLI 曾误写对象格式——非数组即视为损坏，丢弃重建（本体 Array.isArray 校验同款兜底）。 */
function readPortRegistry() {
  try {
    const registry = JSON.parse(fs.readFileSync(activePortsFile, "utf-8"));
    if (!Array.isArray(registry)) return [];
    return registry.filter((e) => e && e.pid && isProcessAlive(e.pid));
  } catch { return []; }
}

let _actualPort = BASE_PORT;

/** listening 确认绑定后调用：写全部 token 文件 + 数组注册表（对齐 IdeWsServer._generateAndSaveToken/_registerActivePort）。 */
function persistDiscovery(port) {
  _actualPort = port;
  try { if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true }); } catch { /* ignore */ }

  const targets = [
    // per-port 纯 token（本体优先读：注册表定端口 → ide_ws_token_<port> 取 token）
    { file: path.join(TOKEN_DIR, `ide_ws_token_${port}`), content: TOKEN },
    // 全局 "port:token"（本体回退解析要求纯数字端口前缀，缺前缀=端口丢失连死默认口）
    { file: path.join(TOKEN_DIR, "ide_ws_token"), content: `${port}:${TOKEN}` },
    // 工作区旧路径兼容
    { file: path.join(WORKSPACE, ".beilu", "_ws_token"), content: `${port}:${TOKEN}` },
  ];
  for (const { file, content } of targets) {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, content, "utf-8");
    } catch (e) { console.warn(`[beilu-cli] 写 token 失败 (${file}): ${e.message}`); }
  }

  // [0727 并发写根修·lost-update] 与 YonBan IdeWsServer._registerActivePort 孪生同改：多方几乎同时
  //   启动时无锁"整读→改→整写"会互相覆盖丢条目（本体池"双开只见一个"根源）。写后核验+短重试收敛。
  let _regOk = false;
  for (let _attempt = 0; _attempt < 3 && !_regOk; _attempt++) {
    try {
      const registry = readPortRegistry().filter((e) => e.pid !== process.pid); // 重试幂等：先摘本进程旧条目
      // instanceId/procStart 与 YonBan IdeWsServer._registerActivePort 同型：
      //   · instanceId = 自报编号（本体认窗口的权威身份）；
      //   · procStart = 本进程启动时刻，让本体的 pid 探活变成双因子（裸 pid 会被系统复用，
      //     复用后死条目被判"还活着"，本体便去连一个早已不存在的实例——ideClient.mjs:1201-1213）。
      registry.push({
        port, pid: process.pid, time: Date.now(), workspace: WORKSPACE, type: "beilu-cli",
        instanceId: INSTANCE_ID,
        procStart: Math.round(Date.now() - process.uptime() * 1000),
      });
      fs.writeFileSync(activePortsFile, JSON.stringify(registry, null, 2), "utf-8");
      // 写后核验：读回见到自己 = 本轮没被并发覆盖
      const _check = JSON.parse(fs.readFileSync(activePortsFile, "utf-8"));
      _regOk = Array.isArray(_check) && _check.some((e) => e && e.pid === process.pid && e.port === port);
      if (!_regOk) console.warn(`[beilu-cli] 注册表被并发覆盖，第 ${_attempt + 1} 次重写`);
    } catch (e) { wbD("server", "discovery:registerFail", false, e.message, { port }); break; }
  }
  if (!_regOk) wbD("server", "discovery:registerRace", false, "3 次重试后自身条目仍未确认在场", { port });
  wbT("server", "discovery:persisted", { port, workspace: WORKSPACE });
}

function unregisterDiscovery() {
  try {
    const registry = readPortRegistry().filter((e) => e.pid !== process.pid);
    fs.writeFileSync(activePortsFile, JSON.stringify(registry, null, 2), "utf-8");
  } catch { /* best effort */ }
  try {
    const perPort = path.join(TOKEN_DIR, `ide_ws_token_${_actualPort}`);
    if (fs.existsSync(perPort)) fs.unlinkSync(perPort);
  } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════
// 工具执行器
// ═══════════════════════════════════════════════════════════════

const executor = new ToolExecutor(WORKSPACE);
console.log(`[beilu-cli] 工作区: ${WORKSPACE}${SETTINGS_PATH ? "（canonical 单源跟随）" : "（显式/CWD）"}`);
console.log(`[beilu-cli] 已注册 ${executor.getToolList().length} 个工具`);

// 路径屏蔽纵深注入（AI 控制面板「路径配置」→ beilu-files-settings → infra resolveWorkspacePath 单点强制）
{
  const { blocked, anchor } = readBlockedPathsUnion();
  setPathGuards(blocked, anchor);
  if (blocked.length) console.log(`[beilu-cli] 路径屏蔽纵深: ${blocked.length} 条（${blocked.join(", ")}）`);
}

// ═══════════════════════════════════════════════════════════════
// 状态快照（对齐 YonBan extension.ts onGetStatus 的 IdeStatusPayload 形状——
// 本体 workspaceRoot getter 读 status.workspaceFolders[0]，审批门区外轴依赖它）
// ═══════════════════════════════════════════════════════════════

const START_TIME = Date.now();
let _wss = null;
let _settingsWatcher = null;
let _watchDebounce = null;
let _acceptingToolCalls = true;
let _shutdownPromise = null;
const _servers = new Set();
const _serverClosePromises = new Map();
const _activeToolCalls = new Set();
const WS_CLIENT_CLOSE_TIMEOUT_MS = 2000;
const WS_CLIENT_TERMINATE_TIMEOUT_MS = 2000;
const WSS_CLOSE_TIMEOUT_MS = 2000;

function buildStatus() {
  return {
    workspaceFolders: [WORKSPACE],
    activeEditor: undefined,
    diagnosticCount: 0,
    extensionVersion: CLI_VERSION,
    wsClients: _wss?.clients?.size ?? 0,
    uptime: Date.now() - START_TIME,
    appName: "beilu-cli",
  };
}

function broadcast(msg) {
  if (!_wss) return;
  const data = JSON.stringify(msg);
  for (const client of _wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch { /* ignore */ }
    }
  }
}

// canonical 根热跟随：用户在文件面板「打开文件夹」→ beilu-files 落盘 settings →
// 本进程 watch 到变更 → executor.setWorkspaceRoot 收口热切（infra 根+checkpoint 根+shell session 一次到位）
// → broadcastStatus → 本体 case "status" 并入 + reconcile（同值幂等）。
// watch 目录而非单文件：settings 若被「临时文件+rename」原子替换写，单文件 watch 会随旧 inode 失效
// （Windows fs.watch 已知行为），目录级 watch 按 filename 过滤不受替换影响。
if (SETTINGS_PATH) {
  const _settingsAbs = path.resolve(SETTINGS_PATH);
  const _settingsName = path.basename(_settingsAbs);
  try {
    _settingsWatcher = fs.watch(path.dirname(_settingsAbs), (_ev, filename) => {
      if (filename && filename !== _settingsName) return;
      if (!_acceptingToolCalls) return;
      clearTimeout(_watchDebounce);
      _watchDebounce = setTimeout(() => {
        _watchDebounce = null;
        if (!_acceptingToolCalls) return;
        // 路径屏蔽随 settings 变更热刷新（用户在面板改「路径配置」→ 落盘 → 此处同步纵深）
        const { blocked, anchor } = readBlockedPathsUnion();
        setPathGuards(blocked, anchor);
        const next = readCanonicalWorkspace();
        if (next && next !== WORKSPACE) {
          wbT("server", "workspace:hotSwitch", { from: WORKSPACE, to: next });
          WORKSPACE = next;
          executor.setWorkspaceRoot(next);
          broadcast({ type: "status", payload: buildStatus() });
        }
      }, 500);
    });
  } catch (e) { console.warn(`[beilu-cli] settings watch 失败（根变更需重启生效）: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════
// 安全发送（YonBan 经验：send 前检查 readyState 防崩）
// ═══════════════════════════════════════════════════════════════

function safeSend(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(typeof data === "string" ? data : JSON.stringify(data)); return true; }
  catch (e) { console.warn(`[beilu-cli] 发送失败: ${e.message}`); return false; }
}

function beginServerClose(wss) {
  const existing = _serverClosePromises.get(wss);
  if (existing) return existing;
  const closing = new Promise((resolve) => {
    try {
      wss.close((error) => {
        if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve({ closed: true, notListening: true });
        else resolve(error ? { error: error.message } : { closed: true });
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve({ closed: true, notListening: true });
      else resolve({ error: error?.message || String(error) });
    }
  });
  _serverClosePromises.set(wss, closing);
  return closing;
}

function waitForClientsClosed(clients, timeoutMs) {
  const pending = new Set(clients.filter((ws) => ws.readyState !== WebSocket.CLOSED));
  if (!pending.size) return Promise.resolve([]);
  return new Promise((resolve) => {
    let timer = null;
    const listeners = new Map();
    const finish = () => {
      if (timer) clearTimeout(timer);
      for (const [ws, listener] of listeners) ws.off("close", listener);
      resolve([...pending].filter((ws) => ws.readyState !== WebSocket.CLOSED));
    };
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    for (const ws of pending) {
      const listener = () => {
        pending.delete(ws);
        if (!pending.size) finish();
      };
      listeners.set(ws, listener);
      ws.once("close", listener);
    }
  });
}

function settleWithin(promise, timeoutMs, timeoutError) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    Promise.resolve(promise).then(
      (value) => finish({ value }),
      (error) => finish({ error: error?.message || String(error) }),
    );
    timer = setTimeout(() => finish({ error: timeoutError }), timeoutMs);
    timer.unref?.();
  });
}

async function closeWebSocketClients(servers) {
  const clients = [...new Set(servers.flatMap((wss) => [...wss.clients]))];
  const failures = [];
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.close(1001, "server_shutdown"); }
      catch (error) { failures.push(`client_close_failed: ${error.message}`); }
    }
  }
  const afterClose = await waitForClientsClosed(clients, WS_CLIENT_CLOSE_TIMEOUT_MS);
  for (const ws of afterClose) {
    if (ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); }
      catch (error) { failures.push(`client_terminate_failed: ${error.message}`); }
    }
  }
  const afterTerminate = await waitForClientsClosed(afterClose, WS_CLIENT_TERMINATE_TIMEOUT_MS);
  if (afterTerminate.length) failures.push(`clients_not_closed_after_terminate: ${afterTerminate.length}`);
  return { success: failures.length === 0, failures, remaining: afterTerminate.length };
}

/**
 * CLI 子进程的唯一关停 owner。所有信号、stdin shutdown 和 EOF 均进入同一个幂等 promise。
 * 顺序是协议的一部分：拒绝新调用 → 关 watcher/debounce → wss 停止接入 →
 * abort 并等待全局 active tool promises → executor.dispose → 关闭/必要时 terminate clients → 等 wss close。
 */
function shutdown(reason = "shutdown") {
  if (_shutdownPromise) return _shutdownPromise;
  _acceptingToolCalls = false;
  _shutdownPromise = (async () => {
    console.log(`\n[beilu-cli] 正在关闭 (${reason})...`);
    const errors = [];
    const recordFailure = (stage, error) => {
      const message = error?.message || String(error);
      errors.push({ stage, error: message });
      console.error(`[beilu-cli] 关停阶段失败 (${stage}): ${message}`);
    };

    if (_watchDebounce) {
      clearTimeout(_watchDebounce);
      _watchDebounce = null;
    }
    if (_settingsWatcher) {
      try { _settingsWatcher.close(); }
      catch (error) { recordFailure("settings_watcher", error); }
      _settingsWatcher = null;
    }

    const servers = [..._servers];
    const serverClosePromises = servers.map((wss) => {
      try { return beginServerClose(wss); }
      catch (error) {
        recordFailure("wss_stop_accepting", error);
        return Promise.resolve({ error: error?.message || String(error) });
      }
    });
    try { unregisterDiscovery(); }
    catch (error) { recordFailure("discovery_unregister", error); }

    for (const call of _activeToolCalls) {
      try {
        if (!call.controller.signal.aborted) call.controller.abort("server_shutdown");
      } catch (error) { recordFailure("active_tool_abort", error); }
    }
    try {
      while (_activeToolCalls.size) {
        await Promise.allSettled([..._activeToolCalls].map((call) => call.promise));
      }
    } catch (error) {
      recordFailure("active_tool_wait", error);
    }

    try {
      const disposeResult = await executor.dispose();
      if (disposeResult?.success === false) {
        recordFailure("executor_dispose", JSON.stringify(disposeResult.terminationFailures || []));
      }
    } catch (error) {
      recordFailure("executor_dispose", error);
    }

    try {
      const clientResult = await closeWebSocketClients(servers);
      if (clientResult.success === false) recordFailure("ws_clients", clientResult.failures.join("; "));
    } catch (error) {
      recordFailure("ws_clients", error);
    }

    const wssClose = await settleWithin(Promise.all(serverClosePromises), WSS_CLOSE_TIMEOUT_MS, "wss_close_timeout");
    if (wssClose.error) recordFailure("wss_close", wssClose.error);
    else {
      const closeErrors = wssClose.value.filter((result) => result?.error);
      if (closeErrors.length) recordFailure("wss_close", closeErrors.map((entry) => entry.error).join("; "));
    }
    _wss = null;
    try { process.stdin.pause(); }
    catch (error) { recordFailure("stdin_pause", error); }
    if (errors.length) process.exitCode = 1;
    return { reason, success: errors.length === 0, errors };
  })().catch((error) => {
    // 阶段内已各自捕获；这里只保留最后一道进程级失败外显。
    process.exitCode = 1;
    try { process.stdin.pause(); } catch { /* 进程已失败，无更多可拆链资源 */ }
    console.error(`[beilu-cli] 关停协调器失败: ${error?.stack || error}`);
    return { reason, success: false, errors: [{ stage: "shutdown_coordinator", error: error?.message || String(error) }] };
  });
  return _shutdownPromise;
}

// ═══════════════════════════════════════════════════════════════
// WS 服务器（端口自增重试）
// ═══════════════════════════════════════════════════════════════

function startServer(port, attempt) {
  const wss = new WebSocketServer({ port, path: WS_PATH, host: "127.0.0.1" });
  _servers.add(wss);
  wss.once("close", () => _servers.delete(wss));

  wss.on("listening", () => {
    if (!_acceptingToolCalls) {
      void beginServerClose(wss);
      return;
    }
    _wss = wss;
    // ★ 端口确认绑定后才写发现文件（YonBan U2/D3：绝不广播未绑定端口）
    persistDiscovery(port);
    console.log(`[beilu-cli] WS 服务器已启动: ws://127.0.0.1:${port}${WS_PATH}`);
    console.log(`[beilu-cli] Token: ${TOKEN.slice(0, 8)}...`);
    console.log(`[beilu-cli] 等待本体连接...\n`);
  });

  wss.on("connection", (ws, req) => {
    if (!_acceptingToolCalls) {
      ws.close(1012, "server_shutting_down");
      return;
    }
    const connectionId = `cli_ws_${crypto.randomUUID()}`;
    const activeToolCalls = new Map();
    // token 认证（与 YonBan 同：不匹配 close 4001，本体按 4001 退避重连）
    let clientToken = "";
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      clientToken = url.searchParams.get("token") || "";
    } catch { /* malformed URL */ }

    if (clientToken !== TOKEN) {
      wbD("server", "connect:authReject", false, `token 不匹配 (got ${clientToken.slice(0, 8)}..., expect ${TOKEN.slice(0, 8)}...)`, { port });
      ws.close(4001, "Invalid token");
      return;
    }

    console.log(`[beilu-cli] ✓ 本体已连接`);
    wbT("server", "connect:established", { port });

    // hello 握手（形状对齐 YonBan IdeWsServer:301-311：本体读 instanceId/extensionVersion/port/status）
    safeSend(ws, {
      type: "hello",
      payload: {
        // 自报编号：本体 ideClient.mjs:2265-2267 从 hello 里取它当窗口身份。
        //   注册表里也写了同一个值——两处不是双源：注册表是"连之前的发现"，hello 是"连上后的身份确认"，
        //   同一实例同一编号，本体两侧比对得上才能做换端口重连的绑定回迁。
        instanceId: INSTANCE_ID,
        extensionVersion: CLI_VERSION,
        appName: "beilu-cli",
        port,
        uptime: Date.now() - START_TIME,
        status: buildStatus(),
      },
    });

    ws.on("message", async (raw) => {
      // JSON 解析容错（二进制/乱码消息不崩进程）
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch {
        console.warn(`[beilu-cli] 收到非 JSON 消息，忽略 (${raw.toString().slice(0, 50)})`);
        return;
      }

      switch (msg.type) {
        case "tool_call": {
          const payload = msg.payload || {};
          const id = msg.id || payload.id || `cli_${Date.now()}`;
          const tool = payload.tool || "";
          const params = payload.params || {};
          const traceId = payload.traceId;
          const transport = payload.transport && typeof payload.transport === "object"
            && !Array.isArray(payload.transport)
            ? payload.transport
            : {};
          // [窗口id 0726] 指令信封携带的窗口/线 id（后端 ideClient 传导层单点注入）→ 透传执行器池入口识别
          const chatid = typeof payload.chatid === "string" ? payload.chatid : "";

          if (!_acceptingToolCalls) {
            safeSend(ws, { type: "tool_result", id, payload: { id, success: false, error: "server_shutting_down" } });
            return;
          }

          if (!tool) {
            console.warn(`[beilu-cli] ← tool_call 缺少 tool 字段`);
            safeSend(ws, { type: "tool_result", id, payload: { id, success: false, error: "tool_call 缺少 tool 字段" } });
            return;
          }
          if (activeToolCalls.has(id)) {
            safeSend(ws, {
              type: "tool_result",
              id,
              payload: { id, success: false, error: `duplicate_tool_call_id: ${id}` },
            });
            return;
          }

          const allTools = executor.getToolList();
          if (!allTools.includes(tool)) {
            console.warn(`[beilu-cli] ← 未知工具: ${tool} (可用: ${allTools.length} 个)`);
            safeSend(ws, { type: "tool_result", id, payload: { id, success: false, error: `未知工具: ${tool}。可用工具: ${allTools.join(", ")}` } });
            return;
          }

          const startedAt = new Date();
          safeSend(ws, {
            type: "tool_started",
            id,
            payload: {
              id,
              tool,
              chatid: chatid || null,
              startedAt: startedAt.toISOString(),
            },
          });

          const paramPreview = JSON.stringify(params);
          console.log(`[beilu-cli] ← ${tool}(${paramPreview.length > 120 ? paramPreview.slice(0, 100) + "..." : paramPreview})`);
          const t0 = startedAt.getTime();
          const lifecycleController = new AbortController();
          const callState = { id, controller: lifecycleController, promise: null };
          activeToolCalls.set(id, callState);
          _activeToolCalls.add(callState);
          callState.promise = (async () => {
            try {
              const result = await executor.execute({
                id,
                tool,
                params,
                traceId,
                chatid,
                transport,
                connectionId,
              }, {
                signal: lifecycleController.signal,
                onProgress: (progress) => {
                  if (activeToolCalls.get(id) !== callState) return;
                  safeSend(ws, {
                    type: "tool_progress",
                    id,
                    payload: {
                      id,
                      tool,
                      chatid: chatid || null,
                      progress,
                      occurredAt: new Date().toISOString(),
                    },
                  });
                },
              });
              const ms = Date.now() - t0;
              result.duration = ms;
              const ok = result.success !== false;
              console.log(`[beilu-cli] → ${ok ? "✓" : "✗"} ${tool} (${ms}ms)${ok ? "" : " — " + (result.error || "").slice(0, 100)}`);
              if (!ok) wbD("server", "toolCall:fail", false, `${tool}: ${(result.error || "").slice(0, 150)}`, { id, ms });
              safeSend(ws, { type: "tool_result", id, payload: result });
            } catch (e) {
              const ms = Date.now() - t0;
              wbD("server", "toolCall:exception", false, `${tool} 异常: ${e.message}`, { id, ms });
              safeSend(ws, { type: "tool_result", id, payload: { id, success: false, error: `工具执行异常: ${e.message}`, duration: ms } });
            } finally {
              if (activeToolCalls.get(id) === callState) activeToolCalls.delete(id);
              _activeToolCalls.delete(callState);
            }
          })();
          await callState.promise;
          break;
        }

        case "ping":
          // 心跳响应（本体 _startHeartbeat 每 30s 发 ping、按 pong 到达判活；对齐 YonBan:362 回带时间戳）
          safeSend(ws, { type: "pong", payload: { timestamp: Date.now() } });
          break;

        case "question": {
          // 无头后端无交互界面：诚实回「未回答」（answered:false → 本体 askQuestion 走取消路径）。
          // 禁终端 y/n：①本进程由插件 spawn，stdio[0]=ignore，readline 永远无人回答=悬死；
          // ②审批裁决在 tool_call 发出前已由本体审批卡完成，执行器自设第二审批层=越权（凛倾 0722 定性）。
          const qId = msg.id || msg.payload?.id;
          wbD("server", "question:headless", false, "question 到达无头后端，回未回答（提问请在 beilu 网页端处理）", { id: qId });
          safeSend(ws, {
            type: "question_answer",
            id: qId,
            payload: { id: qId, answer: "", answered: false, error: "CLI 后端无交互界面，请在 beilu 网页端回答" },
          });
          break;
        }

        default:
          // 未知消息类型静默忽略（协议扩展时不崩旧版本）
          break;
      }
    });

    ws.on("close", (code, reason) => {
      for (const call of activeToolCalls.values()) {
        if (!call.controller.signal.aborted) call.controller.abort("ws_close");
      }
      console.log(`[beilu-cli] 本体断开连接 (code=${code}${reason ? ", reason=" + reason : ""})`);
    });

    ws.on("error", (err) => {
      for (const call of activeToolCalls.values()) {
        if (!call.controller.signal.aborted) call.controller.abort("ws_error");
      }
      console.error(`[beilu-cli] WS 连接错误: ${err.message}`);
    });
  });

  wss.on("error", (err) => {
    if (!_acceptingToolCalls) return;
    if (err.code === "EADDRINUSE") {
      if (attempt < MAX_PORT_RETRIES) {
        const nextPort = port + 1;
        wbD("server", "port:retry", false, `端口 ${port} 被占用，尝试 ${nextPort}`, { attempt: attempt + 1, max: MAX_PORT_RETRIES });
        void beginServerClose(wss);
        startServer(nextPort, attempt + 1);
      } else {
        console.error(`[beilu-cli] 端口 ${BASE_PORT}-${port} 全部被占用，${MAX_PORT_RETRIES} 次重试失败`);
        process.exitCode = 1;
        void shutdown("port_exhausted");
      }
    } else {
      console.error(`[beilu-cli] 服务器错误: ${err.message}`);
      process.exitCode = 1;
      void shutdown("server_error");
    }
  });
}

function installShutdownInputs() {
  let stdinBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    const lines = stdinBuffer.split(/\r?\n/);
    stdinBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim() === "shutdown") void shutdown("stdin_shutdown");
    }
  });
  process.stdin.once("end", () => {
    if (stdinBuffer.trim() === "shutdown") void shutdown("stdin_shutdown");
    else void shutdown("stdin_eof");
  });
  process.stdin.once("error", (error) => {
    console.error(`[beilu-cli] stdin 错误: ${error.message}`);
    void shutdown("stdin_error");
  });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  // spawn 子进程的 stdin 是 pipe；resume 后 EOF 才能成为父进程消失的关停信号。
  process.stdin.resume();
}

installShutdownInputs();
startServer(BASE_PORT, 0);
