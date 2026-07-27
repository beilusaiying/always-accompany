import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * [archiver] — 记忆归档操作执行器：解析并执行 AI 回复中 <memoryArchive> 标签的文件操作。不管表格 CRUD（那是 tableEngine 的事）、不管触发判断（那是 backgroundTasks 的事）。
 *
 * 链路：replyHandler(步骤2 <memoryArchive> 解析) → executeMemoryArchiveOps(archiveOpsRaw) → parseArchiveOperations → switch(op.name) → 磁盘
 * 影响：写/追加/更新 memDir 下的 JSON 文件（createFile/appendToFile/updateFile/updateIndex）
 *        同卷原子搬移（moveEntries，rename 原语，无 copy+unlink 窗口）
 *        清空表格行（clearTable，修改内存引用，需调用方 saveTablesData 落盘）
 *        deleteFile 被安全策略阻止（blocked）
 * 相交：← replyHandler 调用
 *        → storage.mjs（saveJsonFile/loadJsonFileIfExists/isPathSafe/getMemoryDir/diag）
 *        → replyParser.mjs（parseArchiveOperations，解析原始文本为结构化操作列表）
 *        → nicerWriteFile.mjs（renameSyncWithRetry，原子搬移原语）
 *
 * 支持 7 种操作：createFile / appendToFile / updateFile / updateIndex / moveEntries(目录搬移+条目索引搬移) / clearTable / deleteFile(阻止)
 */

import fs from "node:fs";
import path from "node:path";

import {
  diag,
  getMemoryDir,
  isPathSafe,
  loadJsonFileIfExists,
  saveJsonFile,
} from "./storage.mjs";

import { parseArchiveOperations } from "../handler/replyParser.mjs";

// 同卷原子搬移原语（rename + Windows 瞬时锁重试）；与 snapshot.mjs 同款 import
import { renameSyncWithRetry } from "../../../../../scripts/nicerWriteFile.mjs";

/**
 * 同卷原子搬移：把 src 子树搬到 dest。src/dest 同 memDir 必同卷，rename 单 syscall 原子，
 * 无 copy+unlink 那种「源目标并存」窗口。保留原 _moveEntriesDir 语义：文件=覆盖，目录=递归 merge。
 * @param {string} src 源条目绝对路径
 * @param {string} dest 目标条目绝对路径
 */
function _atomicMoveInto(src, dest) {
  const srcIsDir = fs.statSync(src).isDirectory();
  if (!fs.existsSync(dest)) {
    // 目标不存在：整棵子树一次 rename 原子搬走（文件/目录通用，零重复窗口）
    renameSyncWithRetry(src, dest);
    return;
  }
  const destIsDir = fs.statSync(dest).isDirectory();
  if (!srcIsDir && !destIsDir) {
    // 文件覆盖文件：rename 原子替换（POSIX rename / Windows MOVEFILE_REPLACE_EXISTING）
    renameSyncWithRetry(src, dest);
    return;
  }
  if (srcIsDir && destIsDir) {
    // 目录 merge 目录：递归到叶子，每个叶子 rename 原子；搬空后删源空壳
    for (const child of fs.readdirSync(src)) {
      _atomicMoveInto(path.join(src, child), path.join(dest, child));
    }
    fs.rmSync(src, { recursive: true, force: true });
    return;
  }
  // 类型不一致（文件↔目录）：异常输入，抛给上层 catch 记遥测（原 cpSync/copyFile 此处亦失败）
  throw new Error(`类型冲突: src ${srcIsDir ? "目录" : "文件"} vs dest ${destIsDir ? "目录" : "文件"}`);
}


/**
 * 执行记忆归档操作
 * @param {string[]} archiveOpsRaw - <memoryArchive> 标签内的原始文本数组
 * @param {string} username - 用户名
 * @param {string} charName - 角色名
 * @param {object[]} tables - 表格数组引用（clearTable 需要）
 * @returns {object[]} 操作结果数组
 */
export function executeMemoryArchiveOps(
  archiveOpsRaw,
  username,
  charName,
  tables,
) {
  wbT(null, "archiver", "executeMemoryArchiveOps:enter", { username, charName, blockCount: archiveOpsRaw?.length });
  const memDir = getMemoryDir(username, charName);
  const resolvedMemDir = path.resolve(memDir);
  const results = [];

  for (const rawBlock of archiveOpsRaw) {
    const body = rawBlock.replace(/<!--([\s\S]*?)-->/g, "$1").trim();
    const ops = parseArchiveOperations(body);

    for (const op of ops) {
      try {
        let args;
        try {
          try {
            args = JSON.parse("[" + op.rawArgs + "]");
          } catch {
            let cleaned = op.rawArgs
              .replace(/(?<=^|[[,{:]\s*)'([^']*?)'/g, '"$1"')
              .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
            args = JSON.parse("[" + cleaned + "]");
          }
        } catch (parseErr) {
          wbD(null, "archiver", "executeMemoryArchiveOps:parseArgs", false, parseErr.message, { op: op.name });
          results.push({
            op: op.name,
            status: "error",
            error: `参数解析失败: ${parseErr.message}`,
          });
          continue;
        }

        wbT(null, "archiver", "executeMemoryArchiveOps:dispatch", { op: op.name });
        switch (op.name) {
          case "createFile":
            results.push(_opCreateFile(args, memDir, resolvedMemDir));
            break;
          case "appendToFile":
            results.push(_opAppendToFile(args, memDir, resolvedMemDir));
            break;
          case "updateFile":
            results.push(_opUpdateFile(args, memDir, resolvedMemDir));
            break;
          case "updateIndex":
            results.push(_opUpdateIndex(args, memDir, resolvedMemDir));
            break;
          case "moveEntries":
            results.push(_opMoveEntries(args, memDir, resolvedMemDir));
            break;
          case "clearTable":
            results.push(_opClearTable(args, tables));
            break;
          case "deleteFile":
            results.push({
              op: "deleteFile",
              status: "blocked",
              error: "安全策略禁止AI删除文件",
            });
            break;
          default:
            results.push({ op: op.name, status: "error", error: "未知操作" });
        }
      } catch (e) {
        wbD(null, "archiver", "executeMemoryArchiveOps:opError", false, e.message, { op: op.name });
        results.push({ op: op.name, status: "error", error: e.message });
      }
    }
  }

  wbT(null, "archiver", "executeMemoryArchiveOps:done", { resultCount: results.length });
  return results;
}

// ============================================================
// 各操作的内部实现
// ============================================================

function _opCreateFile(args, memDir, resolvedMemDir) {
  const [relPath, content] = args;
  if (!relPath) return { op: "createFile", status: "error", error: "缺少路径" };

  const fullPath = path.join(memDir, relPath);
  if (!isPathSafe(fullPath, resolvedMemDir)) {
    return {
      op: "createFile",
      status: "error",
      path: relPath,
      error: "路径越界",
    };
  }

  saveJsonFile(fullPath, content || {});
  wbT(null, "archiver", "createFile:done", { path: relPath });
  diag.debug(`archiver.createFile: ${relPath}`);
  return { op: "createFile", status: "ok", path: relPath };
}

function _opAppendToFile(args, memDir, resolvedMemDir) {
  const [relPath, newEntries] = args;
  if (!relPath)
    return { op: "appendToFile", status: "error", error: "缺少路径" };

  const fullPath = path.join(memDir, relPath);
  if (!isPathSafe(fullPath, resolvedMemDir)) {
    return {
      op: "appendToFile",
      status: "error",
      path: relPath,
      error: "路径越界",
    };
  }

  const existing = loadJsonFileIfExists(fullPath, null);
  if (existing === null) {
    // 文件不存在，创建新文件
    saveJsonFile(
      fullPath,
      Array.isArray(newEntries) ? { entries: newEntries } : newEntries || {},
    );
  } else {
    // 文件存在，追加到 entries 或 items 数组
    if (Array.isArray(newEntries)) {
      if (Array.isArray(existing.entries)) {
        existing.entries = existing.entries.concat(newEntries);
      } else if (Array.isArray(existing.items)) {
        existing.items = existing.items.concat(newEntries);
      } else {
        existing.entries = [].concat(newEntries);
      }
    }
    saveJsonFile(fullPath, existing);
  }

  wbT(null, "archiver", "appendToFile:done", { path: relPath });
  diag.debug(`archiver.appendToFile: ${relPath}`);
  return { op: "appendToFile", status: "ok", path: relPath };
}

function _opUpdateFile(args, memDir, resolvedMemDir) {
  const [relPath, content] = args;
  if (!relPath) return { op: "updateFile", status: "error", error: "缺少路径" };

  const fullPath = path.join(memDir, relPath);
  if (!isPathSafe(fullPath, resolvedMemDir)) {
    return {
      op: "updateFile",
      status: "error",
      path: relPath,
      error: "路径越界",
    };
  }

  if (Array.isArray(content)) {
    const existing = loadJsonFileIfExists(fullPath, { entries: [] });
    if (Array.isArray(existing.entries)) {
      existing.entries = existing.entries.concat(content);
    } else if (Array.isArray(existing.items)) {
      existing.items = existing.items.concat(content);
    } else {
      existing.entries = content;
    }
    saveJsonFile(fullPath, existing);
  } else {
    saveJsonFile(fullPath, content || {});
  }

  wbT(null, "archiver", "updateFile:done", { path: relPath });
  diag.debug(`archiver.updateFile: ${relPath}`);
  return { op: "updateFile", status: "ok", path: relPath };
}

function _opUpdateIndex(args, memDir, resolvedMemDir) {
  const [relPath, updateData] = args;
  if (!relPath)
    return { op: "updateIndex", status: "error", error: "缺少路径" };

  const fullPath = path.join(memDir, relPath);
  if (!isPathSafe(fullPath, resolvedMemDir)) {
    return {
      op: "updateIndex",
      status: "error",
      path: relPath,
      error: "路径越界",
    };
  }

  const existing = loadJsonFileIfExists(fullPath, {});
  if (
    updateData &&
    typeof updateData === "object" &&
    !Array.isArray(updateData)
  ) {
    for (const [key, val] of Object.entries(updateData)) {
      if (Array.isArray(val) && Array.isArray(existing[key])) {
        existing[key] = existing[key].concat(val);
      } else {
        existing[key] = val;
      }
    }
  }
  saveJsonFile(fullPath, existing);

  diag.debug(`archiver.updateIndex: ${relPath}`);
  return { op: "updateIndex", status: "ok", path: relPath };
}

/**
 * moveEntries 分发器，支持两种模式：
 *   1. moveEntries("srcDir", "destDir") — 整目录原子搬移（_moveEntriesDir → _atomicMoveInto）
 *   2. moveEntries("srcFile", [indices], "destFile") — 按索引从源 JSON 的 entries/items 数组移入目标文件
 * 约束：两种模式均做 isPathSafe 路径越界检查
 */
function _opMoveEntries(args, memDir, resolvedMemDir) {

  if (
    args.length === 2 &&
    typeof args[0] === "string" &&
    typeof args[1] === "string"
  ) {
    return _moveEntriesDir(args[0], args[1], memDir, resolvedMemDir);
  } else if (args.length >= 3) {
    return _moveEntriesByIndex(
      args[0],
      args[1],
      args[2],
      memDir,
      resolvedMemDir,
    );
  }

  return { op: "moveEntries", status: "error", error: "参数格式不匹配" };
}

function _moveEntriesDir(srcRel, destRel, memDir, resolvedMemDir) {
  const srcFull = path.join(memDir, srcRel);
  const destFull = path.join(memDir, destRel);

  if (
    !isPathSafe(srcFull, resolvedMemDir) ||
    !isPathSafe(destFull, resolvedMemDir)
  ) {
    return { op: "moveEntries", status: "error", error: "路径越界" };
  }

  if (!fs.existsSync(srcFull) || !fs.statSync(srcFull).isDirectory()) {
    return {
      op: "moveEntries",
      status: "error",
      error: `源目录不存在: ${srcRel}`,
    };
  }

  if (!fs.existsSync(destFull)) fs.mkdirSync(destFull, { recursive: true });

  const files = fs.readdirSync(srcFull);
  let moved = 0;

  for (const f of files) {
    const s = path.join(srcFull, f);
    const d = path.join(destFull, f);
    try {
      // 原子搬移：同卷 rename 单 syscall，替代旧 copy+unlink（无源目标并存窗口）
      _atomicMoveInto(s, d);
      moved++;
    } catch (e) {
      wbD(null, "archive", "moveEntriesDir:move_fail", false, "归档移动单个条目失败(rename 原子搬移失败，源完整无重复)", { file: f, src: s, dst: d, err: e.message });
      diag.warn(`archiver.moveEntries: 移动 ${f} 失败: ${e.message}`);
    }
  }

  wbT(null, "archiver", "moveEntriesDir:done", { from: srcRel, to: destRel, moved });
  diag.debug(
    `archiver.moveEntries(dir): ${srcRel} -> ${destRel}, moved=${moved}`,
  );
  return { op: "moveEntries", status: "ok", from: srcRel, to: destRel, moved };
}

function _moveEntriesByIndex(srcRel, indices, destRel, memDir, resolvedMemDir) {
  const srcFull = path.join(memDir, srcRel);
  const destFull = path.join(memDir, destRel);

  if (
    !isPathSafe(srcFull, resolvedMemDir) ||
    !isPathSafe(destFull, resolvedMemDir)
  ) {
    return { op: "moveEntries", status: "error", error: "路径越界" };
  }

  if (!Array.isArray(indices)) {
    return { op: "moveEntries", status: "error", error: "索引参数不是数组" };
  }

  const srcData = loadJsonFileIfExists(srcFull, null);
  if (!srcData) {
    return {
      op: "moveEntries",
      status: "error",
      error: `源文件不存在: ${srcRel}`,
    };
  }

  const srcArrayKey = Array.isArray(srcData.entries)
    ? "entries"
    : Array.isArray(srcData.items)
      ? "items"
      : null;
  if (!srcArrayKey) {
    return {
      op: "moveEntries",
      status: "error",
      error: "源文件无 entries/items 数组",
    };
  }

  const srcArray = srcData[srcArrayKey];
  const sortedIndices = [
    ...new Set([...indices].map(Number).filter((i) => !isNaN(i))),
  ].sort((a, b) => b - a);

  const toMove = [];
  for (const idx of sortedIndices) {
    if (idx >= 0 && idx < srcArray.length) toMove.unshift(srcArray[idx]);
  }

  if (toMove.length === 0) {
    return { op: "moveEntries", status: "ok", moved: 0, note: "无有效索引" };
  }

  // 追加到目标文件
  const destData = loadJsonFileIfExists(destFull, {});
  const destArrayKey = Array.isArray(destData.entries)
    ? "entries"
    : Array.isArray(destData.items)
      ? "items"
      : srcArrayKey;
  if (!Array.isArray(destData[destArrayKey])) destData[destArrayKey] = [];
  destData[destArrayKey] = destData[destArrayKey].concat(toMove);
  saveJsonFile(destFull, destData);

  // 从源文件按降序删除
  for (const idx of sortedIndices) {
    if (idx >= 0 && idx < srcArray.length) srcArray.splice(idx, 1);
  }
  saveJsonFile(srcFull, srcData);

  wbT(null, "archiver", "moveEntriesByIndex:done", { from: srcRel, to: destRel, moved: toMove.length });
  diag.debug(
    `archiver.moveEntries(index): ${srcRel} -> ${destRel}, moved=${toMove.length}`,
  );
  return {
    op: "moveEntries",
    status: "ok",
    from: srcRel,
    to: destRel,
    moved: toMove.length,
  };
}

function _opClearTable(args, tables) {
  const [tableId] = args;
  if (typeof tableId !== "number" || !tables) {
    return { op: "clearTable", status: "error", error: "无效表格ID或引用" };
  }

  const target = tables.find((t) => t.id === tableId);
  if (target) {
    target.rows = [];
    diag.debug(`archiver.clearTable: #${tableId}(${target.name})`);
    return { op: "clearTable", status: "ok", tableId };
  }

  // 回退为数组下标
  if (tableId >= 0 && tableId < tables.length) {
    tables[tableId].rows = [];
    diag.debug(
      `archiver.clearTable: 回退下标[${tableId}](${tables[tableId].name})`,
    );
    return { op: "clearTable", status: "ok", tableId, note: "回退数组下标" };
  }

  return { op: "clearTable", status: "error", error: "未找到表格" };
}
