import { wbT, wbD } from "../../../server/wbStub.mjs";
/**
 * ideClient.mjs — 后端→IDE 插件 WebSocket 客户端（IDE 工具闭环 10 跳中的 Hop 3/7/8 节点）。
 *
 * 【功能链】
 *   AI 回复 <ideToolCall> 标签 → replyHandler 安全检查/审批门 → 本模块 callToolAndStore()
 *   → WS 发送 tool_call 到 YonBan IDE 插件 → ToolExecutor 执行（读文件/写文件/运行命令等）
 *   → WS tool_result 回传 → 本模块 enqueuePendingResult()
 *   → generation.mjs consumePendingResults() → 注入下一轮 AI 对话
 *   不管工具在 IDE 端怎么执行（ToolExecutor 的事），不管 AI 回复解析（replyHandler 的事）。
 *
 * 【why】
 *   IDE 工具（读/写文件、运行命令、终端操作等）运行在 YonBan IDE 进程，
 *   与 beilu-memory 后端是两个独立进程，只能通过 WS 通信。
 *   本模块作为后端侧 WS 客户端，把 AI 的工具调用意图转换为 WS 消息，
 *   并把工具结果暂存到 pendingResults 队列供下轮 AI 消费（而非立即注入，避免打断当前回复处理链）。
 *   审批指纹绑定（_approvalFingerprint 稳定 hash）的 fail-closed 设计：
 *   用户批准的是"入队时看到的那条操作"，执行前参数若被 AI 文本骗/引用漂移则重算不符即拒。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块。
 *   触发路径（AI 主动）：AI 回复 <ideToolCall> → replyHandler → callToolAndStore()
 *   触发路径（用户手动批准）：
 *     前端点击"批准"按钮 → SetData("approveToolCall", { approvalId }) → setDataActions
 *     → ideClient.approvePendingApproval() → callToolAndStore()
 *   前端感知工具状态的两条路（producer 不在本文件——本模块只维护队列，广播由消费方发）：
 *     1. WS broadcast "pending_approvals"（producer=replyHandler.mjs:1791，入队后推送）→ 前端渲染审批卡片
 *     2. WS broadcast "tool_results_ready"（producer=setDataActions.mjs 审批完成段 + replyHandler.mjs 结果入队段）→ 前端刷新操作历史面板
 *   前端可通过 GetData 拉取 ide_approvals（待审批队列）和 read_cache（文件读取缓存清单）。
 *
 * 【关联链】
 *   ← replyHandler.mjs（读写分流后调 callToolAndStore / await submitPendingApproval）
 *   ← generation.mjs（consumePendingResults 取结果注入 + countPendingResults 判 auto-continue）
 *   ← setDataActions.mjs（approvePendingApproval / revertToMessage 回档）
 *   → IdeWsServer.ts（WS tool_call 消息出站到 YonBan）
 *   → ToolExecutor.ts（经 WS 间接调用 execute）
 *   → FileCheckpoint.ts（经 _checkpoint_* 内部工具间接调 start/commit/revert）
 *   → fileEditRegistry.mjs（多开同文件写锁协调）
 *   → beilu-files fileHistory（写前备份）
 *
 * 【影响范围】
 *   - WS 发送：tool_call 消息到 YonBan IDE 插件（触发实际工具执行）
 *   - 内存：_pendingResults 队列（generation.mjs 消费后清空）
 *   - 内存：_pendingApprovals 审批队列（用户批准/拒绝后移除）
 *   - 内存：_readCache per-chatid 文件读取缓存（AI 查看清单，AI 自行调 clearReadCache 清理）
 *   - 内存：_resolvedPathMap 权威路径映射（闭合后端→YonBan 跨进程路径盲区）
 *   - 写磁盘：_operationHistory 持久操作历史（按 chatId 落盘，UI 操作监控面板展示）
 *   - 广播（经调用方发出，非本文件直发）：pending_approvals（replyHandler）、tool_results_ready（setDataActions/replyHandler）
 *
 * 【使用效果】
 *   AI 能通过自然语言对话驱动 IDE 操作（读文件查代码、写文件改代码、运行命令测试），
 *   危险操作经过审批门（用户确认/指纹绑定/权限规则），安全层从外到内五级保护，
 *   工具结果注入后续 AI 对话，AI 能看到操作结果并继续工作。
 *
 * 导出工具集合（canonical 单一定义点，新增工具只改这里）：
 *   FILE_EDIT_TOOLS       — 对文件锚点产生改动（per-file 写锁 / data 路由 / 外部修改检测）
 *   WRITE_TOOLS_ALL       — 全部写操作（含 run_command/todo_write，审批判定/读写分离/diff）
 *   PERMISSION_WRITE_TOOLS — 权限模板中需要规则的写工具（不含 run_command）
 *   READ_TOOLS            — 读取类工具（结果记录到缓存清单 + 分身默认权限）
 *
 * 安全层级（从外到内）：
 *   1. replyHandler 命令闸 checkCommandSecurity — 黑名单/灰名单/能力白名单
 *   2. replyHandler B3 规则集引擎 evaluateRuleDecision — 用户自定义 deny/ask/allow
 *   3. replyHandler 审批门 evaluateWriteApprovalGate — 系统强制/策略审批/信任跳过
 *   4. callTool D3 统一执行闸 gateToolExecution — fail-closed 单一 choke point
 *   5. T2 S2 审批指纹绑定 _approvalFingerprint — 执行前重算比对，漂移即拒
 */

// ★ T3a·3.6：命令安全域（黑/灰名单、gateToolExecution、审批门、B3 规则引擎、工具集分类常量、
//   _isPathOutsideWorkspace）已抽出归 security 组（src/yonban/core/functions/security/commandGate.mjs）。
//   本文件 import 使用 + re-export 保旧调用方（replyHandler/setDataActions）import 路径不断。
//   （T3e 分身 D 抓回：此五行原被误插进上方 JSDoc 块内被注释吞掉 → runtime FILE_EDIT_TOOLS undefined，已移至此处）
import { FILE_EDIT_TOOLS, WRITE_TOOLS_ALL, PERMISSION_WRITE_TOOLS, READ_TOOLS, _isPathOutsideWorkspace, gateToolExecution } from "../functions/security/commandGate.mjs";
export { checkCommandSecurity, gateToolExecution, evaluateWriteApprovalGate, evaluateRuleAction, evaluateRuleDecision, matchApprovalSkipRule, matchApprovalDenyRule, buildPermissionTemplateRules, deriveApprovalSkipRule, validateCommandExists, DEFAULT_COMMAND_CATEGORIES, FILE_EDIT_TOOLS, WRITE_TOOLS_ALL, PERMISSION_WRITE_TOOLS, READ_TOOLS, DELETE_CMD_FIRST_WORDS, isSensitiveEnvBasename } from "../functions/security/commandGate.mjs";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
// R5：原 fileURLToPath import 仅供已删除的 _IDE_PROJECT_ROOT 本地推导，路径改走 storage 单源后移除。
// 81: 多开同文件「主动停止+激活」单源注册表（与 beilu-files 共用）
import * as fileEditRegistry from "../../../scripts/fileEditRegistry.mjs";
// R5 路径单源：canonical 工作区根文件（beilu-files-settings.json）的 node 侧路径 + 项目根锚点
//   统一由 storage 供给，删除本文件旧的 fileURLToPath 上溯 4 级本地推导，消除三头巧合对齐。
//   storage 不回引本文件（无环）；ideClient→commandGate→storage 与 ideClient→storage 均单向到 storage。
import { __projectRoot as _IDE_PROJECT_ROOT } from "../functions/memory/storage_mod/storage.mjs";
// [D6 §4 2026-08-04] settings 读路收口：本文件对 beilu-files-settings.json 的两处直读
//   （readFilesPermission / _readCanonicalWorkspace）改经单写者 store 只读视图；
//   无 owner 的 status→SetData 反向直写根（_reconcileWorkspaceToCanonical）已删除——
//   IDE 宣称的根只作候选（conn.ideInfo.status.workspaceFolders 经 getIdeInstances 暴露），
//   确认写入走 beilu-files confirmIdeWorkspaceRoot（owner+chatId+instanceId+connectionId 匹配）。
import { getFilesPermissionView, getOwnerWorkspaceRoot } from "../functions/security/filesSettingsStore.mjs";
import {
  ToolJobRegistry,
  buildToolIoRuntimePolicy,
  readToolRuntimeConfig,
  resolveToolResponseTimeout,
} from "./toolRuntime.mjs";
// 跨 isolate 收口（isolateBridge，零依赖无环）：审批队列单一权威在主进程——worker isolate 的
// worker 的 submitPendingApproval 走有确认的桥请求（主进程审批面板读得到、批准后主进程执行）；
// 同步 addPendingApproval 只允许主进程 owner。写审批开关/主进程工作区根经 bridgeState 下行（applyBridgeState）。
import {
  isWorkerIsolate,
  publishWorkerLifecycle,
  registerBridgeRequestHandler,
  requestFromWorker,
} from "./isolateBridge.mjs";

// PJ-1 dir bug → [D6 §4 2026-08-04] canonical「有效工作区根」持久化在 beilu-files-settings.json，
// 但本文件不再自行读该 JSON（插件间读不到对方 pluginData 的问题改由 filesSettingsStore 只读视图解决）；
// _IDE_PROJECT_ROOT 复用 storage.__projectRoot（相对根 resolve 锚点，与旧本地推导等价=仓库根）。
// [0722 排雷] 禁止模块顶层读 _IDE_PROJECT_ROOT / 顶层触发 storage 路径求值（TDZ 崩全部插件，
//   0722 事故同款）。一律函数体内访问（filesSettingsStore 内同守此约）。

/**
 * 跨插件读 beilu-files 权限键——[D6 §4 2026-08-04] 改经 filesSettingsStore 只读 snapshot
 * （插件间读不到对方 pluginData 的既有范式保持；本文件不再自行 parse 该 JSON）。
 * per-user 布局 {<username>:{permissions:{...}}}；缺失 → def；
 * 设置文件损坏/不可读 → 恒 false（fail-closed，宽默认不救场，store 视图单源裁决）。
 * @param {string} username
 * @param {string} key - permissions 下的键（如 "questions"）
 * @param {boolean} def
 */
export function readFilesPermission(username, key, def = true) {
  return getFilesPermissionView(username, key, def);
}

// 读某 owner 的 canonical 工作区根（[D6 §2 2026-08-04] owner 分区版）。
// 原 _readCanonicalWorkspace 读旧全局 _global.workspaceRoot——该无主根已迁 legacyUnassigned
// 且运行时不自动授予（D6 §2.3）；现必须带 owner（chat 归属用户）才解析得到根，
// 无 owner 上下文 → ""（审批门"区内/区外"轴诚实关闭，不猜别人的根）。
function _readCanonicalWorkspace(owner = "", chatid = null) {
  try {
    const root = getOwnerWorkspaceRoot(owner || "", chatid || null);
    if (!root || root === ".") return "";
    return path.isAbsolute(root) ? root : path.resolve(_IDE_PROJECT_ROOT, root);
  } catch {
    return "";
  }
}


// ---- 审批 binding：稳定哈希（T2 S2 fail-closed） ----
// 对 {tool, params} 做「键递归排序」后哈希，使审批入队时绑定的指纹与执行前重算可严格比对。
// 用途：用户批准的是「入队时看到的那条操作」；执行前 params 若被篡改/漂移（AI 文本骗、引用被改），
// 重算指纹不符 → fail-closed 拒，绝不执行未经批准的真实命令。
function _stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(_stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + _stableStringify(v[k])).join(",") + "}";
}
function _approvalFingerprint(tool, params) {
  const canon = _stableStringify({ tool, params: params ?? {} });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

function _approvalSubmissionFingerprint(toolCall, checkpointId) {
  const canon = _stableStringify({
    tool: toolCall?.tool,
    params: toolCall?.params ?? {},
    forceApproval: !!toolCall?._forceApproval,
    checkpointId: checkpointId || null,
  });
  return crypto.createHash("sha256").update(canon).digest("hex");
}

function _approvalSubmissionError(code, message, state = {}) {
  const error = new Error(message || code || "approval submission failed");
  error.code = code || "E_APPROVAL_SUBMISSION_FAILED";
  error.phase = state.phase || "approval_submission";
  error.executionStarted = state.executionStarted === true;
  error.sideEffectsPossible = state.sideEffectsPossible === true;
  error.indeterminate = state.indeterminate === true;
  if (state.details !== undefined) error.details = state.details;
  return error;
}

function _normalizeApprovalOperationId(operationId) {
  const normalized = typeof operationId === "string" ? operationId.trim() : "";
  if (!normalized || normalized.length > 256) {
    throw _approvalSubmissionError(
      "E_APPROVAL_OPERATION_ID_INVALID",
      "approval operationId must be a non-empty string of at most 256 characters",
      { phase: "approval_preflight" },
    );
  }
  return normalized;
}

// 回档预览/执行之间的 IDE 路由令牌。令牌只描述 _connFor 实际选中的连接代次，
// 不包含工作区推断或可变显示信息；connectionId 防止同端口重连后被误认为同一路由。
const _CONNECTED_IDE_ROUTE_KEYS = Object.freeze([
  "connected",
  "backendKind",
  "port",
  "instanceId",
  "connectionId",
]);

function _snapshotIdeRouteFromConn(conn) {
  if (!conn) return { connected: false };
  const appName = typeof conn.ideInfo?.appName === "string" ? conn.ideInfo.appName : "";
  const backendKind = appName
    ? (appName === "beilu-cli" ? "cli" : "yonban")
    : ((conn.kind === "cli" || conn.kind === "yonban") ? conn.kind : null);
  return {
    connected: true,
    backendKind,
    port: conn.port,
    instanceId: typeof conn.instanceId === "string" && conn.instanceId ? conn.instanceId : null,
    connectionId: conn.connectionId,
  };
}

/** 严格校验可跨 HTTP/WS 序列化的 IDE 路由令牌形状。 */
export function isValidIdeRouteSnapshot(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  const keys = Object.keys(route);
  if (route.connected === false) {
    return keys.length === 1 && keys[0] === "connected";
  }
  if (route.connected !== true
    || keys.length !== _CONNECTED_IDE_ROUTE_KEYS.length
    || !_CONNECTED_IDE_ROUTE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(route, key))) {
    return false;
  }
  return (route.backendKind === null || route.backendKind === "yonban" || route.backendKind === "cli")
    && Number.isSafeInteger(route.port) && route.port > 0 && route.port <= 65535
    && (route.instanceId === null || (typeof route.instanceId === "string" && !!route.instanceId))
    && typeof route.connectionId === "string" && !!route.connectionId;
}

/** 精确比较连接代次；不以“都在线”、端口或实例名的任一子集替代完整令牌。 */
export function ideRouteSnapshotsEqual(expected, actual) {
  if (!isValidIdeRouteSnapshot(expected) || !isValidIdeRouteSnapshot(actual)) return false;
  if (expected.connected !== actual.connected) return false;
  if (!expected.connected) return true;
  return expected.backendKind === actual.backendKind
    && expected.port === actual.port
    && expected.instanceId === actual.instanceId
    && expected.connectionId === actual.connectionId;
}

// （_isPathOutsideWorkspace 已迁 security/commandGate.mjs，经顶部 import 使用）

// ---- 常量 ----
const DEFAULT_PORT = 8931;
const DEFAULT_WS_PATH = "/ide";
const RECONNECT_DELAY = 5000;
// 多开连接池：活跃端口注册表周期重扫间隔（新 YonBan 窗口接入 / 死窗口剪除 / CLI↔YonBan 互斥切换）。
// 单次开销=读一个小 JSON + N 次 process.kill(pid,0) 探活，15s 粒度足够（窗口启停是人手速事件）。
const RESCAN_INTERVAL = 15000;
// ★ B3 写锁：只限制等待前序写的排队时间；工具实际响应时限由可编辑 tool_runtime 单源决定。
const WRITE_LOCK_TIMEOUT = 45000;
// ★ B3：per-file 写锁用 FILE_EDIT_TOOLS（下方 canonical 定义）。
//   run_command/todo_write 不写文件锚点、且命令可长跑(130s)，纳入锁会被 45s 锁等待误杀 → 排除。
//   → FILE_WRITE_TOOLS_FOR_LOCK 声明移至 FILE_EDIT_TOOLS 之后（修 TDZ）。
// ★ F4 null项真广播：chatid===null 的 pending（无会话归属，意为"广播给所有会话"）不再被首个续轮会话
//   整段 drain 独吞。改为：交付给某会话时打 _deliveredTo 标记（不重复交付同一会话），项保留在队列
//   供其他会话各自拾取一次；超过 linger 时间才物理移除（防无界滞留）。命名语义=null项可滞留的最长时间。
const NULL_ITEM_LINGER_MS = 10 * 60 * 1000; // 10 分钟
const HEARTBEAT_INTERVAL = 30000;
// H3: 僵连接检测——连续超过 HEARTBEAT_TIMEOUT 无 pong 即判半开 TCP（防火墙静默丢/睡眠），
//   主动 close 触发 onclose→重扫重连（_scheduleRescanSoon）。取 2.5× 心跳间隔，容忍单次丢包。
const HEARTBEAT_TIMEOUT = 75000;

const TOOL_PROGRESS_PHASES = new Set(["running", "stalled", "telemetry_unavailable"]);
const TOOL_PROGRESS_NUMBER_FIELDS = [
  "pid",
  "processCount",
  "cpuTimeMs",
  "cpuDeltaMs",
  "rssBytes",
  "rssDeltaBytes",
  "outputBytes",
  "outputDeltaBytes",
  "idleForMs",
];

/** 执行端 progress 是跨进程输入，只保留协议字段和有限长度诊断，不把任意对象灌进 Job/前端。 */
function _normalizeToolProgress(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !TOOL_PROGRESS_PHASES.has(raw.phase)) return null;
  const progress = {
    phase: raw.phase,
    sampledAt: typeof raw.sampledAt === "string" ? raw.sampledAt.slice(0, 64) : new Date().toISOString(),
    gpuAvailable: raw.gpuAvailable === true,
  };
  for (const key of TOOL_PROGRESS_NUMBER_FIELDS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) progress[key] = Math.max(0, value);
  }
  if (raw.watchdogAction === "terminate" || raw.watchdogAction === "report") {
    progress.watchdogAction = raw.watchdogAction;
  }
  if (typeof raw.errorCode === "string") progress.errorCode = raw.errorCode.slice(0, 96);
  if (typeof raw.sampleError === "string") progress.sampleError = raw.sampleError.slice(0, 240);
  return progress;
}

// ═══════════════════════════════════════════════════════════════
// ★ IDE 工具集合 — 单一定义点（Canonical）
// 新增写工具时只改这里，其他文件 import 使用。
// 各集合语义：
//   FILE_EDIT_TOOLS    = 对文件锚点产生改动的工具（per-file 写锁 / data 系统路由 / 外部修改检测）
//   WRITE_TOOLS_ALL    = 全部写操作（含 run_command/todo_write，用于审批判定 / 分离读写 / diff 展示）
//   PERMISSION_WRITE_TOOLS = 权限模板中需要规则的写工具（不含 run_command，它单独处理）
// ═══════════════════════════════════════════════════════════════
// （FILE_EDIT_TOOLS/WRITE_TOOLS_ALL/PERMISSION_WRITE_TOOLS/READ_TOOLS 已迁 security/commandGate.mjs，见顶部 import+re-export）
const FILE_WRITE_TOOLS_FOR_LOCK = FILE_EDIT_TOOLS;

// ★ 读取类工具（结果记录到缓存清单 + 分身默认权限）

const IDE_TOOLS = [
  {
    name: "read_file",
    description: "读取 IDE 工作区中的文件内容（支持分页和行号显示；xlsx/xls/xlsm/xlsb/ods/docx/doc/pptx/pdf 文档自动解析为文本）",
    params: {
      path: { type: "string", required: true, description: "文件路径（相对于工作区根目录）" },
      offset: { type: "number", required: false, description: "起始行号（0-based），默认 0" },
      limit: { type: "number", required: false, description: "读取行数限制，默认 500 行（另有 20000 字符预算先到先截；回执 nextOffset/nextCharOffset 为续读点）" },
    },
  },
  {
    name: "write_file",
    description: "写入文件到 IDE 工作区",
    params: {
      path: { type: "string", required: true, description: "文件路径" },
      content: { type: "string", required: true, description: "文件内容" },
    },
  },
  {
    name: "list_files",
    description: "列出 IDE 工作区中指定目录的文件",
    params: {
      path: { type: "string", required: false, description: "目录路径，默认 '.'" },
      recursive: { type: "boolean", required: false, description: "是否递归列出" },
      maxDepth: { type: "number", required: false, description: "最大深度，默认 3" },
    },
  },
  {
    name: "run_command",
    description: "在 IDE 终端中执行命令",
    params: {
      command: { type: "string", required: true, description: "要执行的命令" },
      cwd: { type: "string", required: false, description: "工作目录" },
      timeout: { type: "number", required: false, description: "超时(ms)，默认 120000（2分钟）" },
      session: { type: "boolean", required: false, description: "持久终端会话：true 时复用同一长驻 shell，跨多次调用保持 cd/环境变量/shell 状态（需连续操作时用）" },
    },
  },
  {
    name: "get_diagnostics",
    description: "获取 IDE 中的诊断信息（编译错误、lint 警告等）",
    params: {
      severity: { type: "string", required: false, description: '"error" | "warning" | "all"' },
      path: { type: "string", required: false, description: "限定文件路径" },
    },
  },
  {
    name: "get_status",
    description: "获取 IDE 状态快照（工作区、活跃编辑器、诊断统计等）",
    params: {},
  },
  {
    name: "search_files",
    description: "在 IDE 工作区中搜索文件内容（正则匹配），返回匹配行及上下文",
    params: {
      pattern: { type: "string", required: true, description: "搜索正则表达式（query 也可用，作为别名）" },
      path: { type: "string", required: false, description: "限定搜索目录，默认 '.'" },
      filePattern: { type: "string", required: false, description: "文件名过滤 glob，如 '*.ts'" },
      maxResults: { type: "number", required: false, description: "最大结果数，默认 50" },
      ignoreCase: { type: "boolean", required: false, description: "大小写不敏感搜索" },
      fuzzyIdentifier: { type: "string", required: false, description: "标识符模糊搜索（自动合成驼峰/蛇形/扁平变体正则）" },
      cursor: { type: "string", required: false, description: "分页游标（上次返回值，翻页获取更多结果）" },
    },
  },
  {
    name: "search_by_name",
    description: "按文件名搜索 IDE 工作区中的文件（支持 glob 模式）",
    params: {
      pattern: { type: "string", required: true, description: "文件名搜索模式（glob），如 '*.test.ts'" },
      path: { type: "string", required: false, description: "限定搜索目录，默认 '.'" },
      maxResults: { type: "number", required: false, description: "最大结果数，默认 100" },
    },
  },
  {
    name: "replace_lines",
    description: "替换文件指定行范围的内容（精准行级编辑，无需重写整个文件）",
    params: {
      path: { type: "string", required: true, description: "文件路径" },
      start_line: { type: "number", required: true, description: "起始行号（1-based，含）" },
      end_line: { type: "number", required: true, description: "结束行号（1-based，含）" },
      new_content: { type: "string", required: true, description: "替换内容（可以是多行）" },
    },
  },
  {
    name: "insert_at_line",
    description: "在文件指定行位置插入内容（不覆盖现有行，在指定行之前插入）",
    params: {
      path: { type: "string", required: true, description: "文件路径" },
      line: { type: "number", required: false, description: "插入位置行号（1-based）。0或不传=追加到末尾" },
      content: { type: "string", required: true, description: "要插入的内容（可多行）" },
    },
  },
  // ---- Phase 1 新增工具 ----
  {
    name: "fuzzy_edit",
    description: "模糊匹配编辑文件内容（无需精确行号，通过内容匹配定位）。支持多种容错策略：精确匹配 → 空白容错 → 锚点定位",
    params: {
      path: { type: "string", required: true, description: "文件路径" },
      old_string: { type: "string", required: true, description: "要替换的旧内容（支持模糊匹配）" },
      new_string: { type: "string", required: true, description: "替换后的新内容" },
      line_hint: { type: "number", required: false, description: "大致行号提示（多处匹配时选最近的）" },
      strict: { type: "boolean", required: false, description: "严格模式（不启用模糊匹配策略）" },
      preview: { type: "boolean", required: false, description: "预览模式（只返回匹配位置不执行替换）" },
      anchor_before: { type: "string", required: false, description: "锚点插入：在此行之后插入 new_string（不替换，不需要 old_string）" },
      anchor_after: { type: "string", required: false, description: "锚点插入：在此行之前插入 new_string" },
    },
  },
  {
    name: "todo_read",
    description: "读取当前任务清单（.beilu/todo.md）",
    params: {},
  },
  {
    name: "todo_write",
    description: "写入/更新任务清单（.beilu/todo.md）",
    params: {
      content: { type: "string", required: true, description: "完整的任务清单内容（Markdown 格式）" },
    },
  },
  // ---- Phase 2 导航/验证类工具 ----
  { name: "goto_definition", description: "跳转到符号定义位置", params: { path: { type: "string", required: true }, line: { type: "number", required: true }, column: { type: "number", required: false } } },
  { name: "find_references", description: "查找符号的所有引用位置", params: { path: { type: "string", required: true }, line: { type: "number", required: true }, column: { type: "number", required: false } } },
  { name: "get_project_summary", description: "获取项目结构摘要（文件树+统计）", params: {} },
  { name: "ast_search", description: "AST结构化搜索（需ast-grep CLI）", params: { pattern: { type: "string", required: true }, lang: { type: "string", required: false }, path: { type: "string", required: false } } },
  { name: "smart_search", description: "智能搜索（自动选择ripgrep或ast-grep）", params: { query: { type: "string", required: true }, path: { type: "string", required: false } } },
  { name: "validate_html", description: "验证HTML文件结构", params: { path: { type: "string", required: false, description: "HTML 文件路径（与 content 二选一）" }, content: { type: "string", required: false, description: "直接传 HTML 字符串（与 path 二选一）" } } },
  { name: "lint_code", description: "代码lint检查", params: { path: { type: "string", required: true } } },
  // ---- 文档编辑 ----
  { name: "edit_xlsx", description: "xlsx 公式定点编辑（保留样式，只改公式）", params: { path: { type: "string", required: true, description: "xlsx 文件路径" }, edits: { type: "array", required: true, description: "编辑列表 [{sheet?, cell, formula}]" } } },
  // ---- 脚本执行 ----
  { name: "run_script", description: "执行多行脚本（落临时文件执行，绕过 shell 引号转义）", params: { lang: { type: "string", required: true, description: "python|node|powershell|bash" }, code: { type: "string", required: true, description: "完整脚本源码" }, cwd: { type: "string", required: false, description: "执行目录" }, timeout: { type: "number", required: false, description: "超时(ms)" } } },
  // ---- 结构化 git 工具（G-2，返回结构化数据；不含 push，远程推送走 run_command）----
  // cwd 参数（0715 加）：git 家族原先恒在工作区根跑，仓库在工作区子目录时全线 "not a git repository"
  //   而文件/搜索工具有 path 参数畅通 → 能力不对称。cwd=仓库目录（工作区内），缺省=工作区根。
  //   命名取 cwd 不取 path：path 在 git_diff/git_add 已是"文件限定"语义，run_script 先例=cwd。
  { name: "git_status", description: "git 状态：分支 + ahead/behind + 暂存/未暂存/未跟踪文件（结构化）", params: { cwd: { type: "string", required: false, description: "仓库目录（工作区内；仓库在子目录时指定，缺省=工作区根）" } } },
  { name: "git_diff", description: "git 差异（默认工作区，staged=true 看暂存区）", params: { staged: { type: "boolean", required: false, description: "true 看已暂存改动" }, path: { type: "string", required: false, description: "限定文件" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_log", description: "git 提交历史（结构化 hash/author/date/subject）", params: { maxCount: { type: "number", required: false, description: "条数，默认 20，上限 200" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_add", description: "暂存改动", params: { paths: { type: "array", required: false, description: "路径数组" }, path: { type: "string", required: false, description: "单路径；都不传则暂存全部" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_commit", description: "提交（返回新 commit hash）", params: { message: { type: "string", required: true, description: "提交信息" }, all: { type: "boolean", required: false, description: "true 等价 commit -a（含已跟踪未暂存）" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_branch", description: "列分支（标当前）；create=名字则新建并切换", params: { create: { type: "string", required: false, description: "新分支名（checkout -b）" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_checkout", description: "切换到已有分支", params: { branch: { type: "string", required: true, description: "目标分支名" }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_stash", description: "暂存管理（list/push/pop/apply/drop）", params: { action: { type: "string", required: false, description: "list|push|pop|apply|drop（默认list）" }, message: { type: "string", required: false }, ref: { type: "string", required: false }, includeUntracked: { type: "boolean", required: false }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
  { name: "git_merge", description: "合并分支到当前分支", params: { branch: { type: "string", required: true, description: "要合并的分支名" }, noFf: { type: "boolean", required: false }, message: { type: "string", required: false }, cwd: { type: "string", required: false, description: "仓库目录（缺省=工作区根）" } } },
];

// 提示词里的工具 schema 只能来自上方 canonical registry。这里只生成无连接态、无工作区、无用户
// 配置、无运行值的稳定签名；可编辑的使用规则仍住 INJ-2-code，动态状态仍住 depth:0 data INJ。
// 模块加载时求值一次，保证同一代码版本下逐轮返回字节完全一致，不让运行期对象变化破坏缓存前缀。
const STATIC_IDE_TOOL_SIGNATURES = IDE_TOOLS.map((tool) => {
  const params = Object.entries(tool.params || {}).map(([name, spec]) => {
    const type = typeof spec?.type === "string" && spec.type ? spec.type : "any";
    return `${name}:${type}${spec?.required === true ? "!" : "?"}`;
  });
  return `- ${tool.name}(${params.join(", ")})`;
}).join("\n");

/**
 * 返回可放在历史前缓存区的 IDE 工具静态签名。
 * `!`=required，`?`=optional；自然语言规则由可编辑 INJ 负责。
 */
export function renderStaticIdeToolSignatures() {
  return STATIC_IDE_TOOL_SIGNATURES;
}

// ---- WS token 单一权威（B16）----

/**
 * 解析 YonBan IDE 桥接 WS token —— 本体侧唯一权威实现。
 * ideClient（后端→IDE 客户端）与 beilu-chat endpoints（浏览器代读端点）共用此函数，
 * 避免双实现路径漂移（任一侧改路径另一侧未跟 → 后端连得上前端连不上 / 反之）。
 *
 * 按优先级检查多个来源（本体进程与 VS Code 工作区不一定同目录）：
 *   1. 环境变量 BEILU_IDE_WS_TOKEN（显式覆盖）
 *   2. ~/.beilu/ide_ws_token（YonBan 写入主目录的「传回」全局副本，与工作区位置无关）
 *   3. <cwd>/.beilu/_ws_token（本体与工作区同目录时的原始 Y-2 路径）
 *
 * 文件内容兼容两种格式：多窗口 "port:token"（前缀为纯数字端口）/ 旧版纯 token（hex）。
 *
 * @returns {{ token: string, port: number|null }} 找不到返回 { token: "", port: null }
 */
export function resolveIdeWsToken() {
  const explicit = (typeof process !== "undefined" && process.env?.BEILU_IDE_WS_TOKEN) || "";
  if (explicit && explicit.trim()) return { token: explicit.trim(), port: null };

  let home = null;
  try { home = os.homedir(); } catch { /* ignore */ }

  // ★ U2/D3 根因修：端口以「活跃端口注册表」为权威，不信全局 ide_ws_token 单文件里嵌的端口。
  //   全局 ide_ws_token 是 last-writer-wins 单槽文件，多窗口/重启下会残留已退出实例的端口
  //   （实测 runtime：文件写 8932 但真监听 8931，worker 连 8932 死端口 → IDE 工具"未连接"）。
  //   ide_active_ports.json 是列表 + pid 存活过滤，是「现在真在监听的端口」唯一可信源；
  //   该端口的 token 取 per-port 文件 ide_ws_token_<port>（多窗口各端口各 token，不互相覆盖）。
  if (home) {
    try {
      // ★ [分类器收口 0727] 「当前是哪套 IDE 系统 + 有哪些实例」一律问 resolveIdeMode。
      //   本处原自带一份「读注册表 + pid 探活 + CLI/YonBan 互斥优先级排序 + kind 判定」——
      //   与 _syncConnections、beilu-cli supervisor 并列，是同一规则的**第三份**实现
      //   （凛倾 0727「检测机制完全不分类」的一个源头：三处各判各的，改一处漂一处）。
      //   收口后互斥优先级只由分类器裁决（有 YonBan 即 YonBan 模式，CLI 让位），本处只在
      //   当前系统的实例里取最近注册的那个。探活也随之升级：分类器用 pid+procStart 双因子，
      //   比原来的裸 pid 强（裸 pid 被系统复用后会把死实例判成活的）。
      const _ideCls = resolveIdeMode();
      const _live = [..._ideCls.instances].sort((a, b) => (b.time || 0) - (a.time || 0));
      if (_live.length) {
        const livePort = _live[0].port;
        const liveKind = _ideCls.mode === "cli" ? "cli" : "yonban";
        try {
          const perPort = path.join(home, ".beilu", `ide_ws_token_${livePort}`);
          if (fs.existsSync(perPort)) {
            const t = fs.readFileSync(perPort, "utf-8").trim();
            if (t) return { token: t, port: livePort, kind: liveKind };
          }
        } catch { /* per-port 读不到→用全局 token，端口仍以 live 为准 */ }
        const g = _readGlobalTokenFile(home);
        return { token: g.token, port: livePort, kind: liveKind };
      }
    } catch { /* 注册表不可用→退回全局文件 */ }
  }

  // 回退：全局 ide_ws_token / 工作区 _ws_token（单窗口旧路径，注册表缺失时）
  const g = _readGlobalTokenFile(home);
  if (g.token || g.port != null) return g;
  return { token: "", port: null };
}

/** 读全局 ide_ws_token / 工作区 _ws_token（解析 "port:token" 或旧版纯 token） */
function _readGlobalTokenFile(home) {
  const candidates = [];
  try { if (home) candidates.push(path.join(home, ".beilu", "ide_ws_token")); } catch { /* ignore */ }
  try { candidates.push(path.join(process.cwd(), ".beilu", "_ws_token")); } catch { /* ignore */ }
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8").trim();
        if (!raw) continue;
        const colonIdx = raw.indexOf(":");
        if (colonIdx > 0 && /^\d+$/.test(raw.substring(0, colonIdx))) {
          const fileToken = raw.substring(colonIdx + 1);
          if (fileToken) return { token: fileToken, port: parseInt(raw.substring(0, colonIdx), 10) };
        }
        return { token: raw, port: null };
      }
    } catch { /* 读不到就试下一个 */ }
  }
  return { token: "", port: null };
}

/**
 * 解析指定端口的 WS token（多连接池路由用，与 resolveIdeWsToken 同源规则）。
 * 优先级：env 显式覆盖 → per-port 文件 ~/.beilu/ide_ws_token_<port> → 全局文件（端口匹配或旧版纯 token）。
 * 【why】连接池按「活跃端口注册表的每个 YonBan 实例」建连，每实例 token 独立（IdeWsServer per-port 写入），
 *   不能复用 resolveIdeWsToken（它只选一个赢家端口）。
 * @param {number} port
 * @returns {string} token，找不到返回 ""
 */
export function resolveTokenForPort(port) {
  const explicit = (typeof process !== "undefined" && process.env?.BEILU_IDE_WS_TOKEN) || "";
  if (explicit && explicit.trim()) return explicit.trim();
  let home = null;
  try { home = os.homedir(); } catch { /* ignore */ }
  if (home) {
    try {
      const perPort = path.join(home, ".beilu", `ide_ws_token_${port}`);
      if (fs.existsSync(perPort)) {
        const t = fs.readFileSync(perPort, "utf-8").trim();
        if (t) return t;
      }
    } catch { /* per-port 读不到→退全局 */ }
  }
  const g = _readGlobalTokenFile(home);
  // 全局文件带端口时仅当端口匹配才可信（他窗口的 token 连本端口必 4001）；旧版纯 token 无端口=单窗口时代，放行
  if (g.token && (g.port == null || g.port === port)) return g.token;
  return "";
}

// ---- IdeClient 类 ----

class IdeClient {
  constructor() {
    // ★ 多开连接池（2026-07-26 多窗口 YonBan 支持）：单 _ws 改 per-port 连接条目池。
    //   【why】多开 VSCode 时每个 YonBan 实例各有端口，原单连接只连注册表赢家端口 → 其他窗口的
    //   会话工具调用全打到别人的工作区。会话态早已 per-chatid 分区（F3/B2），只差传输层多连接+路由。
    //   条目结构 {port, kind, ws, connected, connecting, ideInfo, lastPongAt, token, authFailCount}。
    //   路由：_chatBindings(chatid→port，YonBan 窗口 selectChat 时经 SetData bindIdeInstance 上报) →
    //   绑定连接；无绑定/绑定死 → 主连接（_primaryPort，选择规则=原 resolveIdeWsToken：YonBan>CLI、最新注册，
    //   保留凛倾 0722「cli 和 yonban 互斥」裁决：有任一 YonBan 在线即不连 CLI）。
    /** @type {Map<number, object>} */
    this._conns = new Map();
    /** @type {Map<string, number>} chatid → 绑定的 YonBan 实例端口 */
    this._chatBindings = new Map();
    /** @type {Map<string, string>} chatid → 所绑窗口的实例编号（YonBan hello 自报，权威身份）。
     *  [编号识别 0726 凛倾] 端口只是当次监听地址、会被后起实例复用；编号是窗口自己声明的身份。
     *  路由时用它校验「现在连在这个端口上的，还是不是当初绑的那个窗口」，并在端口变化时按编号找回。 */
    this._bindingIds = new Map();
    /** @type {Map<string, string>} chatid → 所绑窗口工作区根快照（仅供降级提示文案，非身份依据）。 */
    this._bindingRoots = new Map();
    /** @type {Map<string, "manual"|"auto">} chatid → 绑定来源。manual=用户在 ＋号 里显式指定（粘性），
     *  auto=窗口打开该对话时的自动上报（弱）。见 bindChat 的覆盖规则。 */
    this._bindingSources = new Map();
    /** [窗口id 0726 容错] 绑定表持久化（~/.beilu/ide_chat_bindings.json）：后端重启后绑定+根快照
     *  从盘上恢复——旧端口多半已死，首次路由即走自愈重绑按根接回，闭合「重启绑定空窗」。
     *  worker isolate 不落盘不加载（绑定经 payload 显式传入，防与主进程互写）。 */
    this._bindingsFile = path.join(os.homedir(), ".beilu", "ide_chat_bindings.json");
    this._bindingsSaveTimer = null;
    if (!isWorkerIsolate) this._loadBindings();
    /** @type {number|null} 主连接端口（未绑定会话的默认路由目标） */
    this._primaryPort = null;
    /** @type {"cli"|"yonban"|null} 未绑定会话默认后端种类；主实例暂时不可用时只允许同种类等价实例。 */
    this._primaryKind = null;
    this._connectionGeneration = 0;
    this._wsPath = DEFAULT_WS_PATH;
    this._rescanTimer = null; // 注册表周期重扫：新窗口上线接入 / 死窗口剪除 / CLI↔YonBan 互斥切换
    this._lastIdeMode = null; // 上一次分类器结果（resolveIdeMode().mode）；变化即广播 ide_mode_changed
    this._rescanSoonTimer = null; // 断连后快速重扫（防抖）

    /** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>, port?: number }>} */
    this._pendingRequests = new Map();
    /** 已删除会话的在飞工具回包墓碑：requestId → { chatid, jobId, connectionId, timer }。
     * 本地 request 立即移除并 settle；执行端没有通用取消协议，所以短期保留连接身份，
     * 让已知迟到回包被定向丢弃，而不是落成匿名 orphan_result。 */
    this._deletedToolRequestTombstones = new Map();
    this._toolJobs = new ToolJobRegistry();
    /** @type {Map<string, string>} chatid → 已从权威会话元数据或认证入口确认的 owner。 */
    this._chatOwners = new Map();
    /** 主进程：workerId\0requestId → 主 ToolJob 与远端 lifecycle 相位。 */
    this._workerLifecycleStates = new Map();

    this._autoReconnect = true;
    this._heartbeatTimer = null;

    // 待消费的工具执行结果
    /** @type {Array<{ tool: string, params: object, result: object, timestamp: string }>} */
    this._pendingResults = [];

    // ---- 写操作审批队列 ----
    /** @type {Array<{ id: string, tool: string, params: object, status: 'pending'|'approved'|'rejected', timestamp: string, checkpointId?: string }>} */
    this._pendingApprovals = [];
    /** 主进程审批提交幂等收据。键=username/chatid/generationId/operationId；生命周期随 chat/user 清理。 */
    this._approvalSubmissionReceipts = new Map();
    /** 写操作是否需要审批（用户可在管理面板切换） */
    this._requireWriteApproval = new Map(); // SEC 破口C(红方round2 隔离): per-user 写审批开关 key=username，缺省 true(fail-safe)
    /** 自动批准读操作 */
    this._autoApproveRead = true;

    // 连接统计
    this._stats = {
      connectAttempts: 0,
      successfulConnections: 0,
      toolCallsSent: 0,
      toolCallsSucceeded: 0,
      toolCallsFailed: 0,
    };

    // 操作历史（供操作监控面板展示，不随consumePendingResults清空）
    /** @type {Array<{ tool: string, params: object, result: object, timestamp: string, success: boolean }>} */
    this._operationHistory = [];
    this._maxHistory = 100;


    // ★ 文件读取缓存（AI通过宏查看清单，自己决定清理）
    // ★ per-chatid 隔离（F3 会话态分区范式）：进程级单例下原单 Map 把所有对话的读取堆一起=跨对话串台。
    //   改 Map<chatid, Map<path,info>>，写入按 chatid 分区，"" 兜底键=无 chatid 的旧全局行为。
    /** @type {Map<string, Map<string, { lines: number, chars: number, timestamp: string, tool: string }>>} */
    this._readCache = new Map();
    this._readCacheRound = 0; // 当前轮次计数器

    // ★ 权威路径映射：relPath(AI 给的) → YonBan resolveWorkspacePath 的真实绝对路径。
    //   后端 fs 操作(mtime/sandbox)优先用它，闭合"后端猜的路径≠YonBan 实写路径"的跨进程盲区。
    //   [多开 0726] 键改「port\0relPath」按连接分区（_resolvedPathKey）：原全局 rel→abs 单槽，
    //   两窗口不同工作区同名相对路径互相覆盖 → A 会话拿到 B 窗口的绝对路径（mtime/沙箱/审批卡全错位）。
    /** @type {Map<string, string>} */
    this._resolvedPathMap = new Map();

    // 多组 v4：per-group 工作区根的 isolate 内存覆盖（仅 worker isolate 内由 runner 设置）。
    // 设了则 workspaceRoot getter 最高优先返回它，使本组 worker 用本组根，不串别组、不写共享磁盘。
    this._workspaceRootOverride = null;

    // 跨 isolate 桥下行：主进程权威工作区根快照（仅 worker isolate 内由 applyBridgeState 设置）。
    // workspaceRoot getter 的回退层：本 isolate 未连 IDE 时先用它，再退盘上 canonical——
    // 消除「worker 自连失败 → 判区外 → L4 也强制审批」的多源漂移。
    this._mainWorkspaceRoot = null;

    // ★ B3 per-file 写锁：键=规范化path(或 __no_path__)，值=该文件当前队尾Promise。
    //   同文件写按入队顺序串行 apply（先a后b），a 落盘后才发 b，IDE 端据 a 后内容重匹配锚点。
    /** @type {Map<string, Promise<void>>} */
    this._writeLocks = new Map();

    // ★ F3 会话态分区：以下成员承载「会话语义」态，进程级单例下多 chatid 会串台，故按 chatid 分区。
    //   分区范式（沿用 A1）：Map<chatid, ...>，无 chatid 用 "" 兜底键 = 旧全局行为，向后兼容。
    // _externalChanges：外部变更通知队列。通知与产生它的会话工作区相关 → 每会话独立 Set；
    //   消费时 drain 自己键 + 兜底键（无 chatid 的通知对所有会话可见）。
    /** @type {Map<string, Set<string>>} */
    this._externalChanges = new Map();
    // _diagRepeat / _lastDiagSig：F5 连续编译错误熔断的会话行为统计。A 的连错不应顶满全局熔断把 B 的真错误暂停。
    //   归因到「写了出错文件」的会话（_attributeDiagChatid）→ 按该 chatid 分区计数。
    /** @type {Map<string, number>} */
    this._diagRepeat = new Map();
    /** @type {Map<string, string>} */
    this._lastDiagSig = new Map();
  }

  // ---- 属性 ----

  // ---- 连接池内部访问 ----

  /** 池内活连接判定（条目级）。 */
  _isConnLive(conn) {
    return !!(conn && conn.connected && conn.ws && conn.ws.readyState === WebSocket.OPEN);
  }

  /** 主连接条目（未绑定会话的默认路由目标）；不活时只在同 backend kind 内选择等价实例。 */
  get _primaryConn() {
    const p = this._primaryPort != null ? this._conns.get(this._primaryPort) : null;
    if (this._isConnLive(p)) return p;
    const expectedKind = this._primaryKind || p?.kind || null;
    for (const c of this._conns.values()) {
      if (!this._isConnLive(c)) continue;
      if (expectedKind && c.kind !== expectedKind) continue;
      return c;
    }
    return null;
  }

  /**
   * 会话路由：chatid 绑定的实例连接（bindIdeInstance 上报）优先。
   * [窗口id 0726 凛倾方案·容错自愈] 绑定死时不再静默回退主连接（错窗执行风险），三级认回：
   *   ① 绑定端口活且编号一致→认；② 编号在池内找回（换端口）/②b 工作区稳定段唯一候选回迁（anon 不参与，多候选拒猜）；
   *   ③ 全部找不回 → **只要绑定过一律诚实降级 null**（:797-801，调用方报「所绑窗口已关闭」，禁跨工作区执行）。
   *   只有**从未绑定过**的会话才走主连接（:804，无归属非错窗）。
   *   [0808 注释校准·治理清单 37 对抗验证发现] 原头注释"无根快照→回退主连接（旧行为）"与代码不符
   *   ——③ 分支并无按根快照回退主连接的路径，照旧注释理解会误判降级语义，已按实际行为改写。
   * @param {string|null} chatid
   * @param {object|null} [routeOut] - 可选出参：诚实降级时置 routeOut.degraded={boundPort,boundRoot}
   * @returns {object|null} 连接条目，全池无活连接或降级返回 null
   */
  _connFor(chatid, routeOut = null) {
    if (chatid) {
      const port = this._chatBindings.get(chatid);
      if (port != null) {
        const wantId = this._bindingIds.get(chatid) || null;
        const c = this._conns.get(port);
        // ① 端口上有活连接：编号一致才认（编号不符=端口被后起实例复用，绝不能当成原窗口）
        if (this._isConnLive(c) && (!wantId || c.instanceId === wantId)) {
          if (!wantId && c.instanceId) { this._bindingIds.set(chatid, c.instanceId); this._persistBindings(); } // 补记编号（绑定发生在 hello 之前时）
          const _r = c.ideInfo?.status?.workspaceFolders?.[0];
          if (_r && this._bindingRoots.get(chatid) !== _r) { this._bindingRoots.set(chatid, _r); this._persistBindings(); }
          return c;
        }
        // ② 端口不可用/编号不符：按编号在池里找回那个窗口（它换端口了但还活着）
        if (wantId) {
          for (const cc of this._conns.values()) {
            if (this._isConnLive(cc) && cc.instanceId === wantId) {
              this._chatBindings.set(chatid, cc.port);
              this._persistBindings();
              wbT(chatid, "ideClient", "bind:reattach", { from: port, to: cc.port, instanceId: wantId });
              return cc;
            }
          }
          // ②b [债#3] 编号两段式 `yb_<工作区段>_<进程段>`：VSCode 重启后进程段变、工作区段不变。
          //   整串对不上时用工作区段再找一次 = 「同一个工作区的窗口重开了」，绑定跟着迁过去。
          //   工作区段为 anon（窗口没打开工作区）不参与匹配——那不是身份，会把互不相干的窗口混为一谈。
          const _stable = (id) => { const p = String(id || "").split("_"); return p.length >= 3 && p[1] !== "anon" ? p[1] : ""; };
          const _wantStable = _stable(wantId);
          if (_wantStable) {
            const stableCandidates = [...this._conns.values()].filter(
              (cc) => this._isConnLive(cc) && _stable(cc.instanceId) === _wantStable,
            );
            if (stableCandidates.length === 1) {
              const cc = stableCandidates[0];
              this._chatBindings.set(chatid, cc.port);
              this._bindingIds.set(chatid, cc.instanceId);
              this._persistBindings();
              wbT(chatid, "ideClient", "bind:reattachByWorkspace", { from: port, to: cc.port, was: wantId, now: cc.instanceId });
              return cc;
            }
            if (stableCandidates.length > 1) {
              wbD(chatid, "ideClient", "bind:reattachByWorkspaceAmbiguous", false,
                "同一 workspace stable 身份存在多个活连接，拒绝猜测回迁", {
                  wantedInstanceId: wantId,
                  candidatePorts: stableCandidates.map((cc) => cc.port),
                });
            }
          }
        }
        // ③ 找不到那个窗口 → 诚实降级，绝不回退主连接。
        //   why：回退=把这条线的工具调用送进另一个窗口的工作区执行（实测事故形态：无工作区的
        //   8933 窗口绑定后每次调用都被静默送去 8932）。未绑定过的会话才用主连接（无归属，非错窗）。
        if (routeOut) routeOut.degraded = { boundPort: port, boundRoot: this._bindingRoots.get(chatid) || null, instanceId: wantId };
        return null;
      }
    }
    return this._primaryConn;
  }

  get isConnected() {
    return this._primaryConn != null; // 池内任一活连接=IDE 可用（原单连接语义的自然扩展）
  }

  isConnectedFor(chatid = null) {
    return this._connFor(chatid || null) != null;
  }

  /**
   * 返回该会话此刻由 _connFor 实际选中的精确连接代次。
   * 未连接只返回 {connected:false}；连接态字段均来自选中的 conn，不做默认端口/实例猜测。
   */
  getRouteSnapshot(chatid = null) {
    return _snapshotIdeRouteFromConn(this._connFor(chatid || null));
  }

  /**
   * 等待连接就绪（或超时）。connect() 非阻塞（onopen 才置 _connected），worker isolate 首轮带工具的
   * GetReply 可能在握手完成前跑到 isConnected 判定 → 工具误判"未连接"失败（D3 竞态）。
   * worker runner 在 GetReply 前调用本方法等连上（超时则降级照常生成，工具首轮可能失败）。
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} 是否在超时内连上
   */
  waitConnected(timeoutMs = 3000) {
    if (this.isConnected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (this.isConnected) { clearInterval(timer); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
      }, 50);
    });
  }

  get ideInfo() {
    return this._primaryConn?.ideInfo ?? null; // 兼容旧单连接消费方：主连接的 hello/status 快照
  }

  ideInfoFor(chatid = null) {
    return this._connFor(chatid || null)?.ideInfo ?? null;
  }

  get availableTools() {
    return IDE_TOOLS;
  }

  get stats() {
    return { ...this._stats };
  }

  /**
   * 当前客户端环境标识
   * @returns {"beilu-chat"|"vscode"|"cursor"|"ide"}
   */
  /**
   * ★ T2 S1：当前 IDE 工作区根（来自 hello/status 的 onGetStatus 快照）。
   * 用于审批门的「工作区内外」轴判断。未连 / 未知 → null（该轴自动关闭）。
   * @returns {string|null}
   */
  /** 多组 v4：worker isolate 内设本组根（内存覆盖，不持久化，isolate 隔离故不串别组）。 */
  setWorkspaceRootOverride(root) {
    this._workspaceRootOverride = (typeof root === "string" && root) ? root : null;
  }

  get workspaceRoot() {
    // 多组 v4：worker isolate 内的 per-group 覆盖最高优先（本组 worker 用本组根）。
    if (this._workspaceRootOverride) return this._workspaceRootOverride;
    // PJ-1 dir bug（保守方案，凛倾 2026-06-05）：YonBan 连着 → 以其 VSCode 根为准
    //（与 ToolExecutor.getWorkspaceRoot 实际解析一致，门根==工具根，不分叉）；
    // 未连 YonBan → 本体单跑，回退 beilu-files canonical 本体根（file_op 沙箱即本体根，审批门/文本有效）。
    // 多开池化后：无 chatid 上下文的旧调用方取主连接根；有 chatid 的一律走 workspaceRootFor（会话所绑窗口的根）。
    const _pc = this._primaryConn;
    if (_pc) {
      // st.workspace 单数已删（2026-07-09 收口审计：YonBan IdeStatusPayload 只产出 workspaceFolders 复数，单数键恒 undefined 悬空）
      return _pc.ideInfo?.status?.workspaceFolders?.[0] || null;
    }
    // 跨 isolate 桥下行回退：本 isolate 未连（worker 自连失败/未完成）时用主进程权威根，
    // 保证审批门「区内/区外」判定与主进程/YonBan 实际打开的工作区一致，再退盘上 canonical。
    if (this._mainWorkspaceRoot) return this._mainWorkspaceRoot;
    return _readCanonicalWorkspace() || null;
  }

  /**
   * ★ 多开路由版工作区根：该会话所绑 YonBan 实例的 VSCode 根（审批门/规则集/路径解析的会话精确视角）。
   * 优先级与 workspaceRoot 同构：isolate 覆盖 → 所绑连接(退主连接)的 hello/status 根 → 桥下行 → 盘上 canonical。
   * @param {string|null} chatid
   * @returns {string|null}
   */
  workspaceRootFor(chatid) {
    if (this._workspaceRootOverride) return this._workspaceRootOverride;
    const c = this._connFor(chatid || null);
    if (c) return c.ideInfo?.status?.workspaceFolders?.[0] || null;
    if (this._mainWorkspaceRoot) return this._mainWorkspaceRoot;
    // [D6 §2] 盘上回退按会话 owner 分区解析（无 owner=null，诚实关闭区外轴，不读无主旧全局根）
    return _readCanonicalWorkspace(this._chatOwners.get(chatid || "") || "", chatid || null) || null;
  }

  get clientEnv() {
    return this.clientEnvFor(null);
  }

  clientEnvFor(chatid = null) {
    const _conn = this._connFor(chatid || null);
    if (!_conn) return "beilu-chat";
    const appName = _conn.ideInfo?.appName || _conn.ideInfo?.status?.appName || "";
    if (/cursor/i.test(appName)) return "cursor";
    if (/code/i.test(appName) || /vscode/i.test(appName)) return "vscode";
    return "ide";
  }

  get pendingResults() {
    // 纯读，不在读取时裁剪——否则日志/UI 读 .length 会 splice 掉尚未被 AI 消费的最老结果（静默漏看）。
    // 上限保护移到写入端（enqueuePendingResult 内）。禁止外部 .pendingResults.push() 绕过截断。
    return this._pendingResults;
  }

  /**
   * 面板/接口只读视图：按认证 owner 隔离并返回副本，不暴露内部数组、Set 或 owner 字段。
   */
  getPendingResults({ ownerUsername = "", chatid } = {}) {
    const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!owner) return [];
    if (chatid && this._chatOwners.get(chatid) !== owner) return [];
    const rows = [];
    for (const entry of this._pendingResults) {
      const entryOwner = entry.ownerUsername || (entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "");
      if (entryOwner !== owner) continue;
      if (chatid != null && entry.chatid !== chatid) continue;
      const { ownerUsername: _owner, _deliveredTo, _firstDeliveredAt, ...publicEntry } = entry;
      rows.push({ ...publicEntry });
    }
    return rows;
  }

  getPendingResultCount(options = {}) {
    return this.getPendingResults(options).length;
  }

  /**
   * 认证入口登记 chat owner。只允许首次写入相同 owner；不同 owner 绝不覆盖。
   * worker runner 同样调用，用于让仅带 chatid 的既有 producer 在 isolate 内获得安全 owner。
   * @returns {boolean} 已登记/同 owner 幂等为 true；参数无效或 owner 冲突为 false。
   */
  registerChatOwner(chatid, ownerUsername) {
    const chatKey = typeof chatid === "string" ? chatid.trim() : "";
    const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!chatKey || !owner) return false;
    const existing = this._chatOwners.get(chatKey);
    if (existing && existing !== owner) {
      wbD(chatKey, "ideClient", "chatOwner:conflict", false,
        "会话 owner 已登记为其他用户，拒绝覆盖", { existingOwner: existing, assertedOwner: owner });
      return false;
    }
    if (!existing) this._chatOwners.set(chatKey, owner);
    return true;
  }

  /**
   * 工具结果入队（Hop 8）。本地工具结果与 worker 跨界回灌的单一入口。
   *
   * 链路：_callToolAndStoreInner → 本函数 → _pendingResults 队列 → generation.mjs consumePendingResults
   * 影响：写 _pendingResults 队列；超 CAP(200) 时按会话感知策略截断（优先丢 null 广播项）
   * 约束：外部禁止 _pendingResults.push() 绕过（M-05），必须走本函数
   *
   * @param {{ tool: string, params: object, result: object, chatid: string|null, timestamp: string }} entry
   */
  enqueuePendingResult(entry) {
    if (!entry || typeof entry !== "object") return false;
    const assertedOwner = typeof entry.ownerUsername === "string" ? entry.ownerUsername.trim() : "";
    const registeredOwner = entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "";
    if (entry.chatid && (!registeredOwner || (assertedOwner && assertedOwner !== registeredOwner))) {
      wbD(entry.chatid, "ideClient", "pendingResults:ownerMismatch", false,
        "定向 pendingResult 缺少已认证 owner 或 owner 冲突，已拒绝入队", {
          tool: entry.tool || null,
          registeredOwner: registeredOwner || null,
          assertedOwner: assertedOwner || null,
        });
      return false;
    }
    const ownerUsername = assertedOwner || registeredOwner;
    // 无 chatid 且无 owner 的 producer 没有安全消费域，禁止退化成所有用户共享结果。
    if (!ownerUsername) {
      wbD(null, "ideClient", "pendingResults:ownerMissing", false,
        "pendingResult 缺少 owner，已拒绝进入队列", { tool: entry.tool || null });
      return false;
    }
    const storedEntry = { ...entry, ownerUsername };
    this._pendingResults.push(storedEntry);
    wbT(entry?.chatid ?? null, "ideClient", "pendingResults:push", { tool: entry?.tool, queueLen: this._pendingResults.length, hasChatid: !!entry?.chatid });
    const CAP = 200;
    if (this._pendingResults.length <= CAP) return true;
    let overflow = this._pendingResults.length - CAP;
    const dropped = [], kept = [];
    for (const r of this._pendingResults) {
      if (overflow > 0 && !r.chatid) { dropped.push(r); overflow--; }
      else kept.push(r);
    }
    if (overflow > 0) dropped.push(...kept.splice(0, overflow)); // 仍超额=全是定向项，丢最旧定向
    this._pendingResults = kept;
    if (dropped.length) wbD(entry?.chatid ?? null, "ideClient", "pendingResults:truncateDrop", false,
      `pendingResults 超 ${CAP}，丢弃 ${dropped.length} 项(会话感知:优先 null 广播,保未消费定向)`,
      { dropped: dropped.length, droppedChatids: dropped.map((d) => d.chatid || null) });
    return true;
  }

  // ---- 写操作审批 ----

  get pendingApprovals() {
    return this._pendingApprovals;
  }

  // SEC 破口C(红方round2 隔离·per-user 写审批)：原单值 → Map<username,bool>，防 A 关写审批殃及 B 的 AI
  //   IDE 写直接执行。缺省 true（fail-safe 需审批）。读用【被 gate 的 op 属主 / 请求用户】的值，写设请求用户的值。
  getRequireWriteApproval(username) {
    const v = this._requireWriteApproval.get(username);
    return v === undefined ? true : v;
  }

  setRequireWriteApproval(username, val) {
    if (username) this._requireWriteApproval.set(username, !!val);
  }

  /**
   * 跨 isolate 桥下行消费（worker isolate 内由 groupReplyRunner 在 GetReply 前调用）。
   * 把主进程权威态灌进本 isolate：写审批开关（_requireWriteApproval 是内存 Map，
   * 权限面板经 SetData 只写主进程那份，worker 缺省恒 true=恒要审批）+ 主进程工作区根快照。
   * @param {{requireWriteApproval?: boolean, mainWorkspaceRoot?: string|null}|null} state
   * @param {string} username
   */
  applyBridgeState(state, username) {
    if (!state || typeof state !== "object") return;
    if (typeof state.requireWriteApproval === "boolean")
      this.setRequireWriteApproval(username, state.requireWriteApproval);
    this._mainWorkspaceRoot = (typeof state.mainWorkspaceRoot === "string" && state.mainWorkspaceRoot) ? state.mainWorkspaceRoot : null;
  }

  /** 判断工具是否为写操作（引用 canonical WRITE_TOOLS_ALL） */
  static isWriteOp(toolName) {
    return WRITE_TOOLS_ALL.has(toolName);
  }

  /**
   * 可等待的审批提交入口。main 直接写权威队列；worker 必须经 request/response 桥拿到主进程 ack。
   * 不内置重试：timeout/indeterminate 时复用同 operationId 的裁决只能由显式调用方发起。
   */
  async submitPendingApproval(toolCall, checkpointId, chatid = null, {
    operationId,
    username = "",
    generationId = "",
  } = {}) {
    const stableOperationId = _normalizeApprovalOperationId(operationId);
    if (isWorkerIsolate) {
      const ack = await requestFromWorker("approval_add", chatid, {
        operationId: stableOperationId,
        toolCall: {
          tool: toolCall?.tool,
          params: toolCall?.params,
          _forceApproval: !!toolCall?._forceApproval,
        },
        checkpointId: checkpointId || null,
      });
      if (
        ack?.accepted !== true
        || typeof ack?.approvalId !== "string"
        || !ack.approvalId
        || ack?.operationId !== stableOperationId
      ) {
        throw _approvalSubmissionError(
          "E_APPROVAL_ACK_INVALID",
          "main process returned an invalid approval acknowledgement",
          {
            phase: "approval_ack",
            executionStarted: true,
            sideEffectsPossible: true,
            indeterminate: true,
            details: { operationId: stableOperationId },
          },
        );
      }
      return ack;
    }
    return this._submitPendingApprovalInMain(toolCall, checkpointId, chatid, {
      operationId: stableOperationId,
      username,
      generationId,
    });
  }

  _submitPendingApprovalInMain(toolCall, checkpointId, chatid, {
    operationId,
    username,
    generationId,
  } = {}) {
    if (isWorkerIsolate) {
      throw _approvalSubmissionError(
        "E_APPROVAL_MAIN_ONLY",
        "authoritative approval submission is only available in the main process",
        { phase: "approval_preflight" },
      );
    }
    const stableOperationId = _normalizeApprovalOperationId(operationId);
    const owner = typeof username === "string" ? username.trim() : "";
    const generation = typeof generationId === "string" ? generationId.trim() : "";
    if (
      !owner
      || !chatid
      || !generation
      || typeof toolCall?.tool !== "string"
      || !toolCall.tool
      || !toolCall.params
      || typeof toolCall.params !== "object"
      || Array.isArray(toolCall.params)
    ) {
      throw _approvalSubmissionError(
        "E_APPROVAL_CONTEXT_INVALID",
        "approval submission requires trusted username, chatid, generationId and tool",
        { phase: "approval_preflight" },
      );
    }
    if (this._chatOwners.get(chatid) !== owner) {
      throw _approvalSubmissionError(
        "E_APPROVAL_OWNER_MISMATCH",
        "approval submission owner does not match the registered chat owner",
        { phase: "approval_preflight" },
      );
    }
    const key = JSON.stringify([owner, chatid, generation, stableOperationId]);
    let fingerprint;
    try {
      fingerprint = _approvalSubmissionFingerprint(toolCall, checkpointId);
    } catch (cause) {
      throw _approvalSubmissionError(
        "E_APPROVAL_PAYLOAD_FINGERPRINT",
        "approval payload cannot be fingerprinted",
        { phase: "approval_preflight", details: { cause: cause?.message || String(cause) } },
      );
    }
    const existing = this._approvalSubmissionReceipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw _approvalSubmissionError(
          "E_APPROVAL_OPERATION_PAYLOAD_DRIFT",
          "approval operationId was reused with a different payload",
          {
            phase: "approval_idempotency",
            details: { operationId: stableOperationId },
          },
        );
      }
      return existing.receipt;
    }
    const entry = this.addPendingApproval(toolCall, checkpointId, chatid, {
      operationId: stableOperationId,
      generationId: generation,
    });
    const receipt = Object.freeze({
      accepted: true,
      approvalId: entry.id,
      operationId: stableOperationId,
    });
    this._approvalSubmissionReceipts.set(key, {
      username: owner,
      chatid,
      generationId: generation,
      operationId: stableOperationId,
      fingerprint,
      receipt,
    });
    return receipt;
  }

  /**
   * 写操作入审批队列（Hop 2i）。replyHandler 审批门判定 needApproval=true 后调用。
   *
   * 链路：replyHandler evaluateWriteApprovalGate → 本函数 → _pendingApprovals 队列 → 前端审批 UI → approveOperation
   * 影响：
   *   - 入 _pendingApprovals 数组
   *   - 绑定 T2 S2 审批指纹（入队时记录 sha256 哈希，执行前重算比对）
   *   - 解析绝对路径 + 区外标记（F6，供前端卡片渲染）
   *
   * @param {{ tool: string, params: object, _forceApproval?: boolean }} toolCall - 工具调用描述
   * @param {string|null} checkpointId - 关联的文件检查点 ID（审批路径用 deferred 检查点）
   * @param {string|null} chatid - 会话 ID（B2 corrId 隔离，审批结果回流时据此归位）
   * @returns {{ id: string, tool: string, params: object, status: string, ... }} 入队的审批条目
   */
  addPendingApproval(toolCall, checkpointId, chatid = null, {
    operationId = null,
    generationId = null,
  } = {}) {
    // 同步入口只保留给主进程 owner。worker 必须 await submitPendingApproval，禁止 fire-and-forget
    // 假 ack，也禁止写入主进程看不到的 isolate 本地队列。
    if (isWorkerIsolate) {
      throw _approvalSubmissionError(
        "E_APPROVAL_SYNC_IN_WORKER",
        "worker must await submitPendingApproval instead of addPendingApproval",
        { phase: "approval_preflight" },
      );
    }
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    // ★ F6 内联审批卡：入队时解析绝对路径 + 区外标记，供前端卡片直接渲染（KILO approval-box 规范：
    //   文件显绝对路径、工作区外强提示）。前端不再自算路径，单一权威在后端。
    const _relPath = toolCall.params?.path ?? null;
    let _absPath = null;
    let _outsideWorkspace = false;
    if (_relPath && toolCall.tool !== "run_command") {
      try {
        // 多开路由：按会话所绑实例的根解析（A 窗口的审批卡不能显 B 窗口的绝对路径/区外判定）
        _absPath = this.resolvePathForFs(_relPath, chatid || null);
        _outsideWorkspace = _isPathOutsideWorkspace(_relPath, this.workspaceRootFor(chatid || null));
      } catch { /* 解析失败保持 null/false，不阻塞入队 */ }
    }
    const entry = {
      id,
      tool: toolCall.tool,
      params: toolCall.params,
      status: "pending",
      timestamp: new Date().toISOString(),
      checkpointId: checkpointId || null,
      chatid: chatid || null,   // ★ B2 corrId隔离: 审批结果回流时按此归位
      operationId: operationId || null,
      generationId: generationId || null,
      // ★ T2 S4：透传系统强制档标记，供前端 attention 弹窗精确区分「高敏操作」与普通写。
      _forceApproval: !!toolCall._forceApproval,
      // ★ F6：绝对路径 + 区外标记（前端卡片显示用；run_command 无 path → 均为 null/false）
      absPath: _absPath,
      outsideWorkspace: _outsideWorkspace,
      // ★ T2 S2：绑定入队指纹 + 关键身份字段（供执行前 fail-closed 重算比对，防 AI 文本骗/params 漂移）
      binding: {
        fingerprint: _approvalFingerprint(toolCall.tool, toolCall.params),
        targetPath: toolCall.params?.path ?? null,
        command: toolCall.params?.command ?? null,
      },
    };
    this._pendingApprovals.push(entry);
    wbT(chatid, "ideClient", "approval:enqueue", { tool: toolCall.tool, id, outsideWorkspace: _outsideWorkspace, forceApproval: !!toolCall._forceApproval, queueLen: this._pendingApprovals.length });
    console.log(`[ideClient] 写操作加入审批队列: ${toolCall.tool} ${toolCall.params.path || toolCall.params.command || ""} (id=${id})`);
    // ★ W66（迁自 replyHandler）：审批入队广播归队列 owner——角标数必须读权威队列
    //   （原在 replyHandler 入队循环后读本地队列，worker isolate 下本地恒空=角标恒 0）。
    this._broadcastApprovalCount(chatid);
    return entry;
  }

  /**
   * 审批队列计数广播（队列 owner 单一收口）。
   * 0714 根因修（放行后 UI 不刷新）：原来只有 addPendingApproval 入队时广播 pending_approvals，
   * approveOperation/rejectOperation 摘除后零广播 → 用户点批准/拒绝后角标与审批面板停在旧态
   * （「放行之后没有刷新状态」）。收口为本方法，入队/批准/拒绝三处同源调用，杜绝散写。
   * 懒 import 防层级环，fire-and-forget 不阻塞调用方。
   */
  /**
   * 实例离线 → 通知绑在它上面的线（凛倾 0726「停止 yonban 停止多窗口」）。
   * 【why】线绑定的执行端停了，这条线的工具调用会全部降级拒绝（_connFor 不跨窗）——用户必须
   *   立刻知道，否则表现为"AI 突然什么都干不了"却没有任何提示。只通知不删绑定：同一实例重连
   *   （即使换了端口）能按编号认回；绑定的物理删除由 unbindChat/forgetChat 收口，不在此处散写。
   * 广播范式同 _broadcastApprovalCount：懒 import dispatcher 防层级环，fire-and-forget。
   */
  /**
   * [P1 2026-08-03] 活连接实例清单（只读快照）。
   * 消费方：setDataActions launchEditor 的 per-target readiness（ready=目标 workspace 实例已接入，
   * 不再拿"全局任意连接"冒充目标窗口就绪，Fable 审查阻断5）；未来 capability registry 的
   * readiness 事实源同此单点。身份=YonBan 自报 instanceId（20260803 框架补正：不靠端口猜）。
   * @returns {Array<{instanceId:string|null, port:number, kind:string, workspace:string|null}>}
   */
  listLiveInstances() {
    const out = [];
    try {
      for (const c of this._conns.values()) {
        if (!this._isConnLive(c)) continue;
        out.push({
          instanceId: c.instanceId || null,
          port: c.port,
          kind: c.kind === "cli" ? "cli" : "yonban",
          workspace: c.ideInfo?.status?.workspaceFolders?.[0] || null,
        });
      }
    } catch { /* 快照失败返回已收集部分 */ }
    return out;
  }

  _notifyBoundLinesGone(conn) {
    const _cids = [];
    for (const [cid, port] of this._chatBindings) if (port === conn.port) _cids.push(cid);
    if (!_cids.length) return;
    const _payload = {
      port: conn.port,
      instanceId: conn.instanceId || null,
      kind: conn.kind === "cli" ? "cli" : "yonban",
      workspace: conn.ideInfo?.status?.workspaceFolders?.[0] || null,
    };
    wbT(null, "ideClient", "instance:gone", { ..._payload, lines: _cids.length });
    import("../dispatch/dispatcher.mjs")
      .then(({ dispatch }) => {
        for (const cid of _cids) {
          // payload 带 chatid：本方法本来就是**按 chatid 逐条**派的，「这条通知属于哪条线」在生产侧
          //   是已知事实；不带下去，前端只能拿 port 反猜属主（多线下必然指错线：看着线A 却提示
          //   "本对话线"，实际死的是线B 的执行端）。消费端据此决定措辞与是否由 lineManager 出名字。
          dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: cid, event: { type: "ide_instance_gone", payload: { ..._payload, chatid: cid } } } })
            .then((r) => {
              // [0726] bus:broadcast 在启动早期可能尚未注册（实测日志：regex/worldbook 广播同因失败）。
              // 本通知是用户唯一能知道「这条线的工具调用已停摆」的途径，失败必须留痕，不许静默吞。
              if (r && r.ok === false) console.warn(`[ideClient] 执行端离线通知未送达(chat=${cid}): ${r?.error?.msg || r?.error?.code || "bus:broadcast 不可用"}`);
            })
            .catch((e) => console.warn(`[ideClient] 执行端离线通知广播异常(chat=${cid}): ${e?.message || e}`));
        }
      })
      .catch((e) => console.warn(`[ideClient] 执行端离线通知 dispatcher 加载失败: ${e?.message || e}`));
  }

  _broadcastApprovalCount(chatid) {
    if (!chatid) return;
    // [0716 T3对接首批] 改经 bus:broadcast 出口（exits.mjs）；fire-and-forget 失败静默=原语义。
    //   动态 import dispatcher 防层级环（dispatcher 静态引 transport/index，此处反向引用走懒加载断环）。
    import("../dispatch/dispatcher.mjs")
      .then(({ dispatch }) => {
        dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid, event: {
          type: "pending_approvals",
          payload: { count: this._pendingApprovals.filter((o) => o.status === "pending").length },
        } } }).catch(() => {});
        // C-1：跨 chatId 广播 → 其他 chat（全智能监听 work 任务事件）即时刷新审批角标
        dispatch({ target: "bus:broadcast", verb: "emitCross", source: "yonban", payload: { chatid, event: { type: "cross_mode_task_update", subtype: "pending_approvals" } } }).catch(() => {});
      })
      .catch(() => { /* 广播失败不影响队列操作 */ });
  }

  /**
   * 批准并执行单个待审批写操作。前端用户点「批准」后触发。
   *
   * 链路：前端审批 UI → YonBanProvider → 本体端点 → 本函数 → callToolAndStore → Hop 3
   * 影响：
   *   - T2 S2 fail-closed 指纹校验（漂移即拒，不执行）
   *   - 带 _checkpointId 让快照落到审批时绑定的检查点（R1 钉住路径）
   *   - 执行完调 _maybeCommitCheckpoint 闭合检查点生命周期
   *
   * @param {string} opId - addPendingApproval 返回的操作 ID
   * @returns {Promise<{ success: boolean, result?: object, error?: string, failClosed?: boolean }>}
   */
  async approveOperation(opId) {
    const idx = this._pendingApprovals.findIndex((o) => o.id === opId);
    if (idx < 0) {
      // 已知:approveAll 并发逐个 await approveOperation,期间 op 可能被另一路径(超时/rejectAll)摘除 → 找不到。
      wbD(null, "ideClient", "approval:opNotFound", false, "审批操作未找到(可能并发已被摘除)", { opId });
      return { success: false, error: "操作未找到" };
    }
    const op = this._pendingApprovals[idx];
    wbT(op.chatid || null, "ideClient", "approval:approve", { tool: op.tool, id: opId });
    // ★ T2 S2 fail-closed：执行前重算指纹，与入队绑定比对。漂移即拒，绝不执行未经批准的真实操作。
    if (op.binding?.fingerprint) {
      const _now = _approvalFingerprint(op.tool, op.params);
      if (_now !== op.binding.fingerprint) {
        this._pendingApprovals.splice(idx, 1);
        const _failEntry = {
          tool: op.tool, params: op.params,
          result: { success: false, failClosed: true, error: "审批绑定校验失败（操作指纹与批准时不符），已拒绝执行" },
          chatid: op.chatid || null,
          timestamp: new Date().toISOString(),
        };
        this.enqueuePendingResult(_failEntry);
        this._recordOperation({ ..._failEntry, success: false });
        void this._maybeCommitCheckpoint(op.checkpointId, op.chatid || null);
        this._broadcastApprovalCount(op.chatid || null);
        wbD(op.chatid || null, "ideClient", "approval:fingerprintMismatch", false, "审批指纹漂移,fail-closed拒绝执行", { tool: op.tool, id: opId });
        console.warn(`[ideClient] ★fail-closed 拒绝: ${op.tool} 指纹漂移 (id=${opId})`);
        return { success: false, failClosed: true, error: "审批绑定校验失败，已拒绝执行" };
      }
    }
    op.status = "approved";
    this._pendingApprovals.splice(idx, 1);
    this._broadcastApprovalCount(op.chatid || null);
    try {
      // R1：带上 op.checkpointId，让服务端把快照钉到该写真正归属的检查点（不依赖全局 _activeId，
      // 避免审批挂起期间被其他轮 start 劫持 → 快照落错检查点 → 回档丢文件）
      const _params = op.checkpointId
        ? { ...op.params, _checkpointId: op.checkpointId }
        : op.params;
      const result = await this.callToolAndStore(op.tool, _params, op.chatid || null);
      // 该检查点的待审批写全部消费完 → 提交（落盘+闭合生命周期）
      await this._maybeCommitCheckpoint(op.checkpointId, op.chatid || null);
      return { success: true, result };
    } catch (e) {
      await this._maybeCommitCheckpoint(op.checkpointId, op.chatid || null);
      return { success: false, error: e.message };
    }
  }

  /**
   * 拒绝单个待审批操作。将拒绝结果入 pendingResults 让 AI 知道。
   *
   * 影响：从 _pendingApprovals 移除 + enqueuePendingResult 拒绝消息 + _maybeCommitCheckpoint 闭合
   *
   * @param {string} opId - 操作 ID
   * @returns {{ success: boolean, error?: string }}
   */
  rejectOperation(opId) {
    const idx = this._pendingApprovals.findIndex((o) => o.id === opId);
    if (idx < 0) {
      wbD(null, "ideClient", "approval:rejectNotFound", false, "拒绝的审批操作未找到", { opId });
      return { success: false, error: "操作未找到" };
    }
    this._pendingApprovals[idx].status = "rejected";
    const op = this._pendingApprovals.splice(idx, 1)[0];
    // 记录被拒绝的操作到 pendingResults，让 AI 知道
    const _rejEntry = {
      tool: op.tool, params: op.params,
      result: { success: false, error: "用户拒绝了此操作" },
      chatid: op.chatid || null,   // ★ B2 corrId隔离: 沿用审批入队时记录的会话
      timestamp: new Date().toISOString(),
    };
    this.enqueuePendingResult(_rejEntry);
    this._recordOperation({ ..._rejEntry, success: false });
    // 该检查点的待审批写全部消费完（含被拒）→ 提交，避免 deferred 检查点成永不闭合的孤儿（fire-and-forget）
    void this._maybeCommitCheckpoint(op.checkpointId, op.chatid || null);
    this._broadcastApprovalCount(op.chatid || null);
    return { success: true };
  }

  /**
   * 批准所有待审批操作。
   * ★ 多窗口会话隔离：传 sessionKey（= 发起会话的 chatid，前端 currentChatId）时只处理
   * `o.chatid === sessionKey` 的项，避免「全部批准」批掉其他会话待审 op。entry.chatid 入队时
   * 取 _qcid（正常回合 = 真实 chatid；N3 合成键项无主，不匹配任何会话 → 自然不被批，语义正确）。
   * 不传 sessionKey → 保持原全量行为（向后兼容内部/旧调用方）。
   */
  async approveAll(sessionKey = null) {
    const pending = this._pendingApprovals.filter(
      (o) => o.status === "pending" && (sessionKey == null || o.chatid === sessionKey),
    );
    // 已知:逐个 await 串行批准期间队列可变,sessionKey==null 全量易跨会话误批/并发误报。
    wbT(sessionKey || null, "ideClient", "approval:approveAll", { count: pending.length, scoped: sessionKey != null });
    const results = [];
    for (const op of pending) {
      results.push(await this.approveOperation(op.id));
    }
    return results;
  }

  /**
   * 拒绝所有待审批操作。sessionKey 语义同 approveAll：传则只拒本会话 op，不传则全量。
   */
  rejectAll(sessionKey = null) {
    const pending = [...this._pendingApprovals.filter(
      (o) => o.status === "pending" && (sessionKey == null || o.chatid === sessionKey),
    )];
    for (const op of pending) {
      this.rejectOperation(op.id);
    }
    return { success: true, count: pending.length };
  }

  // ---- 连接管理 ----

  /**
   * 当前连接的后端类型："cli"（beilu-cli 常驻工具后端）| "yonban"（VS Code/Cursor 真 IDE）| null（未连接）。
   * 权威=hello 载荷 appName（plugins/beilu-cli/server/server.mjs 发 "beilu-cli"，YonBan 无此值或为扩展名）；
   * hello 未到时回退连接期注册表 type 初判。消费方：injectionSystem 识别（CLI 绑 INJ-2、
   * YonBan 绑 INJ-2-code，凛倾 0722）+ 心跳互斥升级（CLI 在连而 YonBan 出现 → 切 YonBan）。
   */
  get backendKind() {
    return this.backendKindFor(null);
  }

  backendKindFor(chatid = null) {
    const _conn = this._connFor(chatid || null);
    if (_conn) {
      const app = _conn.ideInfo?.appName;
      if (app) return app === "beilu-cli" ? "cli" : "yonban";
      return _conn.kind || null;
    }
    // 连接中（尚无活连接）时回退注册表初判——保持原「connecting 期间可判型」语义
    if (!chatid) {
      for (const c of this._conns.values()) if (c.connecting) return c.kind || null;
    }
    return null;
  }

  getToolJobs({ ownerUsername = "", chatid, limit, includeTerminal = true } = {}) {
    const owner = ownerUsername || (chatid ? this._chatOwners.get(chatid) || "" : "");
    return this._toolJobs.list({ ownerUsername: owner, chatid, limit, includeTerminal });
  }

  clearTerminalToolJobs(chatid = null, ownerUsername = "") {
    const owner = ownerUsername || (chatid ? this._chatOwners.get(chatid) || "" : "");
    return this._toolJobs.clearTerminal(owner, chatid);
  }

  // forPrompt=true 走 listForPrompt 单次投递视图（终态 job 只进一次提示词，凛倾 0731
  // 「a 执行、b 看到、c 消失」）；默认 false 保持全量视图（面板/REST 消费者 setDataActions.mjs:5394
  // 读历史不推进投递标记）。两视图共用同一 registry，标记只在 forPrompt 路径写。
  getRuntimeSnapshot(chatid = null, username = "", { forPrompt = false } = {}) {
    const conn = this._connFor(chatid || null);
    const config = readToolRuntimeConfig(username);
    const jobsQuery = {
      ownerUsername: username || (chatid ? this._chatOwners.get(chatid) || "" : ""),
      chatid: chatid == null ? undefined : chatid,
      limit: config.history_limit,
    };
    return {
      chatid: chatid || null,
      connected: !!conn,
      backendKind: this.backendKindFor(chatid || null),
      backendPort: conn?.port ?? null,
      clientEnv: this.clientEnvFor(chatid || null),
      workspaceRoot: this.workspaceRootFor(chatid || null),
      binding: chatid ? this._bindingsSnapshot()[chatid] || null : null,
      config,
      jobs: forPrompt
        ? this._toolJobs.listForPrompt(jobsQuery)
        : this.getToolJobs(jobsQuery),
    };
  }

  async _runtimeContextFor(chatid = null, assertedOwnerUsername = "") {
    let metadataOwner = "";
    if (chatid) {
      try {
        const { chatMetadatas } = await import("../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
        metadataOwner = chatMetadatas?.get(chatid)?.username || "";
      } catch { /* 无会话元数据时使用默认配置 */ }
    }
    const assertedOwner = typeof assertedOwnerUsername === "string" ? assertedOwnerUsername.trim() : "";
    const registeredOwner = chatid ? this._chatOwners.get(chatid) || "" : "";
    if ((metadataOwner && assertedOwner && metadataOwner !== assertedOwner)
      || (registeredOwner && metadataOwner && registeredOwner !== metadataOwner)
      || (registeredOwner && assertedOwner && registeredOwner !== assertedOwner)) {
      return {
        username: "",
        ownerMismatch: true,
        config: readToolRuntimeConfig(""),
      };
    }
    const username = registeredOwner || metadataOwner || assertedOwner;
    if (chatid && username && !this.registerChatOwner(chatid, username)) {
      return {
        username: "",
        ownerMismatch: true,
        config: readToolRuntimeConfig(""),
      };
    }
    return { username, ownerMismatch: false, config: readToolRuntimeConfig(username) };
  }

  /**
   * 返回认证用户可见的操作历史副本。
   * ownerUsername 是强制边界；没有 owner 时 fail-closed，不退化为全局视图。
   */
  getOperationHistory({ ownerUsername = "", chatid, limit } = {}) {
    const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!owner) return [];
    if (chatid && this._chatOwners.get(chatid) !== owner) return [];
    const rows = [];
    for (const entry of this._operationHistory) {
      const entryOwner = entry.ownerUsername || (entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "");
      if (entryOwner !== owner) continue;
      if (chatid != null && entry.chatid !== chatid) continue;
      const { ownerUsername: _owner, ...publicEntry } = entry;
      rows.push({ ...publicEntry });
    }
    const normalizedLimit = Number.isFinite(Number(limit))
      ? Math.max(0, Math.floor(Number(limit)))
      : rows.length;
    if (normalizedLimit === 0) return [];
    return normalizedLimit < rows.length ? rows.slice(-normalizedLimit) : rows;
  }

  /**
   * 只清除认证用户自己的操作历史；跨 owner chat 或缺 owner 都不执行。
   */
  clearOperationHistory({ ownerUsername = "", chatid } = {}) {
    const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!owner) return 0;
    if (chatid && this._chatOwners.get(chatid) !== owner) return 0;
    let cleared = 0;
    this._operationHistory = this._operationHistory.filter((entry) => {
      const entryOwner = entry.ownerUsername || (entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "");
      const matches = entryOwner === owner && (chatid == null || entry.chatid === chatid);
      if (matches) cleared++;
      return !matches;
    });
    return cleared;
  }

  _recordOperation(entry, historyLimit = this._maxHistory) {
    if (!entry || typeof entry !== "object") return false;
    const ownerUsername = (typeof entry.ownerUsername === "string" && entry.ownerUsername.trim())
      || (entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "");
    this._operationHistory.push({ ...entry, ownerUsername });
    const limit = Math.max(20, Number(historyLimit) || this._maxHistory);
    if (this._operationHistory.length > limit) {
      this._operationHistory = this._operationHistory.slice(-limit);
    }
    return true;
  }

  _broadcastToolJob(job, notify = false, phase = null) {
    if (!job) return;
    const ownerUsername = this._toolJobs.ownerOf(job.jobId);
    const event = { type: "tool_job_update", payload: { job, notify: !!notify, phase: phase || job.state } };
    import("../dispatch/dispatcher.mjs")
      .then(({ dispatch }) => {
        if (job.chatid) {
          return dispatch({
            target: "bus:broadcast",
            verb: "emit",
            source: "yonban",
            payload: { chatid: job.chatid, event },
          });
        }
        if (!ownerUsername) {
          return { ok: false, error: { code: "E_OWNER", msg: "无会话 Job 缺少 owner，已禁止广播" } };
        }
        return dispatch({
          target: "bus:broadcast",
          verb: "emitOwner",
          source: "yonban",
          payload: { username: ownerUsername, event },
        });
      })
      .then((r) => {
        if (r && r.ok === false) {
          console.warn(`[ideClient] tool_job_update 未送达(job=${job.jobId}): ${r?.error?.msg || r?.error?.code || "broadcast unavailable"}`);
        }
      })
      .catch((e) => console.warn(`[ideClient] tool_job_update 广播异常(job=${job.jobId}): ${e?.message || e}`));
  }

  _publishWorkerToolLifecycle(pending, phase, extra = {}) {
    if (!isWorkerIsolate || !pending) return false;
    if (!pending.chatid || !pending.username || !pending.requestId || !pending.jobId) {
      wbD(pending?.chatid || null, "ideClient", "workerLifecycle:routeMissing", false,
        "worker lifecycle 缺少 chat/owner/request/job，已 fail-closed", {
          phase,
          requestId: pending?.requestId || null,
          jobId: pending?.jobId || null,
        });
      return false;
    }
    if (phase !== "started" && !pending.lifecycleStarted) {
      if (!this._publishWorkerToolLifecycle(pending, "started")) return false;
    }
    const event = {
      eventId: globalThis.crypto?.randomUUID?.()
        || `tool_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      phase,
      requestId: pending.requestId,
      jobId: pending.jobId,
      chatid: pending.chatid,
      username: pending.username,
      backend: {
        kind: pending.backendKind,
        port: pending.port,
        connectionId: pending.connectionId || undefined,
      },
      tool: pending.tool,
      params: pending.params,
      occurredAt: new Date().toISOString(),
      ...extra,
    };
    const sent = publishWorkerLifecycle(event);
    if (sent && phase === "started") pending.lifecycleStarted = true;
    if (!sent) {
      wbD(pending.chatid, "ideClient", "workerLifecycle:publishFail", false,
        "worker 常驻 lifecycle emitter 不可用", { phase, requestId: pending.requestId, jobId: pending.jobId });
    }
    return sent;
  }

  _armLateResultRetention(requestId, pending) {
    if (pending.retentionTimer) return;
    pending.retentionTimer = setTimeout(() => {
      if (this._pendingRequests.get(requestId) !== pending) return;
      this._pendingRequests.delete(requestId);
      clearTimeout(pending.longTimer);
      if (isWorkerIsolate) {
        if (pending.waitTimedOut || pending.detached) {
          this._publishWorkerToolLifecycle(pending, "transport_lost", {
            errorCode: "late_result_retention_expired",
          });
        }
        this._stats.toolCallsFailed++;
        return;
      }
      const job = this._toolJobs.update(pending.jobId, {
        state: "failed",
        error: "late_result_retention_expired",
        late: true,
      });
      this._stats.toolCallsFailed++;
      this._broadcastToolJob(job, !!pending.config?.notify_failed, "retention_expired");
      wbD(pending.chatid || null, "ideClient", "toolResult:retentionExpired", false,
        "迟到结果接收窗口已到期", { requestId, jobId: pending.jobId });
    }, pending.config.late_result_retention_ms);
    pending.retentionTimer.unref?.();
  }

  _makeLateResultEntry(pending, result) {
    const entry = {
      tool: pending.tool,
      params: pending.params,
      result,
      chatid: pending.chatid || null,
      ownerUsername: pending.username || "",
      timestamp: new Date().toISOString(),
      jobId: pending.jobId,
      backendKind: pending.backendKind,
      backendPort: pending.port,
      late: true,
    };
    const image = result?.success && result.result?.image === true ? result.result : null;
    if (image && typeof image.base64 === "string" && image.base64) {
      try {
        entry.userImage = {
          content: image.content || `[图片: ${pending.params?.path || ""}]`,
          files: [{
            name: (typeof pending.params?.path === "string" ? pending.params.path.split(/[\\/]/).pop() : "") || "image",
            mime_type: image.mimeType || "image/png",
            buffer: Buffer.from(image.base64, "base64"),
          }],
          marker: "ide_read_image",
          keepN: 2,
        };
      } catch { /* 图片解码失败仍保留普通工具结果 */ }
    }
    return entry;
  }

  _publishLateToolResult(pending, result) {
    // worker 只保留执行端 WS/requestId 运输职责；迟到结果不得在 isolate 本地入池、记录、
    // 广播或唤醒。结构化 lifecycle 经常驻 kind:event 交回主进程唯一 owner。
    if (isWorkerIsolate) {
      this._publishWorkerToolLifecycle(pending, "late_result", { result });
      return;
    }
    const entry = this._makeLateResultEntry(pending, result);
    // 没有 chatid 的结果没有安全的 AI 注入目标；保留 operation/Job 诊断，但禁止进入全局 pending 队列。
    if (pending.chatid && !this.enqueuePendingResult(entry)) {
      wbD(pending.chatid, "ideClient", "lateResult:ownerRejected", false,
        "迟到结果 owner 校验失败，禁止广播与唤醒", { jobId: pending.jobId });
      return;
    }
    this._recordOperation({ ...entry, success: result?.success !== false }, pending.config.history_limit);
    this._broadcastToolResultsReady(pending.chatid, pending.jobId, "late_tool_result");
    if (pending.chatid) {
      import("../../../public/parts/shells/beilu-chat/src/lib/generation.mjs")
        .then((generation) => generation.notifyResultReady?.({
          chatid: pending.chatid,
          username: pending.username,
          source: "late_tool_result",
          delayMs: pending.config.late_result_continue_delay_ms,
          enabled: pending.config.auto_continue_late_results,
        }))
        .catch((e) => console.warn(`[ideClient] 迟到工具结果续轮调度失败(job=${pending.jobId}): ${e?.message || e}`));
    }
  }

  _broadcastToolResultsReady(chatid, jobId, source) {
    if (!chatid) return;
    const event = { type: "tool_results_ready", payload: { count: 1, source, jobId } };
    import("../dispatch/dispatcher.mjs")
      .then(({ dispatch }) => dispatch({
        target: "bus:broadcast",
        verb: "emit",
        source: "yonban",
        payload: { chatid, event },
      }))
      .then((r) => {
        if (r && r.ok === false) {
          console.warn(`[ideClient] tool_results_ready 未送达(job=${jobId}): ${r?.error?.msg || r?.error?.code}`);
        }
      })
      .catch((e) => console.warn(`[ideClient] 工具结果广播异常(job=${jobId}): ${e?.message || e}`));
  }

  /**
   * 主进程接收 worker 常驻 lifecycle 的唯一入口。
   * schema/chat/认证 owner/相位任一不成立即 fail-closed：不建结果、不广播、不唤醒。
   */
  async acceptWorkerToolLifecycle(event) {
    if (isWorkerIsolate) return { accepted: false, reason: "worker_cannot_own_lifecycle" };
    const requiredStrings = ["eventId", "workerId", "chatid", "username", "requestId", "jobId", "occurredAt"];
    const missing = requiredStrings.filter((key) => typeof event?.[key] !== "string" || !event[key].trim());
    const validPhase = new Set(["started", "progress", "wait_timeout", "late_result", "transport_lost"]);
    const backend = event?.backend;
    const connectionId = typeof backend?.connectionId === "string"
      ? backend.connectionId.trim()
      : "";
    if (event?.type !== "tool_lifecycle" || event?.version !== 1 || missing.length
      || !validPhase.has(event?.phase)
      || !backend || !["yonban", "cli"].includes(backend.kind)
      || !Number.isSafeInteger(backend.port) || backend.port < 1 || backend.port > 65535
      || !connectionId) {
      wbD(event?.chatid || null, "ideClient", "workerLifecycle:schemaRejected", false,
        "worker lifecycle schema 无效", {
          missing,
          phase: event?.phase,
          version: event?.version,
          backendPort: backend?.port ?? null,
          hasConnectionId: !!connectionId,
        });
      return { accepted: false, reason: "invalid_schema" };
    }
    const chatid = event.chatid.trim();
    const username = event.username.trim();
    const registeredOwner = this._chatOwners.get(chatid) || "";
    let chatData = null;
    try {
      const { chatMetadatas } = await import("../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
      chatData = chatMetadatas?.get(chatid) || null;
    } catch { /* 下方统一 fail-closed */ }
    if (!registeredOwner || registeredOwner !== username || !chatData?.chatMetadata
      || chatData.username !== username || chatData.chatMetadata.username !== username) {
      wbD(chatid, "ideClient", "workerLifecycle:ownerRejected", false,
        "worker lifecycle 的 chat/owner 不在主进程认证域或会话已删除/卸载", {
          registeredOwner: registeredOwner || null,
          eventOwner: username,
          metadataOwner: chatData?.username || null,
          hasMetadata: !!chatData?.chatMetadata,
        });
      return { accepted: false, reason: "chat_owner_invalid" };
    }

    const key = `${event.workerId}\0${event.requestId}`;
    let state = this._workerLifecycleStates.get(key);
    const config = readToolRuntimeConfig(username);
    if (event.phase === "started") {
      if (state) return { accepted: false, reason: "invalid_phase" };
      const created = this._toolJobs.create({
        requestId: event.requestId,
        chatid,
        ownerUsername: username,
        tool: event.tool || "_unknown_tool",
        params: event.params || {},
        backendKind: backend.kind,
        backendPort: Number(backend.port),
        historyLimit: config.history_limit,
      });
      const running = this._toolJobs.update(created.jobId, {
        state: "running",
        startedAt: event.occurredAt || new Date().toISOString(),
      });
      state = {
        key,
        workerId: event.workerId,
        requestId: event.requestId,
        remoteJobId: event.jobId,
        jobId: created.jobId,
        chatid,
        username,
        tool: event.tool || "_unknown_tool",
        params: event.params || {},
        backendKind: backend.kind,
        port: Number(backend.port),
        connectionId,
        phase: "started",
        stallNotified: false,
        config,
      };
      this._workerLifecycleStates.set(key, state);
      this._broadcastToolJob(running, false, "started");
      wbT(chatid, "ideClient", "workerLifecycle:started", {
        workerId: event.workerId, requestId: event.requestId, jobId: created.jobId,
      });
      return { accepted: true, phase: "started", jobId: created.jobId };
    }

    if (!state || state.chatid !== chatid || state.username !== username
      || state.remoteJobId !== event.jobId
      || state.backendKind !== backend.kind || state.port !== backend.port
      || state.connectionId !== connectionId) {
      wbD(chatid, "ideClient", "workerLifecycle:routeRejected", false,
        "worker lifecycle 无匹配 started 或路由事实漂移", {
          phase: event.phase, workerId: event.workerId, requestId: event.requestId, hasState: !!state,
        });
      return { accepted: false, reason: "route_or_phase_invalid" };
    }

    if (event.phase === "progress") {
      if (!["started", "wait_timeout"].includes(state.phase)) {
        return { accepted: false, reason: "invalid_phase" };
      }
      const progress = _normalizeToolProgress(event.progress);
      if (!progress) return { accepted: false, reason: "invalid_progress" };
      const currentJob = this._toolJobs.get(state.jobId);
      const startedAtMs = new Date(currentJob?.startedAt || currentJob?.createdAt || Date.now()).getTime();
      const job = this._toolJobs.update(state.jobId, {
        progress,
        longRunning: currentJob?.longRunning || progress.phase === "stalled",
        duration: Math.max(0, Date.now() - startedAtMs),
      });
      if (progress.phase === "running") state.stallNotified = false;
      const shouldNotify = progress.phase === "stalled"
        && !state.stallNotified
        && !!config.notify_stalled;
      if (progress.phase === "stalled") state.stallNotified = true;
      this._broadcastToolJob(
        job,
        shouldNotify,
        progress.phase,
      );
      return { accepted: true, phase: "progress", jobId: state.jobId };
    }

    if (event.phase === "wait_timeout") {
      if (state.phase !== "started") return { accepted: false, reason: "invalid_phase" };
      state.phase = "wait_timeout";
      const job = this._toolJobs.update(state.jobId, {
        state: "wait_timeout",
        error: "response_wait_timeout",
      });
      this._broadcastToolJob(job, false, "wait_timeout");
      return { accepted: true, phase: "wait_timeout", jobId: state.jobId };
    }

    if (event.phase === "transport_lost") {
      if (!["started", "wait_timeout"].includes(state.phase)) return { accepted: false, reason: "invalid_phase" };
      state.phase = "transport_lost";
      // Map 顺序改为「进入终态的时间顺序」，让 per-owner 修剪删除最老终态，
      // 而不是按 started 的先后误删刚完成的长任务。
      this._workerLifecycleStates.delete(key);
      this._workerLifecycleStates.set(key, state);
      const job = this._toolJobs.update(state.jobId, {
        state: "connection_lost",
        error: event.errorCode || "worker_transport_lost",
      });
      this._broadcastToolJob(job, !!config.notify_failed, "transport_lost");
      this._trimWorkerLifecycleStates(username);
      return { accepted: true, phase: "transport_lost", jobId: state.jobId };
    }

    if (!["started", "wait_timeout"].includes(state.phase)
      || !event.result || typeof event.result !== "object") {
      return { accepted: false, reason: "invalid_phase_or_result" };
    }
    const success = event.result.success !== false;
    const enriched = {
      ...event.result,
      jobId: state.jobId,
      backendKind: state.backendKind,
      backendPort: state.port,
      late: true,
      waitTimedOut: state.phase === "wait_timeout",
    };
    const entry = this._makeLateResultEntry(state, enriched);
    if (!this.enqueuePendingResult(entry)) {
      return { accepted: false, reason: "pending_owner_rejected" };
    }
    this._recordOperation({ ...entry, success }, config.history_limit);
    state.phase = "late_result";
    this._workerLifecycleStates.delete(key);
    this._workerLifecycleStates.set(key, state);
    const job = this._toolJobs.update(state.jobId, {
      state: success ? "succeeded" : "failed",
      error: success ? null : (event.result.error || "tool_failed"),
      late: true,
    });
    this._broadcastToolJob(
      job,
      success ? !!config.notify_completed : !!config.notify_failed,
      "late_result",
    );
    this._broadcastToolResultsReady(chatid, state.jobId, "worker_late_tool_result");
    try {
      const generation = await import("../../../public/parts/shells/beilu-chat/src/lib/generation.mjs");
      generation.notifyResultReady?.({
        chatid,
        username,
        source: "worker_late_tool_result",
        delayMs: config.late_result_continue_delay_ms,
        enabled: config.auto_continue_late_results,
      });
    } catch (e) {
      console.warn(`[ideClient] worker 迟到结果续轮调度失败(job=${state.jobId}): ${e?.message || e}`);
    }
    this._trimWorkerLifecycleStates(username);
    return { accepted: true, phase: "late_result", jobId: state.jobId };
  }

  /**
   * 按 owner 的 tool_runtime.history_limit 修剪 lifecycle 终态。
   * 非终态代表仍可能收到 late_result/transport_lost，绝不能为腾容量而删；
   * 每个 owner 独立计数，避免一个用户的长历史挤掉另一个用户的关联状态。
   */
  _trimWorkerLifecycleStates(ownerUsername) {
    const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!owner) return 0;
    const limit = readToolRuntimeConfig(owner).history_limit;
    const terminalKeys = [];
    for (const [key, state] of this._workerLifecycleStates) {
      if (state.username === owner
        && (state.phase === "late_result" || state.phase === "transport_lost")) {
        terminalKeys.push(key);
      }
    }
    const removeCount = Math.max(0, terminalKeys.length - limit);
    for (let i = 0; i < removeCount; i++) this._workerLifecycleStates.delete(terminalKeys[i]);
    return removeCount;
  }

  _failPendingForConnection(requestId, pending, errorCode) {
    clearTimeout(pending.timer);
    clearTimeout(pending.longTimer);
    clearTimeout(pending.retentionTimer);
    this._pendingRequests.delete(requestId);
    if (pending.kind !== "tool") {
      pending.reject(new Error(errorCode));
      return;
    }
    if (isWorkerIsolate) {
      if (pending.waitTimedOut || pending.detached) {
        this._publishWorkerToolLifecycle(pending, "transport_lost", { errorCode });
      }
      this._stats.toolCallsFailed++;
      pending.resolve({
        success: false,
        error: errorCode,
        errorCode,
        jobId: pending.jobId,
        backendKind: pending.backendKind,
        backendPort: pending.port,
      });
      return;
    }
    const job = this._toolJobs.update(pending.jobId, { state: "connection_lost", error: errorCode });
    this._stats.toolCallsFailed++;
    this._broadcastToolJob(job, !!pending.config?.notify_failed, "connection_lost");
    pending.resolve({
      success: false,
      error: errorCode,
      errorCode,
      jobId: pending.jobId,
      backendKind: pending.backendKind,
      backendPort: pending.port,
    });
  }

  // ---- 多开实例绑定（chatid → YonBan 实例端口，producer=YonBan 窗口 selectChat 经 SetData bindIdeInstance） ----

  /**
   * 绑定会话到指定 YonBan 实例端口。此后该会话的全部 IDE 工具/检查点/提问路由到该窗口。
   * 绑定即确保该端口在连接池内（窗口刚启动、周期重扫未到时也立即接入）。
   * @param {string} chatid
   * @param {number} port
   * @param {"auto"|"manual"} source
   * @param {string|null} expectedInstanceId - 调用方所在 IDE 窗口的权威实例 ID，可在连接就绪前持久化
   */
  bindChat(chatid, port, source = "auto", expectedInstanceId = null) {
    if (!chatid || typeof port !== "number" || !Number.isFinite(port)) return { success: false, error: "chatid/port 无效" };
    const expectedId = typeof expectedInstanceId === "string" && expectedInstanceId.trim()
      ? expectedInstanceId.trim()
      : null;
    const liveAtPort = this._conns.get(port);
    if (expectedId && this._isConnLive(liveAtPort) && liveAtPort.instanceId !== expectedId) {
      wbD(chatid, "ideClient", "bind:instanceConflict", false,
        "目标端口活连接的实例身份与上报不一致，拒绝绑定", {
          port,
          expectedInstanceId: expectedId,
          actualInstanceId: liveAtPort.instanceId || null,
        });
      return { success: false, error: "IDE 实例身份冲突，已拒绝绑定", port, expectedInstanceId: expectedId, actualInstanceId: liveAtPort.instanceId || null };
    }
    // [绑定来源优先级 0726] 用户在 ＋号 里指定的执行端是显式意图（manual，粘性）；YonBan 打开对话时的
    //   自动上报（auto）是弱意图。原先两者同权、最后写入者赢 → 只要该对话在任一 YonBan 窗口被打开过，
    //   用户指定的执行端就被静默改掉。规则：auto 不覆盖仍然在线的 manual 绑定；manual 覆盖一切；
    //   manual 绑的实例已离线时 auto 可接管（否则线会永久卡在一个关掉的窗口上）。
    if (source !== "manual" && this._bindingSources?.get(chatid) === "manual") {
      const _cur = this._conns.get(this._chatBindings.get(chatid));
      if (this._isConnLive(_cur) && _cur.port !== port) {
        wbT(chatid, "ideClient", "bind:autoSkipped", { keep: _cur.port, from: port });
        return { success: true, port: _cur.port, kept: "manual" };
      }
    }
    this._bindingSources?.set(chatid, source === "manual" ? "manual" : "auto");
    this._chatBindings.set(chatid, port);
    // 换绑先清旧身份（编号+根快照），防旧窗残留被误认；新窗身份取自当前连接的 hello，
    // 若此刻尚未握手则留空，由 _connFor 首次命中时补记（见那里的「补记编号」分支）。
    this._bindingIds.delete(chatid);
    this._bindingRoots.delete(chatid);
    const _bc = this._conns.get(port);
    if (expectedId) this._bindingIds.set(chatid, expectedId);
    if (this._isConnLive(_bc)) {
      if (!expectedId && _bc.instanceId) this._bindingIds.set(chatid, _bc.instanceId);
      const _br = _bc.ideInfo?.status?.workspaceFolders?.[0];
      if (_br) this._bindingRoots.set(chatid, _br);
    }
    this._persistBindings();
    if (this._autoReconnect) {
      const _knownKind = this._conns.get(port)?.kind
        || (IdeClient.discoverActivePorts().find((entry) => entry?.port === port)?.type === "beilu-cli" ? "cli" : "yonban");
      this._ensureConn(port, resolveTokenForPort(port), _knownKind);
    }
    wbT(chatid, "ideClient", "bind:set", { port, instanceId: this._bindingIds.get(chatid) || null });
    return { success: true, port, instanceId: this._bindingIds.get(chatid) || null };
  }

  /** [窗口id 0726 容错] 绑定表从盘上恢复（仅主 isolate 构造时调一次）。 */
  _loadBindings() {
    try {
      if (!fs.existsSync(this._bindingsFile)) return;
      const _j = JSON.parse(fs.readFileSync(this._bindingsFile, "utf-8"));
      const _b = _j?.bindings || {};
      for (const [cid, v] of Object.entries(_b)) {
        if (typeof v?.port === "number" && Number.isFinite(v.port)) this._chatBindings.set(cid, v.port);
        if (typeof v?.instanceId === "string" && v.instanceId) this._bindingIds.set(cid, v.instanceId);
        if (v?.source === "manual") this._bindingSources.set(cid, "manual"); // 手动指定跨重启保持粘性
        if (typeof v?.root === "string" && v.root) this._bindingRoots.set(cid, v.root);
      }
      if (this._chatBindings.size) {
        console.log(`[ideClient] 绑定表已恢复: ${this._chatBindings.size} 条（旧端口死则首次路由自愈重绑）`);
        wbT(null, "ideClient", "bindings:restored", { count: this._chatBindings.size }); // 白盒：重启恢复线路可见
      }
    } catch (e) {
      console.warn(`[ideClient] 绑定表加载失败(忽略,从空表开始): ${e.message}`);
    }
  }

  /**
   * 会话绑定快照（**形状单点**）：chatid → { port, instanceId, root, source }。
   * 【why 收单点】这个形状有两个消费面：① 落盘（_persistBindings，重启恢复靠 instanceId 认窗口、
   *   靠 source==="manual" 保持用户手动指定的粘性，见 _loadBindings:1128-1132）；② UI/诊断快照
   *   （getIdeInstances → 前端）。两处各拼一份的实际后果（0726 实况）：落盘是对象，而
   *   getIdeInstances 返回的是**裸端口号**，两个前端消费方却都按对象读——
   *   lineManager._lineIdeLabel:95 / _refreshBindHint:466（b.port、b.source）与
   *   ideConnPanel:131-133（bindings[k]?.port、?.source）→ b.port 恒 undefined ⇒
   *   线图标 tooltip 恒「端口 undefined（不在线）」、＋号恒红判离线、连接面板绑定/手动计数恒 0。
   *   同一事实两处拼形状=必然漂移，故收为本方法，两个消费面共用。
   */
  _bindingsSnapshot() {
    const bindings = {};
    for (const [cid, port] of this._chatBindings)
      bindings[cid] = { port, instanceId: this._bindingIds.get(cid) || null, root: this._bindingRoots.get(cid) || null, source: this._bindingSources.get(cid) || "auto" };
    return bindings;
  }

  /** [窗口id 0726 容错] 绑定表落盘（500ms 防抖；worker isolate 不落盘防与主进程互写）。 */
  _persistBindings() {
    if (isWorkerIsolate) return;
    if (this._bindingsSaveTimer) clearTimeout(this._bindingsSaveTimer);
    this._bindingsSaveTimer = setTimeout(() => {
      try {
        const bindings = this._bindingsSnapshot();
        fs.mkdirSync(path.dirname(this._bindingsFile), { recursive: true });
        fs.writeFileSync(this._bindingsFile, JSON.stringify({ bindings }, null, 2));
      } catch (e) {
        console.warn(`[ideClient] 绑定表落盘失败: ${e.message}`);
      }
    }, 500);
    this._bindingsSaveTimer.unref?.();
  }

  /** 解除会话绑定（回退主连接路由）。 */
  unbindChat(chatid) {
    if (!chatid) return { success: false };
    const had = this._chatBindings.delete(chatid);
    this._bindingIds.delete(chatid);   // 配对删链（编号身份）
    this._bindingSources.delete(chatid); // 配对删链（绑定来源）
    this._bindingRoots.delete(chatid); // 配对删链
    if (had) this._persistBindings();
    wbT(chatid, "ideClient", "bind:clear", { had });
    return { success: true };
  }

  /** 查询会话绑定端口（groupWorkerManager 派发 worker 时取，随 payload 下发给 isolate 定向连接）。 */
  getChatBindingPort(chatid) {
    return chatid ? (this._chatBindings.get(chatid) ?? null) : null;
  }

  /** 连接池状态快照（UI 展示/诊断）：实例列表 + 会话绑定表 + 主端口。 */
  getIdeInstances() {
    const instances = [];
    for (const c of this._conns.values()) {
      instances.push({
        port: c.port,
        instanceId: c.instanceId || null, // 实例自报编号（本体识别窗口的权威身份）
        kind: c.ideInfo?.appName === "beilu-cli" ? "cli" : (c.kind || "yonban"),
        connected: this._isConnLive(c),
        primary: c.port === this._primaryPort,
        appName: c.ideInfo?.appName || null,
        workspaceFolders: c.ideInfo?.status?.workspaceFolders || [],
        extensionVersion: c.ideInfo?.extensionVersion || null,
      });
    }
    // 形状与落盘同源（_bindingsSnapshot）：前端两个消费方按 { port, source } 读，禁回退成裸端口号。
    // ideMode/windowDimension 随快照下发（分类器单点 resolveIdeMode）：前端据此决定「窗口」怎么呈现
    //   —— YonBan 模式=让用户选绑哪个 VSCode 窗口；CLI 模式=窗口就是线，不出现"选实例"这种假选择。
    //   走既有通道下发，不新增端点（链路里已有该事实就别造第二条）。
    const _ide = resolveIdeMode();
    return {
      instances, bindings: this._bindingsSnapshot(), primaryPort: this._primaryPort,
      ideMode: _ide.mode, windowDimension: _ide.windowDimension,
    };
  }

  /** 读取活跃端口注册表，返回所有活跃的 YonBan 实例信息 */
  static discoverActivePorts() {
    try {
      const registryFile = path.join(os.homedir(), ".beilu", "ide_active_ports.json");
      if (!fs.existsSync(registryFile)) return [];
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
      if (!Array.isArray(registry)) return [];
      // [债#9 修 0726] pid 探活 + procStart 双因子：裸 pid 会被系统复用，复用后死条目被判"还活着"，
      //   本体便去连一个早已不存在的实例（连不上→反复重试→池里挂个僵尸目标）。
      //   有 procStart 的条目再比一次启动时刻（容差 2s：写入侧用 Date.now()-uptime 估算，非精确值）；
      //   旧 YonBan 不写此字段 → 无从比对，退回裸 pid 判定（向后兼容，不因缺字段误杀在线实例）。
      const _nowStart = Date.now() - (typeof process.uptime === "function" ? process.uptime() * 1000 : 0);
      return registry.filter(entry => {
        try { process.kill(entry.pid, 0); } catch { return false; }
        if (typeof entry.procStart === "number" && entry.pid === process.pid) {
          // 极端情形：注册表里的 pid 正好等于本进程 pid（pid 已被复用给本体自己）
          return Math.abs(entry.procStart - _nowStart) < 2000;
        }
        return true;
      });
    } catch { return []; }
  }

  /**
   * 连接入口（多开池化版，幂等）。
   * - options.port：定向连接单实例（worker isolate 按会话绑定端口连；不整池扫描）
   * - 无 port：按活跃端口注册表建整池（主进程），并启动周期重扫（新窗口接入/死窗口剪除/CLI互斥）
   * 旧调用方（memory main.mjs / beilu-cli / endpoints）零改动：无 port 调用=整池语义。
   */
  connect(options = {}) {
    this._autoReconnect = options.autoReconnect !== false;
    if (options.port) {
      if (this._primaryPort == null) {
        this._primaryPort = options.port;
        this._primaryKind = options.kind || null;
      } else if (this._primaryPort === options.port && !this._primaryKind && options.kind) {
        this._primaryKind = options.kind;
      }
      this._ensureConn(options.port, options.token || resolveTokenForPort(options.port), options.kind || null);
      this._startHeartbeat();
      return;
    }
    this._syncConnections();
    this._startHeartbeat();
    // worker isolate 不开周期重扫：isolate 生命周期短且只服务单会话（定向 port 或主端口一条连接足够），
    // 每 isolate 一个 15s interval × N 个 worker = 纯浪费；主进程整池重扫是唯一的池权威。
    if (!isWorkerIsolate) this._startRescan();
  }

  /**
   * 注册表 → 连接池同步（多开核心）。
   * 目标集规则：有任一 YonBan 在线 → 全部 YonBan 实例接入、CLI 不连（凛倾 0722 互斥裁决保留）；
   * 无 YonBan → 只连最新注册的 CLI；注册表缺失 → resolveIdeWsToken 旧单连接回退（env/全局 token 文件）。
   * 主连接（未绑定会话默认路由）= 目标集内最新注册，与原单连接选择规则一致。
   */
  _syncConnections() {
    let targets = [];
    // 连接目标集直接由分类器裁决（resolveIdeMode 单点）：谁是当前 IDE 系统、有哪些实例，
    //   与 beilu-cli supervisor 的进程生死、前端的窗口维度呈现读的是同一个答案。
    const _ide = resolveIdeMode();
    // [模式切换广播 0727 凛倾「如果用户从 cli 切换到 yonban，需要关闭其他额外窗口」]
    //   窗口维度随系统改变：cli 模式下"窗口"=本体内的线（一个进程多线），yonban 模式下"窗口"=
    //   VSCode 实例。所以切到 yonban 时，本体那些按线维度开出来的额外窗口在新维度里不成立，
    //   必须收掉——由前端 lineManager（线的持有者）执行关闭，本处只负责如实播报维度变了。
    //   广播用 emitAll（全量）：这是全局事实，不属于某一条线；且必须在 targets 变更**之前**发，
    //   否则连接已切、前端还以为在旧模式。
    if (this._lastIdeMode !== _ide.mode) {
      const _from = this._lastIdeMode ?? "none";
      this._lastIdeMode = _ide.mode;
      if (_from !== "none" || _ide.mode !== "none") {
        wbT(null, "ideClient", "ideMode:changed", { from: _from, to: _ide.mode, dim: _ide.windowDimension });
        import("../dispatch/dispatcher.mjs")
          .then(({ dispatch }) => dispatch({
            target: "bus:broadcast", verb: "emitAll", source: "yonban",
            payload: { event: { type: "ide_mode_changed", payload: { from: _from, to: _ide.mode, windowDimension: _ide.windowDimension, instanceCount: _ide.instances.length } } },
          }).then((r) => {
            if (r && r.ok === false) console.warn(`[ideClient] IDE 模式切换广播未送达: ${r?.error?.msg || r?.error?.code}`);
          }))
          .catch((e) => console.warn(`[ideClient] IDE 模式切换广播异常: ${e?.message || e}`));
      }
    }
    if (_ide.mode === "yonban" || _ide.mode === "hybrid") {
      // YonBan 模式：窗口维度=实例 → 每个在线窗口各建一条连接（多开的物理基础）
      targets = _ide.yonbans.map((e) => ({ port: e.port, kind: "yonban", time: e.time || 0 }));
      if (_ide.mode === "hybrid") {
        // CLI 自身按 chatid 分池，一个在线进程即可；YonBan 则保留每个实例的独立连接。
        const cli = [..._ide.clis].sort((a, b) => (b.time || 0) - (a.time || 0))[0];
        if (cli) targets.push({ port: cli.port, kind: "cli", time: cli.time || 0 });
      }
    } else if (_ide.mode === "cli") {
      // CLI 模式：窗口维度=线 → 一个进程服务全部线，连一条即可（多线靠会话键在 CLI 侧分池）
      const cli = [..._ide.clis].sort((a, b) => (b.time || 0) - (a.time || 0))[0];
      targets = [{ port: cli.port, kind: "cli", time: cli.time || 0 }];
    } else {
      const g = resolveIdeWsToken();
      if (g.token || g.port != null) targets = [{ port: g.port ?? DEFAULT_PORT, kind: g.kind || null, time: 0, token: g.token }];
    }
    // worker isolate 收敛：只连主端口一条（isolate 服务单会话；定向连接走 connect({port})，
    // 这里是无绑定回退）——避免 N 个 worker × M 个窗口的网状连接浪费。
    if (isWorkerIsolate && targets.length > 1) {
      const _workerTargets = targets.some((t) => t.kind === "yonban")
        ? targets.filter((t) => t.kind === "yonban")
        : targets;
      targets = [[..._workerTargets].sort((a, b) => (b.time || 0) - (a.time || 0))[0]];
    }
    const targetPorts = new Set(targets.map((t) => t.port));
    for (const conn of [...this._conns.values()]) {
      if (!targetPorts.has(conn.port)) this._dropConn(conn, "registry-prune");
    }
    // 未绑定会话保持 YonBan 优先的兼容默认；显式绑定的会话始终走自身 CLI/YonBan。
    const _primaryCandidates = targets.some((t) => t.kind === "yonban")
      ? targets.filter((t) => t.kind === "yonban")
      : targets;
    const _primaryTarget = _primaryCandidates.length
      ? [..._primaryCandidates].sort((a, b) => (b.time || 0) - (a.time || 0))[0]
      : null;
    this._primaryPort = _primaryTarget?.port ?? null;
    this._primaryKind = _primaryTarget?.kind || null;
    for (const t of targets) {
      this._ensureConn(t.port, t.token || resolveTokenForPort(t.port), t.kind);
    }
  }

  /** 确保指定端口存在活/在建连接（幂等）。鉴权失败 ≥10 次且 token 未变 → 停手防风暴（token 更新自动恢复）。 */
  _ensureConn(port, token, kind) {
    const existing = this._conns.get(port);
    if (existing && (this._isConnLive(existing) || existing.connecting)) return;
    if (existing && existing.authFailCount >= 10 && existing.lastFailToken === token) return;
    const conn = {
      port, kind: kind || null, ws: null, connected: false, connecting: true,
      ideInfo: null, lastPongAt: 0, token,
      connectionId: `conn_${Date.now()}_${++this._connectionGeneration}`,
      authFailCount: existing?.authFailCount || 0, lastFailToken: existing?.lastFailToken || null,
    };
    this._conns.set(port, conn);
    this._stats.connectAttempts++;
    wbT(null, "ideClient", "connect:start", { port });
    const url = token
      ? `ws://localhost:${port}${this._wsPath}?token=${encodeURIComponent(token)}`
      : `ws://localhost:${port}${this._wsPath}`;
    if (!token) {
      wbD(null, "ideClient", "connect:noToken", false, "未找到WS token", { port });
      console.warn(`[ideClient] 端口 ${port} 未找到 WS token（env BEILU_IDE_WS_TOKEN / ~/.beilu/ide_ws_token_${port} / 全局文件）；若 YonBan 启用了 token 校验，连接将被拒(4001)`);
    }
    try {
      const ws = new WebSocket(url);
      conn.ws = ws;
      ws.onopen = () => {
        if (this._conns.get(port) !== conn) {
          try { ws.close(1000, "stale connection"); } catch { /* ignore */ }
          return;
        }
        conn.connected = true;
        conn.connecting = false;
        conn.lastPongAt = Date.now(); // H3: 连上即设基线，避免首个心跳周期前误判僵连接
        // 鉴权确认清零仍在 case "hello"：onopen 只代表握手升级成功，4001 在其后
        this._stats.successfulConnections++;
        wbT(null, "ideClient", "connect:opened", { port });
        console.log(`[ideClient] 已连接到后端 (端口 ${port}${conn.kind ? "，" + (conn.kind === "cli" ? "CLI" : "YonBan") : ""})`);
        this._startHeartbeat();
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
          this._handleMessage(msg, conn);
        } catch {
          // 非 JSON 消息，忽略
        }
      };
      ws.onclose = (event) => this._handleConnClose(conn, event);
      ws.onerror = () => {
        if (this._conns.get(port) !== conn) return;
        conn.connecting = false;
        wbT(null, "ideClient", "connect:wsError", { port }); // YonBan/IDE 可选,未起=正常态非异常(重扫已节流)
      };
    } catch (err) {
      conn.connecting = false;
      conn.ws = null;
      wbD(null, "ideClient", "connect:exception", false, err.message, { port });
      console.warn(`[ideClient] 连接失败(端口 ${port}): ${err.message}`);
      if (this._autoReconnect) this._scheduleRescanSoon();
    }
  }

  /** 单连接关闭处理：只拒本连接在飞 pending（多连接下禁全清）；鉴权失败计数；调度重扫重连。 */
  _handleConnClose(conn, event) {
    const isCurrent = this._conns.get(conn.port) === conn;
    const wasConnected = conn.connected;
    if (isCurrent && wasConnected) this._notifyBoundLinesGone(conn); // 停 YonBan → 通知绑在它上面的线（取 ideInfo 前调用）
    conn.connected = false;
    conn.connecting = false;
    conn.ideInfo = null;
    conn.ws = null;
    for (const [id, pending] of [...this._pendingRequests]) {
      if (pending.connectionId === conn.connectionId) {
        this._failPendingForConnection(id, pending, "backend_connection_lost");
      }
    }
    if (!isCurrent) {
      wbT(null, "ideClient", "connect:staleCloseIgnored", { port: conn.port, connectionId: conn.connectionId });
      return;
    }
    const code = event?.code;
    if (code === 4001 || code === 4003) {
      conn.authFailCount = (conn.authFailCount || 0) + 1;
      conn.lastFailToken = conn.token;
      wbD(null, "ideClient", "connect:authFail", false, `连接被拒code=${code}`, { port: conn.port, authFailCount: conn.authFailCount });
      if (conn.authFailCount >= 10)
        console.warn(`[ideClient] 端口 ${conn.port} 连接被拒(code=${code})，连续 ${conn.authFailCount} 次鉴权失败，停止重试（token 更新后自动恢复）`);
      else
        console.warn(`[ideClient] 端口 ${conn.port} 连接被拒(code=${code})，第 ${conn.authFailCount} 次；等注册表重扫重试（检查 token 是否就绪）`);
    }
    if (wasConnected) { wbT(null, "ideClient", "connect:disconnected", { port: conn.port, code }); console.log(`[ideClient] 连接已断开(端口 ${conn.port})`); }
    if (this._autoReconnect) this._scheduleRescanSoon();
  }

  /** 剪除池内连接（窗口关闭 pid 失活 / CLI 被 YonBan 互斥顶掉）。 */
  _dropConn(conn, reason) {
    const isCurrent = this._conns.get(conn.port) === conn;
    // [0726 修哑通知] 通知必须在置 connected=false 之前发：本函数先置 false，等 ws.close 的 onclose
    //   回调进 _handleConnClose 时 wasConnected 已是 false → 那里的通知不会触发。而「关掉 VSCode 窗口」
    //   走的正是本路径（重扫发现 pid 失活 → 不在 targets → 剪除），等于最常见场景下线收不到任何提示。
    if (isCurrent && conn.connected) this._notifyBoundLinesGone(conn);
    // 在飞请求就地拒绝：本连接已被剪除，其 pending 不会再有回包，留着只能等 30s 超时白等。
    //   （被动断开路径由 _handleConnClose 做同样的事，此处补主动剪除路径。）
    for (const [id, pending] of [...this._pendingRequests]) {
      if (pending.connectionId === conn.connectionId) {
        this._failPendingForConnection(id, pending, `backend_connection_pruned:${reason}`);
      }
    }
    try { conn.ws?.close(1000, "prune"); } catch { /* ignore */ }
    conn.connected = false;
    conn.connecting = false;
    conn.ws = null;
    conn.ideInfo = null;
    if (isCurrent) this._conns.delete(conn.port);
    wbT(null, "ideClient", "conn:prune", { port: conn.port, reason });
  }

  disconnect() {
    this._autoReconnect = false;
    this._clearReconnectTimer();
    this._stopHeartbeat();
    for (const conn of [...this._conns.values()]) {
      try { conn.ws?.close(1000, "Client disconnecting"); } catch { /* ignore */ }
      conn.connected = false;
      conn.connecting = false;
      conn.ws = null;
      conn.ideInfo = null;
    }
    this._conns.clear();
    this._primaryPort = null;
    this._primaryKind = null;
    console.log("[ideClient] 已手动断开");
  }

  // ---- 工具调用 ----

  /**
   * D3 统一执行闸 + WS 发送（Hop 3 核心）。所有 IDE 工具执行的单一出口。
   *
   * 链路：callToolAndStore / callToolWithLock → 本函数 → WS → IdeWsServer → ToolExecutor.execute
   * 影响：
   *   - 先过 gateToolExecution 安全闸（fail-closed，被拦则不发 WS）
   *   - 写工具执行前调 beilu-files backupBeforeWrite 备份
   *   - 发 WS tool_call 消息，注册 _pendingRequests Promise（超时自动 resolve 失败）
   *   - 更新 _stats 统计计数
   * 约束：必须 isConnected 才能发送，否则直接返回 { success: false, error: "IDE 未连接" }
   *
   * @param {string} tool - 工具名
   * @param {object} params - 工具参数
   * @param {number} [timeout] - 超时毫秒，不传则按工具类型取默认值
   * @param {string} [traceId] - 贯穿三层(本体→YonBan→前端)的单轮关联 ID
   * @param {object} [gateCtx] - 安全闸上下文 { source, preChecked, chatid }
   * @returns {Promise<object>} { success, result, error, blocked, ... }
   */
  async callTool(tool, params = {}, timeout, traceId, gateCtx = {}) {
    wbT(gateCtx.chatid || null, "ideClient", "callTool:enter", {
      tool,
      path: params?.path,
      source: gateCtx.source,
    });
    // ★ T16 abort：signal 已 aborted → 直接返回 blocked，不发 WS
    const _signal = gateCtx.signal;
    if (_signal?.aborted) {
      wbT(null, "ideClient", "callTool:abortedBeforeSend", { tool });
      return { success: false, aborted: true, error: "工具调用已被取消(signal aborted)" };
    }
    // owner 必须先于命令能力读取完成核验。否则前端可伪造 owner 选中别人的
    // command_config，或命令闸只能永远退回默认能力，导致用户设置成为死开关。
    const { username, config, ownerMismatch } = await this._runtimeContextFor(
      gateCtx.chatid || null,
      gateCtx.ownerUsername || "",
    );
    if (ownerMismatch || (gateCtx.chatid && !username)) {
      wbD(gateCtx.chatid || null, "ideClient", "callTool:ownerMismatch", false,
        "认证 owner 缺失或与会话 owner 不一致，已拒绝发送工具调用", { tool });
      return {
        success: false,
        blocked: true,
        error: ownerMismatch ? "工具调用 owner 与会话属主不一致" : "工具调用缺少已认证会话 owner",
        errorCode: ownerMismatch ? "tool_owner_mismatch" : "tool_owner_missing",
      };
    }
    // ★ D3 统一执行闸（单一 choke point）：所有 IDE 工具执行（三通道）在此强制过同一闸。
    //   fail-closed：被拦的命令返回 blocked 结果，绝不发 WS 到 YonBan（使危险命令到不了 YonBan）。
    //   内部 `_` 工具 + 非命令类工具放行（gate 内部白名单），不冻结流水线。
    const _gate = gateToolExecution({
      tool,
      params,
      source: gateCtx.source || (gateCtx.preChecked ? "ai" : "unknown"),
      preChecked: !!gateCtx.preChecked,
      ownerUsername: username,
    });
    if (!_gate.allowed) {
      wbD(null, "ideClient", "callTool:gateBlocked", false, _gate.reason, { tool, riskLevel: _gate.riskLevel });
      console.warn(`[ideClient] ★D3 执行闸拦截: ${tool} — ${_gate.reason}`);
      return {
        success: false,
        blocked: true,
        gateBlocked: true,
        needsApproval: !!_gate.needsApproval,
        riskLevel: _gate.riskLevel || "high",
        error: _gate.reason || "🛡️ 该工具调用被安全闸拦截",
      };
    }

    if (FILE_WRITE_TOOLS_FOR_LOCK.has(tool) && params.path) {
      // ★ T017-2.3 回档基石不裸奔：AI 写文件前必先备份成功，否则回档系统无版本可回滚。
      //   原缺陷：backupBeforeWrite 返回值被忽略 + 外层 catch 空吞 → 备份失败仍继续裸写，errors 系统零记录。
      //   backupBeforeWrite 语义：{backed:true} 备份成功 / {backed:false,error} 真失败(copy 抛错) /
      //     {backed:false} 无 error = 合法跳过(新文件无旧版可备/非 watchFolders/strategy=manual)——这些照常放行。
      //   高安全场景(AI 写文件)=fail-closed：真失败 → 中止写入 + 留痕上报，把原因回给 AI(错误页是诊断面)。
      let _bkFailed = null;
      try {
        const { backupBeforeWrite } = await import("../functions/rollback/fileHistory.mjs"); // T066：ideClient 迁 transport 后同库同域，改指 ../functions/rollback
        const _cid = gateCtx.chatid || this._lastWriteChatid || "";
        const { chatMetadatas } = await import("../../../public/parts/shells/beilu-chat/src/lib/chatStorage.mjs");
        const _u = _cid ? chatMetadatas?.get(_cid)?.username || "" : "";
        const _bk = backupBeforeWrite(_u, params.path, { chatid: _cid, tool });
        if (_bk && _bk.backed === false && _bk.error) _bkFailed = _bk.error; // 真失败(有 error)才拦截；合法跳过放行
      } catch (e) {
        _bkFailed = e?.message || String(e); // 备份链本身抛异常(import/元数据写入失败等)=真失败
      }
      if (_bkFailed) {
        wbD(null, "ideClient", "callTool:backupFailed", false, `写前备份失败,fail-closed 中止写入: ${_bkFailed}`, { tool, path: params.path });
        console.warn(`[ideClient] ★T017 写前备份失败,中止写入 ${tool} ${params.path}: ${_bkFailed}`);
        return { success: false, error: `🛡️ 写前备份失败,已中止写入以保护可回档性: ${_bkFailed}` };
      }
    }

    // ★ 多开路由：按会话绑定选连接（绑定死→同根回退主连接/异根诚实降级；无绑定→主连接），本轮工具全程走该连接
    const _routeInfo = {};
    const _conn = this._connFor(gateCtx.chatid || null, _routeInfo);
    const _actualIdeRoute = _snapshotIdeRouteFromConn(_conn);
    if (Object.prototype.hasOwnProperty.call(gateCtx, "expectedIdeRoute")) {
      const _expectedIdeRoute = gateCtx.expectedIdeRoute;
      if (!isValidIdeRouteSnapshot(_expectedIdeRoute)) {
        return {
          success: false,
          applied: false,
          drift: "ideRoute",
          errorCode: "invalid_ide_route_expectation",
          error: "expectedIdeRoute 形状无效，已拒绝发送工具调用",
          expectedIdeRoute: _expectedIdeRoute,
          actualIdeRoute: _actualIdeRoute,
        };
      }
      if (!ideRouteSnapshotsEqual(_expectedIdeRoute, _actualIdeRoute)) {
        return {
          success: false,
          applied: false,
          drift: "ideRoute",
          errorCode: "ide_route_drift",
          error: "回档令牌已漂移：IDE 路由连接代次变化",
          expectedIdeRoute: _expectedIdeRoute,
          actualIdeRoute: _actualIdeRoute,
        };
      }
    }
    if (!_conn) {
      if (_routeInfo.degraded) {
        // [窗口id 0726] 绑定窗口不可用且无法按工作区身份自愈——拒绝跨窗执行（宁可失败，不在别人的工作区里写）
        const _d = _routeInfo.degraded;
        wbD(gateCtx.chatid || null, "ideClient", "callTool:routeDegraded", false, "所绑窗口不可用且无法自愈,拒绝跨窗执行", { tool, ..._d });
        return {
          success: false,
          error: _d.boundRoot
            ? `该会话绑定的 VSCode 窗口(端口 ${_d.boundPort}, 工作区 ${_d.boundRoot})已断开，且当前没有打开同一工作区的窗口，已拒绝跨窗执行。重新打开该工作区的窗口即可自动接回，或在目标窗口重新选择本对话。`
            : `该会话绑定的 VSCode 窗口(端口 ${_d.boundPort})已断开，且该窗口未打开任何工作区文件夹（无工作区身份，无法自动接回），已拒绝跨窗执行——否则会写进别的窗口的工作区。请在目标 VSCode 窗口打开工作区文件夹后重新选择本对话。`,
        };
      }
      wbT(null, "ideClient", "callTool:notConnected", { tool }); // IDE未连接时调用=正常,返错即可,非异常
      return { success: false, error: "IDE 未连接" };
    }

    const timeoutMs = resolveToolResponseTimeout(config, params, timeout);
    const id = `ide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const backendKind = (_conn.ideInfo?.appName === "beilu-cli" || _conn.kind === "cli") ? "cli" : "yonban";
    const queuedJob = isWorkerIsolate ? null : this._toolJobs.create({
        requestId: id,
        chatid: gateCtx.chatid || null,
        ownerUsername: username,
        tool,
        params,
        backendKind,
        backendPort: _conn.port,
        waitTimeoutMs: timeoutMs,
        historyLimit: config.history_limit,
      });
    if (queuedJob) this._broadcastToolJob(queuedJob, false, "queued");
    const transportJobId = queuedJob?.jobId
      || `worker_tool_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this._stats.toolCallsSent++;

    return new Promise((resolve, reject) => {
      // ★ T16 abort：wrap resolve 统一清理 abort 监听器（防泄漏），任何路径 settle 都走此函数
      let _onAbort, _settled = false;
      const _resolve = (v) => { if (_settled) return; _settled = true; if (_signal && _onAbort) _signal.removeEventListener("abort", _onAbort); resolve(v); };

      const pending = {
        kind: "tool",
        resolve: _resolve,
        reject,
        timer: null,
        longTimer: null,
        retentionTimer: null,
        port: _conn.port,
        connectionId: _conn.connectionId,
        requestId: id,
        jobId: transportJobId,
        tool,
        params,
        chatid: gateCtx.chatid || null,
        username,
        config,
        backendKind,
        waitTimedOut: false,
        detached: false,
        lifecycleStarted: false,
        stallNotified: false,
      };

      const timer = setTimeout(() => {
        if (this._pendingRequests.get(id) !== pending) return;
        pending.waitTimedOut = true;
        if (isWorkerIsolate) {
          this._publishWorkerToolLifecycle(pending, "wait_timeout");
        } else {
          const job = this._toolJobs.update(pending.jobId, {
            state: "wait_timeout",
            error: "response_wait_timeout",
          });
          this._broadcastToolJob(job, false, "wait_timeout");
        }
        this._armLateResultRetention(id, pending);
        wbD(null, "ideClient", "callTool:timeout", false, `工具调用超时(${timeoutMs}ms)`, { tool, id });
        _resolve({
          success: false,
          pending: true,
          waitTimedOut: true,
          error: `工具调用等待超时 (${timeoutMs}ms)，执行端结果仍在接收`,
          errorCode: "response_wait_timeout",
          jobId: pending.jobId,
          backendKind,
          backendPort: _conn.port,
        });
      }, timeoutMs);
      pending.timer = timer;

      pending.longTimer = setTimeout(() => {
        if (this._pendingRequests.get(id) !== pending) return;
        if (isWorkerIsolate) return;
        const currentJob = this._toolJobs.get(pending.jobId);
        const startedAtMs = new Date(currentJob?.startedAt || currentJob?.createdAt || Date.now()).getTime();
        const job = this._toolJobs.update(pending.jobId, {
          longRunning: true,
          // 非终态 update 不会自动计算 duration；显式写入当前耗时，避免长任务提醒显示成 0ms。
          duration: Math.max(0, Date.now() - startedAtMs),
        });
        this._broadcastToolJob(job, !!config.notify_long_running, "long_running");
      }, config.long_running_after_ms);
      pending.longTimer.unref?.();

      this._pendingRequests.set(id, pending);

      // signal 只能停止本地等待；执行端没有取消协议，因此保留 request 接收迟到结果。
      if (_signal) {
        _onAbort = () => {
          clearTimeout(timer);
          clearTimeout(pending.longTimer);
          pending.detached = true;
          if (!isWorkerIsolate) {
            const job = this._toolJobs.update(pending.jobId, {
              state: "detached",
              error: "caller_aborted",
            });
            this._broadcastToolJob(job, false, "detached");
          }
          this._armLateResultRetention(id, pending);
          wbT(null, "ideClient", "callTool:abortedBySignal", { tool, id });
          _resolve({
            success: false,
            aborted: true,
            pending: true,
            error: "工具调用等待已取消，执行端结果仍在接收",
            errorCode: "caller_aborted",
            jobId: pending.jobId,
            backendKind,
            backendPort: _conn.port,
          });
        };
        _signal.addEventListener("abort", _onAbort, { once: true });
        if (_signal.aborted) {
          _onAbort();
          return;
        }
      }

      // traceId：贯穿三层(本体→YonBan→前端)的单轮关联 ID，供端到端日志拼接
      // [窗口id 0726 凛倾方案] chatid=窗口/线 id 随指令信封下发（传导层唯一注入点，全工具统一）——
      //   执行端（YonBan ToolExecutor / CLI executor 孪生）在池入口识别落 params._window_id，
      //   有 per-线状态的工具（run_command 持久会话等）从那里取键。替代原「后端对单个工具注入
      //   session_key」的字段级做法：窗口身份是指令属性，不是某个工具的参数。
      const msg = {
        type: "tool_call",
        id,
        payload: {
          id,
          tool,
          params,
          traceId,
          chatid: gateCtx.chatid || null,
          transport: {
            runtimePolicy: buildToolIoRuntimePolicy(config),
            ownerUsername: username || null,
          },
        },
      };

      try {
        _conn.ws.send(JSON.stringify(msg));
        if (!isWorkerIsolate) {
          const sentJob = this._toolJobs.update(pending.jobId, { state: "sent" });
          this._broadcastToolJob(sentJob, false, "sent");
        }
        wbT(gateCtx.chatid || null, "ideClient", "callTool:wsSent", { tool, id, port: _conn.port, chatid: gateCtx.chatid || null }); // [窗口id 0726] 信封归因：哪条线→哪个窗口端口
        console.log(`[ideClient] 已发送工具调用: ${tool} (id=${id})`);
      } catch (err) {
        clearTimeout(timer);
        clearTimeout(pending.longTimer);
        this._pendingRequests.delete(id);
        this._stats.toolCallsFailed++;
        if (!isWorkerIsolate) {
          const failedJob = this._toolJobs.update(pending.jobId, { state: "failed", error: "send_failed" });
          this._broadcastToolJob(failedJob, !!config.notify_failed, "failed");
        }
        wbD(null, "ideClient", "callTool:sendFail", false, err.message, { tool, id });
        _resolve({
          success: false,
          error: `发送失败: ${err.message}`,
          errorCode: "send_failed",
          jobId: pending.jobId,
          backendKind,
          backendPort: _conn.port,
        });
      }
    });
  }

  /** [多开] 权威路径映射键：按会话所路由连接的端口分区（同 relPath 不同窗口各存各的 abs）。 */
  _resolvedPathKey(relPath, chatid) {
    return `${this._connFor(chatid || null)?.port ?? "-"}\0${relPath}`;
  }

  /** 将工作区相对路径解析为后端可 fs 访问的绝对路径。
   *  优先用 YonBan 回传的权威路径（_resolvedPathMap，per-连接分区），无则按会话所绑实例的
   *  workspaceRoot 猜（chatid 不传=主连接根，旧行为），再无则原样返回（向后兼容）。 */
  resolvePathForFs(relPath, chatid = null) {
    if (!relPath) return relPath;
    if (path.isAbsolute(relPath)) return relPath;
    const authoritative = this._resolvedPathMap.get(this._resolvedPathKey(relPath, chatid));
    if (authoritative) return authoritative;
    const root = this.workspaceRootFor(chatid);
    return root ? path.resolve(root, relPath) : relPath;
  }

  /** 路径归一化键：裸 path 规范化（不 resolve，与 _readCache 裸 path 口径一致）。
   *  【注意】本函数现仅用于 _externalChanges 的路径匹配（裸 path 语义），**不再用作写锁键**——
   *  写锁请用 _writeLockKeyFor（按物理绝对路径）。两者语义不同，勿再合并。 */
  _writeLockKey(tool, params) {
    const p = params && typeof params.path === "string" ? params.path : "";
    if (!p) return "__no_path__";
    return p.trim().replace(/\\/g, "/").toLowerCase();
  }

  /** ★ B3 写锁键（多开修 0726）：按**解析后的绝对路径**，即真实物理文件身份。
   *  【why】原键是裸相对路径 → 多窗口下 A 窗口(工作区X)与 B 窗口(工作区Y)各写 src/index.js 撞同一把锁，
   *    两个毫不相干的文件被强行串行；且锁等待 45s 超时，A 的写一卡（审批挂起/长命令）就把 B 误杀。
   *    改按 abs 后：同名不同根不撞（真并行），真同文件（同根）仍串行——与 fileEditRegistry 的
   *    _regPath=resolvePathForFs 同口径（:1603），两处协调器用同一套身份。 */
  _writeLockKeyFor(tool, params, chatid) {
    const p = params && typeof params.path === "string" ? params.path : "";
    if (!p) return "__no_path__";
    const abs = this.resolvePathForFs(p, chatid || null);
    return String(abs || p).trim().replace(/\\/g, "/").toLowerCase();
  }

  /**
   * ★ B3：对同一文件的写串行化。把 fn 接到该文件队尾 Promise 之后执行（FIFO=apply顺序），
   * 「锁等待」带超时，卡死不冻结整条流水线。释放在 finally 单点完成（正常/异常/超时三条都释放）。
   */
  /**
   * ★ BUG-H：给一组编译错误归因到触发它的会话。
   * 从最近的写历史里倒查命中出错文件的那次写，取其 chatid；找不到则退最近写会话，再退 null(广播)。
   */
  _attributeDiagChatid(errors, srcPort = null) {
    try {
      const _errFiles = (errors || [])
        .map((f) => String(f && f.file || "").replace(/\\/g, "/").toLowerCase())
        .filter(Boolean);
      if (_errFiles.length === 0) return this._lastWriteChatid ?? null;
      for (let i = this._operationHistory.length - 1; i >= 0; i--) {
        const op = this._operationHistory[i];
        if (!op || !FILE_WRITE_TOOLS_FOR_LOCK.has(op.tool)) continue;
        const p = op.params && op.params.path;
        if (!p) continue;
        const _pn = String(p).replace(/\\/g, "/").toLowerCase();
        if (_errFiles.some((ef) => ef === _pn || ef.endsWith("/" + _pn) || _pn.endsWith("/" + ef))) {
          const _cand = op.chatid ?? null;
          // [多开 0726] 归因候选须归属诊断来源窗口——A 窗口的编译错误不能按同名相对路径归给 B 窗口的会话
          if (_cand && !this._chatBelongsToPort(_cand, srcPort)) continue;
          return _cand;
        }
      }
      return this._lastWriteChatid ?? null;
    } catch {
      return this._lastWriteChatid ?? null;
    }
  }

  async _withWriteLock(key, fn) {
    const prev = this._writeLocks.get(key) || Promise.resolve();
    let release;
    const myTurn = new Promise((res) => { release = res; });
    const chained = prev.then(() => myTurn).catch(() => myTurn);
    this._writeLocks.set(key, chained);

    let timer = null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("__write_lock_timeout__")), WRITE_LOCK_TIMEOUT);
    });

    try {
      // 只对「等前序」竞速超时；前序卡死则本写超时跳过，不永久排队
      await Promise.race([prev.catch(() => {}), timeout]);
      clearTimeout(timer); timer = null;
      return await fn();
    } catch (e) {
      if (e && e.message === "__write_lock_timeout__") {
        wbD(null, "ideClient", "_withWriteLock:timeout", false, `写锁等待超时(${WRITE_LOCK_TIMEOUT}ms)`, { key });
        console.warn(`[ideClient] B3 写锁等待超时(${WRITE_LOCK_TIMEOUT}ms) key=${key} — 标失败，不冻结流水线`);
        return { success: false, error: `写锁等待超时(${WRITE_LOCK_TIMEOUT}ms): 同文件 ${key} 前序写未完成，本次写已跳过，请稍后重试。` };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      release();
      // ★ BUG-A：摘 key 防 Map 单调泄漏。仅当队尾仍是自己(无后续排队者覆盖)时删——
      //   有后续者会 set 新 promise，则 get(key)!==chained，不误删别人的链。
      if (this._writeLocks.get(key) === chained) this._writeLocks.delete(key);
    }
  }

  /**
   * 带存储的工具调用入口（Hop 3 完整路径）。replyHandler 读/写操作的主调用点。
   *
   * 链路：replyHandler(读直行/写审批通过) → 本函数 → _withWriteLock(写) → _callToolAndStoreInner → callTool → WS
   * 影响：
   *   - 写工具调 fileEditRegistry.onWriteStart 停其他窗口在飞生成（81 多开协调）
   *   - 写工具走 per-file 写锁串行化（B3，同文件 FIFO）
   *   - _callToolAndStoreInner 内：enqueuePendingResult 入队 + _operationHistory 记录 + readCache 刷新
   *   - 写完调 fileEditRegistry.onWriteComplete 激活被打断的窗口
   * 约束：读工具/命令/todo 不走写锁（避免读被写阻塞、长命令被锁等待误杀）
   *
   * @param {string} tool - 工具名
   * @param {object} params - 工具参数
   * @param {string|null} chatid - 会话 ID（null 则结果广播给所有会话）
   * @param {string} [traceId] - 端到端关联 ID
   * @param {AbortSignal|null} [signal] - T16 abort：可选的取消信号，abort 时中止等待 WS 回包
   * @returns {Promise<object>} callTool 的返回结果
   */
  async callToolAndStore(tool, params = {}, chatid = null, traceId, signal = null) {
    wbT(chatid, "ideClient", "callToolAndStore:enter", { tool, path: params?.path });
    // ★ B3：仅真·文件写工具走 per-file 串行锁（同文件 a→b 串行，b 基于 a 后内容重匹配锚点）；
    //   读类/命令/todo 直通（不排队，避免读被写阻塞、长命令被锁等待误杀）。
    // 81 多开同文件：写类执行前停其他窗口在飞生成；读/写后登记编辑者；写后激活其他窗口重读续。
    const _isFileWrite = FILE_WRITE_TOOLS_FOR_LOCK.has(tool);
    // [多开 0726] fileEditRegistry 键归一为绝对路径（会话所绑窗口根解析，与 beilu-files 侧
    // resolveCanonicalOpPath 同步改 abs）：多窗口不同工作区同名相对路径原会撞键 → 误停别的线的生成；
    // abs 后同名不同根不撞，真同文件（同根/IDE↔file_op）仍协调。
    const _regPathRaw = typeof params?.path === "string" ? params.path : "";
    const _regPath = _regPathRaw ? this.resolvePathForFs(_regPathRaw, chatid) : "";
    let _stoppedCids = [];
    if (_isFileWrite && _regPath && chatid) {
      try { _stoppedCids = await fileEditRegistry.onWriteStart(_regPath, chatid); } catch { /* 停失败不阻断写，被动重读兜底 */ }
    }
    let _result;
    if (_isFileWrite) {
      _result = await this._withWriteLock(
        this._writeLockKeyFor(tool, params, chatid), // 按物理文件身份（多窗同名相对路径不再互锁）
        () => this._callToolAndStoreInner(tool, params, chatid, traceId, signal),
      );
    } else {
      _result = await this._callToolAndStoreInner(tool, params, chatid, traceId, signal);
    }
    if (_regPath && chatid) {
      try { fileEditRegistry.touch(_regPath, chatid); } catch { /* noop */ }
      if (_isFileWrite) {
        // 81：只激活本次写前真被打断的窗口（_stoppedCids），不空唤闲置/纯读过的窗口
        try { await fileEditRegistry.onWriteComplete(_regPath, chatid, _stoppedCids); } catch { /* 激活失败不阻断，被动重读兜底 */ }
      }
    }
    return _result;
  }

  /**
   * 与 callToolAndStore 同款 per-file 写锁（B3 顺序插入），但**不写 pendingResults**——
   * 供分身/clone 用：分身自管结果队列(_clToolResults)，不能污染主 AI 的 pendingResults；
   * 但写类工具仍须串行化（同文件 a→b），否则并发写分身互踩 old_string（v3 §5）。
   */
  async callToolWithLock(tool, params = {}, chatid = null) {
    // ★ D3：分身/clone 通道（C）——未经 replyHandler 命令闸，统一闸按 source:"subagent" fail-closed。
    // [0727 id传导·凛倾「按照id传导就不可能出现」] 原注释"分身无会话归属"不成立：分身是从某条线
    //   派出去的，id 一直存在，是本签名没给它留位置（执行违纪，非设计）。chatid 随指令信封下发后，
    //   连接路由（_connFor）与 run_command 会话键都按线走，双开不串。锁键第三参同步传 chatid——
    //   锁键解析必须与工具实际执行的连接同口径（原按主连接解析，现按线解析）。
    //   调用方未传 chatid 时行为与原来逐字相同（主连接 + 默认会话键）。
    if (FILE_WRITE_TOOLS_FOR_LOCK.has(tool)) {
      return await this._withWriteLock(
        this._writeLockKeyFor(tool, params, chatid || null),
        () => this.callTool(tool, params, undefined, undefined, { source: "subagent", chatid: chatid || null }),
      );
    }
    return await this.callTool(tool, params, undefined, undefined, { source: "subagent", chatid: chatid || null });
  }

  async _callToolAndStoreInner(tool, params = {}, chatid = null, traceId, signal = null) {
    // [窗口id 0726 凛倾方案] 原「run_command session:true 注入 session_key=chatid」工具级字段注入已删——
    // 窗口/线 id 现随指令信封统一下发（callTool 发送点 payload.chatid 唯一注入点），执行端池入口
    // 识别落 params._window_id、run_command 自行派生会话键（含 __noChat_ 合成键排除，语义随迁执行端）。
    // params.session_key 仍被执行端优先识别（显式覆盖口保留）。
    // ★ D3：路径 A（AI 回复 / 已审批写）。run_command 已在 replyHandler 上游过命令闸+审批门并获批，
    //   approveOperation 重入也经此；标 preChecked 让统一闸不重复拦（高危已 HITL 过）。
    const result = await this.callTool(tool, params, undefined, traceId, { preChecked: true, source: "ai", signal, chatid: chatid || null });
    // ★ 捕获 YonBan 回传的权威解析路径 → 供后续 mtime/sandbox 对齐真实工作区路径（闭合跨进程盲区）。
    if (result?.resolvedPath && typeof params?.path === "string" && params.path) {
      this._resolvedPathMap.set(this._resolvedPathKey(params.path, chatid), result.resolvedPath); // per-连接分区键
      if (this._resolvedPathMap.size > 500) {
        // FIFO 截断，防无界增长
        const _firstKey = this._resolvedPathMap.keys().next().value;
        this._resolvedPathMap.delete(_firstKey);
      }
    }
    // ★ 消费 _externalChanges（file_changed 记录的"曾被外部修改"文件）：写工具命中目标文件 → 附 warning，
    //   提醒 AI 本次编辑可能基于过期内容；一次性消费（命中即从集合删除，不重复刷屏）。防"基于过期内容瞎改"。
    if (FILE_WRITE_TOOLS_FOR_LOCK.has(tool) && this._externalChanges.size > 0 && result) {
      const _tgt = this._writeLockKey(tool, params); // 已 fwd-slash + lowercase
      if (_tgt && _tgt !== "__no_path__") {
        // F3 分区：只查本会话键 + "" 兜底键（无 chatid 的全局通知对所有会话可见）。
        const _scanSets = [];
        const _ownSet = this._externalChanges.get(chatid || "");
        if (_ownSet) _scanSets.push([chatid || "", _ownSet]);
        if ((chatid || "") !== "") {
          const _globalSet = this._externalChanges.get("");
          if (_globalSet) _scanSets.push(["", _globalSet]);
        }
        let _hit = false;
        for (const [_key, _set] of _scanSets) {
          for (const _ch of _set) {
            const _cn = _ch.replace(/\\/g, "/").toLowerCase();
            if (_tgt === _cn || _tgt.endsWith("/" + _cn) || _cn.endsWith("/" + _tgt)) {
              result.warning = (result.warning ? result.warning + " " : "")
                + `⚠ 目标文件「${_ch}」曾被外部修改，本次编辑可能基于过期内容；若结果异常请先 read_file 重读再改。`;
              _set.delete(_ch);
              if (_set.size === 0) this._externalChanges.delete(_key);
              _hit = true;
              break;
            }
          }
          if (_hit) break;
        }
      }
    }
    const entry = {
      tool, params, result,
      chatid: chatid || null,   // ★ B2 corrId隔离: 会话维度，null=广播给所有会话(向后兼容)
      timestamp: new Date().toISOString(),
      jobId: result?.jobId || null,
      backendKind: result?.backendKind || null,
      backendPort: result?.backendPort ?? null,
      late: !!result?.late,
    };
    // ★ [0723 图片进视觉·A方案] read_file 读图片 → 内层工具返回 {image:true, base64, mimeType}（CLI+YonBan 两套 file-tools 均产此结构）。
    //   传输契约：callTool resolve 的是外层包装 {id, success, result:<工具返回>}（CLI executor.mjs L221 / YonBan ToolCallResult 同形），
    //   工具返回在 result.result（formatToolResultsForInjection L165 同此约定读 r.result.result）——检测必须查内层，查外层永不触发。
    //   本处是两套系统工具结果的单一入队点（单源收口），检测 image 结构 → 附 userImage 字段，
    //   复用现成 _flushPendingUserImages 通道（generation.mjs L182）→ addUserReply(files) → buildMessages → image_url → 视觉模型。
    //   why: 原图片结果走普通通道 formatToolResultsForInjection=纯文本，base64 是 AI 看不懂的乱码。userImage 才进视觉。
    //   格式契约: files 元素 { mime_type, buffer(真 Buffer) } —— _flushPendingUserImages L189 Buffer.from(buffer) 需真 Buffer
    //   （base64 字符串会被当 utf-8 误解），故此处 Buffer.from(base64,"base64") 转真 Buffer。marker+keepN 限历史只留最近图。
    const _imgInner = (result?.success && result.result && result.result.image === true) ? result.result : null;
    if (_imgInner && typeof _imgInner.base64 === "string" && _imgInner.base64.length > 0) {
      try {
        const _imgBuf = Buffer.from(_imgInner.base64, "base64");
        entry.userImage = {
          content: _imgInner.content || `[图片: ${params?.path || ""}]`,  // 文本占位（也进对话，AI 知道读了图）
          files: [{
            name: (typeof params?.path === "string" ? params.path.split(/[\\/]/).pop() : "") || "image",
            mime_type: _imgInner.mimeType || "image/png",
            buffer: _imgBuf,
          }],
          marker: "ide_read_image",  // 标记供 trimEntryFiles 限历史图数（只留最近，防上下文膨胀）
          keepN: 2,
        };
      } catch (_e) {
        // base64 解码失败不阻断回合，图片降级为文本占位（content 仍随普通通道注入）
        wbD(chatid, "ideClient", "readImage:base64Decode", false, _e?.message || "图片 base64 解码失败", { path: params?.path });
      }
    }
    wbT(chatid, "ideClient", "_callToolAndStoreInner:result", { tool, success: result?.success !== false, path: params?.path });
    if (result?.success === false) {
      wbD(chatid, "ideClient", "_callToolAndStoreInner:toolFail", false, result?.error || "工具执行失败", { tool, path: params?.path });
    }
    // ★ BUG-H：记录最近写操作的 chatid，供 diagnostics_changed(VSCode 工作区级事件，本身不带 chatid)归因。
    if (FILE_WRITE_TOOLS_FOR_LOCK.has(tool)) this._lastWriteChatid = chatid || null;
    const success = result && result.success !== false;
    if (success && FILE_WRITE_TOOLS_FOR_LOCK.has(tool) && params.path) {
      const _wAbsFs = this.resolvePathForFs(params.path, chatid);
      try {
        const _wMtime = fs.statSync(_wAbsFs).mtimeMs;
        const _wContent = fs.readFileSync(_wAbsFs, "utf-8");
        const _wHash = crypto.createHash("md5").update(_wContent).digest("hex");
        const _wCache = this._readCacheFor(chatid);
        const _wPath = params.path;
        const _wOld = _wCache.get(_wPath);
        if (_wOld) { _wOld.mtime = _wMtime; _wOld.hash = _wHash; }
        else _wCache.set(_wPath, { lines: _wContent.split("\n").length, chars: _wContent.length, tokens: Math.ceil(_wContent.length / 3.5), timestamp: entry.timestamp, tool, mtime: _wMtime, hash: _wHash });
      } catch { /* 文件不存在/权限/删除类工具无需刷缓存 */ }
    }
    this.enqueuePendingResult(entry); // 单源入队+会话感知截断（与 worker 回灌共用）
    // 操作历史（持久，不随consume清空）
    const { config: _historyConfig } = await this._runtimeContextFor(chatid);
    this._recordOperation({ ...entry, success }, _historyConfig.history_limit);
    // ★ 读取类工具结果记录到缓存清单（AI可查看并决定清理）
    if (success && READ_TOOLS.has(tool) && result.result) {
      const _path = params.path || params.pattern || "(unknown)";
      const _content = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
      const _lines = typeof result.result === "string" ? result.result.split("\n").length : 0;
      // ★ Gap-1：read 成功即写 mtime 基线（不再只在写后设），让纯读未写文件被外部改也可检测。
      // ★ MD5 兜底：存内容哈希，mtime 撒谎(挂载层/同秒改)时用 hash 确认变动。仅对真实单文件路径取。
      let _mtime = null, _hash = null;
      if (params.path) {
        const _absForFs = this.resolvePathForFs(params.path, chatid);
        try { _mtime = fs.statSync(_absForFs).mtimeMs; } catch { /* 文件不存在/无权限 */ }
        try { _hash = crypto.createHash("md5").update(_content).digest("hex"); } catch { /* ignore */ }
      }
      this._readCacheFor(chatid).set(_path, { // per-chatid 分区写入（chatid 由 _callToolAndStoreInner 传入），杜绝跨对话串台
        lines: _lines,
        chars: _content.length,
        tokens: Math.ceil(_content.length / 3.5), // 粗估token（此处用 /3.5；注意 aiRunner 编程模式 token 估算用 /3，两处口径不同）
        timestamp: entry.timestamp,
        tool,
        mtime: _mtime,
        hash: _hash,
      });
    }
    return result;
  }

  /** ★ per-chatid 读缓存分区访问：返回该会话的内层 Map（不存在则建）。"" = 无 chatid 兜底键。 */
  _readCacheFor(chatid) {
    const _k = chatid || "";
    let _m = this._readCache.get(_k);
    if (!_m) { _m = new Map(); this._readCache.set(_k, _m); }
    return _m;
  }

  /** ★ 生成缓存清单文本（注入给AI看，AI自己决定清理）——按会话取本对话缓存。 */
  getReadCacheInventory(chatid) {
    const _cache = this._readCache.get(chatid || "");
    if (!_cache || _cache.size === 0) return "";
    const _now = Date.now();
    const _rows = [];
    let _totalTokens = 0;
    let _staleCount = 0;
    for (const [path, info] of _cache) {
      const _age = _now - new Date(info.timestamp).getTime();
      const _ageStr = _age < 60000 ? `${Math.round(_age / 1000)}秒前`
        : _age < 3600000 ? `${Math.round(_age / 60000)}分钟前`
        : `${Math.round(_age / 3600000)}小时前`;
      // 双向同步：file_changed 标记的 stale 文件在清单里显式标「⚠已变更·需重读」。
      const _staleFlag = info.stale ? " ⚠已变更·需重读" : "";
      if (info.stale) _staleCount++;
      _rows.push(`| ${path} | ${info.tool} | ${info.lines}行 | ~${info.tokens} | ${_ageStr}${_staleFlag} |`);
      _totalTokens += info.tokens;
    }
    return `[上下文文件缓存 — 共${_cache.size}项, ~${_totalTokens} token${_staleCount ? `, ${_staleCount}项已被外部改动需重读` : ""}]\n`
      + `| 文件/路径 | 工具 | 大小 | Token | 时间 |\n`
      + `|---|---|---|---|---|\n`
      + _rows.join("\n") + "\n"
      + `[/上下文文件缓存]\n`
      + (_staleCount ? `⚠ 标「已变更」的文件已被外部修改，缓存内容过期，依赖前先 read_file 重读。\n` : "")
      + `提示: 用 <contextClean>read_file:路径</contextClean> 清理不再需要的文件`;
  }

  /** [多开] 会话是否归属某来源窗口：绑定=端口相等；未绑定=仅当来源是主连接（未绑会话路由主连接）。 */
  _chatBelongsToPort(chatid, srcPort) {
    if (srcPort == null || !chatid) return true; // 无来源信息/无会话键 → 旧全局语义
    const _b = this._chatBindings.get(chatid);
    return _b != null ? _b === srcPort : srcPort === this._primaryPort;
  }

  // 双向同步：把外部改动的文件在读缓存里标 stale（路径归一 + 后缀匹配，同写路径口径）。
  // 外部改动是文件级、跨会话：遍历会话分区，命中即标 stale（读过该文件的对话都该重读）。
  // [多开 0726] srcPort=事件来源窗口：只标归属该窗口的会话——跨窗口同名相对路径不再互相误标。
  _markReadCacheStale(changedFiles, srcPort = null) {
    if (!this._readCache.size || !Array.isArray(changedFiles)) return;
    for (const _ch of changedFiles) {
      const _cn = String(_ch).replace(/\\/g, "/").toLowerCase();
      for (const [_cid, _cache] of this._readCache) {
        if (!this._chatBelongsToPort(_cid, srcPort)) continue;
        for (const [_p, _info] of _cache) {
          const _pn = String(_p).replace(/\\/g, "/").toLowerCase();
          if (_pn === _cn || _pn.endsWith("/" + _cn) || _cn.endsWith("/" + _pn)) {
            _info.stale = true;
          }
        }
      }
    }
  }

  /** ★ 从缓存清单移除指定路径：传 chatid 只删该会话分区；不传则删所有会话（兜底）。 */
  removeFromReadCache(path, chatid) {
    if (chatid != null) return this._readCache.get(chatid || "")?.delete(path) || false;
    let _removed = false;
    for (const _cache of this._readCache.values()) if (_cache.delete(path)) _removed = true;
    return _removed;
  }

  /** ★ 清空缓存清单：传 chatid 只清该会话分区；不传则全清。 */
  clearReadCache(chatid) {
    if (chatid != null) this._readCache.get(chatid || "")?.clear();
    else this._readCache.clear();
  }

  /** ★ 增加轮次计数（每次生成调用） */
  advanceRound() {
    this._readCacheRound++;
  }

  /**
   * leak-fix（与 fileEditRegistry 发现1 同类）：会话删除时清本会话残留的 per-chatid 运行时态，
   * 防 _diagRepeat/_lastDiagSig 随 chatid 单调泄漏（二者只 set 无 delete/TTL，deleteChat 原不通知本类）。
   * "" 全局兜底键不删。_externalChanges 一并清（设计按 chatid 键，当前虽仅 "" 但对称+未来安全）。
   */
  forgetChat(chatid) {
    if (!chatid) return;
    const ownerUsername = this._chatOwners?.get(chatid) || "";
    let pendingRequestsDetached = 0;
    for (const [requestId, pending] of this._pendingRequests || []) {
      if (pending?.kind !== "tool" || pending.chatid !== chatid) continue;
      clearTimeout(pending.timer);
      clearTimeout(pending.longTimer);
      clearTimeout(pending.retentionTimer);
      pending.detached = true;
      pending.resolve?.({
        success: false,
        aborted: true,
        pending: false,
        error: "会话已删除，已停止等待该工具结果",
        errorCode: "chat_deleted",
        jobId: pending.jobId,
        backendKind: pending.backendKind,
        backendPort: pending.port,
      });
      this._pendingRequests.delete(requestId);
      // 执行端没有通用取消协议：本地 active request 立即移除，只保留连接身份墓碑。
      // 真实回包会删除墓碑；没有回包则按既有 late-result retention 自动到期。
      const tombstone = {
        chatid,
        jobId: pending.jobId,
        connectionId: pending.connectionId,
        timer: null,
      };
      tombstone.timer = setTimeout(() => {
        if (this._deletedToolRequestTombstones.get(requestId) === tombstone) {
          this._deletedToolRequestTombstones.delete(requestId);
        }
      }, Math.max(1_000, Number(pending.config?.late_result_retention_ms) || 900_000));
      tombstone.timer.unref?.();
      this._deletedToolRequestTombstones.set(requestId, tombstone);
      pendingRequestsDetached++;
    }
    const pendingResultsBefore = this._pendingResults.length;
    this._pendingResults = this._pendingResults.filter((entry) => {
      if (entry?.chatid === chatid) return false;
      entry?._deliveredTo?.delete?.(chatid);
      return true;
    });
    const pendingResultsRemoved = pendingResultsBefore - this._pendingResults.length;
    const operationHistoryRemoved = this.clearOperationHistory({ ownerUsername, chatid });
    let approvalSubmissionReceiptsRemoved = 0;
    for (const [key, submission] of this._approvalSubmissionReceipts || []) {
      if (submission?.chatid !== chatid) continue;
      this._approvalSubmissionReceipts.delete(key);
      approvalSubmissionReceiptsRemoved++;
    }
    // [0808 治理·清理链补漏] 审批队列本体随会话删除清理（治理清单 循环08 #1：原 16 项清理唯独漏
    //   _pendingApprovals，:3210 清的 _approvalSubmissionReceipts 是提交收据不是队列——删对话后
    //   pending 条目永久滞留=僵尸审批，角标/面板还能看到已删会话的待批项）。
    //   不走 rejectOperation（它会 enqueuePendingResult 拒绝消息续喂——会话已删无线可喂）；
    //   条目的 checkpointId 均为本会话检查点（cp_${chatId}_… :3386），随会话消亡无跨会话阻塞，直接摘除。
    let pendingApprovalsRemoved = 0;
    if (Array.isArray(this._pendingApprovals) && this._pendingApprovals.length) {
      const _apBefore = this._pendingApprovals.length;
      this._pendingApprovals = this._pendingApprovals.filter((o) => o?.chatid !== chatid);
      pendingApprovalsRemoved = _apBefore - this._pendingApprovals.length;
    }
    this._diagRepeat?.delete(chatid);
    this._lastDiagSig?.delete(chatid);
    this._externalChanges?.delete(chatid);
    this._readCache?.delete(chatid); // per-chatid 读缓存分区随会话删除清理，防泄漏
    this._chatBindings?.delete(chatid); // 多开：会话删除时回收实例绑定
    this._bindingIds?.delete(chatid);   // 配对删链（编号身份随绑定回收）
    this._bindingSources?.delete(chatid); // 配对删链（绑定来源随绑定回收）
    this._bindingRoots?.delete(chatid); // 配对删链（根快照随绑定回收）
    this._toolJobs?.forgetChat(chatid, ownerUsername);
    for (const [key, state] of this._workerLifecycleStates || []) {
      if (state.chatid === chatid && state.username === ownerUsername) this._workerLifecycleStates.delete(key);
    }
    this._chatOwners?.delete(chatid);
    this._persistBindings?.(); // 持久表同步剪除（防删聊天后盘上残留死键）
    wbT(chatid, "ideClient", "forgetChat:toolStateCleared", {
      pendingRequestsDetached,
      pendingResultsRemoved,
      operationHistoryRemoved,
      approvalSubmissionReceiptsRemoved,
      pendingApprovalsRemoved,
    });
    return { pendingRequestsDetached, pendingResultsRemoved, operationHistoryRemoved, approvalSubmissionReceiptsRemoved, pendingApprovalsRemoved };
  }

  /**
   * _externalChanges 是 Map<chatid|"", Set<path>>（file_changed 入 "" 兜底键，见 _handleMessage 的 case "file_changed"）。
   * 封装正确访问口径供消费端用——消费端不得用「路径当顶层 key」直接 .has/.delete（那是 bug：
   * replyHandler 原 .has(path)/.delete(path) 永不命中，致 hash stale 检测死分支）。
   * 匹配口径与 _callToolAndStoreInner 的 _externalChanges 消费段一致：路径归一(反斜杠→/，小写) + 尾段双向 endsWith。
   */
  hasExternalChange(filePath, chatid) {
    if (!this._externalChanges || this._externalChanges.size === 0 || !filePath) return false;
    const _pn = String(filePath).replace(/\\/g, "/").toLowerCase();
    for (const _key of (chatid || "") !== "" ? [chatid, ""] : [""]) {
      const _set = this._externalChanges.get(_key);
      if (!_set) continue;
      for (const _ch of _set) {
        const _cn = String(_ch).replace(/\\/g, "/").toLowerCase();
        if (_pn === _cn || _pn.endsWith("/" + _cn) || _cn.endsWith("/" + _pn)) return true;
      }
    }
    return false;
  }
  /** 从本会话(+""兜底)外部变更集中移除匹配某路径的项（消费后清，空集删键）。 */
  clearExternalChange(filePath, chatid) {
    if (!this._externalChanges || !filePath) return;
    const _pn = String(filePath).replace(/\\/g, "/").toLowerCase();
    for (const _key of (chatid || "") !== "" ? [chatid, ""] : [""]) {
      const _set = this._externalChanges.get(_key);
      if (!_set) continue;
      for (const _ch of [..._set]) {
        const _cn = String(_ch).replace(/\\/g, "/").toLowerCase();
        if (_pn === _cn || _pn.endsWith("/" + _cn) || _cn.endsWith("/" + _pn)) _set.delete(_ch);
      }
      if (_set.size === 0) this._externalChanges.delete(_key);
    }
  }

  /**
   * 消费待处理结果（Hop 9a 入口）。generation.mjs 在每轮生成后调用。
   *
   * 链路：generation.mjs consumePendingResults → 本函数 → 取出本会话可消费项 → 注入对话 → auto-continue
   * 影响：
   *   - 带 chatid 的定向项：取走并从队列移除
   *   - null 广播项：交付给本会话（打 _deliveredTo 标记），项保留供其他会话各收一次，超 linger 时间物理移除
   *   - 不传 chatid 退化为全量 drain（兼容旧调用方如 worker runner）
   *
   * @param {string|null} chatid - 会话 ID，null 则全量 drain
   * @returns {Array<object>} 本会话可消费的结果数组
   */
  consumePendingResults(chatid = null, ownerUsername = "") {
    // ★ B2 corrId隔离 + F4 null项真广播:
    //   - 带 chatid 的项(本会话专属): 取走并从队列移除(仍独占,语义=定向给该会话)。
    //   - null 项(无会话归属=广播给所有会话): 不再被首个续轮会话整段 drain 独吞。改为每会话各收一次——
    //     交付给本会话时打 _deliveredTo 标记(Set of chatid),项保留在队列供其他会话拾取;
    //     仅当项超过 linger 时间才物理移除(防无界滞留)。无活跃会话注册表故用 linger 收尾(见 NULL_ITEM_LINGER_MS)。
    //   - 不传 chatid(=null) 退化为全量 drain(无会话标识的老调用方,如 worker runner 回传),保持旧行为不变。
    const _now = Date.now();
    if (!chatid) {
      const owner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
      if (!owner) return [];
      const mine = [], rest = [];
      for (const entry of this._pendingResults) {
        const entryOwner = entry.ownerUsername || (entry.chatid ? this._chatOwners.get(entry.chatid) || "" : "");
        if (entryOwner === owner) mine.push(entry);
        else rest.push(entry);
      }
      this._pendingResults = rest;
      wbT(null, "ideClient", "pendingResults:consumeOwnerDrain", { owner, taken: mine.length, remain: rest.length });
      return mine;
    }
    const consumerOwner = this._chatOwners.get(chatid) || "";
    const assertedConsumerOwner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!consumerOwner || (assertedConsumerOwner && assertedConsumerOwner !== consumerOwner)) {
      wbD(chatid, "ideClient", "pendingResults:consumeOwnerRejected", false,
        "消费 pendingResult 时缺少认证 owner 或 owner 冲突", {
          registeredOwner: consumerOwner || null,
          assertedOwner: assertedConsumerOwner || null,
        });
      return [];
    }
    const mine = [];
    const rest = [];
    let _lingerEvicted = 0;
    for (const r of this._pendingResults) {
      if (r.chatid === chatid && r.ownerUsername === consumerOwner) {
        // 定向本会话: 取走 + 移除。
        mine.push(r);
      } else if (r.chatid) {
        // 定向其他会话: 不动。
        rest.push(r);
      } else {
        // null 项 = 广播。本会话未收过 → 交付 + 标记;已收过 → 跳过。项保留(由 linger 决定何时删)。
        if (!consumerOwner || !r.ownerUsername || r.ownerUsername !== consumerOwner) {
          rest.push(r);
          continue;
        }
        if (!r._deliveredTo) r._deliveredTo = new Set();
        if (!r._deliveredTo.has(chatid)) {
          mine.push(r);
          r._deliveredTo.add(chatid);
        }
        if (r._firstDeliveredAt == null) r._firstDeliveredAt = _now;
        // 首次交付起 linger 内保留供其他会话拾取;超时物理移除。
        if (_now - r._firstDeliveredAt < NULL_ITEM_LINGER_MS) rest.push(r);
        else _lingerEvicted++; // 超 linger 物理移除的 null 项（未被某些会话拾取即丢）
      }
    }
    this._pendingResults = rest;
    wbT(chatid, "ideClient", "pendingResults:consume", { taken: mine.length, remain: rest.length });
    if (_lingerEvicted > 0) {
      wbD(chatid, "ideClient", "pendingResults:lingerEvict", false,
        `${_lingerEvicted} 个 null(广播)项超 linger(${NULL_ITEM_LINGER_MS}ms) 被物理移除，可能未被部分会话拾取`,
        { evicted: _lingerEvicted });
    }
    return mine;
  }

  // A2: 按 chatid 计数本会话可消费的 pending（与 consumePendingResults 同款过滤）。
  // 用于 generation autocontinue 判定，避免用全局 length 让多窗口下别的 chat 的 pending 串台误判。
  countPendingResults(chatid = null, ownerUsername = "") {
    if (!chatid) return this.getPendingResultCount({ ownerUsername });
    const consumerOwner = this._chatOwners.get(chatid) || "";
    const assertedConsumerOwner = typeof ownerUsername === "string" ? ownerUsername.trim() : "";
    if (!consumerOwner || (assertedConsumerOwner && assertedConsumerOwner !== consumerOwner)) return 0;
    let n = 0;
    for (const r of this._pendingResults) {
      if (r.chatid === chatid && r.ownerUsername === consumerOwner) n++;
      // F4: null 项只在本会话尚未收过时才计数(与 consumePendingResults 同款,避免 linger 期内
      //   已交付的项被反复计入、误触发空续轮)。
      else if (!r.chatid
        && consumerOwner
        && r.ownerUsername === consumerOwner
        && !(r._deliveredTo && r._deliveredTo.has(chatid))) n++;
    }
    return n;
  }

  // ---- 文件操作检查点（回档+溯源） ----
  // 通过 _checkpoint_* 内部工具间接调用 YonBan FileCheckpoint。
  // 常规路径：start → snapshotBeforeWrite(自动) → commit（一轮一检查点）。
  // 审批路径：start(deferred=true) → 挂起 → 用户批准 → pinTarget → 写 → _maybeCommitCheckpoint。

  /**
   * 开始一个文件操作检查点（Hop 6 入口）。
   *
   * @param {string} chatId - 聊天 ID
   * @param {number} messageIndex - 消息索引
   * @param {boolean} deferred - true=审批路径（不抢占全局 _activeId），false=即时路径
   * @returns {Promise<{ success: boolean, id: string }>}
   */
  async startCheckpoint(chatId, messageIndex, deferred = false, messageId = "") {
    const id = `cp_${chatId}_${messageIndex}_${Date.now()}`;
    // gateCtx.chatid：检查点必须建在该会话所绑窗口（与后续写同一连接），多开下不落错实例
    const result = await this.callTool("_checkpoint_start", { id, chatId, messageIndex, deferred, ...(messageId ? { messageId } : {}) }, undefined, undefined, { chatid: chatId });
    if (result?.success) console.log(`[ideClient] 检查点已开始: ${id} (deferred=${deferred})`);
    return { success: !!result?.success, id };
  }

  /** 当某检查点关联的待审批写操作全部消费完（批准/拒绝）后，提交检查点（落盘，使可回档+可被清理） */
  async _maybeCommitCheckpoint(checkpointId, chatid = null) {
    if (!checkpointId) return;
    const stillPending = this._pendingApprovals.some((o) => o.checkpointId === checkpointId);
    if (stillPending) return;
    try {
      const commitResult = await this.commitCheckpoint(checkpointId, chatid);
      if (!commitResult.success) {
        wbD(chatid, "ideClient", "checkpoint:commitFailed", false,
          commitResult.error || "审批检查点提交未成功", {
            checkpointId,
            persisted: commitResult.persisted,
            warning: commitResult.warning || null,
          });
        console.warn(`[ideClient] 审批检查点提交失败: ${commitResult.error || "未知错误"}`);
      }
      return commitResult;
    } catch (e) {
      console.warn(`[ideClient] 审批检查点提交失败: ${e.message}`);
      wbD(chatid, "ideClient", "checkpoint:commitException", false,
        e?.message || String(e), { checkpointId });
      return { success: false, persisted: false, error: e?.message || String(e) };
    }
  }

  async commitCheckpoint(id, chatid = null) {
    const result = await this.callTool("_checkpoint_commit", { id }, undefined, undefined, chatid ? { chatid } : {});
    const inner = (result?.result && typeof result.result === "object") ? result.result : {};
    const outerOk = result?.success === true;
    const innerOk = inner.success !== false;
    const success = outerOk && innerOk;
    const persisted = success && inner.persisted === true;
    const warning = inner.warning
      || (success && !persisted ? "检查点已提交，但后端未确认已持久化到磁盘" : undefined);
    const error = success
      ? undefined
      : (inner.error || result?.error || "检查点提交未成功");
    if (success && persisted) {
      console.log(`[ideClient] 检查点已提交并持久化: ${id}`);
    } else if (success) {
      console.warn(`[ideClient] 检查点已提交但未确认持久化: ${id}${warning ? ` (${warning})` : ""}`);
    } else {
      console.warn(`[ideClient] 检查点提交失败: ${id} (${error})`);
    }
    return { success, persisted, ...(warning ? { warning } : {}), ...(error ? { error } : {}) };
  }

  /**
   * 回档单个检查点
   * @param {string} id - 检查点ID
   * @returns {Promise<object>}
   */
  async revertCheckpoint(id, chatid = null) {
    console.log(`[ideClient] 请求回档检查点: ${id}`);
    const result = await this.callTool("_checkpoint_revert", { id }, undefined, undefined, chatid ? { chatid } : {}); // [多开] 会话路由（检查点在其所建窗口）
    if (result?.success) {
      console.log(`[ideClient] 检查点回档完成: ${id}`);
    } else {
      console.warn(`[ideClient] 检查点回档失败: ${result?.error || "未知错误"}`);
    }
    return result;
  }

  /**
   * 回档到指定消息（R6 交叉：回档链路的文件恢复节点）。
   * 恢复该消息之后所有检查点的文件操作（LIFO 顺序，最旧检查点最后 revert 保证最原始态落地）。
   *
   * 链路：chatOps rollbackMemoryToMessage → 本函数 → _checkpoint_revert_to_message → FileCheckpoint.revertToMessage
   * 影响：YonBan 侧文件恢复/删除 + 检查点从内存和磁盘删除
   *
   * @param {string} chatId
   * @param {number} targetIndex - 回档目标消息索引（之后的检查点全部 revert）
   * @returns {Promise<object>}
   */
  async revertToMessage(chatId, targetIndex, expectedCheckpointIds = undefined, expectedIdeRoute = undefined) {
    console.log(`[ideClient] 请求文件回档: chatId=${chatId}, targetIndex=${targetIndex}`);
    const result = await this.callTool("_checkpoint_revert_to_message", {
      chatId,
      targetIndex,
      ...(expectedCheckpointIds !== undefined ? { expectedCheckpointIds } : {}),
    }, undefined, undefined, {
      chatid: chatId,
      ...(expectedIdeRoute !== undefined ? { expectedIdeRoute } : {}),
    });
    if (result?.success) {
      const r = result.result || {};
      console.log(
        `[ideClient] 文件回档完成: 恢复${r.checkpointsReverted || 0}个检查点, ` +
          `还原${r.totalRestored || 0}个文件, 删除${r.totalDeleted || 0}个新建文件`,
      );
    } else {
      console.warn(`[ideClient] 文件回档失败: ${result?.error || "未知错误"}`);
    }
    return result;
  }

  /**
   * 只读预览：若回档到 targetIndex，文件层会还原/删除哪些文件。绝不改状态。
   * @returns {Promise<{success:boolean, result?:{checkpointsToRevert,filesToRestore,filesToDelete}, error?:string}>}
   */
  async getCheckpointDiff(chatId, targetIndex, expectedCheckpointIds = undefined, expectedIdeRoute = undefined) {
    console.log(`[ideClient] 请求回档预览(只读): chatId=${chatId}, targetIndex=${targetIndex}`);
    const result = await this.callTool("_checkpoint_revert_diff", {
      chatId,
      targetIndex,
      ...(expectedCheckpointIds !== undefined ? { expectedCheckpointIds } : {}),
    }, undefined, undefined, {
      chatid: chatId,
      ...(expectedIdeRoute !== undefined ? { expectedIdeRoute } : {}),
    });
    if (result?.success) {
      const r = result.result || {};
      console.log(
        `[ideClient] 回档预览: 涉及${r.checkpointsToRevert || 0}个检查点, ` +
          `将还原${(r.filesToRestore || []).length}个文件, 删除${(r.filesToDelete || []).length}个新建文件`,
      );
    } else {
      console.warn(`[ideClient] 回档预览失败: ${result?.error || "未知错误"}`);
    }
    return result;
  }

  /**
   * 列出所有检查点
   * @returns {Promise<Array>}
   */
  async listCheckpoints() {
    const result = await this.callTool("_checkpoint_list", {});
    if (result?.success && result.result?.checkpoints) {
      return result.result.checkpoints;
    }
    return [];
  }

  async canReplay(id) {
    const result = await this.callTool("_checkpoint_can_replay", { id });
    if (result?.success) return result.result || { canReplay: false, changedFiles: [] };
    return { canReplay: false, changedFiles: [] };
  }

  async getCheckpointOps(id) {
    const result = await this.callTool("_checkpoint_get_ops", { id });
    if (result?.success && result.result?.success) return result.result.operations;
    return null;
  }

  // ---- Question 提问通道 ----

  /**
   * 向用户发送提问（通过 IDE 弹窗）
   * @param {string} questionText - 问题文本
   * @param {number} [timeout=60000] - 等待超时（ms）
   * @returns {Promise<{ answered: boolean, answer?: string }>}
   */
  async askQuestion(questionText, timeout = 60000, chatid = null) {
    // 多开路由：提问弹在该会话所绑的窗口（问 A 会话的问题不能弹到 B 窗口）
    const _qConn = this._connFor(chatid || null);
    if (!_qConn) {
      wbT(null, "ideClient", "askQuestion:notConnected", {}); // IDE可选未连=正常态,对齐 callTool:notConnected 降级(非异常)
      return { answered: false, error: "IDE 未连接" };
    }

    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        wbD(null, "ideClient", "askQuestion:timeout", false, `用户未回答(超时${timeout}ms)`, { id });
        resolve({ answered: false, error: "用户未回答（超时）" });
      }, timeout);

      this._pendingRequests.set(id, {
        kind: "question",
        resolve: (payload) => {
          clearTimeout(timer);
          const answer = payload?.answer || payload?.result?.answer || "";
          // 回答的注入走调用方（replyHandler 7.5 节）enqueuePendingResult 复用 pendingResults 管道；
          // 原 _pendingQuestionAnswers 内部队列已删（全根零消费者的死队列，留着=push 无人取的内存泄漏）。
          // answered 透传 YonBan 侧判定（IdeWsServer.ts: answered = answer !== null，用户 Esc 取消 InputBox
          // 时为 false）——不读它会把"用户取消"错当"回答了空字符串"。
          const _userAnswered = payload?.answered !== false;
          // error 优先透传执行端原因（CLI 无头后端回"请在 beilu 网页端回答"），YonBan 不带 error 字段=回退原文本
          resolve(_userAnswered ? { answered: true, answer } : { answered: false, error: payload?.error || "用户取消了输入框" });
        },
        reject: (err) => {
          clearTimeout(timer);
          resolve({ answered: false, error: err.message });
        },
        timer,
        port: _qConn.port,
      });

      // 发送 question 消息
      try {
        _qConn.ws.send(JSON.stringify({
          type: "question",
          id,
          payload: { id, text: questionText },
        }));
        console.log(`[ideClient] 已发送提问: "${questionText.substring(0, 50)}..." (id=${id})`);
      } catch (err) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        wbD(null, "ideClient", "askQuestion:sendFail", false, err.message, { id });
        resolve({ answered: false, error: `发送失败: ${err.message}` });
      }
    });
  }

  // ---- 内部方法 ----

  // [D6 §2.4 2026-08-04] 原"反向桥"_reconcileWorkspaceToCanonical 已删除：
  //   它在 hello/status 时对 beilu-files 发无 owner 的 SetData({setWorkspaceRoot,_fromIDE})——
  //   IDE 宣称的根被直接写进持久 canonical（无 owner/chat 授权面，D6 事实表确证的直写点）。
  //   现 IDE status/hello 只【记录候选】（conn.ideInfo.status.workspaceFolders，
  //   经 getIdeInstances/listLiveInstances 暴露给 UI 显示"IDE 候选根"）；持久化确认必须走
  //   beilu-files 的 confirmIdeWorkspaceRoot 动作：认证 owner + chatId + instanceId +
  //   connectionId 与 getRouteSnapshot(chatId) 精确匹配才允许一次 ide-bound 根写入。

  _handleMessage(msg, conn) {
    switch (msg.type) {
      case "hello":
        conn.ideInfo = msg.payload || {};
        // [编号识别 0726 凛倾] 实例自报编号（IdeWsServer.instanceId 随 hello 下发）——本体只负责记，
        // 不再靠 pid/端口/workspace 推断身份。CLI 端未发编号时留空，路由回落端口（旧语义不变）。
        conn.instanceId = conn.ideInfo.instanceId || null;
        // 鉴权真正确认点：YonBan 仅在校验 token 通过后才发 hello。失败计数在此清零
        // （不在 onopen，那只是 socket 升级成功；4001 鉴权失败发生在 onopen 之后）。
        conn.authFailCount = 0;
        conn.lastFailToken = null;
        this._autoReconnect = true; // 连上后恢复自动重连（可能被手动断开/上限关闭过）
        console.log(
          `[ideClient] IDE 握手: version=${conn.ideInfo.extensionVersion || "?"}, port=${conn.ideInfo.port || conn.port}, 后端=${(conn.ideInfo.appName === "beilu-cli" || conn.kind === "cli") ? "CLI(beilu-cli)" : "YonBan IDE"}`,
        );
        // [D6 §2.4] hello 携带的工作区根只作候选记录（conn.ideInfo），不再反向直写 canonical。
        break;

      case "tool_started": {
        const requestId = msg.id || msg.payload?.id;
        const deletedTombstone = this._deletedToolRequestTombstones.get(requestId);
        if (deletedTombstone) {
          wbT(deletedTombstone.chatid || null, "ideClient", "tool_started:deletedChatDiscarded", {
            requestId,
            jobId: deletedTombstone.jobId,
            connectionMatch: deletedTombstone.connectionId === conn?.connectionId,
          });
          break;
        }
        const pending = this._pendingRequests.get(requestId);
        if (pending?.kind === "tool" && pending.connectionId === conn?.connectionId) {
          if (!isWorkerIsolate) {
            const job = this._toolJobs.update(pending.jobId, {
              state: "running",
              startedAt: msg.payload?.startedAt || new Date().toISOString(),
            });
            this._broadcastToolJob(job, false, job?.state);
          }
        } else if (pending?.kind === "tool") {
          wbD(null, "ideClient", "tool_started:connectionMismatch", false,
            "tool_started 来自非请求所属连接，已忽略", {
              requestId,
              expectedConnectionId: pending.connectionId,
              actualConnectionId: conn?.connectionId,
            });
        } else {
          wbD(null, "ideClient", "tool_started:orphan", false, "tool_started 无匹配工具请求", { requestId, port: conn?.port });
        }
        break;
      }

      case "tool_progress": {
        const requestId = msg.id || msg.payload?.id;
        const deletedTombstone = this._deletedToolRequestTombstones.get(requestId);
        if (deletedTombstone) {
          wbT(deletedTombstone.chatid || null, "ideClient", "tool_progress:deletedChatDiscarded", {
            requestId,
            jobId: deletedTombstone.jobId,
          });
          break;
        }
        const pending = this._pendingRequests.get(requestId);
        if (pending?.kind === "tool" && pending.connectionId === conn?.connectionId) {
          const progress = _normalizeToolProgress(msg.payload?.progress);
          if (!progress) {
            wbD(pending.chatid || null, "ideClient", "tool_progress:schemaRejected", false,
              "tool_progress payload 无效", { requestId, jobId: pending.jobId });
            break;
          }
          if (isWorkerIsolate) {
            this._publishWorkerToolLifecycle(pending, "progress", { progress });
          } else {
            const currentJob = this._toolJobs.get(pending.jobId);
            const startedAtMs = new Date(
              currentJob?.startedAt || currentJob?.createdAt || Date.now(),
            ).getTime();
            const job = this._toolJobs.update(pending.jobId, {
              progress,
              longRunning: currentJob?.longRunning || progress.phase === "stalled",
              duration: Math.max(0, Date.now() - startedAtMs),
            });
            if (progress.phase === "running") pending.stallNotified = false;
            const shouldNotify = progress.phase === "stalled"
              && !pending.stallNotified
              && !!pending.config.notify_stalled;
            if (progress.phase === "stalled") pending.stallNotified = true;
            this._broadcastToolJob(
              job,
              shouldNotify,
              progress.phase,
            );
          }
        } else if (pending?.kind === "tool") {
          wbD(null, "ideClient", "tool_progress:connectionMismatch", false,
            "tool_progress 来自非请求所属连接，已忽略", {
              requestId,
              expectedConnectionId: pending.connectionId,
              actualConnectionId: conn?.connectionId,
            });
        } else {
          wbD(null, "ideClient", "tool_progress:orphan", false,
            "tool_progress 无匹配工具请求", { requestId, port: conn?.port });
        }
        break;
      }

      case "tool_result": {
        const resultPayload = msg.payload;
        const requestId = msg.id || resultPayload?.id;
        const deletedTombstone = this._deletedToolRequestTombstones.get(requestId);
        if (deletedTombstone) {
          const connectionMatch = deletedTombstone.connectionId === conn?.connectionId;
          if (connectionMatch) {
            clearTimeout(deletedTombstone.timer);
            this._deletedToolRequestTombstones.delete(requestId);
          }
          wbT(deletedTombstone.chatid || null, "ideClient", "tool_result:deletedChatDiscarded", {
            requestId,
            jobId: deletedTombstone.jobId,
            success: resultPayload?.success !== false,
            connectionMatch,
          });
          break;
        }
        const pending = this._pendingRequests.get(requestId);
        if (pending?.kind === "tool" && pending.connectionId === conn?.connectionId) {
          clearTimeout(pending.timer);
          clearTimeout(pending.longTimer);
          clearTimeout(pending.retentionTimer);
          this._pendingRequests.delete(requestId);
          const success = resultPayload?.success !== false;
          if (success) this._stats.toolCallsSucceeded++;
          else this._stats.toolCallsFailed++;
          const late = !!(pending.waitTimedOut || pending.detached);
          const enriched = {
            ...(resultPayload || {}),
            jobId: pending.jobId,
            backendKind: pending.backendKind,
            backendPort: pending.port,
            late,
            waitTimedOut: !!pending.waitTimedOut,
            detached: !!pending.detached,
          };
          if (isWorkerIsolate) {
            if (late) this._publishLateToolResult(pending, enriched);
            else pending.resolve(enriched);
          } else {
            const job = this._toolJobs.update(pending.jobId, {
              state: success ? "succeeded" : "failed",
              error: success ? null : (resultPayload?.error || "tool_failed"),
              late,
            });
            this._broadcastToolJob(
              job,
              success ? !!pending.config.notify_completed : !!pending.config.notify_failed,
              late ? "late_completed" : (success ? "completed" : "failed"),
            );
            if (late) this._publishLateToolResult(pending, enriched);
            else pending.resolve(enriched);
          }
        } else if (pending?.kind === "tool") {
          // request id 不是连接认证：旧连接或另一后端即使拿到 id，也不能完成不属于它的 pending。
          wbD(null, "ideClient", "tool_result:connectionMismatch", false,
            "tool_result 来自非请求所属连接，已拒绝匹配", {
              requestId,
              expectedConnectionId: pending.connectionId,
              actualConnectionId: conn?.connectionId,
            });
        } else {
          if (isWorkerIsolate) {
            wbD(null, "ideClient", "tool_result:workerOrphan", false,
              "worker 收到无匹配 request 的 tool_result，缺少 chat/owner 路由，仅留运输诊断", {
                requestId, port: conn?.port,
              });
            break;
          }
          // 真正未知的回包不注入任何会话，只保留可诊断 Job/历史；避免旧实现静默丢弃，也避免跨会话广播。
          const orphan = this._toolJobs.create({
            requestId,
            chatid: null,
            ownerUsername: "",
            tool: resultPayload?.tool || "_unknown_tool",
            params: {},
            backendKind: (conn?.ideInfo?.appName === "beilu-cli" || conn?.kind === "cli") ? "cli" : "yonban",
            backendPort: conn?.port ?? null,
          });
          const orphanJob = this._toolJobs.update(orphan.jobId, {
            state: "orphan_result",
            error: "unmatched_tool_result",
            late: true,
          });
          this._recordOperation({
            tool: resultPayload?.tool || "_unknown_tool",
            params: {},
            result: resultPayload || null,
            success: false,
            chatid: null,
            timestamp: new Date().toISOString(),
            jobId: orphanJob?.jobId || null,
            state: "orphan_result",
          });
          wbD(null, "ideClient", "tool_result:orphan", false, "tool_result 无匹配 pending，已留诊断记录且未注入会话", { requestId, port: conn?.port });
        }
        break;
      }

      case "question_answer": {
        // 用户回答了提问
        const requestId = msg.id || msg.payload?.id;
        const pending = this._pendingRequests.get(requestId);
        if (pending?.kind === "question") {
          clearTimeout(pending.timer);
          this._pendingRequests.delete(requestId);
          pending.resolve(msg.payload);
        }
        break;
      }

      case "console":
        if (msg.payload) {
          const entry = msg.payload;
          const text = `[IDE] ${entry.text || ""}`;
          // [白盒链路 0726] 执行端白盒埋点（"[wb:yonban.*]"，YonBan tool-infra wbT/wbD）原级转发，
          //   不参与下面的噪声收敛。why：原逻辑 log 级整条丢弃、warn 级降 debug，导致 YonBan 侧埋点
          //   一条都到不了 monitor 面板，而 CLI 侧 "[wb:cli.*]"（stdout 桥→console→monitor hook）能到
          //   ——两端埋点落在不同面板、无法同一套过滤比对。两端可比对才算链路真的拉到前端。
          const _isWb = typeof entry.text === "string" && entry.text.startsWith("[wb:");
          if (entry.level === "error") console.error(text);
          else if (_isWb) { if (entry.level === "warn") console.warn(text); else console.log(text); }
          else if (entry.level === "warn") console.debug(text); // 噪声收敛: IDE warn 降 debug, 不灌入监控面板(warn 被全量捕获致刷屏)
        }
        break;

      case "status":
        // 2026-07-09 收口审计：status 裸快照（IdeStatusPayload）并入 ideInfo.status 嵌套=单一真值位。
        //   原 spread 到顶层：嵌套 status 停在 hello 快照不更新，而 workspaceRoot getter/reconcile 嵌套
        //   优先读 → status 广播新工作区后仍读到旧根、反向桥回写旧值。
        if (msg.payload) conn.ideInfo = { ...conn.ideInfo, status: { ...(conn.ideInfo?.status || {}), ...msg.payload } };
        // [D6 §2.4] status 更新只刷新候选快照，不再反向直写 canonical 根。
        break;

      // ★ 文件变更通知：VSCode检测到文件被外部修改
      case "file_changed":
        if (msg.payload && msg.payload.fileChanges) {
          const _chFiles = msg.payload.fileChanges;
          console.log(`[ideClient] 检测到 ${_chFiles.length} 个文件被外部修改: ${_chFiles.slice(0, 5).join(", ")}`);
          // 记录变更文件，工具执行时检查。file_changed 是 VSCode 工作区级事件、不带 chatid →
          //   入 "" 兜底键（对所有会话可见）；消费端 drain 自己键 + 兜底键。
          let _extSet = this._externalChanges.get("");
          if (!_extSet) { _extSet = new Set(); this._externalChanges.set("", _extSet); }
          for (const f of _chFiles) _extSet.add(f);
          // 双向同步：外部改动同时标记本体读缓存为 stale，使 AI 在「上下文文件缓存」里
          //   直接看到该文件已变更、该重读——不必等到写工具命中才警告（原只在写路径消费）。
          //   [多开] 带来源窗口端口：只标归属该窗口的会话。
          this._markReadCacheStale(_chFiles, conn?.port ?? null);
        }
        break;

      // ★ 终端错误自动捕获：VSCode诊断变化 → 注入AI上下文
      case "diagnostics_changed":
        if (msg.payload && msg.payload.errors && msg.payload.errors.length > 0) {
          const _diagErrors = msg.payload.errors;
          const _diagTotal = msg.payload.totalErrors || 0;
          const _diagText = _diagErrors.map(f =>
            `${f.file}:\n${f.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}`
          ).join("\n\n");
          // ★ F5 死循环熔断：相同错误集连续重复时升级提示/熔断，防编译错误自动修复陷入死循环刷屏。
          //   错误集签名 = 文件+行+消息排序拼接；连错≥3 升级"改策略"提示，≥6 暂停注入（仅日志）直至错误集变化。
          const _diagSig = _diagErrors
            .map(f => `${f.file}|${f.errors.map(e => `${e.line}:${e.message}`).join(";")}`)
            .sort().join("||");
          // ★ F3 会话态分区：先归因到「写了出错文件」的会话，再按该 chatid 分区计连错次数。
          //   原全局 _diagRepeat 让 A 的连错顶满全局熔断、把 B 的真错误也一并暂停注入（串台）。
          //   现每会话独立计数：A 连错 6 次只熔断 A 自己的注入，不影响 B。键="" = 无归因(旧全局语义)。
          const _alertChatid = this._attributeDiagChatid(_diagErrors, conn?.port ?? null); // [多开] 按来源窗口归因
          const _diagKey = _alertChatid || "";
          let _repeat;
          if (this._lastDiagSig.get(_diagKey) === _diagSig) {
            _repeat = (this._diagRepeat.get(_diagKey) || 1) + 1;
          } else {
            this._lastDiagSig.set(_diagKey, _diagSig);
            _repeat = 1;
          }
          this._diagRepeat.set(_diagKey, _repeat);
          console.warn(`[ideClient] 检测到 ${_diagTotal} 个编译错误（会话${_diagKey || "(广播)"} 相同错误第${_repeat}次）`);
          if (_repeat >= 6) {
            // 熔断：相同错误反复注入仍未解决 → 停止刷屏，等错误集变化（AI改对/换错）再恢复注入
            wbD(_alertChatid, "ideClient", "diagnostics:circuitBreak", false,
              `F5熔断:相同编译错误连续${_repeat}次,暂停注入`, { repeat: _repeat, totalErrors: _diagTotal });
            console.warn(`[ideClient] F5熔断：相同编译错误连续${_repeat}次，暂停注入直至错误集变化`);
          } else {
            const _loopHint = _repeat >= 3
              ? `\n\n⚠ 相同的编译错误已连续出现 ${_repeat} 次，当前修复策略可能无效或陷入死循环。请改变思路（read_file 重读确认实际内容、核对是否改错位置/层级），勿重复同一改法。`
              : "";
            // 注入pendingResults，AI下一轮会看到并自动修复
            this.enqueuePendingResult({
              tool: "_diagnostics_alert",
              params: { totalErrors: _diagTotal, repeat: _repeat },
              result: { success: false, error: `[IDE编译错误检测 — ${_diagTotal}个错误]\n\n${_diagText}\n\n请检查并修复这些错误。${_loopHint}` },
              chatid: _alertChatid,
              timestamp: new Date().toISOString(),
            });
          }
        }
        break;

      case "pong":
        // H3: 记录 pong 到达时间，供 _startHeartbeat 判活（收不到 pong 判僵连接重连）
        conn.lastPongAt = Date.now();
        break;

      default:
        break;
    }
  }

  /** 断连后快速重扫（RECONNECT_DELAY 防抖）：比周期重扫更快接回瞬断连接；风暴防护=_ensureConn 鉴权上限。 */
  _scheduleRescanSoon() {
    if (this._rescanSoonTimer) return;
    this._rescanSoonTimer = setTimeout(() => {
      this._rescanSoonTimer = null;
      if (this._autoReconnect) this._syncConnections();
    }, RECONNECT_DELAY);
  }

  /** 注册表周期重扫：新窗口上线接入 / 死窗口剪除 / CLI↔YonBan 互斥切换（原心跳内互斥检查收口至此）。 */
  _startRescan() {
    if (this._rescanTimer) return;
    this._rescanTimer = setInterval(() => {
      if (this._autoReconnect) this._syncConnections();
    }, RESCAN_INTERVAL);
  }

  _clearReconnectTimer() {
    if (this._rescanTimer) {
      clearInterval(this._rescanTimer);
      this._rescanTimer = null;
    }
    if (this._rescanSoonTimer) {
      clearTimeout(this._rescanSoonTimer);
      this._rescanSoonTimer = null;
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return; // 幂等：每条连接 onopen 都调，单一 interval 遍历全池
    this._heartbeatTimer = setInterval(() => {
      for (const conn of [...this._conns.values()]) {
        if (!this._isConnLive(conn)) continue;
        // H3: 僵连接检测——超 HEARTBEAT_TIMEOUT 未收到 pong（YonBan 服务端 IdeWsServer 收 ping 回 pong），
        //   判半开 TCP 死连，主动 close 触发 onclose→重扫重连（消除 tool_call 全部 30s 超时才暴露）。
        if (conn.lastPongAt && Date.now() - conn.lastPongAt > HEARTBEAT_TIMEOUT) {
          wbD(null, "ideClient", "heartbeat:stale", false, `心跳超时无pong,判僵连接主动重连`, { sinceLastPongMs: Date.now() - conn.lastPongAt, port: conn.port });
          console.warn(`[ideClient] 端口 ${conn.port} 心跳超时 ${Math.round((Date.now() - conn.lastPongAt) / 1000)}s 无 pong，判僵连接，主动重连`);
          try { conn.ws.close(); } catch { /* ignore */ }
          continue;
        }
        try { conn.ws.send(JSON.stringify({ type: "ping", payload: null })); } catch { /* ignore */ }
      }
      // 互斥升级（凛倾 0722「cli 和 yonban 互斥」）已收口进 _syncConnections 周期重扫：
      // CLI 在连而 YonBan 上线 → 目标集只含 YonBan → CLI 连接被剪除切换；反向回落同理（YonBan 全关 → 目标集=CLI）。
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}

// ---- 单例导出 ----

/**
 * 活跃实例分区（**互斥规则单点**）：注册表 → { yonbans, clis }。
 * 规则=凛倾 0722/0726 拍板「有 YonBan 在线时 CLI 让位」。两个消费面共用这一份分区：
 *   ① 本体连接目标集（_syncConnections：有 YonBan → 只连 YonBan，CLI 不进池）；
 *   ② CLI 子进程生死（beilu-cli supervisor：有 YonBan → 停 CLI 进程）——凛倾原话
 *      「cli就是要离线啊，不离线指令会不会互斥？会不会导致2个都开占用内存和cpu」：
 *      只做到"本体不连"，CLI 进程照跑、照监听端口、照占内存 CPU，等于互斥只做了一半。
 * 【why 收单点】两处各自解析注册表 / 各写一遍「谁算 YonBan」= 同一规则两份实现，必然漂移
 *   （一侧改判据另一侧不动 → 出现"本体不连但进程也不停"或反过来"进程停了本体还在连"的裂口）。
 */
export function partitionActiveIdeInstances() {
  const live = IdeClient.discoverActivePorts();
  return {
    yonbans: live.filter((e) => e && e.type !== "beilu-cli"),
    clis: live.filter((e) => e && e.type === "beilu-cli"),
  };
}

/**
 * ══ IDE 系统分类器（凛倾 0727「先搭建分类器，分类现在链接的是 cli 还是 yonban」）══
 * 全项目唯一回答这三个问题的地方：现在连的是哪套 IDE 系统 / 这套系统的「窗口」是什么维度 /
 * 有哪些实例。任何地方要判断"CLI 还是 YonBan"都调它，禁再各写一遍 `type !== "beilu-cli"`。
 *
 * 【windowDimension 是本分类器的核心产出，不是装饰】两套系统的多开维度**不同**：
 *   · yonban → "instance"：一个 VSCode 窗口一个实例，线↔实例 1:1，需要选"绑哪个窗口"；
 *   · cli    → "line"：一个 CLI 进程按会话键分池处理指令（command-tools.mjs 会话池，
 *              键=chatid），**多条线共用一个进程**，不存在也不需要"选哪个 CLI"。
 * 【why 必须显式给出】0727 事故：把 "一线一实例" 当成两套共同规则 → 单个 CLI 被当成
 *   "只能有一个窗口" → 本体拉第二条线时检测不到第二个实例 = 本体的多线被套进 YonBan 的
 *   多实例口径（凛倾原话「搞嵌套了，检测机制完全不分类」）。分类器把维度显式化，堵住这条。
 *
 * @returns {{mode:"hybrid"|"yonban"|"cli"|"none", windowDimension:"backend"|"instance"|"line"|null,
 *            yonbans:Array, clis:Array, instances:Array}}
 */
export function resolveIdeMode() {
  const { yonbans, clis } = partitionActiveIdeInstances();
  if (yonbans.length && clis.length) {
    return { mode: "hybrid", windowDimension: "backend", yonbans, clis, instances: [...yonbans, ...clis] };
  }
  if (yonbans.length) return { mode: "yonban", windowDimension: "instance", yonbans, clis: [], instances: yonbans };
  if (clis.length) return { mode: "cli", windowDimension: "line", yonbans: [], clis, instances: clis };
  return { mode: "none", windowDimension: null, yonbans: [], clis: [], instances: [] };
}

export const ideClient = new IdeClient();

try {
  const { events } = await import("../../../server/events.mjs");
  events.on("AfterUserDeleted", ({ username }) => {
    ideClient._requireWriteApproval?.delete?.(username);
    for (const [key, submission] of ideClient._approvalSubmissionReceipts || []) {
      if (submission?.username === username) ideClient._approvalSubmissionReceipts.delete(key);
    }
  });
} catch {}

// 跨 isolate 审批 request/ack（主 isolate 专属）：只有主进程认证 parent context 的
// username/chatid/generationId 可参与幂等键；payload 只承载操作内容与 operationId。
if (!isWorkerIsolate) {
  registerBridgeRequestHandler("approval_add", (p, trustedContext) => {
    const username = typeof trustedContext?.username === "string" ? trustedContext.username.trim() : "";
    const chatid = typeof trustedContext?.chatid === "string" ? trustedContext.chatid.trim() : "";
    const generationId = typeof trustedContext?.generationId === "string"
      ? trustedContext.generationId.trim()
      : "";
    if (!username || !chatid || !generationId) {
      throw _approvalSubmissionError(
        "E_APPROVAL_TRUSTED_CONTEXT_INVALID",
        "approval bridge request is missing trusted username, chatid or generationId",
        { phase: "approval_preflight" },
      );
    }
    return ideClient._submitPendingApprovalInMain(
      p?.toolCall,
      p?.checkpointId || null,
      chatid,
      {
        operationId: p?.operationId,
        username,
        generationId,
      },
    );
  });
}

/**
 * 获取当前客户端环境字符串
 * @returns {string}
 */
export function getClientEnvString() {
  return ideClient.clientEnv;
}

// generateIdeToolsPromptText 已删除（0722 凛倾「工具规则放到 INJ」）：代码不再生成自然语言
// 教学/未连接引导。工具使用规则唯一权威=可编辑 INJ；{{ide_tools}} 只从 IDE_TOOLS 生成
// 无运行态的静态名称/参数签名，避免注册表与 INJ 手写清单漂移，同时保持历史前缀可缓存。

// ============================================================
// 标签解析/消息判定/格式化 -- 提取到 ideTagParser.mjs（纯函数，零副作用）
// ideClient.mjs re-export 保持所有外部消费者 import 路径不变
// ============================================================
export {
  parseIdeToolCallTags,
  parseQuestionTags,
  formatToolResultsForInjection,
  isIdeToolResultMsg,
  isIdeToolCallMsg,
  CLONE_TAG_RE,
  collectNoiseToHide,
  generateHumanReadableDescription,
  getSeverityEmoji,
} from "./ideTagParser.mjs";
