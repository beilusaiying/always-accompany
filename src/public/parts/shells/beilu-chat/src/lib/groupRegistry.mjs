/**
 * 多组并行 v4 · 阶段0 地基 —— groupId 组注册表 + chatid→groupId 映射
 *
 * 一组(group) = 一条并行线 = 一个项目，组内一角色一常驻窗口(chatid)。
 * 注册表是 worker 网关路由(chatid→groupId→worker)与广播按组 scope 的单一权威源。
 *
 * 持久化：<userDir>/work/groups/registry.json
 *   { [groupId]: { projectName, workspaceRoot, workerId, roles: { [role]: chatid }, status } }
 *
 * 复用现状：getUserDictionary(auth)、loadJsonFileIfExists/saveJsonFile(json_loader)、
 *           chatid 既有隔离键体系；本模块只在其上加 groupId 一层命名空间。
 */

import fs from "node:fs";
import crypto from "node:crypto";

import {
  loadJsonFileIfExists,
  saveJsonFile,
} from "../../../../../../scripts/json_loader.mjs";
import { getUserDictionary } from "../../../../../../yonban/core/functions/security/auth.mjs";
import { wbT, wbD } from "../../../../../../server/wbStub.mjs";

// 单一权威源 = 磁盘文件；内存仅作读缓存，每次写回时刷新。
/** @type {Map<string, Record<string, GroupEntry>>} */
const _cache = new Map();

/**
 * @typedef {object} GroupEntry
 * @property {string} projectName
 * @property {string} workspaceRoot
 * @property {string|null} workerId
 * @property {Record<string, string>} roles  role → chatid
 * @property {string} status  "idle" | "running" | "stopped"
 */

function registryPath(username) {
  return getUserDictionary(username) + "/work/groups/registry.json";
}

/** 读注册表（带内存缓存）。返回的是缓存引用，调用方不应直接改写——用本模块写函数。 */
export function getGroupRegistry(username) {
  if (_cache.has(username)) return _cache.get(username);
  const reg = loadJsonFileIfExists(registryPath(username), {});
  _cache.set(username, reg);
  return reg;
}

/** 写回磁盘 + 刷新缓存。确保 work/groups/ 目录存在（nicerWriteFileSync 不建父目录）。 */
function persist(username, reg) {
  const file = registryPath(username);
  try {
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    saveJsonFile(file, reg);
  } catch (_pErr) {
    wbD(null, "group", "registry:persistFail", false, _pErr?.message || String(_pErr), { username, groupCount: Object.keys(reg || {}).length });
    throw _pErr;
  }
  _cache.set(username, reg);
  _notifyRuntimeUpdate(username);
}

// F4 组运行态推送 producer：注册表任何落库（建组/状态/角色绑定）都广播一次，
// 前端 groupRuntimePanel 即时刷新（不变式4 推送优先，4s 轮询降级为兜底）。
// 懒 import 防循环依赖；广播失败不影响落库。
function _notifyRuntimeUpdate(username) {
  import("./broadcast.mjs")
    .then((m) => m.broadcastAllChatUi?.({ type: "group_runtime_update", payload: { username } }, username))
    .catch(() => {});
}

/**
 * 新建组并落库，返回 groupId。
 * @returns {string} groupId
 */
export function createGroup(username, { projectName = "", workspaceRoot = "" } = {}) {
  const reg = getGroupRegistry(username);
  const groupId = "group-" + crypto.randomUUID().slice(0, 8);
  reg[groupId] = {
    projectName,
    workspaceRoot,
    workerId: null,
    roles: {},
    status: "idle",
  };
  persist(username, reg);
  wbT(null, "group", "registry:createGroup", { username, groupId, projectName });
  return groupId;
}

/** 删组。返回是否删除了已存在的组。 */
export function removeGroup(username, groupId) {
  const reg = getGroupRegistry(username);
  if (!reg[groupId]) return false;
  delete reg[groupId];
  persist(username, reg);
  return true;
}

/** 合并更新组的字段（projectName/workspaceRoot/workerId/status），roles 用 setGroupRole 改。 */
export function updateGroup(username, groupId, patch = {}) {
  const reg = getGroupRegistry(username);
  const g = reg[groupId];
  if (!g) return false;
  for (const k of ["projectName", "workspaceRoot", "workerId", "status"])
    if (k in patch) g[k] = patch[k];
  persist(username, reg);
  return true;
}

/**
 * 把某 chatid 绑到组内某角色（建立 chatid→groupId 映射的正向源）。
 * 同一 chatid 若已属别组的某角色，先从旧绑定摘除（一个 chatid 只属一组）。
 */
export function setGroupRole(username, groupId, role, chatid) {
  const reg = getGroupRegistry(username);
  if (!reg[groupId]) return false;
  // 防覆盖：该角色名已绑了另一个 chatid 时拒绝，避免 Map 键冲突静默丢失旧绑定
  const existing = reg[groupId].roles[role];
  if (existing && existing !== chatid) {
    throw new Error(`角色名 "${role}" 已绑定到对话 ${existing}，请换一个角色名或先解绑`);
  }
  // 摘除该 chatid 在任意组的旧角色绑定
  for (const g of Object.values(reg))
    for (const [r, cid] of Object.entries(g.roles))
      if (cid === chatid) delete g.roles[r];
  reg[groupId].roles[role] = chatid;
  persist(username, reg);
  wbT(null, "group", "registry:setGroupRole", { username, groupId, role, chatid });
  return true;
}

/** 解绑组内某角色。 */
export function clearGroupRole(username, groupId, role) {
  const reg = getGroupRegistry(username);
  if (!reg[groupId]?.roles?.[role]) return false;
  delete reg[groupId].roles[role];
  persist(username, reg);
  return true;
}

/**
 * chatid → groupId 反查（广播 scope / 网关路由用）。
 * @returns {string|null} groupId，未绑定返回 null
 */
export function getGroupIdByChatId(username, chatid) {
  const reg = getGroupRegistry(username);
  for (const [groupId, g] of Object.entries(reg))
    for (const cid of Object.values(g.roles))
      if (cid === chatid) return groupId;
  return null;
}

/**
 * 取组内全部 chatid（广播按组过滤用）。
 * @returns {string[]}
 */
export function getGroupChatIds(username, groupId) {
  const reg = getGroupRegistry(username);
  const g = reg[groupId];
  return g ? Object.values(g.roles) : [];
}

/** 取组条目（含 workspaceRoot/workerId/status，网关路由用）。 */
export function getGroup(username, groupId) {
  return getGroupRegistry(username)[groupId] || null;
}

/** 测试/重载用：丢弃内存缓存，下次读强制回磁盘。 */
export function invalidateGroupCache(username) {
  if (username == null) _cache.clear();
  else _cache.delete(username);
}
