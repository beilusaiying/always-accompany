import { wbT, wbD } from "../../../../server/wbStub.mjs" // T3a·3.10: 新位 4 级;
/**
 * tableSnapshot.mjs — 轻量表格快照（<tableEdit> 执行前自动备份，供精准回档）
 *
 * 功能链：replyHandler → saveTableSnapshot(tables, chatId, messageIndex) → 内存环形缓冲 + 写盘
 *         replyHandler / rollbackHandler → restoreTableSnapshot(chatId, messageIndex) → 返回 tables 深拷贝
 * why：AI 批量执行 <tableEdit> 前需逐消息记录表格快照，当某条消息触发的改动出错时可按 chatId+messageIndex 精准回滚，
 *      比全量 snapshot.mjs 开销更小，专为实时回档场景设计。
 * 关联链：
 *   ← replyHandler（tableEdit 执行前调用 saveTableSnapshot）
 *   → storage.mjs（ensureMemoryDir，取 hot/ 路径）
 *   → nicerWriteFile.mjs（nicerWriteFileSync 原子写单源，0716 收口）
 *   → snapshot.mjs（互补，全量保险层）
 * 影响范围：写 memory/{charName}/hot/_table_snapshots.json（环形，最多 50 条，覆盖最旧）
 * 使用效果：内存缓存（snapshotCache Map）+ 文件持久化双保险；进程重启后仍可从文件恢复
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs" // T3a·3.10: 新位 4 级; // 0716 收口：原子写单源（原 renameSyncWithRetry+内联 tmp）
import { diag, ensureMemoryDir } from "../memory/storage_mod/storage.mjs"; // T8·回切：改组内引用（T3a·3.10 暂指旧位壳的欠账，T3e memory 已入住）


/**
 * 内存缓存：username/charName -> 快照数组
 * @type {Map<string, Array<TableSnapshotEntry>>}
 */
const snapshotCache = new Map();

const MAX_SNAPSHOTS = 50;

/**
 * @typedef {Object} TableSnapshotEntry
 * @property {string} id - 快照ID（新快照为 UUID；旧时间戳 ID 继续兼容读取）
 * @property {string} timestamp - ISO时间戳
 * @property {string} chatId - 关联的聊天ID
 * @property {number} messageIndex - 关联的消息索引（该消息触发了tableEdit）
 * @property {string} [messageId] - 关联的稳定消息 ID（旧快照可缺省）
 * @property {string} reason - 快照原因
 * @property {string} [mode] - 快照桶归属 chat/code/work（20260716 修2 断链A：无 mode 快照不知自己属哪个桶，
 *   恢复端只能按会话 active_mode 乱写=跨模式表污染；旧条目缺省 ""=legacy，恢复端按查看桶处理）
 * @property {object[]} tables - 表格数据深拷贝
 */

/**
 * 获取快照文件路径
 */
function getSnapshotFilePath(username, charName) {
  const memDir = ensureMemoryDir(username, charName);
  const hotDir = path.join(memDir, "hot");
  if (!fs.existsSync(hotDir)) {
    fs.mkdirSync(hotDir, { recursive: true });
  }
  return path.join(hotDir, "_table_snapshots.json");
}

/**
 * 获取缓存key
 */
function getCacheKey(username, charName) {
  return `${username}/${charName}`;
}

function snapshotUnavailableError(filePath, username, charName, cause) {
  const detail = cause?.message || String(cause);
  const error = new Error(`表格快照文件不可用: ${detail}`);
  error.code = "E_TABLE_SNAPSHOT_UNAVAILABLE";
  error.filePath = filePath;
  error.username = username;
  error.charName = charName;
  error.cause = cause;
  return error;
}

function validateSnapshotEntries(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("顶层必须是快照数组或包含 snapshots 数组的对象");
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`snapshots[${index}] 必须是对象`);
    }
    if (typeof entry.id !== "string" || !entry.id) {
      throw new TypeError(`snapshots[${index}].id 必须是非空字符串`);
    }
    if (typeof entry.chatId !== "string") {
      throw new TypeError(`snapshots[${index}].chatId 必须是字符串`);
    }
    if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
      throw new TypeError(`snapshots[${index}].timestamp 必须是有效时间戳`);
    }
    if (!Number.isInteger(entry.messageIndex)) {
      throw new TypeError(`snapshots[${index}].messageIndex 必须是整数`);
    }
    if (entry.messageId !== undefined && typeof entry.messageId !== "string") {
      throw new TypeError(`snapshots[${index}].messageId 必须是字符串`);
    }
    if (!Array.isArray(entry.tables)) {
      throw new TypeError(`snapshots[${index}].tables 必须是数组`);
    }
    if (entry.mode !== undefined && entry.mode !== "" && entry.mode !== "chat" && entry.mode !== "code" && entry.mode !== "work") {
      throw new TypeError(`snapshots[${index}].mode 不是受支持的表格桶`);
    }
  }
  return value;
}

/**
 * 从文件加载快照列表（如果缓存未命中）
 */
function loadSnapshots(username, charName) {
  const key = getCacheKey(username, charName);
  if (snapshotCache.has(key)) {
    return snapshotCache.get(key);
  }

  let filePath = null;
  let snapshots = [];
  try {
    filePath = getSnapshotFilePath(username, charName);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        snapshots = validateSnapshotEntries(parsed);
      } else if (parsed?.snapshots && Array.isArray(parsed.snapshots)) {
        snapshots = validateSnapshotEntries(parsed.snapshots);
      } else {
        throw new TypeError("顶层必须是快照数组或包含 snapshots 数组的对象");
      }
    }
  } catch (e) {
    const unavailable = snapshotUnavailableError(filePath, username, charName, e);
    wbD(null, "table", "tableSnapshot:load_fail", false, "快照文件存在但无法读取/解析/校验，拒绝把未知态当作无快照", { path: filePath, username, charName, code: unavailable.code, err: e.message });
    diag.error(`tableSnapshot: 加载快照文件失败，已拒绝回退空数组: ${e.message}`);
    throw unavailable;
  }

  snapshotCache.set(key, snapshots);
  return snapshots;
}

/**
 * 将快照列表持久化到文件
 */
function saveSnapshots(username, charName) {
  const key = getCacheKey(username, charName);
  const snapshots = snapshotCache.get(key) || [];
  const filePath = getSnapshotFilePath(username, charName);

  wbT(null, "table", "tableSnapshot:save", { path: filePath, count: snapshots.length });
  try {
    // D-05：原子写 tmp+rename，避免写盘中途崩溃留半截文件致快照损坏丢全部回档点（与 storage.mjs/dataSystem.mjs 同口径）
    const _content = JSON.stringify(
      { _format: "beilu-table-snapshots", snapshots },
      null,
      "\t",
    ) + "\n";
    nicerWriteFileSync(filePath, _content); // 0716 收口：原子写单源（tmp+重试 rename+同值跳写在单源内）
  } catch (e) {
    wbD(null, "table", "tableSnapshot:save_fail", false, "快照文件写盘失败(回档点未持久化)", { path: filePath, username, charName, count: snapshots.length, err: e.message });
    diag.error(`tableSnapshot: 保存快照文件失败: ${e.message}`);
    throw e;
  }
}

/**
 * 创建表格快照（在 tableEdit 执行前调用）
 *
 * @param {string} username
 * @param {string} charName
 * @param {object[]} tables - 当前表格数据（会深拷贝）
 * @param {string} chatId - 当前聊天ID
 * @param {number} [messageIndex] - 触发快照的消息索引（可选，-1表示未知）
 * @param {string} [reason] - 快照原因
 * @param {string} [mode] - 桶归属 chat/code/work（tables 来自哪个模式桶；非法值落 ""=legacy 语义）
 * @param {string} [messageId] - 触发快照的稳定消息 ID
 * @returns {{ success: boolean, snapshotId: string }}
 */
export function createTableSnapshot(
  username,
  charName,
  tables,
  chatId,
  messageIndex = -1,
  reason = "tableEdit前自动快照",
  mode = "",
  messageId = "",
) {
  wbT(chatId || null, "table", "createTableSnapshot:enter", { username, charName, chatId, messageIndex, messageId: messageId || null, mode, tableCount: Array.isArray(tables) ? tables.length : 0 });
  const key = getCacheKey(username, charName);
  const snapshots = loadSnapshots(username, charName);
  const previousSnapshots = snapshots.slice();
  const timestamp = new Date().toISOString();
  const id = randomUUID();

  /** @type {TableSnapshotEntry} */
  const entry = {
    id,
    timestamp,
    chatId: chatId || "",
    messageIndex,
    ...(typeof messageId === "string" && messageId ? { messageId } : {}),
    reason,
    mode: (mode === "chat" || mode === "code" || mode === "work") ? mode : "",
    tables: structuredClone(tables),
  };

  snapshots.push(entry);

  // 环形缓冲：超过上限删除最旧的
  while (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.shift();
  }

  try {
    saveSnapshots(username, charName);
  } catch (error) {
    snapshotCache.set(key, previousSnapshots);
    throw error;
  }

  diag.debug(
    `tableSnapshot: 已创建快照 ${id} (chatId=${chatId}, msgIdx=${messageIndex}, reason=${reason}, tables=${tables.length}个表格)`,
  );
  console.log(
    `[tableSnapshot] 已创建快照: ${id} (${reason}, ${tables.length}个表格)`,
  );

  return { success: true, snapshotId: id };
}

/**
 * 列出所有表格快照
 *
 * @param {string} username
 * @param {string} charName
 * @returns {Array<{id: string, timestamp: string, chatId: string, messageIndex: number, reason: string, tableCount: number}>}
 */
export function listTableSnapshots(username, charName) {
  const snapshots = loadSnapshots(username, charName);
  return snapshots.map((s) => ({
    id: s.id,
    timestamp: s.timestamp,
    chatId: s.chatId,
    messageIndex: s.messageIndex,
    messageId: s.messageId || "",
    reason: s.reason,
    mode: s.mode || "",
    tableCount: s.tables?.length || 0,
  }));
}

/**
 * 获取指定快照的完整数据
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} snapshotId
 * @returns {TableSnapshotEntry|null}
 */
export function getTableSnapshot(username, charName, snapshotId) {
  const snapshots = loadSnapshots(username, charName);
  return snapshots.find((s) => s.id === snapshotId) || null;
}

/**
 * 查找最适合回档的快照（基于 chatId + messageIndex）
 *
 * 语义：“回档到并保留目标消息”必须恢复目标之后第一次表格编辑前的快照，
 * 即 chatId 匹配且 messageIndex > targetIndex 的最早快照。没有后续表格改动就不恢复。
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} chatId
 * @param {number} targetIndex - 目标消息索引（回档到此消息并保留它）
 * @returns {TableSnapshotEntry|null}
 */
export function findSnapshotForRollback(
  username,
  charName,
  chatId,
  targetIndex,
) {
  const snapshots = loadSnapshots(username, charName);

  // 1. 筛选同一个 chatId 的快照
  const chatSnapshots = snapshots.filter((s) => s.chatId === chatId);
  if (chatSnapshots.length === 0) {
    // 无匹配 chatId 的快照 → 返回 null。旧版回退"任意最新快照"会把【别的对话】的表格状态套到本对话
    // （快照按 username/charName 加载，跨所有对话）= 跨会话表格污染。调用方
    // (setDataActions rollbackMemoryToMessage) 对 null 安全：跳过表格层、只走文件层回档。
    diag.warn(`tableSnapshot: 无匹配 chatId=${chatId} 的表格快照，本对话表格层不回档（不跨对话借用快照）`);
    return null;
  }

  // 2. 找 messageIndex > targetIndex 的第一份编辑前快照。
  //    同一 messageIndex 可有多种表格操作，必须取最先创建的那份，
  //    才是该条消息所有表格改动开始前的状态。
  const candidates = chatSnapshots.filter(
    (s) => Number.isInteger(s.messageIndex) && s.messageIndex > targetIndex,
  );

  if (candidates.length > 0) {
    candidates.sort((a, b) =>
      a.messageIndex - b.messageIndex ||
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return candidates[0];
  }

  // 3. 目标之后没有表格编辑：表格层不应产生任何恢复副作用。
  return null;
}

/**
 * 恢复表格快照（将快照中的 tables 数据写回内存数据）
 *
 * 注意：此函数只返回恢复后的 tables 数据，不直接写入文件。
 * 调用方需要自行 saveTablesData。
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} snapshotId
 * @param {{chatId:string, messageIndex?:number, messageId?:string}} expectedScope
 * @returns {{ success: boolean, tables?: object[], error?: string, code?: string }}
 */
export function restoreTableSnapshot(username, charName, snapshotId, expectedScope = {}) {
  if (typeof snapshotId !== "string" || !snapshotId) {
    return { success: false, code: "E_INVALID_TABLE_SNAPSHOT_ID", error: "snapshotId 必须是非空字符串" };
  }
  if (!expectedScope || typeof expectedScope !== "object" || Array.isArray(expectedScope)
    || typeof expectedScope.chatId !== "string" || !expectedScope.chatId) {
    return {
      success: false,
      code: "E_TABLE_SNAPSHOT_SCOPE_REQUIRED",
      error: "恢复表格快照必须提供非空 chatId 作用域",
    };
  }
  if (expectedScope.messageIndex !== undefined && !Number.isInteger(expectedScope.messageIndex)) {
    return { success: false, code: "E_INVALID_TABLE_SNAPSHOT_SCOPE", error: "messageIndex 作用域必须是整数" };
  }
  if (expectedScope.messageId !== undefined && (typeof expectedScope.messageId !== "string" || !expectedScope.messageId)) {
    return { success: false, code: "E_INVALID_TABLE_SNAPSHOT_SCOPE", error: "messageId 作用域必须是非空字符串" };
  }

  const snapshots = loadSnapshots(username, charName);
  const idMatches = snapshots.filter((entry) => entry.id === snapshotId);
  if (idMatches.length === 0) {
    return { success: false, code: "E_TABLE_SNAPSHOT_NOT_FOUND", error: `快照不存在: ${snapshotId}` };
  }
  const scopedMatches = idMatches.filter((entry) =>
    entry.chatId === expectedScope.chatId
    && (expectedScope.messageIndex === undefined || entry.messageIndex === expectedScope.messageIndex)
    && (expectedScope.messageId === undefined || entry.messageId === expectedScope.messageId)
  );
  if (scopedMatches.length === 0) {
    return {
      success: false,
      code: "E_TABLE_SNAPSHOT_SCOPE_MISMATCH",
      drift: "tableSnapshotScope",
      error: `快照 ${snapshotId} 不属于预期对话/消息作用域`,
      expectedScope: {
        chatId: expectedScope.chatId,
        ...(expectedScope.messageIndex !== undefined ? { messageIndex: expectedScope.messageIndex } : {}),
        ...(expectedScope.messageId !== undefined ? { messageId: expectedScope.messageId } : {}),
      },
      actualScopes: idMatches.map((entry) => ({
        chatId: entry.chatId,
        messageIndex: entry.messageIndex,
        ...(entry.messageId ? { messageId: entry.messageId } : {}),
      })),
    };
  }
  if (scopedMatches.length > 1) {
    return {
      success: false,
      code: "E_TABLE_SNAPSHOT_AMBIGUOUS",
      drift: "tableSnapshotScope",
      error: `快照 ${snapshotId} 在预期作用域内不唯一，拒绝猜测恢复目标`,
      expectedScope,
      matchCount: scopedMatches.length,
    };
  }
  const snapshot = scopedMatches[0];

  if (!snapshot.tables || !Array.isArray(snapshot.tables)) {
    wbD(null, "table", "restoreTableSnapshot:corrupt", false, "回档快照数据损坏(tables 非数组)，恢复失败", { snapshotId, username, charName });
    return { success: false, code: "E_TABLE_SNAPSHOT_CORRUPT", error: `快照数据损坏: tables 不是数组` };
  }

  console.log(
    `[tableSnapshot] 恢复快照: ${snapshotId} (${snapshot.tables.length}个表格, 创建于 ${snapshot.timestamp})`,
  );

  return {
    success: true,
    mode: snapshot.mode || "",
    tables: structuredClone(snapshot.tables),
  };
}

/**
 * 清除指定 chatId 在 targetIndex 之后的所有快照
 * （回档后，后续的快照已无效）
 *
 * @param {string} username
 * @param {string} charName
 * @param {string} chatId
 * @param {number} targetIndex
 * @returns {number} 删除的快照数量
 */
export function pruneSnapshotsAfter(username, charName, chatId, targetIndex) {
  const key = getCacheKey(username, charName);
  const snapshots = loadSnapshots(username, charName);

  const before = snapshots.length;
  const filtered = snapshots.filter(
    (s) =>
      s.chatId !== chatId ||
      s.messageIndex === -1 ||
      s.messageIndex <= targetIndex,
  );

  const pruned = before - filtered.length;
  if (pruned > 0) {
    snapshotCache.set(key, filtered);
    try {
      saveSnapshots(username, charName);
    } catch (error) {
      snapshotCache.set(key, snapshots);
      throw error;
    }
    diag.debug(
      `tableSnapshot: 清理了 ${pruned} 个过期快照 (chatId=${chatId}, after msgIdx=${targetIndex})`,
    );
  }

  return pruned;
}

/**
 * 清除缓存（用于内存管理）
 */
export function clearSnapshotCache(username, charName) {
  const key = getCacheKey(username, charName);
  snapshotCache.delete(key);
}
