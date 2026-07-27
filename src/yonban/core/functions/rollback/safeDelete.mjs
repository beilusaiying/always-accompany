import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs" // T3a·3.10: 新位 4 级; // 0716 收口：原子写单源（原内联 tmp；旧 tmp 名无 Date.now=并发互覆面，单源已含）
import { data_path } from "../../../../server/server.mjs" // T3a·3.10: 新位 4 级;
import { CHAT_SNAPSHOT_MAX, CHAT_BACKUP_MAX, CHAT_BACKUP_INTERVAL_MS } from "./deleteConfig.mjs";

let _trash = null;
async function _getTrash() {
  if (_trash === null) {
    try {
      const mod = await import("npm:trash");
      _trash = mod.default || mod;
    } catch {
      _trash = false;
    }
  }
  return _trash || null;
}

function _fallbackDir() {
  return path.join(data_path, "_trash_fallback");
}

function _undoDir() {
  return path.join(data_path, "_chat_undo");
}

function _backupDir() {
  return path.join(data_path, "_chat_backups");
}

function _ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * 安全删除目录 → 系统回收站。
 * fallback: trash 失败 → 先 cpSync 复制到 data/_trash_fallback/{date}/{label}_{basename}_{ts}/，
 * 复制成功后才对原路径 rmSync(:62)——原始数据仍保留在 fallback 目录，非无保留删除。
 */
export async function safeTrash(targetPath, label = "") {
  if (!targetPath || !fs.existsSync(targetPath)) return { success: true, method: "not_found" };

  const trash = await _getTrash();
  if (trash) {
    try {
      await trash(targetPath);
      console.log(`[safeDelete] trash 成功: ${targetPath} (${label})`);
      return { success: true, method: "trash" };
    } catch (e) {
      console.warn(`[safeDelete] trash 失败 (${e.message})，尝试 fallback: ${targetPath}`);
    }
  }

  try {
    const date = new Date().toISOString().slice(0, 10);
    const safeName = (label || "del").replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "_").slice(0, 40);
    const fallbackPath = path.join(_fallbackDir(), date, `${safeName}_${path.basename(targetPath)}_${_ts()}`);
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.cpSync(targetPath, fallbackPath, { recursive: true });
    for (let i = 0; ; i++) {
      try { fs.rmSync(targetPath, { recursive: true, force: true }); break; }
      catch (re) {
        if ((re.code === "EBUSY" || re.code === "EPERM") && i < 3) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw re;
      }
    }
    console.log(`[safeDelete] fallback 移到: ${fallbackPath} (${label})`);
    return { success: true, method: "fallback", fallbackPath };
  } catch (e2) {
    console.error(`[safeDelete] fallback 也失败: ${targetPath} (${label}) — ${e2.message}`);
    return { success: false, method: "failed", error: e2.message };
  }
}

/**
 * 安全删除文件 → 系统回收站。
 * fallback: trash 失败 → 复制到 data/_trash_fallback/ 后 unlinkSync。
 */
export async function safeUnlink(filePath, label = "") {
  if (!filePath || !fs.existsSync(filePath)) return { success: true, method: "not_found" };

  const trash = await _getTrash();
  if (trash) {
    try {
      await trash(filePath);
      console.log(`[safeDelete] trash 文件成功: ${filePath} (${label})`);
      return { success: true, method: "trash" };
    } catch (e) {
      console.warn(`[safeDelete] trash 文件失败 (${e.message})，尝试 fallback: ${filePath}`);
    }
  }

  try {
    const date = new Date().toISOString().slice(0, 10);
    const safeName = (label || "del").replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "_").slice(0, 40);
    const fallbackPath = path.join(_fallbackDir(), date, `${safeName}_${path.basename(filePath)}_${_ts()}`);
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.copyFileSync(filePath, fallbackPath);
    for (let i = 0; ; i++) {
      try { fs.unlinkSync(filePath); break; }
      catch (re) {
        if ((re.code === "EBUSY" || re.code === "EPERM") && i < 3) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw re;
      }
    }
    console.log(`[safeDelete] fallback 文件移到: ${fallbackPath} (${label})`);
    return { success: true, method: "fallback", fallbackPath };
  } catch (e2) {
    console.error(`[safeDelete] fallback 文件也失败: ${filePath} (${label}) — ${e2.message}`);
    return { success: false, method: "failed", error: e2.message };
  }
}

/**
 * 消息删除前保存 chatLog 快照（轮转保留最近 maxSnapshots 次）。
 * 存储：data/_chat_undo/{chatid}/{timestamp}_{reason}.json
 */
export function chatLogSnapshot(chatid, chatLog, reason = "delete", maxSnapshots = CHAT_SNAPSHOT_MAX) {
  if (!chatid || !chatLog) return null;

  try {
    const dir = path.join(_undoDir(), chatid);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${_ts()}_${reason}.json`;
    const filepath = path.join(dir, filename);
    const data = JSON.stringify({ timestamp: new Date().toISOString(), reason, messageCount: chatLog.length, chatLog }, null, "\t");

    nicerWriteFileSync(filepath, data); // 0716 收口：原子写单源

    _pruneSnapshots(dir, maxSnapshots);

    console.log(`[safeDelete] chatLog 快照已保存: ${filepath} (${chatLog.length} 条消息)`);
    return filepath;
  } catch (e) {
    console.error(`[safeDelete] chatLog 快照失败 (chatid=${chatid}): ${e.message}`);
    return null;
  }
}

/**
 * 列出某 chatid 的全部可用快照。
 */
export function listChatLogSnapshots(chatid) {
  if (!chatid) return [];
  const dir = path.join(_undoDir(), chatid);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .map(f => {
        try {
          const stat = fs.statSync(path.join(dir, f));
          return { file: f, path: path.join(dir, f), size: stat.size, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 从快照恢复 chatLog（返回原始 chatLog 数组，由调用方决定如何应用）。
 */
export function loadChatLogSnapshot(chatid, snapshotFile) {
  const filepath = path.join(_undoDir(), chatid, snapshotFile);
  if (!fs.existsSync(filepath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
    return data.chatLog || null;
  } catch { return null; }
}

export function listChatAutoBackups(chatid) {
  if (!chatid) return [];
  const dir = path.join(_backupDir(), chatid);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .map(f => {
        try {
          const stat = fs.statSync(path.join(dir, f));
          return { file: f, path: path.join(dir, f), size: stat.size, mtime: stat.mtimeMs, source: "auto" };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

export function loadChatAutoBackup(chatid, backupFile) {
  const filepath = path.join(_backupDir(), chatid, backupFile);
  if (!fs.existsSync(filepath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filepath, "utf8"));
    return data.chatLog || data;
  } catch { return null; }
}

export function listAllChatBackups(chatid) {
  const snapshots = listChatLogSnapshots(chatid).map(s => ({ ...s, source: "undo" }));
  const autos = listChatAutoBackups(chatid);
  return [...snapshots, ...autos].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

function _pruneSnapshots(dir, max) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    while (files.length > max) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * saveChat 备份 throttle。
 * 每次调用记录请求，实际备份不超过每 intervalMs 一次。
 * per-chatid 隔离，轮转保留 maxBackups 个。
 */
const _backupTimers = new Map();
const _backupPending = new Map();

export function throttledChatBackup(chatid, chatData, { intervalMs = CHAT_BACKUP_INTERVAL_MS, maxBackups = CHAT_BACKUP_MAX } = {}) {
  if (!chatid || !chatData) return;

  _backupPending.set(chatid, chatData);

  if (_backupTimers.has(chatid)) return;

  _doBackup(chatid, maxBackups);

  const timer = setTimeout(() => {
    _backupTimers.delete(chatid);
    const pending = _backupPending.get(chatid);
    if (pending) {
      _backupPending.delete(chatid);
      _doBackup(chatid, maxBackups);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  _backupTimers.set(chatid, timer);
}

function _doBackup(chatid, maxBackups) {
  const chatData = _backupPending.get(chatid);
  if (!chatData) return;
  _backupPending.delete(chatid);

  try {
    const dir = path.join(_backupDir(), chatid);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${chatid}_${_ts()}.json`;
    const filepath = path.join(dir, filename);
    nicerWriteFileSync(filepath, JSON.stringify(chatData, null, "\t")); // 0716 收口：原子写单源（分身漏报点，主 AI 残留 grep 补获）

    _pruneDir(dir, maxBackups);
  } catch (e) {
    console.error(`[safeDelete] 备份失败 (chatid=${chatid}): ${e.message}`);
  }
}

function _pruneDir(dir, max) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
    while (files.length > max) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function flushAllBackups() {
  for (const [chatid, timer] of _backupTimers) {
    clearTimeout(timer);
    _backupTimers.delete(chatid);
    const pending = _backupPending.get(chatid);
    if (pending) {
      _backupPending.delete(chatid);
      _doBackup(chatid, CHAT_BACKUP_MAX);
    }
  }
}
