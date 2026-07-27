/**
 * [dataSystem] — 线路/警告数据系统：route 埋点 + 反复修改检测。不管表格 CRUD（那是 tableEngine 的事）、不管提示词注入（那是 getPromptHandler 的事）。
 * （2026-07-16 凛倾拍板去重：原「框架/问题」两类与 code 记忆表格 #3 流程·架构索引/#4 错误·经验表概念重复，
 *   且 AI 读写链全死（{{framework}} 宏无预设引用、<dataWrite> 无提示词教）——整链删除，架构/问题知识归记忆表格单源。
 *   保留线路/警告 = 独有机制（同处反复修改→警告），记忆表格无对应物。）
 *
 * 链路：setDataActions(addRouteNote/ackDataWarning) → 本模块 → 磁盘 JSONL/JSON
 *        replyHandler(ideToolCall 写成功后) → detectRepeatedEdit() → upsertRepeatWarning()
 *        getPromptHandler(记忆召回命中时) → appendBehaviorSignal()
 *        getDataHandler(GetData) → getDataSnapshot() → 前端 data 界面（记忆板块表格视图内）
 * 影响：写 _global/memory/_data_config.json（阈值配置，共享层）
 *        写 {char}/memory/code/active/{task}.route.jsonl（append-only 事件流，截头保近端）
 *        写 {char}/memory/code/active/{task}.state.json（warnings 列表）
 *        写 {char}/memory/_behavior_signals.jsonl（fire-and-forget，1MB 截头）
 * 相交：← setDataActions / replyHandler / getPromptHandler / getDataHandler 调用
 *        → storage.mjs(getMemoryDir/ensureMemoryDir) 为唯一 lib 依赖（杜绝循环）
 *
 * 存储：独立层（本角色写）线路/警告 → chars/{char}/memory/code/active/{taskName}.*；阈值配置 → chars/_global/memory/
 * 范围（凛倾收口）：机制层 = 线路埋点 + 同处反复修改计数 → 警告信号。
 * 不做（提示词侧/凛倾）：阈值定多少（此处只读配置 + 兜底默认）、警告后硬阻断/强制回溯。
 */

import fs from "node:fs";
import path from "node:path";
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs"; // 0716 收口：原子写单源（原 renameSyncWithRetry+内联 tmp 三处改走它）
import { readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // T019：损坏不再返fallback（防后续_writeJson覆盖真数据），备份后抛错
import {
  getMemoryDir,
  ensureMemoryDir,
} from "../storage_mod/storage.mjs";

// ---- 通用 JSON 读写（T019 半销毁改造：不存在→fallback 首装；损坏→备份 .corrupt.bak 后抛错，
//      不再返 fallback——旧行为下后续 _writeJson 会拿兜底结构覆盖真数据。避免循环依赖故走 scripts 层） ----
function _readJson(file, fallback) {
  try {
    return readJsonSafeSync(file, fallback);
  } catch (e) {
    wbD(null, "storage", "dataSystem:readJson_corrupt", false, "data 系统 JSON 损坏，已备份 .corrupt.bak 并中止本次操作", { path: file, err: e && e.message });
    throw e;
  }
}
function _writeJson(file, obj) {
  wbT(null, "storage", "dataSystem:writeJson", { path: file });
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 0716 轮子收口：原子写内联（tmp+rename）→ nicerWriteFileSync 单源（D-3 半截防护语义在单源内；2 空格缩进不变）。
  nicerWriteFileSync(file, JSON.stringify(obj, null, 2));
  wbT(null, "storage", "dataSystem:writeJson_done", { path: file });
}

// ============================================================
// 路径（v2：_global 共享 + per-char 独立）
// ============================================================
function _globalDir(username) {
  return ensureMemoryDir(username, "_global");
}
function _configFile(username) {
  return path.join(_globalDir(username), "_data_config.json");
}
/** 独立层：本角色 code/active/ 下按任务名分文件。 */
function _activeDir(username, charName) {
  return path.join(getMemoryDir(username, charName), "code", "active");
}
function _safeTaskName(taskName) {
  // 防路径穿越：只留文件名安全字符。
  return String(taskName || "_session").replace(/[^a-zA-Z0-9_\-.\u4e00-\u9fa5]/g, "_") || "_session";
}
function _routeFile(username, charName, taskName) {
  return path.join(_activeDir(username, charName), `${_safeTaskName(taskName)}.route.jsonl`);
}
function _stateFile(username, charName, taskName) {
  return path.join(_activeDir(username, charName), `${_safeTaskName(taskName)}.state.json`);
}

// ============================================================
// 配置（阈值=提示词侧定，机制只读配置 + 兜底默认）
// ============================================================
const _CONFIG_DEFAULT = {
  repeat_edit_threshold: 3,   // 同处编辑达此次数 → 置 warning（默认值，提示词侧可改）
  recent_window: 50,          // 检测只看最近 N 条 edit 事件（防历史无限累积误判）
  route_log_max: 2000,        // route.jsonl 行数上限（超出截头保留近端）
};
export function getDataConfig(username) {
  return { ..._CONFIG_DEFAULT, ..._readJson(_configFile(username), {}) };
}

/**
 * 幂等初始化共享层阈值配置（只在缺失时写默认值），让用户能在 beilu-files 界面看到并编辑。
 * route.jsonl / state.json 按需创建（首条事件/首条警告时），此处不预建。
 *
 * 链路：getDataHandler() 每次 GetData 调用 → initDataFiles() → _globalDir() → ensureMemoryDir()
 * 影响：写 _data_config.json（仅在文件不存在时）
 * @param {string} username
 * @returns {string} _global 共享目录路径
 */
export function initDataFiles(username) {
  const cfg = _configFile(username);
  if (!fs.existsSync(cfg)) _writeJson(cfg, { ..._CONFIG_DEFAULT, _note: "repeat_edit_threshold 等阈值由提示词侧/用户调；机制只读此文件。" });
  return _globalDir(username);
}

// ============================================================
// 一、线路 route.jsonl（独立层 per-char per-task，append-only 事件流）
// ============================================================
function _readRouteEvents(username, charName, taskName) {
  const file = _routeFile(username, charName, taskName);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* 跳过坏行 */ } }
  return out;
}

/**
 * 追加一条线路事件（seq/ts 自动补）。append-only 事件流，超 route_log_max 截头保近端。
 *
 * 链路：replyHandler(ideToolCall 写成功后) / setDataActions(addRouteNote) → appendRouteEvent() → 磁盘 .route.jsonl
 * 影响：写 {char}/memory/code/active/{taskName}.route.jsonl（原子 tmp+rename 或 appendFileSync）
 * 约束：截头重写时走原子 tmp+rename（D-3），防写中断留半截 jsonl
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} taskName - 任务名（经 _safeTaskName 过滤路径穿越字符）
 * @param {object} event - {action,target,node?,reason?,errorAfter?}
 * @returns {object} 写入的事件记录 {seq,ts,action,target,node,reason,errorAfter}
 */
export function appendRouteEvent(username, charName, taskName, event) {
  wbT(null, "storage", "dataSystem:appendRouteEvent", { username, charName, taskName, action: event && event.action });
  const file = _routeFile(username, charName, taskName);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const events = _readRouteEvents(username, charName, taskName);
  const seq = events.length ? (events[events.length - 1].seq || events.length) + 1 : 1;
  const rec = {
    seq,
    ts: Date.now(),
    action: event.action || "edit",
    target: event.target || "",
    node: event.node ?? null,
    reason: event.reason ?? null,
    errorAfter: event.errorAfter ?? null,
  };
  const cfg = getDataConfig(username);
  if (events.length + 1 > cfg.route_log_max) {
    const kept = events.slice(events.length + 1 - cfg.route_log_max);
    // 0716 收口：截头重写原子步骤 → nicerWriteFileSync 单源（D-3 半截防护语义在单源内）。
    nicerWriteFileSync(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n" + JSON.stringify(rec) + "\n");
  } else {
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
  }
  return rec;
}

export function readRoute(username, charName, taskName) {
  return _readRouteEvents(username, charName, taskName);
}

/** 用户在界面给线路加批注事件（append-only，不抹历史，对标设计§1.2）。 */
export function appendRouteAmendment(username, charName, taskName, note, target) {
  return appendRouteEvent(username, charName, taskName, { action: "note", target: target || "", reason: String(note || "") });
}

// ============================================================
// 二、行为信号 behavior_signals.jsonl（T7 自优化：per-char append-only）
// 采集用户已产生的行为（关注入/approve-reject/改记忆/召回命中），供 S2 按计数阈值算注入分级。
// 只采集不判断——分级规则在 S2/提示词侧；此处纯 append + 容错 + 体积兜底（recall_hit 可能高频）。
// ============================================================
function _behaviorSignalsFile(username, charName) {
  return path.join(getMemoryDir(username, charName), "_behavior_signals.jsonl");
}
const _SIGNAL_LOG_MAX_BYTES = 1024 * 1024; // 1MB → 截头保留近端
const _SIGNAL_KEEP_LINES = 3000;
/** 追加一条行为信号。signal: {type, target?, action?, weight?}。失败静默（不影响主流程）。 */
export function appendBehaviorSignal(username, charName, signal) {
  try {
    if (!signal || !signal.type) return null;
    const file = _behaviorSignalsFile(username, charName);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = {
      ts: Date.now(),
      type: String(signal.type),
      target: signal.target ?? "",
      action: signal.action ?? "",
      weight: typeof signal.weight === "number" ? signal.weight : 1,
    };
    // 体积兜底：仅在超阈值时才读全文件截头（appendFileSync 平时 O(1)，避免每次 append 全读 O(n²)）。
    let _sz = 0;
    try { _sz = fs.statSync(file).size; } catch { /* 不存在=0 */ }
    if (_sz > _SIGNAL_LOG_MAX_BYTES) {
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
      const kept = lines.slice(-_SIGNAL_KEEP_LINES);
      // 0716 收口：截头重写原子步骤 → nicerWriteFileSync 单源。
      nicerWriteFileSync(file, kept.join("\n") + "\n" + JSON.stringify(rec) + "\n");
    } else {
      fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf-8");
    }
    return rec;
  } catch (e) { wbD(null, "storage", "dataSystem:appendBehaviorSignal_fail", false, "行为信号写盘失败(fire-and-forget，信号丢失)", { username, charName, type: signal && signal.type, err: e && e.message }); return null; }
}
/** 读全部行为信号（坏行跳过）。可选 sinceMs 只取近端。 */
export function readBehaviorSignals(username, charName, sinceMs = 0) {
  const file = _behaviorSignalsFile(username, charName);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const l of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (!sinceMs || (o.ts || 0) >= sinceMs) out.push(o); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// ============================================================
// 三、反复修改检测（纯计数，凛倾要的"检查同处反复修改→警告"）
// ============================================================

/** 从工具入参解析「编辑目标位置」：文件 + 行区间（无行信息=整文件 lo=null）。 */
export function editTargetOf(tool, params = {}) {
  const file = String(params.path || "").replace(/\\/g, "/").toLowerCase();
  let lo = null, hi = null;
  if (typeof params.start_line === "number") {
    lo = params.start_line;
    hi = typeof params.end_line === "number" ? params.end_line : params.start_line;
  } else if (typeof params.line === "number") {
    // Q2 修：ToolExecutor insert_at_line 真实入参名 = params.line（非 line_number/line_hint）。
    lo = hi = params.line;
  } else if (typeof params.line_number === "number") {
    lo = hi = params.line_number;
  } else if (typeof params.line_hint === "number" && params.line_hint > 0) {
    lo = hi = params.line_hint;
  }
  return { file, lo, hi };
}

/** 两个编辑目标是否"同一处"：同文件 + 行区间重叠（任一为整文件则同文件即重叠）。 */
function _overlap(a, b) {
  if (!a.file || a.file !== b.file) return false;
  if (a.lo == null || b.lo == null) return true; // 整文件改 = 与同文件任意改重叠
  return a.lo <= b.hi && b.lo <= a.hi;
}

/** target 可读串（写进 route 事件 + warnings）。 */
export function targetLabel(t) {
  if (!t.file) return "(unknown)";
  if (t.lo == null) return t.file;
  return t.lo === t.hi ? `${t.file}:${t.lo}` : `${t.file}:${t.lo}-${t.hi}`;
}

/** 把 route 事件里的 target 串解析回 {file,lo,hi}（与 targetLabel 互逆）。 */
function _parseEventTarget(s) {
  const str = String(s || "");
  const m = str.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (m) return { file: m[1], lo: Number(m[2]), hi: Number(m[3] || m[2]) };
  return { file: str, lo: null, hi: null };
}

/**
 * 检测某次编辑是否触发"同处反复修改"警告。扫最近 recent_window 条 edit 事件，计数同处编辑次数（含本次）。
 *
 * 链路：replyHandler(ideToolCall 写成功后) → detectRepeatedEdit() → 若 triggered → upsertRepeatWarning()
 * 影响：纯计算，不写磁盘（写盘由调用方决定是否 upsertRepeatWarning）
 * 约束：recent_window / repeat_edit_threshold 均从 _data_config.json 读取（机制只读，阈值由提示词侧定）
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} taskName
 * @param {{file:string, lo:number|null, hi:number|null}} target - editTargetOf() 解析出的编辑位置
 * @param {string|null} errorAfter - 编辑后是否仍有错误（用于 persistentError 判断）
 * @returns {{ repeat:number, threshold:number, triggered:boolean, persistentError:boolean }}
 */
export function detectRepeatedEdit(username, charName, taskName, target, errorAfter) {
  const cfg = getDataConfig(username);
  const events = _readRouteEvents(username, charName, taskName).filter((e) => e.action === "edit");
  const recent = events.slice(-cfg.recent_window);
  let repeat = 1; // 含本次
  let allErr = errorAfter != null && errorAfter !== "";
  for (const e of recent) {
    const et = _parseEventTarget(e.target);
    if (_overlap(target, et)) {
      repeat++;
      if (!(e.errorAfter != null && e.errorAfter !== "")) allErr = false;
    }
  }
  return {
    repeat,
    threshold: cfg.repeat_edit_threshold,
    triggered: repeat >= cfg.repeat_edit_threshold,
    persistentError: repeat >= cfg.repeat_edit_threshold && allErr,
  };
}

// ============================================================
// 四、警告 state.json warnings[]（独立层 per-char，机制只产信号，处置=提示词侧）
// ============================================================
export function readState(username, charName, taskName) {
  return _readJson(_stateFile(username, charName, taskName), { warnings: [] });
}

/** 登记/更新一条同处反复修改警告（按 position 去重，刷新次数与末次时间）。 */
export function upsertRepeatWarning(username, charName, taskName, label, repeat, persistentError) {
  const file = _stateFile(username, charName, taskName);
  const state = _readJson(file, { warnings: [] });
  if (!Array.isArray(state.warnings)) state.warnings = [];
  const now = Date.now();
  const existing = state.warnings.find((w) => w.kind === "repeat_edit" && w.position === label);
  if (existing) {
    existing.count = repeat;
    existing.lastTs = now;
    existing.persistentError = !!persistentError;
    existing.acked = false; // 次数刷新 → 重新提醒
  } else {
    state.warnings.push({
      kind: "repeat_edit",
      position: label,
      count: repeat,
      persistentError: !!persistentError,
      firstTs: now,
      lastTs: now,
      acked: false,
    });
  }
  _writeJson(file, state);
  return existing || state.warnings[state.warnings.length - 1];
}

/** 用户手动消警：按 position 标记 acked（不删历史）。 */
export function ackWarning(username, charName, taskName, position) {
  const file = _stateFile(username, charName, taskName);
  const state = _readJson(file, { warnings: [] });
  if (!Array.isArray(state.warnings)) return false;
  const w = state.warnings.find((x) => x.kind === "repeat_edit" && x.position === position);
  if (!w) return false;
  w.acked = true;
  w.ackedTs = Date.now();
  _writeJson(file, state);
  return true;
}

/** 取未消警的 warning（供回流注入；按 position 过滤可选）。 */
export function getActiveWarnings(username, charName, taskName, position) {
  const state = readState(username, charName, taskName);
  const list = (state.warnings || []).filter((w) => !w.acked);
  if (position) return list.filter((w) => w.position === position);
  return list;
}

// ============================================================
// 五、聚合快照（供前端 data 界面一次性拉取）
// ============================================================

/**
 * 聚合线路/警告数据的完整快照，供 getDataHandler.handleGetData() 一次性返回前端 data 界面。
 *
 * 链路：getDataHandler() → getDataSnapshot() → readState/readRoute/getDataConfig
 * 影响：纯读取，不写磁盘
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} taskName - 当前活动任务（决定读哪个 route/state 文件）
 * @param {number} [recentN=100] - route 事件截取最近 N 条
 * @returns {{ warnings, route, routeTotal, config }}
 */
export function getDataSnapshot(username, charName, taskName, recentN = 100) {
  const route = readRoute(username, charName, taskName);
  return {
    warnings: readState(username, charName, taskName).warnings || [],
    route: route.slice(-recentN),
    routeTotal: route.length,
    config: getDataConfig(username),
  };
}
