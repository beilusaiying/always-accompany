/**
 * beilu-eye — 桌面截图感知 + Electron 桌宠进程管理。不管截图的前端消费/发送（那是 index-eye.mjs 的事）。
 *
 * 链路：
 *   截图注入: Python beilu_eye.py POST /api/eye/inject → endpoints.mjs(令牌闸+黑白名单) → injection_state.setPendingInjection
 *            → 前端 pollEyeStatus 轮询 → consumePendingInjection → addUserReply(files) → AI 看到图片
 *   桌宠:    web POST /api/eye/pet-settings / SetData('pet-set-enabled') → savePetSettingsStore 单 funnel
 *            → onPetSettingsChange 订阅立即 ensurePetRunning(基线/冷却同步);reconcilePet(4s)只作崩溃自愈对账
 *
 * 影响：拉起/杀死 Python 截图进程 + Electron 桌宠进程；注册/回收启动令牌(registerPetToken/revokePetToken)
 * 相交：← endpoints.mjs 的 /api/eye/* 路由群（令牌闸鉴权、黑白名单、归档）
 *       → injection_state.mjs（per-user pending 分区 + 令牌注册表 + 进程状态 + 配置存储）
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import info from "../../../../public/parts/plugins/beilu-eye/info.json" with { type: "json" }; // T3a·3.7: part 元数据留原位
import { wbT, wbD } from "../../../../server/wbStub.mjs";
import {
  consumePendingInjection,
  getPetClientSeenAgoMs,
  getPetClientSeenAtMs,
  hasActiveInteractionLease,
  hasPendingInjection,
  loadPetSettingsStore,
  onInteractionLeaseChange,
  onPetSettingsChange,
  registerPetToken,
  resolveHeartbeatConfirm,
  resolvePetModelName,
  resolveStopOutcome,
  revokeInteractionLeases,
  revokePetToken,
  savePetSettingsStore,
  setEyeProcessState,
  setPendingInjection,
  setPetRuntimeState,
  STOP_ACK_DEADLINE_MS,
} from "./injection_state.mjs";

// 桌宠拥有者 username：单桌宠进程归实例 owner（getOwnerUsername=createdAt 最早用户）。
// orb per-user 隔离用此 username 作令牌绑定键。auth.mjs 在 server 域：beilu-eye→plugins→parts→public→src→server。
// 惰性导入避免 bootstrap 静态环，但桌宠签发令牌前必须 await 完成；旧实现只触发 import 就立即
// 返回 ""，第一次启动会把 002 的桌宠绑定到 _default，继而谎报“角色未绑定”。
let _authMod = null;
const _authReady = import(new URL("../security/auth.mjs", import.meta.url).href)
  .then((mod) => { _authMod = mod; return mod; })
  .catch((error) => {
    console.error("[beilu-eye] owner 鉴权模块加载失败:", error?.message || error);
    return null;
  });
function ownerUsername() {
  try { return (_authMod?.getOwnerUsername?.()) || ""; } catch { return ""; }
}
async function requireOwnerUsername() {
  await _authReady;
  const username = ownerUsername();
  if (!username) throw new Error("无法确定桌宠所属用户，拒绝以空用户签发令牌");
  return username;
}

// DIAG 探针默认关（同 MVU M10 范式）：原无条件 console.log 把 message 正文前50字 + eyeStatus dump 到控制台(隐私/噪声)。需排查时 env BEILU_EYE_DIAG=1 开启；结构化追踪走 wbT 不受影响。
// 0716 死标记接线：未设 env 时既有探针改走 diagLogger eye 模块（BEILU_DIAG=eye + debug 级可开），env=1 保持旧的无门槛直出。
import { createDiag } from "../../../../server/diagLogger.mjs";
const _eyeD = createDiag("eye");
const _EYE_DIAG = (() => { try { return globalThis.Deno?.env?.get?.("BEILU_EYE_DIAG") === "1"; } catch { return false; } })();
function _eyeDiag(...args) { if (_EYE_DIAG) console.log(...args); else _eyeD.debug(...args); }

// ============================================================
// beilu-eye 插件 — 桌面截图临时注入
//
// 职责：
// - 自动启动/管理 Python 桌面截图客户端
// - 接收来自 Python 脚本的截图数据（通过 /api/eye/inject → 共享状态）
// - 截图通过前端 pollEyeStatus → addUserReply(files) 路径发送（GetPrompt 已移除，见文件尾）
// - 截图在 AI 看到一次后自动清除，不留在聊天记录或后续上下文中
// ============================================================

// 路径计算
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// beilu-eye 位于 src/public/parts/plugins/beilu-eye/
// 项目根目录(beilu-always accompany)在 5 层之上：
//   beilu-eye → plugins → parts → public → src → [项目根]
const projectRoot = resolve(__dirname, "..", "..", "..", "..", "..");
const desktopEyeDir = resolve(projectRoot, "desktop-eye");
// Electron 桌宠二进制(npm i 后)。缺失=先尝试自动 npm i(联网自愈),仍缺才降级(不崩,提示用户装)。
// 二进制名按平台定：原实现硬编码 electron.exe,Linux/mac 上桌宠永远判 missing(跨平台死点,2026-07-19 修)。
const electronExe = resolve(
  desktopEyeDir, "node_modules", "electron", "dist",
  ...(Deno.build.os === "windows" ? ["electron.exe"]
    : Deno.build.os === "darwin" ? ["Electron.app", "Contents", "MacOS", "Electron"]
    : ["electron"]),
);

// Python 子进程
let eyeProcess = null;
let eyeStatus = "stopped"; // 'stopped' | 'checking' | 'starting' | 'running' | 'error'
let eyeError = null;
// Python 截图客户端启动令牌(inject per-user 鉴权,A4)：拉起 Python 时随机生成 +
//   registerPetToken(token, ownerUsername)，env 传 BEILU_PET_TOKEN；killPythonEye/退出时 revokePetToken 回收。
//   与 Electron 桌宠的 _petToken 各自独立(各一进程一令牌)，都绑定到 owner。
//   端点 /api/eye/inject 据此反解 username 只给令牌所属 user 推图(丢弃 payload 的 username)。
let _pythonToken = null;

// Electron 桌宠子进程(T1 接入本体:与 Python 截图眼【并存】。
//   悬浮球已删除(凛倾 2026-07-09):Python 任何模式都不画球,只留 Alt+Shift+S/托盘;可见悬浮物=Live2D 桌宠。)
let petProcess = null;
// D5 §2.1 状态机(2026-08-04 结构版):
//   'stopped'|'installing'|'missing'|'starting'|'waiting_heartbeat'|'running'|'adopting'|'adopted'
//   |'stopping'|'error'|'error_unconfirmed'
//   spawn 后不再直接置 running——先 waiting_heartbeat,10s 内收到本代进程的 pet-token 心跳才 running;
//   超窗记 error_unconfirmed(进程保留,心跳迟到仍可回升 running,不谎报就绪)。
let petStatus = "stopped";
// 桌宠启动令牌(orb per-user 鉴权)：拉起时随机生成 + registerPetToken(token, ownerUsername)，env 传桌宠；
// killElectronPet 时 revokePetToken 回收。一次一进程一令牌，进程退出即作废。
let _petToken = null;
let _petOwner = "";
let _petAdoptedAt = 0;
let _petSpawnedAt = 0; // 本代 child spawn 时刻(心跳确认基准:露面时刻>=spawn 时刻才算本代心跳)
const _PET_HANDOFF_EXIT_CODE = 73;
const _PET_ADOPT_GRACE_MS = 8000;
const _PET_HEARTBEAT_STALE_MS = 10000;

// 状态迁移单点:改 petStatus 一律经此,顺手推运行时镜像(injection_state)供 DTO/端点只读消费。
// 白盒定位点:每次迁移留痕(from→to)——桌宠生命周期排查看 eye:pet status_transition 一条线即可复现全程。
function _setPetStatus(status, extra = {}) {
  if (petStatus !== status) wbT(null, "eye:pet", "status_transition", { from: petStatus, to: status, pid: petProcess?.pid ?? null });
  petStatus = status;
  setPetRuntimeState({ status, pid: petProcess?.pid ?? null, ...extra });
}

// spawn 后心跳确认(WAITING_HEARTBEAT → RUNNING / ERROR_UNCONFIRMED):对账周期与状态读点调用,幂等。
function _confirmHeartbeatIfDue() {
  if (petStatus !== "waiting_heartbeat" && petStatus !== "error_unconfirmed") return;
  if (!petProcess || !_petSpawnedAt) return;
  const outcome = resolveHeartbeatConfirm({
    spawnedAt: _petSpawnedAt,
    heartbeatSeenAt: _petOwner ? getPetClientSeenAtMs(_petOwner) : null,
    now: Date.now(),
  });
  if (outcome === "running" && petStatus !== "running") {
    wbT(null, "eye:pet", "heartbeat_confirmed", { pid: petProcess.pid });
    _setPetStatus("running", { error: null });
  } else if (outcome === "unconfirmed" && petStatus === "waiting_heartbeat") {
    wbD(null, "eye:pet", "heartbeat_unconfirmed", false, "spawn 后 10s 未收到本代 pet-token 心跳(进程保留,心跳到达可回升)", { pid: petProcess.pid });
    _setPetStatus("error_unconfirmed", { error: "spawn 后 10s 内未收到桌宠心跳确认" });
  }
}

function petRuntimeHealthy() {
  _confirmHeartbeatIfDue();
  // 本代 child 存活即算"在跑"(running/等心跳/心跳未确认都不该被自愈重拉——进程真实存在,重拉=双实例churn)
  if (petProcess && (petStatus === "running" || petStatus === "waiting_heartbeat" || petStatus === "error_unconfirmed")) return true;
  if (petStatus !== "adopting" && petStatus !== "adopted") return false;
  const seenAgo = _petOwner ? getPetClientSeenAgoMs(_petOwner) : null;
  if (seenAgo !== null && seenAgo <= _PET_HEARTBEAT_STALE_MS) {
    if (petStatus !== "adopted") _setPetStatus("adopted");
    return true;
  }
  return petStatus === "adopting" && Date.now() - _petAdoptedAt <= _PET_ADOPT_GRACE_MS;
}

/** 读当前桌宠开关(默认关闭,但用户开/关已持久化=操作储存)。 */
function petEnabled() {
  try { return !!loadPetSettingsStore(projectRoot).petEnabled; }
  catch { return false; }
}

/** effective desired 单点(D5 §2.1):显式持久开关 || 活跃互动租约。进程生杀只看它。 */
function effectiveDesired() {
  return petEnabled() || hasActiveInteractionLease();
}
/** 读当前桌宠选用模型(0722 去指名硬编码:空=按可用性解析首个图片包,无包返 ""→renderer 字典首项/兜底)。 */
function petModel() {
  try { return resolvePetModelName(projectRoot); }
  catch { return ""; }
}

// 同步初始状态到共享模块（供 endpoints.mjs 的 /api/eye/getdata 使用）
setEyeProcessState({
  status: eyeStatus,
  error: eyeError,
  desktopEyeDir: desktopEyeDir,
});

// Python 眼拉起链(checkPythonScriptExists/checkPythonDeps/launchPythonEye/ensurePythonEyeRunning)
// 已整链删除(凛倾 2026-07-12"已经废弃的beilu eye……直接替换beilueye"):
// 截图全链由桌宠 Electron 进程接管(desktop-eye/autoCapture.js 移植了 auto_capture_and_send 全部算法)。
// killPythonEye 保留:清理本后端此前拉起的残留进程(Unload/stop/restart 入口仍可扫尾)。

/**
 * 异步管道输出（非阻塞）
 */
async function pipeOutput(stream, prefix) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true }).trim();
      // 噪声收敛: 子进程正常 stdout 降 debug(不灌监控面板), 仅错误流(ERR)进面板
      if (text) { if (prefix.includes("ERR")) console.error(prefix, text); else console.debug(prefix, text); }
    }
  } catch {
    /* 进程已结束 */
  }
}

/**
 * 关闭 Python 子进程
 * Windows 上必须用 SIGKILL（映射到 TerminateProcess），
 * 因为 SIGTERM 不会终止 tkinter mainloop 的 GUI 进程
 */
function killPythonEye() {
  // 令牌随进程作废：即使 eyeProcess 已自行退出(status.then 置 null)，也回收令牌防泄漏（同 killElectronPet 范式）。
  if (_pythonToken) { try { revokePetToken(_pythonToken); } catch { /* ignore */ } _pythonToken = null; }
  if (eyeProcess) {
    try {
      // Windows 上 SIGTERM 无法终止 tkinter GUI 进程
      // 使用 SIGKILL（在 Windows 上映射为 TerminateProcess）
      eyeProcess.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    eyeProcess = null;
    eyeStatus = "stopped";
    setEyeProcessState({ status: eyeStatus, error: null });
    wbT(null, "eye:python", "killed", null);
    console.log("[beilu-eye] Python 进程已终止");
  }
}

// ============================================================
// Electron 桌宠进程(T1 接入本体,与 Python 截图眼并存)
// 默认关闭(petEnabled);用户开/关持久化(操作储存),仅当 petEnabled=true 才拉起。
// electron 缺失=优雅降级:不崩,log 提示用户 `cd desktop-eye && npm i`。
// ============================================================

/**
 * 启动 Electron 桌宠(Live2D/前端美化兜底 + 下方对话框)。electron 缺失则降级不崩。
 *
 * 链路：ensurePetRunning → 本函数 → Deno.Command spawn → electron dist/electron.exe
 * 影响：
 *   - 生成随机令牌 _petToken 并 registerPetToken(token, ownerUsername)
 *   - 令牌经 env BEILU_PET_TOKEN 传给桌宠 → orb 请求带 x-pet-token → 端点反解 username
 *   - 异步监听进程退出：status.then 清理 petProcess + revokePetToken
 * 约束：electronExe 不存在时 petStatus='missing'，不崩，提示用户安装
 */
// Electron 自动安装(联网自愈,去重共享同一 promise——形状同 crawlProbe.ensureBrowsers)。
// cwd=desktop-eye 用其自有 package.json,与项目根清单/overrides 无关;离线或失败=保持既有优雅降级。
let _electronInstalling = null;
// 进程启动单飞：顶层 autostart、part Load、设置订阅和 4s reconcile 可能同时进入。
// 没有本闸时两个调用会一起越过 await Deno.stat 前的 petProcess 检查，产生双 Electron；
// 后启动者因单例锁退出并把仍存活的前一实例状态清空，随后每 30s 无限重拉。
let _petLaunchPromise = null;
// 失败冷却:离线时自愈对账每 30s 重进,若每次都真跑 npm=持续进程churn+双行日志刷屏。
// 失败后 10min 内自愈路径静默跳过;用户显式开关桌宠(边沿/SetData)清零冷却=立即重试。
let _electronInstallFailAt = 0;
const _ELECTRON_INSTALL_COOLDOWN_MS = 10 * 60 * 1000;
function ensureElectronInstalled() {
  if (_electronInstalling) return _electronInstalling;
  if (Date.now() - _electronInstallFailAt < _ELECTRON_INSTALL_COOLDOWN_MS) return Promise.resolve(false);
  _electronInstalling = (async () => {
    console.log("[beilu-eye] Electron 未安装,尝试自动安装 (npm install, 目录: desktop-eye)...");
    try {
      const cmd = new Deno.Command("npm", {
        args: ["install", "--no-audit", "--no-fund"],
        cwd: desktopEyeDir,
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr);
        console.warn(`[beilu-eye] Electron 自动安装失败 (code ${output.code}): ${stderr.slice(0, 200)}`);
        _electronInstallFailAt = Date.now();
        return false;
      }
      try { await Deno.stat(electronExe); } catch {
        console.warn("[beilu-eye] npm install 完成但 electron 二进制仍未检测到");
        _electronInstallFailAt = Date.now();
        return false;
      }
      console.log("[beilu-eye] Electron 自动安装完成");
      return true;
    } catch (e) {
      console.warn("[beilu-eye] Electron 自动安装异常(离线或 npm 不可用):", e.message?.slice(0, 200));
      _electronInstallFailAt = Date.now();
      return false;
    } finally {
      _electronInstalling = null;
    }
  })();
  return _electronInstalling;
}

async function _launchElectronPetOnce() {
  if (petRuntimeHealthy()) return;
  // 优雅自举:检查 electron 二进制是否存在;缺失先走自动安装(联网自愈),仍缺才降级
  try {
    await Deno.stat(electronExe);
  } catch {
    _setPetStatus("installing", { error: null });
    const installed = await ensureElectronInstalled();
    if (!installed) {
      _setPetStatus("missing", { error: "Electron 未安装且自动安装未成功(离线?)" });
      wbD(null, "eye:pet", "electron_missing", false, "Electron 未安装且自动安装未成功", { electronExe });
      console.warn("[beilu-eye] 桌宠已开启但 Electron 未装上(离线?)。联网后重开桌宠即自动重装,或手动: cd desktop-eye && npm i");
      return;
    }
  }
  // 安装/鉴权等待期间用户可能已撤回全部意愿(显式关+lease 释放)或插件已 Unload，禁止迟到启动。
  // 判据=effectiveDesired(D5 §2.1):互动 lease 与显式开关同为合法启动来源。
  if (!effectiveDesired() || _petUnloaded) return;
  _setPetStatus("starting", { error: null });
  console.log("[beilu-eye] 启动 Electron 桌宠(并存)...");
  let token = null;
  try {
    const port = (typeof Deno !== "undefined" && Deno.env.get("BEILU_PORT")) || "1314";
    // orb per-user 鉴权令牌：每次拉起生成新随机 token，绑定本桌宠拥有者 username。
    // 桌宠经 env 持令牌 → orb 请求带 x-pet-token → 端点反解出 username 只访问该 user 的 orb 槽。
    const petOwner = await requireOwnerUsername();
    if (!effectiveDesired() || _petUnloaded) return;
    token = crypto.randomUUID();
    registerPetToken(token, petOwner);
    const command = new Deno.Command(electronExe, {
      args: ["."],
      cwd: desktopEyeDir,
      env: { BEILU_PORT: String(port), BEILU_PET_MODEL: petModel(), BEILU_PET_TOKEN: token },
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    _petToken = token;
    _petOwner = petOwner;
    _petAdoptedAt = 0;
    petProcess = child;
    _petSpawnedAt = Date.now();
    // D5 §2.1:spawn ≠ 已就绪。先 waiting_heartbeat,首个本代 pet-token 心跳(≤10s)才 RUNNING;
    // 超窗 error_unconfirmed(见 _confirmHeartbeatIfDue),不把"进程拉起了"谎报成"桌宠已就绪"。
    _setPetStatus("waiting_heartbeat", { error: null });
    wbT(null, "eye:pet", "spawn_ok", { pid: child.pid, owner: petOwner });
    console.log("[beilu-eye] Electron 桌宠已启动 (PID:", child.pid, ", owner:", petOwner, "),等待心跳确认...");
    child.status
      .then((status) => {
        console.log("[beilu-eye] Electron 桌宠进程已退出, code:", status.code, "pid:", child.pid);
        if (status.code === _PET_HANDOFF_EXIT_CODE && petProcess === child && _petToken === token) {
          // 已有跨后端重启的桌宠拿到 second-instance 新令牌；当前短命子进程只负责交接。
          // 令牌必须保留给被接管实例，后续以 pet-token 请求的 lastSeen 判断真实存活。
          petProcess = null;
          _petAdoptedAt = Date.now();
          _setPetStatus("adopting");
          wbT(null, "eye:pet", "adopt_handoff", { owner: petOwner });
          return;
        }
        try { revokePetToken(token); } catch { /* ignore */ }
        if (petProcess === child) {
          petProcess = null;
          _setPetStatus("stopped");
        }
        if (_petToken === token) { _petToken = null; _petOwner = ""; _petAdoptedAt = 0; }
      })
      .catch(() => {
        try { revokePetToken(token); } catch { /* ignore */ }
        if (petProcess === child) {
          petProcess = null;
          _setPetStatus("stopped");
        }
        if (_petToken === token) { _petToken = null; _petOwner = ""; _petAdoptedAt = 0; }
      });
    pipeOutput(child.stdout, "[pet]");
    pipeOutput(child.stderr, "[pet ERR]");
  } catch (err) {
    if (token) { try { revokePetToken(token); } catch { /* ignore */ } }
    if (_petToken === token) { _petToken = null; _petOwner = ""; _petAdoptedAt = 0; }
    wbD(null, "eye:pet", "spawn_error", false, "桌宠启动失败", { err: err.message });
    console.error("[beilu-eye] Electron 桌宠启动失败:", err.message);
    petProcess = null;
    _setPetStatus("error", { error: err.message });
  }
}

function launchElectronPet() {
  if (petRuntimeHealthy()) return Promise.resolve();
  if (_petLaunchPromise) return _petLaunchPromise;
  _petLaunchPromise = _launchElectronPetOnce().finally(() => { _petLaunchPromise = null; });
  return _petLaunchPromise;
}

/** 立即终止(SIGKILL)——仅 Unload/进程收尾路径使用(整插件退场必须即时,不适用 10s 优雅协议)。
 *  用户可见的"关闭桌宠/停止互动"一律走 stopElectronPetGraceful(有 ack,不谎报 stopped)。 */
function killElectronPet() {
  // 令牌随进程作废：即使 petProcess 已自行退出(status.then 置 null)，也回收令牌防泄漏。
  if (_petToken) { try { revokePetToken(_petToken); } catch { /* ignore */ } _petToken = null; }
  _petOwner = "";
  _petAdoptedAt = 0;
  if (petProcess) {
    try { petProcess.kill("SIGKILL"); } catch { /* ignore */ }
    petProcess = null;
    _setPetStatus("stopped");
    wbT(null, "eye:pet", "killed", null);
    console.log("[beilu-eye] Electron 桌宠进程已终止");
  }
  if (!petProcess && petStatus !== "stopped") _setPetStatus("stopped");
}

// ── 优雅停止(D5 §2.1:停止 deadline 10s,先请求退出,确认 exit/心跳消失才置 stopped) ──
// 优雅通道=既有 pet-settings 轮询:调用前提是 effectiveDesired 已为 false,Electron 每 orbPollSec(≤3s)
// 轮询 GET /api/eye/pet-settings 见 effective=false 自行 app.quit()(desktop-eye/main.js _syncPetSettingsFromBeilu)。
// ack 判据(resolveStopOutcome 纯函数,tests/pet_lifecycle_contract_test.mjs 覆盖):
//   本代 child → child.status 落定;到期未退 → 升级 SIGKILL 再等 status 落定(有界)。
//   接管实例(无句柄) → 心跳消失;到期心跳仍新鲜 → 记 stop_timeout,状态保持 stopping(不谎报),对账继续观察。
let _petStopPromise = null;
function stopElectronPetGraceful(reason = "desired-off") {
  if (!petProcess && petStatus === "stopped") return Promise.resolve({ stopped: true, alreadyStopped: true });
  if (_petStopPromise) return _petStopPromise;
  _petStopPromise = _stopElectronPetOnce(reason).finally(() => { _petStopPromise = null; });
  return _petStopPromise;
}
async function _stopElectronPetOnce(reason) {
  const child = petProcess;
  const token = _petToken;
  const owner = _petOwner;
  const requestedAt = Date.now();
  _setPetStatus("stopping", { stopRequestedAt: requestedAt, stopDeadlineMs: STOP_ACK_DEADLINE_MS, stopTimeout: false, error: null });
  wbT(null, "eye:pet", "stop_requested", { reason, pid: child?.pid ?? null, adopted: !child });
  let childExited = false;
  if (child) child.status.then(() => { childExited = true; }, () => { childExited = true; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let escalated = false;
  while (true) {
    // 停止期间意愿翻回(用户又开/新互动 lease):中止停止,交回 ensure 走启动线(child 若已死会重拉)
    if (effectiveDesired() && !_petUnloaded) {
      wbT(null, "eye:pet", "stop_cancelled_desired_back", { reason });
      if (child && !childExited) { _setPetStatus(childExited ? "stopped" : "waiting_heartbeat"); return { stopped: false, cancelled: true }; }
      _setPetStatus("stopped");
      return { stopped: !child || childExited, cancelled: true };
    }
    const outcome = resolveStopOutcome({
      childExited,
      hasChild: !!child,
      heartbeatAgoMs: owner ? getPetClientSeenAgoMs(owner) : null,
      heartbeatStaleMs: _PET_HEARTBEAT_STALE_MS,
      elapsedMs: Date.now() - requestedAt,
    });
    if (outcome === "confirmed") break;
    if (outcome === "escalate_kill" && !escalated) {
      escalated = true;
      wbD(null, "eye:pet", "stop_escalate_kill", false, "10s 内未优雅退出,升级 SIGKILL(仍等 exit 落定后才置 stopped)", { pid: child?.pid });
      try { child?.kill("SIGKILL"); } catch { /* ignore */ }
      const t0 = Date.now();
      while (!childExited && Date.now() - t0 < 3000) await sleep(100);
      break; // TerminateProcess 后 status 必然落定;3s 兜底防句柄异常挂死
    }
    if (outcome === "timeout") {
      // 接管实例仍在发心跳:不能宣布 stopped。记录 stop_timeout,保持 stopping,4s 对账继续观察
      // (它下一次 pet-settings 轮询会看到 effective=false 自退;心跳一消失即由对账收尾置 stopped)。
      setPetRuntimeState({ status: "stopping", stopTimeout: true, error: "stop_timeout: 10s 内接管实例未确认退出(心跳仍新鲜),继续观察" });
      wbD(null, "eye:pet", "stop_timeout", false, "接管实例 10s 未确认退出,状态保持 stopping", { owner });
      return { stopped: false, stopTimeout: true };
    }
    await sleep(250);
  }
  // 已确认退出:收尾(child.status 处理器可能已抢先清理,全部幂等)
  if (token && _petToken === token) { try { revokePetToken(token); } catch { /* ignore */ } _petToken = null; }
  if (!child || petProcess === child) petProcess = null;
  _petOwner = "";
  _petAdoptedAt = 0;
  _setPetStatus("stopped", { error: null, stopTimeout: false });
  wbT(null, "eye:pet", "stop_confirmed", { reason, escalated });
  console.log("[beilu-eye] Electron 桌宠已确认停止" + (escalated ? "(升级 SIGKILL)" : "(优雅退出)"));
  return { stopped: true, escalated };
}

/** 确保桌宠进程与 effective desired(显式开关 || 互动 lease)一致:true 拉起、false 优雅停止。 */
async function ensurePetRunning() {
  if (effectiveDesired()) {
    if (petStatus === "stopping") return; // 停止收束中:等 settle,由停止环的意愿回翻检测/下轮对账接手
    if (!petRuntimeHealthy()) await launchElectronPet();
  } else if (petProcess || petRuntimeHealthy() || petStatus === "stopping") {
    await stopElectronPetGraceful();
  } else {
    // 无进程无接管:直接归位(回收可能残留的令牌)
    killElectronPet();
  }
}

// 桌宠意愿对账:意愿【变更】由两条订阅即时处理(petEnabled 落盘 funnel + 互动 lease 变更),
// 本周期对账只剩崩溃自愈职责(电平触发:应跑而没跑=补拉)+ stopping 收尾观察 + 订阅遗漏兜底边沿。
// 基线从 petEnabled 升级为 effectiveDesired(D5 §2.1):lease 与显式开关同为合法意愿源。
let _lastDesired = null;
let _lastSelfHealAt = 0;
let _petUnloaded = false; // Unload(有意关闭)抑制自愈复活;Load 解除
// 写侧单 funnel 订阅:petEnabled 一落盘(无论 web POST/SetData/托盘回写哪个入口)立即同步基线+清冷却+进程生杀。
// 基线先行同步=reconcilePet 不会对同一变更二次动作(边沿判定已相等)。
onPetSettingsChange((patch) => {
  if (!patch || typeof patch !== "object" || !("petEnabled" in patch)) return;
  const on = !!patch.petEnabled;
  wbT(null, "eye:pet", "settings_change", { on });
  // 用户显式关闭=接管(D5 §2.2/iter6 语义升级):互动租约一并吊销——session 继续跑(文字陪伴不受影响),
  // 桌宠按用户显式意愿停止;停止互动时 release 已吊销的 lease 幂等无害。
  if (!on) revokeInteractionLeases("explicit-off");
  _lastDesired = effectiveDesired();
  if (on) _electronInstallFailAt = 0; // 显式开=清安装冷却,立即允许重试自动安装(原语义只在 SetData 入口,现全入口)
  return ensurePetRunning();
});
// 互动租约变更(acquire/release/revoke)即时生杀——与 pet-settings 订阅同型,零轮询延迟。
onInteractionLeaseChange((event) => {
  wbT(null, "eye:pet", "lease_change", { type: event?.type, count: event?.count });
  _lastDesired = effectiveDesired();
  if (event?.type === "acquire") _electronInstallFailAt = 0; // 互动要求桌宠=同显式开,清安装冷却
  return ensurePetRunning();
});
async function reconcilePet() {
  const desired = effectiveDesired();
  // stopping 收尾观察:接管实例 stop_timeout 后由这里持续复查(心跳消失即置 stopped;意愿回翻由停止环自理)。
  if (petStatus === "stopping" && !desired && !_petStopPromise) {
    await stopElectronPetGraceful("reconcile-stopping-settle");
    return;
  }
  // 电平触发自愈(操作闭环审计 2026-07-12:原纯边沿触发——开关值不变就不动作,
  // 桌宠进程崩溃/被外杀后意愿仍=true,永远不重拉=用户"启用着却没有桌宠"且无同面回路)。
  // 意愿变化照旧动作;值没变但"应跑而没跑"也补拉(ensurePetRunning 幂等:running 即返回,不抖动)。
  if (desired === _lastDesired) {
    // 自愈只治"崩溃/被外杀",不复活"有意关闭":Unload(角色卡退出)期间抑制,Load 解除。
    if (desired && !_petUnloaded && !petRuntimeHealthy() && petStatus !== "stopping") {
      // 退避可配(凛倾 2026-07-13 去硬编码):pet_settings.selfHealBackoffSec,默认30(=原值);0=每次对账都重试。
      // why 退避:孤儿实例占 Electron 单例锁时新实例立退,无退避=4s 无限重生 spawn churn。
      const _backoffSec = Number(loadPetSettingsStore(projectRoot).selfHealBackoffSec);
      const _backoffMs = (Number.isFinite(_backoffSec) && _backoffSec >= 0) ? _backoffSec * 1000 : 30000;
      if (Date.now() - _lastSelfHealAt > _backoffMs) {
        _lastSelfHealAt = Date.now();
        wbT(null, "eye:pet", "reconcile_selfheal", { petStatus });
        await ensurePetRunning();
      }
    }
    return;
  }
  _lastDesired = desired;
  wbT(null, "eye:pet", "reconcile", { desired });
  if (desired) _electronInstallFailAt = 0; // 意愿转正=清冷却,立即允许重试自动安装
  await ensurePetRunning();
}

// ============================================================
// 模块顶层自启动
// beilu-eye 是全局服务型插件，不依赖特定角色卡
// shallowLoadDefaultPartsForUser 只调 import 不调 Load()
// 所以需要在 import 时自启动
// ============================================================

setTimeout(() => {
  wbT(null, "eye:load", "autostart", null);
  // Python 眼(beilu_eye.py)拉起已摘除(凛倾 2026-07-12"已经废弃的beilu eye……直接替换beilueye"):
  // 截图全链(热键框选/自动截图 captureRequested/去重/元数据)由桌宠 Electron 进程接管(desktop-eye/autoCapture.js)。
  // 桌宠默认关闭;仅当用户上次开启(持久化)才并存拉起(操作储存,凛倾决策)。
  _lastDesired = effectiveDesired(); // 设基线,避免对账首跳误触发(启动时无 lease=等价 petEnabled)
  ensurePetRunning().catch((err) => {
    wbD(null, "eye:pet", "autostart_error", false, "桌宠自启动失败", { err: err.message });
    console.error("[beilu-eye] 桌宠自启动失败:", err.message);
  });
  // 周期对账 web 设置中心对 petEnabled 的改动(web→桌宠开关实时生效)。
  setInterval(() => { reconcilePet().catch(() => {}); }, 4000);
}, 3000);

// ============================================================
// 插件导出
// ============================================================

export default {
  info,
  Load: async () => {
    wbT(null, "eye:load", "entry", null);
    // Python 眼拉起已摘除(截图链由桌宠 Electron 接管);杀残留防双消费 captureRequested。
    killPythonEye();
    _petUnloaded = false; // 角色卡回来=解除 Unload 抑制,自愈恢复值守
    // 桌宠按持久化开关并存(默认关;开启态用户已储存)。桌宠是全局进程,不随角色重启抖动:仅确保状态一致。
    await ensurePetRunning();
  },

  Unload: async () => {
    wbT(null, "eye:load", "unload", null);
    // 角色卡退出时终止 Python 进程 + Electron 桌宠
    _petUnloaded = true; // 抑制 reconcile 自愈复活(Unload=有意关闭,不是崩溃;Load 时解除)
    killPythonEye();
    killElectronPet();
    console.log("[beilu-eye] Unload() — 角色卡退出，Python + 桌宠进程已关闭");
  },

  interfaces: {
    config: {
      GetData: async () => {
        // ★ T017-2.1：hasPending 按 owner 分区键查(与 inject 写入端 :534 同键),不查兜底键 ""(防读到别用户/全局残留)。
        const _gdUser = ownerUsername();
        wbT(null, "eye:getdata", "entry", { hasPending: hasPendingInjection(_gdUser), eyeStatus });
        return {
          hasPending: hasPendingInjection(_gdUser),
          eyeStatus,
          eyeError,
          desktopEyeDir,
          // 桌宠状态(供设置中心显示开关态 + Electron 是否就绪)。
          petEnabled: petEnabled(),
          petModel: petModel(),
          petStatus,
          description:
            "桌面截图(桌宠 Electron 进程),截图通过 files 路径直接发送给 AI",
        };
      },
      /**
       * SetData 同时作为截图注入的接收入口 + 进程控制
       */
      SetData: async (data) => {
        wbT(null, "eye:setdata", "entry", { action: data && data._action });
        if (!data) return;

        if (data._action === "inject") {
          wbT(null, "eye:inject", "entry", { hasImage: !!data.image, mode: data.mode || "passive" });
          _eyeDiag(
            "[beilu-eye][DIAG] SetData inject 收到请求",
            "| image:",
            !!data.image,
            "| message:",
            (data.message || "").substring(0, 50),
            "| mode:",
            data.mode || "passive",
            "| hasPending_before:",
            hasPendingInjection(ownerUsername()), // T017-2.1：按 owner 分区键查,与写入端同键
            "| eyeStatus:",
            eyeStatus,
            "| timestamp:",
            Date.now(),
          );
          if (!wbD(null, "eye:inject", "validate", !!data.image, "inject 缺少 image 字段", null)) {
            console.warn("[beilu-eye] inject 缺少 image 字段");
            return;
          }
          // ★ T017-2.1 串台隔离：SetData inject 是 owner 侧 parts 接口，注入语义=用户级(injection_state 按 username 分区)。
          //   原缺陷：不传 username → 恒落兜底键 "" → 多用户共享实例时 B 用户轮询消费到 owner 写入的全局键 = 截图跨用户泄露。
          //   修法：以 ownerUsername() 作分区键(单用户=owner,行为不变)；缺 username(auth 未就绪/异常)=fail-closed 拒写+留痕，
          //   绝不回落空键裸写(否则串台漏洞照旧)。DONE WHEN 2.1：无 username 上报→写入被拒+错误留痕。
          const _eyeUser = ownerUsername();
          if (!wbD(null, "eye:inject", "scope", !!_eyeUser, "缺 username 上下文(ownerUsername 空)，inject 拒写防串台", null)) {
            console.warn("[beilu-eye] inject 缺 username 上下文，fail-closed 拒写防串台");
            return;
          }
          wbT(null, "eye:inject", "before_write", { user: _eyeUser });
          setPendingInjection({
            image: data.image,
            message: data.message || "",
            mode: data.mode || "passive",
          }, _eyeUser);
          wbT(null, "eye:inject", "after_write", { hasPending: hasPendingInjection(_eyeUser) });
          _eyeDiag(
            "[beilu-eye][DIAG] inject 完成, hasPending_after:",
            hasPendingInjection(_eyeUser),
          );
          return;
        }

        if (data._action === "clear") {
          // ★ T017-2.1：clear 按 owner 分区键消费(与 inject 写入端同键),只清本 owner 的 pending,不误清/漏清跨用户键。
          const _clrUser = ownerUsername();
          wbT(null, "eye:consume", "entry", { user: _clrUser });
          const hadPending = hasPendingInjection(_clrUser);
          consumePendingInjection(_clrUser);
          wbT(null, "eye:consume", "after_consume", { hadPending });
          console.log(
            "[beilu-eye][DIAG] clear 执行, hadPending:",
            hadPending,
            "| hasPending_after:",
            hasPendingInjection(_clrUser),
          );
          return;
        }

        if (data._action === "restart") {
          wbT(null, "eye:setdata", "restart", null);
          // Python 眼已废弃(截图链由桌宠 Electron 接管):restart 不再拉起,只清残留进程。
          killPythonEye();
          console.log("[beilu-eye] Python 眼已废弃,restart 仅清理残留(截图由桌宠进程接管)");
          return;
        }

        if (data._action === "stop") {
          wbT(null, "eye:setdata", "stop", null);
          killPythonEye();
          return;
        }

        // 桌宠开关(操作储存):写持久化 petEnabled 并即时拉起/关闭。
        //   web 设置中心/托盘经此切换桌宠;开/关选择持久化,下次按上次走(凛倾决策)。
        if (data._action === "pet-set-enabled") {
          const on = !!data.enabled;
          wbT(null, "eye:pet", "set_enabled", { on });
          // 启动语义(基线同步/清冷却/进程生杀)收口到 savePetSettingsStore 变更订阅(本文件上方
          // onPetSettingsChange),本入口只落盘——与 web POST /api/eye/pet-settings 同一套写语义,零副本。
          savePetSettingsStore(projectRoot, { petEnabled: on });
          return;
        }
        // 桌宠模型选择(持久化;运行时切换由 Electron 主进程经 IPC 处理)。
        if (data._action === "pet-set-model") {
          wbT(null, "eye:pet", "set_model", { model: data.model });
          savePetSettingsStore(projectRoot, { modelName: String(data.model || "") });
          return;
        }
      },
    },
    // GetPrompt 已移除 — 截图改为通过前端 pollEyeStatus → addUserReply(files) 路径发送
    // 与浏览器上传图片完全相同的管线，AI 可以直接看到图片内容
  },
};
