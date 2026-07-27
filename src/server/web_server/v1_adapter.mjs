/**
 * v1_adapter.mjs — v1 API 转接器层
 *
 * 职责：
 *   1. 操作分级（L0 只读 / L1 写 / L2 危险写 / L3 系统级）
 *   2. 统一委托到内部模块（走完整链路，不直接 fs 操作）
 *   3. 错误包装（不泄露内部路径）
 *   4. 来源标记（sourceChannel 注入）
 *
 * 设计原则：
 *   - router 只做路由 + 认证 + confirm 门
 *   - adapter 做业务逻辑委托
 *   - 外部消费方不知道内部模块结构
 */

import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../scripts/nicerWriteFile.mjs"; // [0716 断电安全] 原子写单源
import { wbTrace, wbDetect } from "../whitebox.mjs";
import { confineSegment } from "../../yonban/core/functions/security/path_confine.mjs";
import { events } from "../events.mjs";

// ============================================================
// v1 可调常量（单一数据源，所有 v1 模块引用此处）
// ============================================================
export const V1_CONST = {
  SANITIZE_MAX_LEN: 4000,
  SANITIZE_SENDER_MAX: 64,
  DELEGATE_USER_MSG_MAX: 800,
  DELEGATE_CONTEXT_ENTRIES: 6,
  DELEGATE_CONTEXT_ENTRY_MAX: 120,
  DELEGATE_EXTERNAL_MAX_ROUNDS: 5,
  RATE_LIMIT_DEFAULT_PER_MIN: 120,
  RATE_LIMIT_WINDOW_MS: 60000,
  CHAT_SEND_DEFAULT_TIMEOUT: 60000,
  CHAT_SEND_MAX_TIMEOUT: 300000,
  GEN_CONCURRENCY_DEFAULT_MAX: 10,
};

let _projectRoot = null;
async function getProjectRoot() {
  if (_projectRoot) return _projectRoot;
  const { __projectRoot } = await import("../../yonban/core/functions/memory/storage_mod/storage.mjs"); // T8·回切：改指 yonban 新位实现体（T3e memory 已入住）
  _projectRoot = __projectRoot;
  return _projectRoot;
}

let _setDataMod = null;
async function getSetDataActions() {
  if (_setDataMod) return _setDataMod;
  const root = await getProjectRoot();
  const { pathToFileURL } = await import("node:url");
  const p = path.join(root, "src", "public", "parts", "plugins", "beilu-memory", "lib", "setDataActions.mjs");
  _setDataMod = await import(pathToFileURL(p).href);
  return _setDataMod;
}

function wrapError(e) {
  const msg = e?.message || String(e);
  return msg.replace(/[A-Z]:\\[^\s]*/gi, "[path]").replace(/\/[^\s]*\.(mjs|ts|js)/gi, "[module]");
}

// ============================================================
// 角色卡操作
// ============================================================

export async function getCharacterList(username) {
  const root = await getProjectRoot();
  const charsDir = path.join(root, "data", "users", username, "chars");
  if (!fs.existsSync(charsDir)) return [];
  return fs.readdirSync(charsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== "_global")
    .map(d => d.name);
}

export async function getCharacterDetail(username, charName) {
  const safe = confineSegment(charName);
  if (!safe) throw new Error("invalid name");
  const root = await getProjectRoot();
  const charDir = path.join(root, "data", "users", username, "chars", safe);
  if (!fs.existsSync(charDir)) return null;
  const entries = fs.readdirSync(charDir, { withFileTypes: true });
  return { name: safe, files: entries.filter(e => e.isFile()).map(e => e.name), dirs: entries.filter(e => e.isDirectory()).map(e => e.name) };
}

export async function createCharacter(username, charData) {
  const safe = confineSegment(charData.name);
  if (!safe) throw new Error("invalid name");
  const root = await getProjectRoot();
  const charDir = path.join(root, "data", "users", username, "chars", safe);
  if (fs.existsSync(charDir)) throw Object.assign(new Error("character already exists"), { status: 409 });
  fs.mkdirSync(charDir, { recursive: true });
  const data = { name: safe, description: charData.description || "", personality: charData.personality || "", scenario: charData.scenario || "", first_mes: charData.first_mes || "", mes_example: charData.mes_example || "" };
  try {
    // [0716 断电安全] 原子写收口（凛倾日常因素审计：直写断电=半写损坏）
    nicerWriteFileSync(path.join(charDir, "chardata.json"), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    try { fs.rmSync(charDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  wbTrace(null, "v1_adapter", "createCharacter", { username, charName: safe });
  return safe;
}

export async function updateCharacter(username, charName, updates) {
  const safe = confineSegment(charName);
  if (!safe) throw new Error("invalid name");
  const root = await getProjectRoot();
  const chardataPath = path.join(root, "data", "users", username, "chars", safe, "chardata.json");
  if (!fs.existsSync(chardataPath)) return null;
  const chardata = JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
  for (const [k, v] of Object.entries(updates)) if (v !== undefined) chardata[k] = v;
  // [0716 断电安全] 原子写收口：原直写覆盖，断电半写=角色卡损坏且旧内容全失
  nicerWriteFileSync(chardataPath, JSON.stringify(chardata, null, 2), "utf-8");
  wbTrace(null, "v1_adapter", "updateCharacter", { username, charName: safe });
  return chardata;
}

export async function exportCharacter(username, charName) {
  const safe = confineSegment(charName);
  if (!safe) throw new Error("invalid name");
  const root = await getProjectRoot();
  const chardataPath = path.join(root, "data", "users", username, "chars", safe, "chardata.json");
  if (!fs.existsSync(chardataPath)) return null;
  return JSON.parse(fs.readFileSync(chardataPath, "utf-8"));
}

// ============================================================
// 记忆操作（委托 setDataActions）
// ============================================================

export async function memoryAction(username, charId, action, params = {}) {
  const mod = await getSetDataActions();
  if (typeof mod.handleSetData !== "function") throw new Error("memory module not available");
  try {
    return await mod.handleSetData({ _action: action, ...params }, { username, char_id: charId || "_global" });
  } catch (e) {
    throw new Error(wrapError(e));
  }
}

// ============================================================
// 世界书操作（委托 beilu-worldbook 插件）
// ============================================================

let _wbPluginCache = new Map();
export async function loadWorldbookPlugin(username) {
  if (_wbPluginCache.has(username)) return _wbPluginCache.get(username);
  const { loadPart } = await import("../parts_loader.mjs");
  const wb = await loadPart(username, "plugins/beilu-worldbook");
  _wbPluginCache.set(username, wb);
  return wb;
}

// 改名/删号缓存失效：_wbPluginCache 按 username 键持 worldbook part 引用（FullProxy 捕获旧用户名），
//   删号/改名后不清 → 旧键残留（内存泄漏 + 改名后新名首访重建、旧名条目变悬挂）。与 event_dispatcher /
//   parts_router / setting_loader 的同族缓存清扫对齐（那些已有此闸，此处半接补齐）。
events.on("AfterUserDeleted", ({ username }) => {
  _wbPluginCache.delete(username);
});
events.on("AfterUserRenamed", ({ oldUsername }) => {
  _wbPluginCache.delete(oldUsername);
});

export async function getWorldbooks(username) {
  const wb = await loadWorldbookPlugin(username);
  // [0719 错桶修·病族] worldbook GetData 读第一参 ctx.username 分桶（T074）——漏传=读 _default 桶
  const data = wb.interfaces?.config?.GetData?.({ username }) || {};
  return data.worldbooks || data.books || [];
}

export async function getWorldbookEntries(username, bookName) {
  const books = await getWorldbooks(username);
  const book = books.find(b => (b.name || b.id) === bookName);
  return book ? (book.entries || []) : null;
}

export async function worldbookAction(username, bookName, action, params = {}) {
  const wb = await loadWorldbookPlugin(username);
  if (!wb.interfaces?.config?.SetData) throw new Error("worldbook SetData not available");
  try {
    // [0719 错桶修·病族] worldbook SetData 读第二参 ctx.username——漏传=写 _default 桶
    const result = await wb.interfaces.config.SetData({ _action: action, bookName, ...params }, { username });
    _wbPluginCache.delete(username);
    return result;
  } catch (e) {
    throw new Error(wrapError(e));
  }
}

// ============================================================
// 对话操作（委托 beilu-chat 模块）
// ============================================================

let _chatModule = null;
export async function getChatModule() {
  if (_chatModule) return _chatModule;
  const root = await getProjectRoot();
  const { pathToFileURL } = await import("node:url");
  const chatPath = path.join(root, "src", "public", "parts", "shells", "beilu-chat", "src", "chat.mjs");
  _chatModule = await import(pathToFileURL(chatPath).href);
  return _chatModule;
}

export async function isChatOwner(chatId, username) {
  if (!username) return false;
  const chat = await getChatModule();
  const metas = chat.getChatMetadatas();
  let meta = metas.get(chatId);
  if (!meta) { try { await chat.loadChat(chatId); } catch (e) { console.warn(`[v1_adapter] isChatOwner loadChat(${chatId}) 失败:`, e?.message || e); /* T021 留痕：探测性加载，失败按非属主处理；磁盘错会误判 403，留痕可溯 */ } meta = metas.get(chatId); }
  return !!meta && meta.username === username;
}

// ============================================================
// Scope 定义单一数据源
// ============================================================

export const AVAILABLE_SCOPES = [
  { value: "*", label: "全权限", group: "全局" },
  { value: "chat:read", label: "读取对话", group: "聊天" },
  { value: "chat:send", label: "发送消息/触发 AI", group: "聊天" },
  { value: "chat:raw", label: "raw_send（跳过输入消毒）", group: "聊天" },
  { value: "characters:read", label: "读取角色", group: "角色" },
  { value: "characters:write", label: "创建/更新/删除角色", group: "角色" },
  { value: "variables:read", label: "读取变量", group: "变量" },
  { value: "variables:write", label: "写入变量", group: "变量" },
  { value: "memory:read", label: "读取记忆", group: "记忆" },
  { value: "memory:write", label: "写入记忆/归档/快照", group: "记忆" },
  { value: "presets:read", label: "读取预设/注入", group: "预设" },
  { value: "presets:write", label: "修改预设/注入", group: "预设" },
  { value: "worldbook:read", label: "读取世界书", group: "世界书" },
  { value: "worldbook:write", label: "修改世界书", group: "世界书" },
  { value: "tools:list", label: "列出工具", group: "工具" },
  { value: "tools:exec", label: "执行工具", group: "工具" },
  { value: "webhooks:read", label: "读取 Webhook", group: "Webhook" },
  { value: "webhooks:write", label: "管理 Webhook", group: "Webhook" },
  { value: "regex:read", label: "读取正则规则", group: "正则" },
  { value: "regex:write", label: "修改正则规则", group: "正则" },
];

// 危险操作 confirm 描述（单一数据源，i18n 后续可替换）
export const DANGEROUS_OPS = {
  "memory/archive": "归档操作会将记忆条目从 hot→warm 或 warm→cold 迁移，此操作不可简单撤销",
  "chat/delete": "删除对话将永久移除该对话及所有消息",
  "presets/write": "修改预设会改变 AI 的行为规则",
  "injections/write": "修改注入提示词会改变 AI 的行为规则",
};

export { wrapError };
