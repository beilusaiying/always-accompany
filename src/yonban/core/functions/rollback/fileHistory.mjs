import fs from "node:fs";
import path from "node:path";
import { nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs" // T3a·3.10: 新位 4 级; // 0716 收口：原子写单源（原内联 tmp 两处；旧 tmp 名无 Date.now=并发互覆面，单源已含）
import { data_path } from "../../../../server/server.mjs" // T3a·3.10: 新位 4 级;
import { getUserDictionary } from "../security/auth.mjs" // T3a·3.10: 新位 4 级;
import { FILE_HISTORY_MAX_VERSIONS } from "./deleteConfig.mjs"; // T3a·3.10: deleteConfig 同组同迁
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs"; // T060：meta.json 损坏不静默返 {versions:[]} 再 _saveMeta 清空全部版本历史——同 T019 切共享安全读原语（损坏先备份 .corrupt.bak 再抛 CorruptJsonError），由各调用点既有失败契约承接留痕。node:fs 在 Deno 下可用，同 F6/T019 范式

function _ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function _historyRoot(username) {
  return path.join(getUserDictionary(username), "_file_history");
}

function _configPath(username) {
  return path.join(_historyRoot(username), "config.json");
}

const DEFAULT_CONFIG = {
  watchFolders: [],
  strategy: "auto",
  maxVersions: FILE_HISTORY_MAX_VERSIONS,
};

// T060b（同 T060 型）：config.json 损坏原 catch→{...DEFAULT_CONFIG} 会静默把用户配置重置——
//   watchFolders（监控哪些文件夹）/strategy（备份策略）/maxVersions 全丢，且下一次 saveConfig 会把
//   这份空默认写回磁盘，损坏一个字节即永久清空用户的文件历史监控配置。切 readJsonSafeSync：不存在→
//   DEFAULT_CONFIG（首装路径，与旧一致）；损坏→先备份 .corrupt.bak 再抛 CorruptJsonError，由各调用点
//   既有/新增失败契约承接留痕（不再静默重置）。JSON.parse 结果与 DEFAULT_CONFIG 浅合并语义不变。
export function loadConfig(username) {
  const p = _configPath(username);
  const saved = readJsonSafeSync(p, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(username, cfg) {
  const p = _configPath(username);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  nicerWriteFileSync(p, JSON.stringify(cfg, null, "\t")); // 0716 收口：原子写单源
}

function _isInWatchFolders(absPath, watchFolders) {
  if (!watchFolders || watchFolders.length === 0) return false;
  const resolved = path.resolve(absPath);
  return watchFolders.some(folder => {
    const resolvedFolder = path.resolve(folder);
    return resolved.startsWith(resolvedFolder + path.sep) || resolved === resolvedFolder;
  });
}

function _versionDir(username, chatid, relPath) {
  const safeChatid = (chatid || "_global").replace(/[\\/:*?"<>|]/g, "_");
  const safePath = relPath.replace(/\\/g, "/").replace(/[/:*?"<>|]/g, "_");
  return path.join(_historyRoot(username), safeChatid, safePath);
}

function _metaPath(dir) {
  return path.join(dir, "meta.json");
}

function _loadMeta(dir) {
  // T060：文件不存在→{versions:[]}（首建路径，与旧行为一致）；损坏→readJsonSafeSync 先备份
  //   .corrupt.bak 再抛 CorruptJsonError，绝不静默返空表（旧代码 catch→{versions:[]} 会被 _saveMeta
  //   写回，一个字节损坏即清空该文件的全部版本历史）。抛错由各调用点 try/catch 转为失败返回契约。
  return readJsonSafeSync(_metaPath(dir), { versions: [] });
}

function _saveMeta(dir, meta) {
  const mp = _metaPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  nicerWriteFileSync(mp, JSON.stringify(meta, null, "\t")); // 0716 收口：原子写单源
}

/**
 * AI 操作前备份文件。
 * 仅当文件在 watchFolders 内时才备份。strategy="manual" 时跳过。
 * @returns {{ backed: boolean, bakPath?: string }}
 */
export function backupBeforeWrite(username, absPath, { chatid = "", tool = "", messageIndex = -1 } = {}) {
  if (!absPath || !fs.existsSync(absPath)) return { backed: false };
  if (!fs.statSync(absPath).isFile()) return { backed: false };

  // T060b：loadConfig 现会在 config.json 损坏时抛 CorruptJsonError（已备份 .corrupt.bak）。转 {backed:false,error}
  //   失败返回（消费方 ideClient/main.mjs 据 backed===false 中止裸写并记 errors），不静默按默认配置续写。
  let cfg;
  try {
    cfg = loadConfig(username);
  } catch (e) {
    console.warn(`[fileHistory] backupBeforeWrite 读配置失败 ${username}: ${e.message}`);
    return { backed: false, error: e.message };
  }
  if (cfg.strategy === "manual") return { backed: false };
  if (!_isInWatchFolders(absPath, cfg.watchFolders)) return { backed: false };

  const workspaceRoot = cfg.watchFolders[0] || path.dirname(absPath);
  const relPath = path.relative(workspaceRoot, absPath) || path.basename(absPath);

  const dir = _versionDir(username, chatid, relPath);

  const timestamp = Date.now();
  const bakFile = `${timestamp}.bak`;
  const bakPath = path.join(dir, bakFile);

  try {
    // T060：_loadMeta 纳入 try——meta 损坏时抛 CorruptJsonError，转为 {backed:false,error} 失败返回
    //   （消费方 ideClient/main.mjs 据 backed===false 中止裸写并记 errors，见 ideClient.mjs:951-952），
    //   不再静默空表续写把损坏的历史彻底覆盖清空。
    const meta = _loadMeta(dir);

    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(absPath, bakPath);

    meta.file = relPath;
    meta.versions.push({
      timestamp: new Date(timestamp).toISOString(),
      tool,
      author: "ai",
      size: fs.statSync(bakPath).size,
      bakFile,
      chatid,
      messageIndex,
    });

    _pruneVersions(dir, meta, cfg.maxVersions);
    _saveMeta(dir, meta);

    return { backed: true, bakPath };
  } catch (e) {
    console.warn(`[fileHistory] 备份失败 ${absPath}: ${e.message}`);
    return { backed: false, error: e.message };
  }
}

/**
 * 列出某文件的全部历史版本。
 */
export function getFileVersions(username, absPath, chatid = "") {
  // T060b：loadConfig 损坏抛 CorruptJsonError（已备份 .corrupt.bak）。转失败返回——不静默按默认配置继续
  //   （默认 watchFolders=[] 会让 workspaceRoot 落到 dirname，relPath 算错，列出错误版本集误导用户）。
  let cfg;
  try {
    cfg = loadConfig(username);
  } catch (e) {
    console.warn(`[fileHistory] getFileVersions 读配置失败 ${username}: ${e.message}`);
    return { file: path.basename(absPath || ""), absPath, versions: [], error: e.message };
  }
  const workspaceRoot = cfg.watchFolders[0] || path.dirname(absPath);
  const relPath = path.relative(workspaceRoot, absPath) || path.basename(absPath);
  const allVersions = [];
  const root = _historyRoot(username);
  if (fs.existsSync(root)) {
    try {
      for (const sub of fs.readdirSync(root)) {
        if (sub === "config.json") continue;
        const safePath = relPath.replace(/\\/g, "/").replace(/[/:*?"<>|]/g, "_");
        const dir = path.join(root, sub, safePath);
        if (!fs.existsSync(dir)) continue;
        const meta = _loadMeta(dir);
        for (const v of meta.versions) {
          allVersions.push({
            ...v,
            source: sub === "_global" ? "manual" : sub,
            bakPath: path.join(dir, v.bakFile),
            exists: fs.existsSync(path.join(dir, v.bakFile)),
          });
        }
      }
    } catch (e) {
      // ★ T017-2.3：版本目录遍历失败原为静默 catch{}，导致历史面板漏列版本却无任何痕迹(用户以为无历史可回)。留痕不中断——
      //   已收集的 allVersions 仍返回(尽力而为),但把读取异常打出来供诊断(readdir/meta 损坏等)。
      console.warn(`[fileHistory] getFileVersions 遍历版本目录失败(已列版本仍返回): ${e.message}`);
    }
  }
  allVersions.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  return { file: relPath, absPath, versions: allVersions };
}

/**
 * 回滚到指定版本。当前文件先备份一份再覆盖。
 */
export function revertToVersion(username, absPath, timestamp, chatid = "") {
  try {
    // T060b：loadConfig 移入 try——config.json 损坏抛 CorruptJsonError（已备份 .corrupt.bak），
    //   转 {success:false,error}。回滚是数据挽救场景，配置损坏必须报错不能按默认配置乱算 relPath。
    const cfg = loadConfig(username);
    const workspaceRoot = cfg.watchFolders[0] || path.dirname(absPath);
    const relPath = path.relative(workspaceRoot, absPath) || path.basename(absPath);
    const dir = _versionDir(username, chatid, relPath);

    // T060：_loadMeta 纳入 try——meta 损坏抛 CorruptJsonError 转 {success:false,error}，
    //   不再静默返空表让"版本不存在"误导用户（回滚是数据挽救场景，损坏必须报错不能吞）。
    const meta = _loadMeta(dir);

    const version = meta.versions.find(v => v.timestamp === timestamp);
    if (!version) return { success: false, error: "版本不存在" };

    const bakPath = path.join(dir, version.bakFile);
    if (!fs.existsSync(bakPath)) return { success: false, error: "备份文件已丢失" };

    if (fs.existsSync(absPath)) {
      const beforeRevertBak = `${Date.now()}_before_revert.bak`;
      fs.copyFileSync(absPath, path.join(dir, beforeRevertBak));
      meta.versions.push({
        timestamp: new Date().toISOString(),
        tool: "revert_backup",
        author: "user",
        size: fs.statSync(absPath).size,
        bakFile: beforeRevertBak,
        chatid,
        messageIndex: -1,
      });
      _saveMeta(dir, meta);
    }

    fs.copyFileSync(bakPath, absPath);
    return { success: true, restoredFrom: version.timestamp };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 两个版本的 unified diff（文本文件）。
 */
export function diffVersions(username, absPath, ts1, ts2, chatid = "") {
  // T060：meta 损坏抛 CorruptJsonError（已备份 .corrupt.bak），转 {success:false,error} 报错——
  //   不再静默返空表让 diff 假装"无法读取版本文件"掩盖真实损坏。
  // T060b：loadConfig 一并纳入本 try——config.json 损坏同样抛 CorruptJsonError，转 {success:false,error}。
  let meta, dir;
  try {
    const cfg = loadConfig(username);
    const workspaceRoot = cfg.watchFolders[0] || path.dirname(absPath);
    const relPath = path.relative(workspaceRoot, absPath) || path.basename(absPath);
    dir = _versionDir(username, chatid, relPath);
    meta = _loadMeta(dir);
  } catch (e) {
    return { success: false, error: e.message };
  }

  const v1 = meta.versions.find(v => v.timestamp === ts1);
  const v2 = meta.versions.find(v => v.timestamp === ts2);

  const readVersion = (v) => {
    if (!v) return null;
    const p = path.join(dir, v.bakFile);
    if (!fs.existsSync(p)) return null;
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
  };

  let content1 = readVersion(v1);
  let content2 = readVersion(v2);

  if (ts2 === "current") {
    try { content2 = fs.readFileSync(absPath, "utf8"); } catch { content2 = null; }
  }

  if (content1 === null || content2 === null) {
    return { success: false, error: "无法读取版本文件" };
  }

  const lines1 = content1.split("\n");
  const lines2 = content2.split("\n");
  const diff = [];
  const maxLen = Math.max(lines1.length, lines2.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= lines1.length) {
      diff.push({ type: "add", line: i + 1, content: lines2[i] });
    } else if (i >= lines2.length) {
      diff.push({ type: "del", line: i + 1, content: lines1[i] });
    } else if (lines1[i] !== lines2[i]) {
      diff.push({ type: "del", line: i + 1, content: lines1[i] });
      diff.push({ type: "add", line: i + 1, content: lines2[i] });
    }
  }

  return { success: true, diff, totalLines1: lines1.length, totalLines2: lines2.length };
}

/**
 * 手动触发全部监控文件夹的备份扫描。
 */
export function manualBackupAll(username, chatid = "") {
  // T060b：loadConfig 损坏抛 CorruptJsonError（已备份 .corrupt.bak），转 {success:false,error}——
  //   不静默按空默认配置返回"没有配置监控文件夹"（那会把损坏误报成"未配置"，掩盖真实损坏）。
  let cfg;
  try {
    cfg = loadConfig(username);
  } catch (e) {
    return { success: false, error: `读取文件历史配置失败：${e.message}` };
  }
  if (!cfg.watchFolders || cfg.watchFolders.length === 0) return { success: false, error: "没有配置监控文件夹" };

  let backed = 0;
  let errors = 0;

  for (const folder of cfg.watchFolders) {
    if (!fs.existsSync(folder)) continue;
    _scanAndBackup(folder, username, chatid, cfg, (ok) => { if (ok) backed++; else errors++; });
  }

  return { success: true, backed, errors };
}

function _scanAndBackup(dir, username, chatid, cfg, cb, depth = 0) {
  if (depth > 5) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        _scanAndBackup(full, username, chatid, cfg, cb, depth + 1);
      } else if (entry.isFile()) {
        const r = backupBeforeWrite(username, full, { chatid, tool: "manual_backup" });
        cb(r.backed);
      }
    }
  } catch { /* ignore unreadable dirs */ }
}

function _pruneVersions(dir, meta, maxVersions) {
  while (meta.versions.length > maxVersions) {
    const oldest = meta.versions.shift();
    if (oldest?.bakFile) {
      try { fs.unlinkSync(path.join(dir, oldest.bakFile)); } catch { /* ignore */ }
    }
  }
}
