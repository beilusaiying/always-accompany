/**
 * filesSettingsStore.mjs — data/beilu-files-settings.json 的唯一 read/validate/mutate/write owner
 * （D6 §4，2026-08-04 窗口A 施工）。
 *
 * 【功能链】
 *   写路（全部经 mutate 单一跨入口锁 + versioned CAS + 原子写 + 读回校验）：
 *     beilu-files 插件（用户桶/工作区 owner 分区）→ patchUserFilesSettings / setWorkspaceScope
 *     /api/security/command-gate|command-rules（endpoints 薄 adapter）→ patchCommandGate
 *     /api/security/files-settings/repair（owner 显式修复）→ repair
 *   读路（只读 snapshot，永不写）：
 *     beilu-files Load/GetData → readSnapshot / getWorkspaceView
 *     commandGate _loadCommandRules/_loadCommandGateConfig → getCommandGateView
 *     ideClient readFilesPermission/_readCanonicalWorkspace → getFilesPermissionView / getOwnerWorkspaceRoot
 *   政策单源（root 候选与 browse 同一政策链，D6 §2.2/§3.3 五入口同拒）：
 *     resolveWorkspaceRootCandidate / resolveBrowseListingTarget / listBrowseBases
 *
 * 【why】
 *   原状是三个整文档写者（插件 RMW 队列 / endpoints._writeCommandGate / _writeCommandRules）
 *   无共享锁无 revision（B1，可丢 command gate/workspace/用户权限字段）；损坏被读侧各自
 *   catch 成"无配置用默认"（B2 fail-open）；根建立无 C 盘/系统卷不变式且幽灵根只修内存不修盘
 *   （B6）。本模块把该物理文件收成单写者：versioned document（schemaVersion:2 + revision 单调）、
 *   严格读取（损坏→备份 .corrupt.<ts>.bak + typed 错误 + 健康故障态）、CAS（revision 冲突
 *   E_SETTINGS_REVISION_CONFLICT 不重试覆盖）、原子写（tmp+fsync+rename+readback）、
 *   损坏期 fail-closed（禁一切 mutation，恢复=显式 repair 成功 readback 后才清故障）。
 *
 * 【关联链】
 *   → storage_mod/storage.mjs getFilesSettingsPath（路径单源；⚠ 0722 排雷：只在函数内调用，
 *     禁模块顶层求值——storage 初始化前被读 = TDZ 崩全部插件）
 *   → scripts/safeJsonIO.mjs bakCorruptFile（损坏备份原语单源）
 *   → transport/isolateBridge.mjs isWorkerIsolate（零依赖叶子；worker isolate 拒写=主进程单写者）
 *   ← beilu-files/main.mjs、web_server/endpoints.mjs、security/commandGate.mjs、transport/ideClient.mjs
 *
 * 【影响范围】
 *   本模块上线后，插件/endpoint/commandGate/ideClient 不得再自行 parse/write 该 JSON；
 *   任何新写点必须走 mutate 族 API。锁语义=单进程内 promise 队列（写者全部在主 isolate；
 *   worker isolate mutate 直接抛 E_FILES_SETTINGS_WORKER_WRITE）。跨进程并发写不存在
 *   （Deno 单进程 owner）；原子 rename 仍兜底半截文件。
 *
 * 【文档形状 v2（迁移后仍兼容现有桶名）】
 *   { schemaVersion:2, revision:N,
 *     _global: { workspaceByOwner: { [owner]: { defaultRoot, byChatId:{[chatId]:root}, fromIDE? } },
 *               legacyUnassigned: { workspaceRoot?, workspaceRoots? },   // 旧无主根，运行时不自动授予（D6 §2.3）
 *               browsePolicy: { browseBases?: string[] } },
 *     commandGate: {...},
 *     [username]: { ...beilu-files 用户设置桶 } }
 *   旧格式（无 schemaVersion；_global.workspaceRoot/workspaceRoots 全局根）由 ensureMigrated
 *   一次性迁移：旧全局根 → _global.legacyUnassigned（B6 幽灵根从此离开运行时读路，盘上留档）。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { wbT, wbD } from "../../../../server/wbStub.mjs"; // 白盒：settings 单写者是 files 安全线的落盘轴，提交/CAS 冲突/损坏转移/repair 四事件可观测（D6 白盒补点）
import { bakCorruptFile } from "../../../../scripts/safeJsonIO.mjs";
import { getFilesSettingsPath } from "../memory/storage_mod/storage.mjs";
import { isWorkerIsolate } from "../../transport/isolateBridge.mjs";

const SCHEMA_VERSION = 2;
/** 顶层保留键（非用户桶）。_legacyShape=旧格式内存视图标记（_normalizeLegacyView 打、写前删除），
 *  必须在形状校验的用户桶枚举之外——否则旧格式一读即被误判损坏（契约测试实抓）。 */
const RESERVED_TOP_KEYS = new Set(["schemaVersion", "revision", "_global", "commandGate", "_legacyShape"]);

// ---- 健康故障态（单源；null=健康）----
// 一旦置位：mutate 族全拒（E_FILES_SETTINGS_*），消费方按各自 fail-closed 政策裁决；
// 只有 repair 成功 readback 才清（D6 §4「没有成功 readback 就不清健康故障」）。
let _health = null; // null | { state:"corrupt"|"unreadable", detail, backupPath, at }
/** 同一损坏现场只备份一次（按 mtime+size 指纹），防每次 readSnapshot 都刷一份 .bak。 */
let _lastCorruptSig = null;

// ---- 单一跨入口写锁（进程内 promise 队列）----
let _writeQueue = Promise.resolve();

// ---- 测试钩子：契约测试必须指向临时文件，绝不触碰真实 data/beilu-files-settings.json ----
let _pathOverrideForTest = null;
export function __setSettingsPathForTest(p) {
  _pathOverrideForTest = p || null;
  _health = null;
  _lastCorruptSig = null;
  _writeQueue = Promise.resolve();
}
function _settingsFile() {
  return _pathOverrideForTest || getFilesSettingsPath();
}

function _typedError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function _fileSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function _setHealth(state, detail, backupPath) {
  _health = { state, detail, backupPath: backupPath ?? null, at: new Date().toISOString() };
  wbD(null, "files", "settingsStore:health_fault", false, `设置文件${state === "corrupt" ? "损坏" : "不可读"}，进入 fail-closed`, { state, detail, backupPath: _health.backupPath });
  console.error(`[filesSettingsStore] ★ 设置文件${state === "corrupt" ? "损坏" : "不可读"}，进入 fail-closed（禁 mutation/根变更/browse，等显式 repair）：${detail}`);
  return _health;
}

/** 当前健康态（null=健康）。消费方据此 fail-closed，不得把故障伪装成"默认设置已生效"。 */
export function getSettingsHealth() {
  return _health;
}

/** 安全初始文档（ENOENT 首装；未持久化，首个 mutate 才落盘）。 */
function _initialDoc() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, _global: {} };
}

function _validateDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "文档必须是 JSON 对象";
  if (doc.schemaVersion !== SCHEMA_VERSION) return `schemaVersion 必须为 ${SCHEMA_VERSION}`;
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 0) return "revision 必须是非负整数";
  if (!doc._global || typeof doc._global !== "object" || Array.isArray(doc._global)) return "_global 必须是对象";
  if (doc.commandGate !== undefined && (typeof doc.commandGate !== "object" || doc.commandGate === null || Array.isArray(doc.commandGate))) return "commandGate 必须是对象";
  for (const [k, v] of Object.entries(doc)) {
    if (RESERVED_TOP_KEYS.has(k)) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) return `用户桶 ${k} 必须是对象`;
  }
  return null;
}

/**
 * 旧格式在内存中的读取视图归一（不落盘；落盘迁移走 ensureMigrated 的 mutate）。
 * 旧格式判据：无 schemaVersion。视图化：包上 schemaVersion/revision:0；
 * 旧全局根字段保留原位（运行时消费方一律不读它们——只有 legacyUnassigned 才是迁移后的家）。
 */
function _normalizeLegacyView(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.schemaVersion === undefined) {
    const { _global, ...rest } = raw;
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      _global: (_global && typeof _global === "object" && !Array.isArray(_global)) ? _global : {},
      ...rest,
      _legacyShape: true,
    };
  }
  return raw;
}

/**
 * 严格读 snapshot（同步；commandGate 等同步消费方依赖）。
 * - 不存在 → { ok:true, persisted:false, doc:安全初始 }（合法首装，不落盘）
 * - 健康故障已置位 → { ok:false, code, health }（fail-closed 持续到显式 repair）
 * - JSON 损坏 → 备份 .corrupt.<ts>.bak（同现场一次）+ 置健康故障 + { ok:false, code:"E_FILES_SETTINGS_CORRUPT" }
 * - 其他 IO 错 → 置健康故障 + { ok:false, code:"E_FILES_SETTINGS_UNREADABLE" }
 * @returns {{ok:boolean, code?:string, doc?:object, revision?:number, persisted?:boolean, health?:object|null}}
 */
export function readSnapshot() {
  const file = _settingsFile();
  if (_health) {
    return { ok: false, code: _health.state === "corrupt" ? "E_FILES_SETTINGS_CORRUPT" : "E_FILES_SETTINGS_UNREADABLE", health: _health };
  }
  let raw;
  try {
    if (!fs.existsSync(file)) {
      return { ok: true, persisted: false, doc: _initialDoc(), revision: 0, health: null };
    }
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    _setHealth("unreadable", e?.message || String(e), null);
    return { ok: false, code: "E_FILES_SETTINGS_UNREADABLE", health: _health };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    const sig = _fileSig(file);
    let bak = null;
    if (sig !== _lastCorruptSig) {
      bak = bakCorruptFile(file);
      _lastCorruptSig = sig;
    }
    _setHealth("corrupt", e?.message || String(e), bak);
    return { ok: false, code: "E_FILES_SETTINGS_CORRUPT", health: _health };
  }
  doc = _normalizeLegacyView(doc);
  const shapeErr = _validateDoc(doc);
  if (shapeErr) {
    const sig = _fileSig(file);
    let bak = null;
    if (sig !== _lastCorruptSig) {
      bak = bakCorruptFile(file);
      _lastCorruptSig = sig;
    }
    _setHealth("corrupt", `形状校验失败: ${shapeErr}`, bak);
    return { ok: false, code: "E_FILES_SETTINGS_CORRUPT", health: _health };
  }
  return { ok: true, persisted: true, doc, revision: doc.revision, health: null };
}

/** Windows rename 偶发 EPERM（AV/索引器短锁），有界重试；与 nicerWriteFile 同型语义（本模块自持防环）。 */
function _renameWithRetry(from, to, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (e?.code !== "EPERM" && e?.code !== "EACCES" && e?.code !== "EBUSY") throw e;
      const until = Date.now() + 15 * (i + 1);
      while (Date.now() < until) { /* 短自旋，锁内同步写路径 */ }
    }
  }
  throw lastErr;
}

function _atomicWriteAndReadback(file, doc) {
  const json = JSON.stringify(doc, null, 2);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp_${process.pid}_${Date.now()}`;
  fs.writeFileSync(tmp, json, "utf-8");
  let fd = null;
  try {
    fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  _renameWithRetry(tmp, file);
  // readback 校验：写后读回 parse + revision 一致才算提交成功（D6 §4 mutate 链尾）。
  const back = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (back?.revision !== doc.revision) {
    throw _typedError("E_FILES_SETTINGS_READBACK", `写后读回 revision 不一致（期望 ${doc.revision}，读到 ${back?.revision}）`);
  }
  return back;
}

/**
 * 单一 mutate 事务（D6 §4）：跨入口锁内 strictRead → schema validate → actor 授权 →
 * mutator → revision+1 → tmp+fsync+atomic rename → readback validate。
 * @param {number|null} expectedRevision - null=以锁内当前值为基线（同步原子，无 await 间隙）；
 *   数字=CAS，与当前 revision 不等抛 E_SETTINGS_REVISION_CONFLICT（附 currentRevision，不重试覆盖）。
 * @param {{kind:string, username?:string}} actor - 写者身份（审计+授权由包装 API 收窄）。
 * @param {(doc:object)=>void|object} mutator - 原地改 doc（禁改 schemaVersion/revision）。
 * @returns {Promise<{revision:number, doc:object}>}
 */
export async function mutate(expectedRevision, actor, mutator) {
  if (isWorkerIsolate) {
    throw _typedError("E_FILES_SETTINGS_WORKER_WRITE", "settings 单写者在主进程；worker isolate 禁写");
  }
  if (!actor || typeof actor.kind !== "string" || !actor.kind) {
    throw _typedError("E_FILES_SETTINGS_ACTOR_REQUIRED", "mutate 需要写者身份 actor");
  }
  const run = _writeQueue.then(async () => {
    const snap = readSnapshot();
    if (!snap.ok) {
      throw _typedError(snap.code, `设置文件${snap.code === "E_FILES_SETTINGS_CORRUPT" ? "损坏" : "不可读"}，已 fail-closed 禁止写入（需显式 repair）`, { health: snap.health });
    }
    const doc = structuredClone(snap.doc);
    delete doc._legacyShape;
    if (expectedRevision !== null && expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision)) {
        throw _typedError("E_SETTINGS_REVISION_INVALID", "expectedRevision 必须是整数或 null");
      }
      if (expectedRevision !== snap.revision) {
        wbD(null, "files", "settingsStore:cas_conflict", false, `revision 冲突：期望 ${expectedRevision}，当前 ${snap.revision}`, { actor: actor.kind, username: actor.username ?? null, expectedRevision, currentRevision: snap.revision });
        throw _typedError("E_SETTINGS_REVISION_CONFLICT", `revision 冲突：期望 ${expectedRevision}，当前 ${snap.revision}`, { currentRevision: snap.revision });
      }
    }
    const beforeRevision = doc.revision;
    await mutator(doc);
    if (doc.schemaVersion !== SCHEMA_VERSION || doc.revision !== beforeRevision) {
      throw _typedError("E_FILES_SETTINGS_MUTATOR_VIOLATION", "mutator 不得改 schemaVersion/revision（由事务推进）");
    }
    doc.revision = beforeRevision + 1;
    const shapeErr = _validateDoc(doc);
    if (shapeErr) throw _typedError("E_FILES_SETTINGS_SCHEMA", `写前形状校验失败: ${shapeErr}`);
    const persisted = _atomicWriteAndReadback(_settingsFile(), doc);
    wbT(null, "files", "settingsStore:mutate_commit", { actor: actor.kind, username: actor.username ?? null, revision: persisted.revision });
    return { revision: persisted.revision, doc: persisted };
  });
  // 队列失败后继续服务后续写者；本次调用方仍拿到自己的失败。
  _writeQueue = run.catch(() => {});
  return run;
}

// ============================================================
// 包装写口（授权收窄，全部经同一 mutate）
// ============================================================

function _requireUser(username, what) {
  const u = typeof username === "string" ? username.trim() : "";
  if (!u) throw _typedError("E_FILES_SETTINGS_OWNER_REQUIRED", `${what} 需要认证用户`);
  return u;
}

/** 只改该用户桶（beilu-files per-user 设置）。patch=对象浅覆盖或 mutator 函数。 */
export async function patchUserFilesSettings(authUser, patch, expectedRevision = null) {
  const u = _requireUser(authUser, "用户设置写入");
  return mutate(expectedRevision, { kind: "plugin", username: u }, (doc) => {
    const bucket = (doc[u] && typeof doc[u] === "object" && !Array.isArray(doc[u])) ? doc[u] : (doc[u] = {});
    if (typeof patch === "function") patch(bucket);
    else Object.assign(bucket, patch);
  });
}

/** 只改该 owner 的工作区 scope（D6 §2 owner 分区；chatId=null 写 defaultRoot）。root=null 删除该 scope。 */
export async function setWorkspaceScope(authUser, chatId, root, { fromIDE = false, expectedRevision = null } = {}) {
  const u = _requireUser(authUser, "工作区根写入");
  return mutate(expectedRevision, { kind: fromIDE ? "ide-bound" : "plugin", username: u }, (doc) => {
    if (!doc._global.workspaceByOwner || typeof doc._global.workspaceByOwner !== "object") doc._global.workspaceByOwner = {};
    const byOwner = doc._global.workspaceByOwner;
    const entry = (byOwner[u] && typeof byOwner[u] === "object") ? byOwner[u] : (byOwner[u] = { defaultRoot: "", byChatId: {} });
    if (!entry.byChatId || typeof entry.byChatId !== "object") entry.byChatId = {};
    const key = typeof chatId === "string" ? chatId.trim() : "";
    if (root === null || root === undefined || root === "") {
      if (key) delete entry.byChatId[key];
      else entry.defaultRoot = "";
    } else {
      if (typeof root !== "string") throw _typedError("E_WORKSPACE_ROOT_INVALID", "root 必须是字符串");
      if (key) entry.byChatId[key] = root;
      else entry.defaultRoot = root;
      if (fromIDE) entry.fromIDE = true;
    }
  });
}

/** 批量替换该 owner 的完整 workspace scope（插件持久化用：defaultRoot + byChatId 整块）。 */
export async function replaceOwnerWorkspace(authUser, { defaultRoot = "", byChatId = {}, fromIDE = false } = {}, expectedRevision = null) {
  const u = _requireUser(authUser, "工作区根写入");
  return mutate(expectedRevision, { kind: "plugin", username: u }, (doc) => {
    if (!doc._global.workspaceByOwner || typeof doc._global.workspaceByOwner !== "object") doc._global.workspaceByOwner = {};
    doc._global.workspaceByOwner[u] = {
      defaultRoot: typeof defaultRoot === "string" ? defaultRoot : "",
      byChatId: (byChatId && typeof byChatId === "object" && !Array.isArray(byChatId)) ? { ...byChatId } : {},
      ...(fromIDE ? { fromIDE: true } : {}),
    };
  });
}

/** commandGate 段写口（安全端点薄 adapter；owner 授权在路由层 requireOwner，此处记 actor）。 */
export async function patchCommandGate(ownerUsername, patchFn, expectedRevision = null) {
  const u = _requireUser(ownerUsername, "commandGate 写入");
  return mutate(expectedRevision, { kind: "owner-endpoint", username: u }, (doc) => {
    if (!doc.commandGate || typeof doc.commandGate !== "object") doc.commandGate = {};
    patchFn(doc.commandGate);
  });
}

/**
 * 旧格式一次性迁移（插件 Load 时调用；幂等）：
 * - 无 schemaVersion 的旧文档 → 打 v2 戳；
 * - 旧 _global.workspaceRoot/workspaceRoots（无可证明 owner）→ _global.legacyUnassigned，
 *   运行时读路从此不再消费（B6 幽灵根盘上归档，不自动授予任何登录用户，D6 §2.3）。
 * 文件不存在/已迁移 → 不落盘不动。健康故障时静默返回（等 repair）。
 */
export async function ensureMigrated() {
  const snap = readSnapshot();
  if (!snap.ok) return { migrated: false, health: snap.health };
  if (!snap.persisted) return { migrated: false, reason: "no_file" };
  const needsStamp = snap.doc._legacyShape === true;
  const g = snap.doc._global || {};
  const hasLegacyRoots = typeof g.workspaceRoot === "string" || (g.workspaceRoots && typeof g.workspaceRoots === "object");
  if (!needsStamp && !hasLegacyRoots) return { migrated: false, reason: "already_migrated" };
  const r = await mutate(null, { kind: "migration" }, (doc) => {
    const gg = doc._global;
    if (typeof gg.workspaceRoot === "string" || (gg.workspaceRoots && typeof gg.workspaceRoots === "object")) {
      const legacy = (gg.legacyUnassigned && typeof gg.legacyUnassigned === "object") ? gg.legacyUnassigned : {};
      if (typeof gg.workspaceRoot === "string" && legacy.workspaceRoot === undefined) legacy.workspaceRoot = gg.workspaceRoot;
      if (gg.workspaceRoots && typeof gg.workspaceRoots === "object" && legacy.workspaceRoots === undefined) legacy.workspaceRoots = gg.workspaceRoots;
      gg.legacyUnassigned = legacy;
      delete gg.workspaceRoot;
      delete gg.workspaceRoots;
    }
  });
  console.log(`[filesSettingsStore] 旧格式已迁移为 v2（revision=${r.revision}；旧全局根已归档 legacyUnassigned，不自动授予）`);
  return { migrated: true, revision: r.revision };
}

/** 旧无主根归属确认（owner 显式动作）：legacyUnassigned 整块迁入该 owner scope 后清空。 */
export async function adoptLegacyWorkspace(authUser, expectedRevision = null) {
  const u = _requireUser(authUser, "旧工作区根认领");
  return mutate(expectedRevision, { kind: "owner-adopt", username: u }, (doc) => {
    const legacy = doc._global.legacyUnassigned;
    if (!legacy || typeof legacy !== "object") {
      throw _typedError("E_WORKSPACE_LEGACY_EMPTY", "没有待认领的旧工作区根");
    }
    if (!doc._global.workspaceByOwner || typeof doc._global.workspaceByOwner !== "object") doc._global.workspaceByOwner = {};
    const byOwner = doc._global.workspaceByOwner;
    const entry = (byOwner[u] && typeof byOwner[u] === "object") ? byOwner[u] : (byOwner[u] = { defaultRoot: "", byChatId: {} });
    if (!entry.byChatId || typeof entry.byChatId !== "object") entry.byChatId = {};
    if (typeof legacy.workspaceRoot === "string" && legacy.workspaceRoot && !entry.defaultRoot) entry.defaultRoot = legacy.workspaceRoot;
    if (legacy.workspaceRoots && typeof legacy.workspaceRoots === "object") {
      for (const [cid, root] of Object.entries(legacy.workspaceRoots)) {
        if (typeof root === "string" && root && entry.byChatId[cid] === undefined) entry.byChatId[cid] = root;
      }
    }
    delete doc._global.legacyUnassigned;
  });
}

// ============================================================
// 显式修复（D6 §4：损坏后恢复只此一条路）
// ============================================================

/** 列出损坏备份（repair fromBackup 的候选来源）。 */
export function listCorruptBackups() {
  const file = _settingsFile();
  const dir = path.dirname(file);
  const base = path.basename(file);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.corrupt.`) && f.endsWith(".bak"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 显式 owner 修复：提交经 schema 校验的完整 replacement，或指定已列出的损坏备份，
 * 或 revalidate（重新严格读现文件——外部工具已手工修好时用）。
 * 成功 readback 后才清健康故障；期间任何失败都保持 fail-closed。
 * @param {{username:string}} actor
 * @param {{replacement?:object, fromBackup?:string, revalidate?:boolean}} source
 */
export async function repair(actor, { replacement, fromBackup, revalidate } = {}) {
  const u = _requireUser(actor?.username, "settings 修复");
  if (isWorkerIsolate) throw _typedError("E_FILES_SETTINGS_WORKER_WRITE", "settings 修复只能在主进程执行");
  const run = _writeQueue.then(async () => {
    const file = _settingsFile();
    let doc;
    if (replacement !== undefined) {
      doc = structuredClone(replacement);
    } else if (typeof fromBackup === "string" && fromBackup) {
      const base = path.basename(_settingsFile());
      if (!fromBackup.startsWith(`${base}.corrupt.`) || !fromBackup.endsWith(".bak") || fromBackup.includes("/") || fromBackup.includes("\\") || fromBackup.includes("..")) {
        throw _typedError("E_FILES_SETTINGS_REPAIR_SOURCE", "fromBackup 必须是已列出的损坏备份文件名");
      }
      const bakPath = path.join(path.dirname(file), fromBackup);
      if (!fs.existsSync(bakPath)) throw _typedError("E_FILES_SETTINGS_REPAIR_SOURCE", `备份不存在: ${fromBackup}`);
      doc = JSON.parse(fs.readFileSync(bakPath, "utf-8"));
    } else if (revalidate === true) {
      doc = JSON.parse(fs.readFileSync(file, "utf-8"));
    } else {
      throw _typedError("E_FILES_SETTINGS_REPAIR_SOURCE", "repair 需要 replacement / fromBackup / revalidate 之一");
    }
    doc = _normalizeLegacyView(doc);
    delete doc._legacyShape;
    if (!Number.isSafeInteger(doc.revision)) doc.revision = 0;
    if (doc.schemaVersion === undefined) doc.schemaVersion = SCHEMA_VERSION;
    if (!doc._global || typeof doc._global !== "object" || Array.isArray(doc._global)) doc._global = {};
    doc.revision = doc.revision + 1;
    const shapeErr = _validateDoc(doc);
    if (shapeErr) throw _typedError("E_FILES_SETTINGS_SCHEMA", `repair 提交内容校验失败: ${shapeErr}`);
    const persisted = _atomicWriteAndReadback(file, doc);
    // 成功 readback → 清健康故障（唯一清除点）。
    _health = null;
    _lastCorruptSig = null;
    wbT(null, "files", "settingsStore:repair_success", { by: u, revision: persisted.revision, source: replacement !== undefined ? "replacement" : (fromBackup ? "fromBackup" : "revalidate") });
    console.log(`[filesSettingsStore] repair 成功（by ${u}，revision=${persisted.revision}），健康故障已清除`);
    return { repaired: true, revision: persisted.revision };
  });
  _writeQueue = run.catch(() => {});
  return run;
}

// ============================================================
// 只读视图（消费方专用；永不写、永不抛——损坏时按各自 fail-closed 语义返回）
// ============================================================

/** commandGate 段视图：{ commandGate, health, revision }。损坏→commandGate:null（消费方按最严默认裁决）。 */
export function getCommandGateView() {
  const snap = readSnapshot();
  if (!snap.ok) return { commandGate: null, health: snap.health, revision: null };
  const g = snap.doc.commandGate;
  return { commandGate: (g && typeof g === "object") ? g : {}, health: null, revision: snap.revision };
}

/**
 * 用户 permissions 键视图（ideClient readFilesPermission 消费）。
 * 健康：user 桶 → _default 桶 → def。损坏/不可读：恒 false（fail-closed，宽默认不救场）。
 */
export function getFilesPermissionView(username, key, def = true) {
  const snap = readSnapshot();
  if (!snap.ok) return false;
  const v = snap.doc?.[username]?.permissions?.[key]
    ?? snap.doc?._default?.permissions?.[key];
  return typeof v === "boolean" ? v : def;
}

/** workspace owner 分区视图：{ workspaceByOwner, legacyUnassigned, browsePolicy, health, revision }。 */
export function getWorkspaceView() {
  const snap = readSnapshot();
  if (!snap.ok) return { workspaceByOwner: {}, legacyUnassigned: null, browsePolicy: {}, health: snap.health, revision: null };
  const g = snap.doc._global || {};
  return {
    workspaceByOwner: (g.workspaceByOwner && typeof g.workspaceByOwner === "object") ? g.workspaceByOwner : {},
    legacyUnassigned: (g.legacyUnassigned && typeof g.legacyUnassigned === "object") ? g.legacyUnassigned : null,
    browsePolicy: (g.browsePolicy && typeof g.browsePolicy === "object") ? g.browsePolicy : {},
    health: null,
    revision: snap.revision,
  };
}

/** 某 owner 的生效根（byChatId 精确 → defaultRoot → ""）。损坏/无 owner → ""（诚实降级，不猜根）。 */
export function getOwnerWorkspaceRoot(owner, chatId = null) {
  if (!owner) return "";
  const view = getWorkspaceView();
  if (view.health) return "";
  const entry = view.workspaceByOwner[owner];
  if (!entry || typeof entry !== "object") return "";
  if (chatId && entry.byChatId && typeof entry.byChatId === "object" && typeof entry.byChatId[chatId] === "string") {
    return entry.byChatId[chatId];
  }
  return typeof entry.defaultRoot === "string" ? entry.defaultRoot : "";
}

// ============================================================
// root / browse 统一政策（D6 §2.2 + §3：C 盘/系统卷/blocked 祖先五入口同拒）
// ============================================================

function _projectRoot() {
  // 路径单源锚：settings 文件路径 = <projectRoot>/data/beilu-files-settings.json
  return path.dirname(path.dirname(getFilesSettingsPath()));
}

function _normKey(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function _isUnder(child, parent) {
  const c = _normKey(child);
  const p = _normKey(parent);
  if (!p) return false;
  return c === p || c.startsWith(p + "/");
}

function _isDriveRoot(p) {
  return /^[a-z]:$/i.test(_normKey(p)) || _normKey(p) === "";
}

function _systemDriveKey() {
  const sd = (process.env.SystemDrive || "C:").replace(/\\/g, "/");
  return _normKey(sd);
}

/**
 * 浏览/选根基（browseBases）：browsePolicy.browseBases（用户可配，store 内）优先；
 * 缺省 = 项目根 + 全部非系统盘固定盘符根（Windows）/ 用户主目录（POSIX）。
 * 系统盘（默认 C:）永不入基——"C:/ 永远拒"在此结构性成立，而装在 C 盘的部署仍经
 * 项目根基获得自己的玩耍空间（应用锚定例外，D6 §2.2 application base）。
 */
export function listBrowseBases() {
  const view = getWorkspaceView();
  const configured = Array.isArray(view.browsePolicy?.browseBases)
    ? view.browsePolicy.browseBases.filter((b) => typeof b === "string" && b.trim())
    : null;
  if (configured && configured.length) return configured.map((b) => path.resolve(b));
  const bases = [_projectRoot()];
  if (process.platform === "win32") {
    const sys = _systemDriveKey();
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:`;
      if (_normKey(drive) === sys) continue;
      try {
        if (fs.existsSync(drive + "\\")) bases.push(drive + "\\");
      } catch { /* 盘符探测失败=不入基 */ }
    }
  } else {
    try {
      const home = process.env.HOME || "";
      if (home) bases.push(home);
    } catch { /* ignore */ }
  }
  return bases;
}

/** 应用敏感目录（root/browse 永拒；应用自身与数据/密钥域）。 */
function _appSensitiveDirs() {
  const root = _projectRoot();
  return [root ? path.join(root, "data") : "", root ? path.join(root, "src") : "", root ? path.join(root, ".git") : ""].filter(Boolean);
}

/** 系统敏感目录判定（绝对路径段级）：Windows 系统目录 / AppData / 密钥目录。 */
function _hitsSystemSensitive(absPath) {
  const key = "/" + _normKey(absPath).replace(/^[a-z]:/, "");
  const segs = ["/windows/", "/program files/", "/program files (x86)/", "/programdata/", "/appdata/", "/.ssh/", "/.gnupg/"];
  for (const s of segs) {
    if (key.includes(s) || key.endsWith(s.slice(0, -1))) return s.replace(/\//g, "");
  }
  return null;
}

function _policyDeny(code, error) {
  return { ok: false, code, error };
}

/**
 * 统一政策链（root 候选与 browse 共用；差异只在末端约束）。
 * 步骤：锚定解析（相对→项目根，不锚 Deno.cwd）→ realpath（允许一层未创建）→
 *   基包含（browseBases）→ 系统卷/应用敏感 → blockedPaths deny-overrides（不可被显式选根覆盖）。
 * @returns {{ok:true, path:string, parentReal:string, exists:boolean} | {ok:false, code, error}}
 */
function _resolvePolicyPath(requestedPath, { userBlockedPaths = [], allowCreateLeaf = false, codes }) {
  if (!requestedPath || typeof requestedPath !== "string") {
    return _policyDeny(codes.invalid, "路径不能为空");
  }
  let abs = requestedPath;
  if (!path.isAbsolute(abs)) abs = path.resolve(_projectRoot(), abs);
  else abs = path.resolve(abs);

  // realpath：存在→取物理路径（链接逃逸在物理域裁决）；不存在→允许一层创建（父必须真实存在）。
  let real = null;
  let exists = false;
  try {
    real = fs.realpathSync(abs);
    exists = true;
  } catch {
    if (!allowCreateLeaf) return _policyDeny(codes.invalid, `路径不存在: ${requestedPath}`);
    const parent = path.dirname(abs);
    let parentReal;
    try {
      parentReal = fs.realpathSync(parent);
    } catch {
      return _policyDeny(codes.invalid, `路径及其父目录均不存在，拒绝创建幽灵目录: ${requestedPath}`);
    }
    real = path.join(parentReal, path.basename(abs));
    exists = false;
  }

  if (_isDriveRoot(real)) {
    // 盘符根本身可作 browse 基（列举），但不可作工作区根（由调用方 allowDriveRoot 区分）。
    if (!codes.allowDriveRoot) return _policyDeny(codes.system, `盘符根不可作为目标: ${requestedPath}`);
  }

  // 基包含（浏览/选根都必须落在 browseBases 之下；系统盘不在基 → C:/ 域结构性拒绝）。
  const bases = listBrowseBases();
  const inBase = bases.some((b) => _isUnder(real, b));
  if (!inBase) return _policyDeny(codes.scope, `路径不在允许的浏览/工作区基内: ${requestedPath}`);

  // 系统卷敏感目录 + 应用自身目录（项目根本体/data/src/.git）。
  const sysHit = _hitsSystemSensitive(real);
  if (sysHit) return _policyDeny(codes.system, `安全策略：禁止访问系统/敏感目录 (${sysHit})`);
  const proot = _projectRoot();
  if (_normKey(real) === _normKey(proot)) return _policyDeny(codes.system, "应用自身根目录不可作为目标");
  for (const d of _appSensitiveDirs()) {
    if (_isUnder(real, d)) return _policyDeny(codes.system, `应用数据/源码目录不可作为目标: ${requestedPath}`);
  }

  // blockedPaths：deny-overrides，根/祖先一律生效，不允许"显式选根"覆盖（D6 §3.4）。
  // 唯一收窄=部署锚定例外：条目本身覆盖【项目根的祖先】（如默认 C:/ 而应用装在 C 盘）时，
  //   该条目对项目根基内部不生效——那是部署位置事实，不是用户选根覆盖；项目根基之外照拒。
  const realKey = _normKey(real);
  for (const bp of userBlockedPaths || []) {
    if (!bp || typeof bp !== "string") continue;
    const bpAbs = path.isAbsolute(bp) ? path.resolve(bp) : path.resolve(_projectRoot(), bp);
    const bpKey = _normKey(bpAbs);
    const hit = realKey === bpKey || realKey.startsWith(bpKey + "/") || (bpKey.endsWith(":") && realKey.startsWith(bpKey));
    if (!hit) continue;
    if (_isUnder(proot, bpAbs) && _isUnder(real, proot)) continue; // 部署锚定例外（仅项目根基内）
    return _policyDeny(codes.blocked, `安全策略：该路径在禁止清单内 (${bp})`);
  }

  return { ok: true, path: real, exists };
}

/**
 * 工作区根候选统一校验（D6 §2.2）：根建立、配置读回、每 chat root、IDE 确认、默认根创建共用。
 * 被禁的系统盘或其祖先永远拒绝，不允许"用户显式选根"覆盖。
 * @returns {{ok:true, root:string, exists:boolean} | {ok:false, code, error}}
 */
export function resolveWorkspaceRootCandidate(owner, requestedPath, { userBlockedPaths = [] } = {}) {
  if (!owner) return _policyDeny("E_WORKSPACE_ROOT_OWNER", "工作区根需要认证 owner");
  const r = _resolvePolicyPath(requestedPath, {
    userBlockedPaths,
    allowCreateLeaf: true,
    codes: {
      invalid: "E_WORKSPACE_ROOT_INVALID",
      scope: "E_WORKSPACE_ROOT_SCOPE",
      system: "E_WORKSPACE_ROOT_SYSTEM",
      blocked: "E_WORKSPACE_ROOT_BLOCKED",
      allowDriveRoot: false,
    },
  });
  if (!r.ok) return r;
  if (r.exists) {
    try {
      if (!fs.statSync(r.path).isDirectory()) return _policyDeny("E_WORKSPACE_ROOT_INVALID", `工作区根不是目录: ${requestedPath}`);
    } catch (e) {
      return _policyDeny("E_WORKSPACE_ROOT_INVALID", `工作区根不可访问: ${e?.message || e}`);
    }
  }
  return { ok: true, root: r.path, exists: r.exists };
}

/**
 * browse 列举目标统一校验（D6 §3.3）：只列目录元数据的受限动作，须 grant（grant 生命周期
 * 在 beilu-files 插件内），路径本身在此按同一政策链裁决。盘符根（非系统盘）可列举。
 * @returns {{ok:true, path:string} | {ok:false, code, error}}
 */
export function resolveBrowseListingTarget(owner, requestedPath, { userBlockedPaths = [] } = {}) {
  if (!owner) return _policyDeny("E_BROWSE_SCOPE", "browse 需要认证 owner");
  const r = _resolvePolicyPath(requestedPath, {
    userBlockedPaths,
    allowCreateLeaf: false,
    codes: {
      invalid: "E_BROWSE_SCOPE",
      scope: "E_BROWSE_SCOPE",
      system: "E_BROWSE_SYSTEM_VOLUME",
      blocked: "E_BROWSE_BLOCKED",
      allowDriveRoot: true,
    },
  });
  if (!r.ok) return r;
  try {
    const st = fs.statSync(r.path);
    if (!st.isDirectory()) return _policyDeny("E_BROWSE_SCOPE", "browse 只能列目录");
  } catch (e) {
    return _policyDeny("E_BROWSE_SCOPE", `目录不可访问: ${e?.message || e}`);
  }
  return { ok: true, path: r.path };
}
