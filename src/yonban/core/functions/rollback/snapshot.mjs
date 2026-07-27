/**
 * snapshot.mjs — 全量记忆快照系统（手动/自动/恢复/清理）
 *
 * 功能链：replyHandler / snapshotHandler → createSnapshot/restoreSnapshot → copyDirSync → data/backups/memory-snapshots/
 * why：归档执行前或每天首启时，需把整个 memoryDir（含 hot/warm/cold/tables.json）原子备份到独立 backup 目录，
 *      防归档操作写坏数据后无法回退；与 tableSnapshot.mjs（轻量表格回档）互补，本模块做全量保险。
 * 关联链：
 *   ← setDataActions（createSnapshot/listSnapshots/restoreSnapshot 手动 verb，memtool 快照 UI）
 *   ← backgroundTasks endDay / warm→cold、aiRunner triggerP2Summary（createArchiveSnapshot 归档前自动快照，凛倾0712接线）
 *   → storage.mjs（loadCodeConfig，取 projectRoot）
 *   → nicerWriteFile.mjs（renameSyncWithRetry，重命名原子写）
 * 影响范围：写 data/backups/memory-snapshots/{username}/{charName}/{id}/ 目录（不在 memoryDir 内，不被导出/导入影响）
 * 使用效果：快照超出上限（默认 10）自动删最旧；恢复前自动建"恢复前快照"保底
 */
import fs from "node:fs";
import path from "node:path";
import { loadCodeConfig, ensureMemoryDir, loadJsonFileIfExists, saveJsonFile, getTodayStr, __projectRoot } from "../memory/storage_mod/storage.mjs"; // T8·回切：改组内引用（T3a·3.10 暂指旧位壳的欠账，T3e memory 已入住）
import { renameSyncWithRetry, nicerWriteFileSync } from "../../../../scripts/nicerWriteFile.mjs" // T3a·3.10: 新位 4 级;
import { wbD } from "../../../../server/wbStub.mjs";

// 快照存储在独立backup目录（不在memory内部，避免被导出/导入影响）
function getSnapshotBaseDir(projectRoot) {
  return path.join(projectRoot, "data", "backups", "memory-snapshots");
}

/**
 * 递归复制目录
 * @param {string} src - 源目录
 * @param {string} dest - 目标目录
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 创建快照
 * @param {string} projectRoot - beilu项目根目录
 * @param {string} username
 * @param {string} charName
 * @param {string} memoryDir - memory/{char_name}/ 绝对路径
 * @param {string} [reason] - 快照原因描述
 * @returns {{ success: boolean, snapshotId: string, timestamp: string }}
 */
export function createSnapshot(
  projectRoot,
  username,
  charName,
  memoryDir,
  reason,
) {
  const baseDir = getSnapshotBaseDir(projectRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotId = `${username}_${charName}_${timestamp}`;
  const snapshotDir = path.join(baseDir, username, charName, timestamp);

  fs.mkdirSync(snapshotDir, { recursive: true });
  copyDirSync(memoryDir, snapshotDir);

  // 写入快照元数据
  const meta = {
    snapshotId,
    username,
    charName,
    timestamp: new Date().toISOString(),
    reason: reason || "手动快照",
    sourceDir: memoryDir,
  };
  nicerWriteFileSync(
    path.join(snapshotDir, "_snapshot_meta.json"),
    JSON.stringify(meta, null, "\t") + "\n",
  );

  // 清理超过上限的旧快照
  const config = loadCodeConfig(username, charName); // T7 尾段收口：签名随 storage 权威化改 (username,charName)
  const maxCount = config?.snapshot_max_count || 10;
  pruneSnapshots(projectRoot, username, charName, maxCount);

  console.log(
    `[snapshot] 快照已创建: ${snapshotId} (reason: ${reason || "手动"})`,
  );
  return { success: true, snapshotId, timestamp: meta.timestamp };
}

/**
 * 归档链前置自动快照（凛倾0712「快照做」）——本文件头注释一直声称「归档执行前」
 * 备份，但此前从未接线；此函数是归档域的统一入口，破坏性归档点各自调一行。
 *
 * 频控：非 force 时按日戳（memoryDir/_config.json 的 _last_archive_snapshot）每天
 * 最多一份，防 P2 阈值型触发把 10 份滚动位挤满；endDay 等强破坏点传 force=true 每次必拍。
 * 失败语义：快照是保险层不是新单点故障——失败 warn+wbD 可见，归档照常继续。
 * @param {string} username
 * @param {string} charName
 * @param {string} reason - 快照原因（进 _snapshot_meta.json）
 * @param {{force?: boolean}} [opts]
 */
export function createArchiveSnapshot(username, charName, reason, opts = {}) {
  try {
    const memDir = ensureMemoryDir(username, charName);
    const cfgPath = path.join(memDir, "_config.json");
    const today = getTodayStr();
    if (!opts.force) {
      const cfg = loadJsonFileIfExists(cfgPath, { enabled: true });
      if (cfg._last_archive_snapshot === today) return { success: true, skipped: "daily_throttle" };
    }
    const r = createSnapshot(__projectRoot, username, charName, memDir, reason);
    if (r?.success) {
      const cfg = loadJsonFileIfExists(cfgPath, { enabled: true });
      cfg._last_archive_snapshot = today;
      saveJsonFile(cfgPath, cfg);
    }
    return r;
  } catch (e) {
    wbD(null, "snapshot", "createArchiveSnapshot:fail", false, e.message, { username, charName, reason });
    console.warn(`[snapshot] 归档前自动快照失败（归档继续）: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * 列出所有快照
 * @param {string} projectRoot
 * @param {string} username
 * @param {string} charName
 * @returns {Array<{id: string, timestamp: string, reason: string}>}
 */
export function listSnapshots(projectRoot, username, charName) {
  const charDir = path.join(
    getSnapshotBaseDir(projectRoot),
    username,
    charName,
  );
  if (!fs.existsSync(charDir)) return [];

  const entries = fs
    .readdirSync(charDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name)); // 最新在前

  return entries.map((e) => {
    const metaPath = path.join(charDir, e.name, "_snapshot_meta.json");
    let meta = { timestamp: e.name, reason: "未知" };
    try {
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      }
    } catch {
      /* ignore */
    }
    return {
      id: e.name,
      timestamp: meta.timestamp || e.name,
      reason: meta.reason || "未知",
    };
  });
}

/**
 * 恢复快照
 * @param {string} projectRoot
 * @param {string} username
 * @param {string} charName
 * @param {string} memoryDir
 * @param {string} snapshotId
 * @returns {{ success: boolean, restored?: string, error?: string }}
 */
export function restoreSnapshot(
  projectRoot,
  username,
  charName,
  memoryDir,
  snapshotId,
) {
  // 先创建"恢复前快照"
  createSnapshot(
    projectRoot,
    username,
    charName,
    memoryDir,
    `恢复前自动备份 (即将恢复 ${snapshotId})`,
  );

  const snapshotDir = path.join(
    getSnapshotBaseDir(projectRoot),
    username,
    charName,
    snapshotId,
  );
  if (!fs.existsSync(snapshotDir)) {
    return { success: false, error: `快照不存在: ${snapshotId}` };
  }

  // N11 原子恢复：先把快照拷到 staging 目录，全部成功后再 rename swap。
  // 旧实现"先清空 live 再逐项拷回"中途失败会留下半毁的 live 目录（"恢复前自动备份"不会自动回灌）。
  const parentDir = path.dirname(memoryDir);
  const baseName = path.basename(memoryDir);
  const stagingDir = path.join(parentDir, `.${baseName}.restoring_${Date.now()}`);
  const oldDir = path.join(parentDir, `.${baseName}.old_${Date.now()}`);

  // 1) 拷快照 → staging（排除 _snapshot_meta.json）。此阶段失败 live 原封未动
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const snapEntries = fs.readdirSync(snapshotDir, { withFileTypes: true });
    for (const entry of snapEntries) {
      if (entry.name === "_snapshot_meta.json") continue;
      const src = path.join(snapshotDir, entry.name);
      const dest = path.join(stagingDir, entry.name);
      if (entry.isDirectory()) copyDirSync(src, dest);
      else fs.copyFileSync(src, dest);
    }
  } catch (e) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { success: false, error: `快照恢复失败(暂存阶段，live 未改动): ${e.message}` };
  }

  // 2) 原子 swap：live → old → staging 上位 → 删 old。任一步失败都保证 live 完整
  try {
    renameSyncWithRetry(memoryDir, oldDir);
  } catch (e) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { success: false, error: `快照恢复失败(切换阶段，live 未改动): ${e.message}` };
  }
  try {
    renameSyncWithRetry(stagingDir, memoryDir);
  } catch (e) {
    // ★ T017-2.3：回滚 rename(old→live)是快照恢复失败后的最后防线，原静默 catch 会让「回滚本身也失败」无声无息——
    //   此时 live 目录可能已缺失(old 未改回),是数据完整性最危险的态，必须打出来(上层已有 error return 通知调用方,此处补留痕)。
    try { renameSyncWithRetry(oldDir, memoryDir); } catch (e2) {
      console.error(`[snapshot] ★T017 严重：快照切换失败后回滚 live 也失败! live 目录可能缺失,需人工核查 ${memoryDir}: ${e2.message}`);
    } // 回滚：把 old 改回 live
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { success: false, error: `快照恢复失败(切换阶段已回滚 live): ${e.message}` };
  }
  try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* old 残留不影响数据正确性 */ }

  console.log(`[snapshot] 快照已恢复(原子swap): ${snapshotId}`);
  return { success: true, restored: snapshotId };
}

/**
 * 清理超过上限的旧快照
 * @param {string} projectRoot
 * @param {string} username
 * @param {string} charName
 * @param {number} maxCount
 */
function pruneSnapshots(projectRoot, username, charName, maxCount) {
  const charDir = path.join(
    getSnapshotBaseDir(projectRoot),
    username,
    charName,
  );
  if (!fs.existsSync(charDir)) return;

  const entries = fs
    .readdirSync(charDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)); // 最旧在前

  while (entries.length > maxCount) {
    const oldest = entries.shift();
    const p = path.join(charDir, oldest.name);
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[snapshot] 已清理旧快照: ${oldest.name}`);
  }
}

/**
 * 自动快照条件判断
 * @param {string} projectRoot
 * @param {string} username
 * @param {string} charName
 * @param {string} memoryDir
 * @returns {boolean}
 */
export function shouldAutoSnapshot(projectRoot, username, charName, memoryDir) {
  const config = loadCodeConfig(username, charName); // T7 尾段收口：签名随 storage 权威化改 (username,charName)
  if (!config?.auto_snapshot) return false;

  const snapshots = listSnapshots(projectRoot, username, charName);
  if (snapshots.length === 0) return true; // 从未快照过

  const lastTimestamp = snapshots[0]?.timestamp;
  if (!lastTimestamp) return true;

  const lastTime = new Date(lastTimestamp).getTime();
  const now = Date.now();
  // 超过24小时没快照
  return now - lastTime > 24 * 60 * 60 * 1000;
}
