/**
 * whitebox.mjs — 后端白盒线路追踪 + 异常检测（核心层 / server）
 *
 * K13 迁移（2026-06-10）：原位于 shells/beilu-chat/src/lib/whitebox.mjs，造成
 *   ① core→shell 倒挂：plugins / serviceGenerators / 其它 shell 反向 import 进 beilu-chat 壳层；
 *   ② 与 broadcast.mjs 循环依赖：whitebox import broadcastChatEvent，broadcast 又 import wbTrace/wbDetect。
 * 迁到中立核心层 server/（与 monitor.mjs/events.mjs 同级，被各层向下依赖、自身不依赖任何 shell）。
 * broadcast 依赖改为 setBroadcaster 注入：启动时由 beilu-chat 壳层（chat.mjs）显式装配
 *   setBroadcaster(broadcastChatEvent)。whitebox 不再静态 import broadcast → 循环依赖消除。
 *
 * 接入既有监控合集：
 *  - console.log("[wb:line:node] ...") → 被 server/monitor.mjs 的 console hook 捕获（warn/error 级）& 服务端日志
 *  - 注入的 broadcaster(chatid, {type:"wb_trace"}) → 前端 websocket.mjs 分发 → backendMonitor 面板展示
 *
 * 用法：
 *  wbTrace(chatid, "generation", "stream_start", { messageId })
 *  const end = wbSpan(chatid, "requestBuilder", "buildPrompt"); ...; end({ size })
 *  wbDetect(chatid, "mvu", "json_parse", ok, "JSONPatch 解析失败", { raw })
 *
 * 链路：全项目 → wbTrace/wbSpan/wbDetect → emit → RING 环形缓冲 + console + broadcaster(ws) + 安全审计落盘
 * 影响：写 data/audit/security-*.jsonl（仅 detect=true 的安全事件）；广播 ws 到前端面板
 * 相交：← 全项目（auth/safe_fetch/path_confine/security_policy/parts_loader/beilu-files/生成器/插件...）
 *         / server.mjs init()(setAuditConfig 装配审计日志)
 *         / beilu-chat chat.mjs(setBroadcaster 装配广播实现)
 *         / beilu-chat executeGeneration/greeting/fakeSend(runWithAmbientChatId 装配回合 chatid)
 *       → monitor.mjs(installConsoleHook 捕获 console.warn/error 进错误缓冲)
 *       → 无下游模块依赖（核心层底座，自身不 import 任何 shell/plugin）
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

let _enabled = true;
const _seq = new Map(); // chatid -> seq
const RING = [];
const RING_MAX = 500;

// ★ broadcaster 注入点（K13）：默认 no-op；启动时 chat.mjs 调 setBroadcaster(broadcastChatEvent) 装配。
//   保持原契约：broadcaster 函数体内严禁调用任何 wb*（否则 wb→broadcaster→wb 无限递归）。
let _broadcaster = null;
/** 启动装配：注入广播实现（chatid, event）=> void。未注入时白盒只进 console/RING，不广播。 */
export function setBroadcaster(fn) { _broadcaster = typeof fn === "function" ? fn : null; }

// SEC-AL: 安全审计日志（可配开关，默认关闭）。
//   detect=true 的安全事件追加写入 data/audit/security-YYYY-MM-DD.jsonl。
//   开关注入：setAuditConfig({ enabled, dir })，由 server 启动时装配（避免 whitebox→server 循环依赖）。
let _auditCfg = { enabled: false, dir: "" };
let _auditStream = null;
let _auditDate = "";
export function setAuditConfig(cfg) {
  _auditCfg = { enabled: !!cfg?.enabled, dir: cfg?.dir || "" };
  if (!_auditCfg.enabled && _auditStream) { try { _auditStream.end(); } catch {} _auditStream = null; }
}
function _auditWrite(entry) {
  if (!_auditCfg.enabled || !_auditCfg.dir) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _auditDate || !_auditStream) {
      if (_auditStream) try { _auditStream.end(); } catch {}
      fs.mkdirSync(_auditCfg.dir, { recursive: true });
      _auditStream = fs.createWriteStream(path.join(_auditCfg.dir, `security-${today}.jsonl`), { flags: "a" });
      _auditDate = today;
    }
    _auditStream.write(JSON.stringify(entry) + "\n");
  } catch { /* 审计写入失败不影响主流程 */ }
}

// ★ 问题映射根治（2026-06-08）：插件（toggle/mvu/ejs/preset…）的 wbD/wbT 全传 chatid=null，
//   原 emit() 的 `if(chatid)` 闸门把它们挡在前端外——只进后端 console，永不广播到本体「运行时日志」面板。
//   用 AsyncLocalStorage 存「当前回合 chatid」：chat 回合入口（executeGeneration/greeting/fakeSend）
//   用 runWithAmbientChatId 包住回合体，emit 用 `chatid || store` 兜底 → 回合内插件 wbD(null,…)
//   自动映射到前端，零插件改动。用 ALS 而非模块标量：按异步上下文传播，免疫多 chat 并发交错串话。
const _chatIdStore = new AsyncLocalStorage();
/** 在 ambient chatid 上下文内运行 fn（回合入口包住回合体）。fn 内所有异步续延都能读到该 chatid。 */
export function runWithAmbientChatId(chatid, fn) { return chatid ? _chatIdStore.run(chatid, fn) : fn(); }
export function getAmbientChatId() { return _chatIdStore.getStore() || null; }

// quiet 上下文：fake-send（token 预览，每 15s 轮询）等非真实回合路径——其白盒 trace 纯噪声，
// 每轮会把 getChatRequest:enter/exit + 全插件 GetPrompt trace 刷一屏到 console 和前端面板。
// 套 runQuiet 后 emit 直接早返：不记 RING、不打 console、不广播。问题在真实回合仍会浮现。
const _quietStore = new AsyncLocalStorage();
export function runQuiet(fn) { return _quietStore.run(true, fn); }

export function setWhiteboxEnabled(on) { _enabled = !!on; }
export function isWhiteboxEnabled() { return _enabled; }
export function getWhiteboxRing() { return RING.slice(); }

function nextSeq(chatid) {
  const n = (_seq.get(chatid) || 0) + 1;
  _seq.set(chatid, n);
  return n;
}

// 去重表：line:node → 上次打印的签名。「白盒开着只通知一次,之后只报变化」用，防 no_path_matched/wsError 等正常态每请求每重连刷屏
const _wbConsoleLast = new Map();
// 签名剔除易变遥测字段：ms(wbSpan 每次计时不同)/requestId(dispatcher 每请求自增) 会把「内容不变不打」
// 的去重击穿成每请求必打(dispatch 轮询 2~5s 一条刷屏)。剔除仅影响 console 去重判定，
// RING/广播/审计仍存完整 data，requestId 诊断信息不丢失。
const _WB_SIG_VOLATILE = ["ms", "requestId"];
function _sigBody(entry) {
  if (entry.data == null) return entry.msg || "";
  const d = entry.data;
  if (typeof d !== "object") return JSON.stringify(d);
  const stable = { ...d };
  for (const k of _WB_SIG_VOLATILE) delete stable[k];
  return JSON.stringify(stable);
}
function emit(entry, chatid) {
  if (_quietStore.getStore()) return; // fake-send 等预览路径：全静默，不刷屏
  RING.push(entry);
  if (RING.length > RING_MAX) RING.shift();
  try {
    const body = entry.data != null ? JSON.stringify(entry.data) : (entry.msg || "");
    const _k = entry.line + ":" + entry.node;
    const _sig = (entry.detect ? "⚠" : "") + _sigBody(entry);
    if (_wbConsoleLast.get(_k) !== _sig) { // 内容不变不再刷 console（变化或新探针点才打印）
      _wbConsoleLast.set(_k, _sig);
      if (entry.detect) console.warn(`[wb:${entry.line}:${entry.node}] ⚠`, body);
      else console.log(`[wb:${entry.line}:${entry.node}]`, body);
    }
  } catch { /* 序列化失败不影响主流程 */ }
  try {
    // chatid 优先；插件 wbD/wbT 传 null 时回退 ALS 里的回合 chatid，保证问题映射到前端面板。
    const _cid = chatid || _chatIdStore.getStore();
    if (_cid && _broadcaster) _broadcaster(_cid, { type: "wb_trace", payload: entry });
  } catch { /* 广播失败不影响主流程 */ }
  if (entry.detect) _auditWrite(entry);
}

/** 追踪一个执行点 */
export function wbTrace(chatid, line, node, data) {
  if (!_enabled) return;
  emit({ seq: chatid ? nextSeq(chatid) : 0, ts: Date.now(), side: "be", line, node, data: data || null }, chatid);
}

/** 计时 span：返回结束函数，结束时记录 ms */
export function wbSpan(chatid, line, node, data) {
  if (!_enabled) return () => {};
  const t0 = Date.now();
  return (extra) => {
    if (!_enabled) return;
    emit({ seq: chatid ? nextSeq(chatid) : 0, ts: Date.now(), side: "be", line, node, data: { ms: Date.now() - t0, ...(data || {}), ...(extra || {}) } }, chatid);
  };
}

/** 检测：ok=true 正常（不记录），ok=false 异常 → 升级 warn + 标 detect。返回 ok 供内联使用 */
export function wbDetect(chatid, line, node, ok, msg, data) {
  if (!_enabled) return ok;
  if (!ok) emit({ seq: chatid ? nextSeq(chatid) : 0, ts: Date.now(), side: "be", line, node, detect: true, msg: msg || "detect failed", data: data || null }, chatid);
  return ok;
}
