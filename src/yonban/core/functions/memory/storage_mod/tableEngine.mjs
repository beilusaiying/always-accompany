import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * tableEngine.mjs — 表格 CRUD 引擎 + 文本生成 + 热记忆读取
 *
 * 功能链：replyHandler(解析 <tableEdit> 标签) → executeTableOperations(tables, ops) → 内存修改 → 调用方 saveTablesData 落盘
 *         getPromptHandler → tablesToPromptText / readHotMemoryForInjection → 注入提示词
 * why：AI 回复中的表格操作指令需要统一执行引擎来做 add/update/delete/swap 等 CRUD，同时负责把表格数据格式化成
 *      可注入提示词的文本；热记忆文件(hot/*.json)也由本模块统一读取供注入。
 * 关联链：
 *   ← replyHandler（执行表格操作）
 *   ← getPromptHandler（读表格文本 + 热记忆）
 *   → storage.mjs（getMemoryDir / loadJsonFile / saveJsonFile）
 *   → replyParser.mjs（parseOperationArgs，解析操作参数）
 * 影响范围：修改内存中 tables 数组（不直接写盘，由调用方 saveTablesData 持久化）；读 hot/*.json（只读）
 * 使用效果：executeTableOperations 返回成功操作计数；B01 延迟删除修复确保删行后索引不漂移
 */

import fs from "node:fs";
import path from "node:path";

import { diag, getMemoryDir, loadJsonFile, saveJsonFile } from "./storage.mjs";

import { parseOperationArgs } from "../handler/replyParser.mjs";


// ============================================================
// 表格操作执行引擎
// ============================================================

/**
 * 执行表格操作
 * @param {object[]} tables - 表格数组
 * @param {Array<{type: string, rawArgs: string}>} operations - 操作列表
 * @returns {number} 成功执行的操作数
 */
export function executeTableOperations(tables, operations) {
  wbT(null, "tableEngine", "executeTableOperations:enter", { opCount: operations.length, tableCount: tables.length });
  let successCount = 0;
  // 断点#5 修（0716 工具链走查）：失败明细结构化返回——原失败只进 diag/console（人类日志），
  // AI 发 tableEdit 失败后下一轮零反馈以为写成功无法自纠（对比 IDE/联网链均有失败回喂）。
  // 消费：replyHandler 喂 pendingTableEditFeedback → getPromptHandler 下轮注入纯事实呈现。
  const failures = [];
  const _fail = (op, reason) => failures.push({ op: `${op.type}(${String(op.rawArgs ?? "").slice(0, 60)})`, reason });
  const _deferredDeletes = [];

  diag.debug(`executeTableOperations: ${operations.length} 个操作待执行`);

  for (const op of operations) {
    const parsed = parseOperationArgs(op.type, op.rawArgs);
    if (!parsed) {
      wbD(null, "tableEngine", "executeTableOperations:parseFail", false, "无法解析操作", { opType: op.type, rawArgs: op.rawArgs });
      diag.warn(
        `executeTableOperations: 无法解析操作: ${op.type}(${op.rawArgs})`,
      );
      console.warn(`[beilu-memory] 无法解析操作: ${op.type}(${op.rawArgs})`);
      _fail(op, "参数无法解析");
      continue;
    }

    const table = tables.find((t) => t.id === parsed.tableIndex);
    if (!table) {
      const fallbackTable = tables[parsed.tableIndex];
      if (fallbackTable) {
        diag.warn(
          `executeTableOperations: 按 id=${parsed.tableIndex} 未找到表格，回退为数组索引 [${parsed.tableIndex}] -> #${fallbackTable.id}(${fallbackTable.name})`,
        );
      } else {
        diag.warn(
          `executeTableOperations: 表格 #${parsed.tableIndex} 不存在 (共${tables.length}个表格, ids=${tables.map((t) => t.id).join(",")})`,
        );
        console.warn(`[beilu-memory] 表格 #${parsed.tableIndex} 不存在`);
        _fail(op, `表格 #${parsed.tableIndex} 不存在（现有 ids=${tables.map((t) => t.id).join(",")}）`);
        continue;
      }
    }

    const targetTable = table || tables[parsed.tableIndex];
    if (!targetTable) continue;

    if (targetTable.enabled === false) {
      diag.warn(
        `executeTableOperations: 操作目标表格 #${targetTable.id}(${targetTable.name}) 已禁用，操作仍执行（数据层不阻止）`,
      );
    }

    try {
      switch (op.type) {
        case "insertRow": {
          const newRow = new Array(targetTable.columns.length).fill("");
          for (const [colIdx, value] of Object.entries(parsed.values)) {
            const idx = parseInt(colIdx, 10);
            if (idx >= 0 && idx < targetTable.columns.length) {
              newRow[idx] = value;
            }
          }
          targetTable.rows.push(newRow);
          diag.debug(
            `executeTableOperations: insertRow(#${targetTable.id}) -> row[${targetTable.rows.length - 1}], ${Object.keys(parsed.values).length} 列`,
          );
          successCount++;
          break;
        }
        case "updateRow": {
          if (
            parsed.rowIndex < 0 ||
            parsed.rowIndex >= targetTable.rows.length
          ) {
            diag.warn(
              `executeTableOperations: updateRow 行 #${parsed.rowIndex} 不存在于表格 #${targetTable.id}(${targetTable.name}) (共${targetTable.rows.length}行), 自动降级为 insertRow`,
            );
            console.warn(
              `[beilu-memory] updateRow 越界->降级insertRow: 行 #${parsed.rowIndex} 不存在于表格 #${targetTable.id}(${targetTable.name}), 当前行数=${targetTable.rows.length}`,
            );
            const newRow = new Array(targetTable.columns.length).fill("");
            for (const [colIdx, value] of Object.entries(parsed.values)) {
              const idx = parseInt(colIdx, 10);
              if (idx >= 0 && idx < targetTable.columns.length) {
                newRow[idx] = value;
              }
            }
            targetTable.rows.push(newRow);
            diag.debug(
              `executeTableOperations: updateRow->insertRow(#${targetTable.id}) -> row[${targetTable.rows.length - 1}]`,
            );
            successCount++;
            break;
          }
          const updatedCols = [];
          for (const [colIdx, value] of Object.entries(parsed.values)) {
            const idx = parseInt(colIdx, 10);
            if (idx >= 0 && idx < targetTable.columns.length) {
              const oldVal = targetTable.rows[parsed.rowIndex][idx];
              targetTable.rows[parsed.rowIndex][idx] = value;
              updatedCols.push(
                `col${idx}: "${(oldVal || "").substring(0, 20)}" -> "${value.substring(0, 20)}"`,
              );
            }
          }
          diag.debug(
            `executeTableOperations: updateRow(#${targetTable.id}, row${parsed.rowIndex}): ${updatedCols.join(", ")}`,
          );
          successCount++;
          break;
        }
        case "deleteRow": {
          _deferredDeletes.push({
            table: targetTable,
            rowIndex: parsed.rowIndex,
            rawArgs: op.rawArgs,
          });
          break;
        }
      }
    } catch (e) {
      wbD(null, "tableEngine", "executeTableOperations:opError", false, e.message, { opType: op.type });
      diag.error(`executeTableOperations: ${op.type} 异常:`, e.message);
      console.error(`[beilu-memory] 执行 ${op.type} 失败:`, e.message);
      _fail(op, `执行异常: ${e.message}`);
    }
  }

  // B01修复：按降序处理所有延迟的 deleteRow 操作
  if (_deferredDeletes.length > 0) {
    const deletesByTable = new Map();
    for (const del of _deferredDeletes) {
      const key = del.table.id;
      if (!deletesByTable.has(key)) deletesByTable.set(key, []);
      deletesByTable.get(key).push(del);
    }
    for (const [, dels] of deletesByTable) {
      dels.sort((a, b) => b.rowIndex - a.rowIndex);
      const seen = new Set();
      for (const del of dels) {
        if (seen.has(del.rowIndex)) continue;
        seen.add(del.rowIndex);
        if (del.rowIndex < 0 || del.rowIndex >= del.table.rows.length) {
          diag.warn(
            `executeTableOperations: deleteRow 行 #${del.rowIndex} 不存在于表格 #${del.table.id}(${del.table.name}) (共${del.table.rows.length}行)`,
          );
          console.warn(
            `[beilu-memory] deleteRow 越界: 行 #${del.rowIndex} 不存在于表格 #${del.table.id}(${del.table.name}), 当前行数=${del.table.rows.length}`,
          );
          _fail({ type: "deleteRow", rawArgs: del.rawArgs }, `行 #${del.rowIndex} 不存在于表格 #${del.table.id}（共 ${del.table.rows.length} 行）`);
          continue;
        }
        const deletedRow = del.table.rows[del.rowIndex];
        diag.debug(
          `executeTableOperations: deleteRow(#${del.table.id}, row${del.rowIndex}): ${JSON.stringify(deletedRow).substring(0, 100)}`,
        );
        del.table.rows.splice(del.rowIndex, 1);
        successCount++;
      }
    }
    diag.debug(
      `executeTableOperations: 延迟删除完成，共 ${_deferredDeletes.length} 个 deleteRow 操作`,
    );
  }

  diag.debug(
    `executeTableOperations: 完成 ${successCount}/${operations.length} 成功`,
  );
  wbT(null, "tableEngine", "executeTableOperations:done", { success: successCount, total: operations.length, failCount: failures.length });
  return { successCount, failures };
}

// ============================================================
// 表格 -> 文本
// ============================================================

/**
 * 将全部表格转为注入文本（含操作规则）
 */
// ★ 表格缓存：记录上次注入的hash，只注入有变化的表格到非缓存位置
const _tableHashCache = new Map(); // key=`userName/charName/tableId`（D-03 含 username 防跨用户哈希串号）, value=hash

function _simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function tablesToPromptText(tables, charName, userName) {
  wbT(null, "tableEngine", "tablesToPromptText:enter", { tableCount: tables.length, charName });
  const enabledTables = tables.filter((t) => t.enabled !== false);
  const disabledIds = tables
    .filter((t) => t.enabled === false)
    .map((t) => `#${t.id}`);
  diag.debug(
    `tablesToPromptText: ${enabledTables.length}/${tables.length} 表格注入 prompt${disabledIds.length ? `, 禁用: ${disabledIds.join(",")}` : ""}`,
  );
  const lines = ["[记忆表格]"];
  const changedTables = [];
  const unchangedTables = [];

  for (const table of enabledTables) {
    const name = table.name
      .replace(/\{\{char\}\}/g, charName)
      .replace(/\{\{user\}\}/g, userName);
    const columns = table.columns.map((c) =>
      c.replace(/\{\{char\}\}/g, charName).replace(/\{\{user\}\}/g, userName),
    );
    // 计算当前hash
    const _cacheKey = `${userName}/${charName}/${table.id}`; // D-03: 含 username，防多用户同 charName 表格哈希串号（全局 Map 跨用户共享）
    const _curHash = _simpleHash(JSON.stringify(table.rows));
    const _lastHash = _tableHashCache.get(_cacheKey);
    const _changed = _curHash !== _lastHash;
    _tableHashCache.set(_cacheKey, _curHash);

    if (_changed || !_lastHash) {
      // ★ 有变化或首次：完整注入（非缓存位置）
      lines.push(`\n#${table.id} ${name} [已更新]`);
      lines.push(columns.join(","));
      for (let _ri = 0; _ri < table.rows.length; _ri++) {
        lines.push(`[${_ri}] ${table.rows[_ri].join(",")}`);
      }
      changedTables.push(table.id);
    } else {
      // ★ 无变化：只输出表头和行数摘要（缓存位置，省token）
      lines.push(`\n#${table.id} ${name} [缓存,${table.rows.length}行]`);
      unchangedTables.push(table.id);
    }
  }
  if (unchangedTables.length > 0) {
    diag.debug(`tablesToPromptText: 缓存表格#${unchangedTables.join(",#")}，完整注入#${changedTables.join(",#") || "无"}`);
  }

  // ★ 导出缓存/非缓存分离数据（供getPromptHandler按depth分别注入）
  // cachedTableIds: 没变的表格ID列表（应放到高depth=999缓存区）
  // freshTableIds: 有变化的表格ID列表（放到正常depth）
  lines._cacheInfo = { cachedIds: unchangedTables, freshIds: changedTables };

  lines.push("\n[表格操作规则]");
  lines.push("当满足以下条件时，在回复末尾使用 <tableEdit> 标签进行操作：");
  for (const table of enabledTables) {
    const name = table.name
      .replace(/\{\{char\}\}/g, charName)
      .replace(/\{\{user\}\}/g, userName);
    lines.push(`#${table.id} ${name}:`);
    if (table.rules.insert) lines.push(`  插入: ${table.rules.insert}`);
    if (table.rules.update) lines.push(`  更新: ${table.rules.update}`);
    if (table.rules.delete) lines.push(`  删除: ${table.rules.delete}`);
  }

  lines.push("\n操作格式:");
  lines.push("<tableEdit>");
  lines.push("<!--");
  lines.push('insertRow(表格编号, {列编号: "值", ...})');
  lines.push('updateRow(表格编号, 行编号, {列编号: "新值", ...})');
  lines.push("deleteRow(表格编号, 行编号)");
  lines.push("archiveRows(表格编号, 行编号, 行编号...)");
  lines.push("-->");
  lines.push("</tableEdit>");
  lines.push("deleteRow=彻底删除不留档；archiveRows=移入归档文件（过时但可能需要回查的内容用它）。同一回复中对同一表格不要混用 deleteRow 和 archiveRows。");

  return lines.join("\n");
}

/**
 * 将全部表格转为纯数据文本（不含操作规则，用于 {{tableData}} 宏替换）
 */
export function generateTableDataOnly(tables, charName, userName) {
  wbT(null, "tableEngine", "generateTableDataOnly:enter", { tableCount: tables.length, charName });
  const enabledTables = tables.filter((t) => t.enabled !== false);
  const disabledIds = tables
    .filter((t) => t.enabled === false)
    .map((t) => `#${t.id}`);
  diag.debug(
    `generateTableDataOnly: ${enabledTables.length}/${tables.length} 表格输出${disabledIds.length ? `, 禁用: ${disabledIds.join(",")}` : ""}`,
  );
  const lines = [];

  for (const table of enabledTables) {
    const name = table.name
      .replace(/\{\{char\}\}/g, charName)
      .replace(/\{\{user\}\}/g, userName);
    lines.push(`\n#${table.id} ${name}`);
    const columns = table.columns.map((c) =>
      c.replace(/\{\{char\}\}/g, charName).replace(/\{\{user\}\}/g, userName),
    );
    lines.push(columns.join(","));
    for (let _ri = 0; _ri < table.rows.length; _ri++) {
      lines.push(`[${_ri}] ${table.rows[_ri].join(",")}`);
    }
    if (table.rules) {
      lines.push(
        `规则: 插入=${table.rules.insert} | 更新=${table.rules.update} | 删除=${table.rules.delete}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * ★ 生成表格数据（缓存/非缓存分离版）
 * 返回 { cached: string, fresh: string, allText: string }
 * - cached: 没变的表格（只表头+行数）→ 放到高depth缓存区
 * - fresh: 有变化的表格（完整数据）→ 放到低depth非缓存区
 * - allText: 合并后的完整文本（兼容宏替换）
 */
export function generateTableDataSplit(tables, charName, userName) {
  const enabledTables = tables.filter((t) => t.enabled !== false);
  const cachedLines = [];
  const freshLines = [];

  for (const table of enabledTables) {
    const name = table.name
      .replace(/\{\{char\}\}/g, charName)
      .replace(/\{\{user\}\}/g, userName);
    const columns = table.columns.map((c) =>
      c.replace(/\{\{char\}\}/g, charName).replace(/\{\{user\}\}/g, userName),
    );
    const _cacheKey = `${userName}/${charName}/${table.id}`; // D-03: 含 username，防多用户同 charName 表格哈希串号（全局 Map 跨用户共享）
    const _curHash = _simpleHash(JSON.stringify(table.rows));
    const _lastHash = _tableHashCache.get(_cacheKey);
    const _changed = _curHash !== _lastHash;
    _tableHashCache.set(_cacheKey, _curHash);

    if (_changed || !_lastHash) {
      freshLines.push(`\n#${table.id} ${name}`);
      freshLines.push(columns.join(","));
      for (let _ri = 0; _ri < table.rows.length; _ri++) {
        freshLines.push(`[${_ri}] ${table.rows[_ri].join(",")}`);
      }
    } else {
      cachedLines.push(`#${table.id} ${name} [${table.rows.length}行]`);
    }
  }

  const cached = cachedLines.length > 0 ? "[缓存表格]\n" + cachedLines.join("\n") + "\n[/缓存表格]" : "";
  const fresh = freshLines.length > 0 ? "[更新表格]\n" + freshLines.join("\n") + "\n[/更新表格]" : "";
  return { cached, fresh, allText: (cached ? cached + "\n" : "") + (fresh || "") };
}

// ============================================================
// 热记忆层读取
// ============================================================

/**
 * 读取热记忆层内容用于注入
 */
export function readHotMemoryForInjection(username, charName, opts = {}) {
  wbT(null, "tableEngine", "readHotMemoryForInjection:enter", { username, charName });
  const memDir = getMemoryDir(username, charName);
  const hotDir = path.join(memDir, "hot");
  if (!fs.existsSync(hotDir)) { wbT(null, "tableEngine", "readHotMemoryForInjection:noHotDir", { hotDir }); return ""; }

  const lines = [];

  // #7 想要记住的关于 user 的事情
  const rememberDir = path.join(hotDir, "remember_about_user");
  if (fs.existsSync(rememberDir)) {
    const files = fs
      .readdirSync(rememberDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    if (files.length > 0) {
      lines.push("\n* 想要记住的关于{{user}}的事情:");
      for (const file of files) {
        try {
          const data = loadJsonFile(path.join(rememberDir, file));
          const entries = data.entries || data;
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const text =
                typeof entry === "string"
                  ? entry
                  : entry.content || entry.thing || JSON.stringify(entry);
              lines.push(`  - ${file.replace(".json", "")}: ${text}`);
            }
          }
        } catch (e) {
          // S4：原空 catch 静默吞坏文件无日志 → 加 wbD 观测（非致命，仍跳过该文件继续）
          wbD(null, "table", "tableEngine:hot_file_skip", false, "跳过坏 hot 记忆文件", { err: e.message });
        }
      }
    }
  }

  // #8 永远记住的事情（Top-K 100条）
  const foreverPath = path.join(hotDir, "forever.json");
  if (fs.existsSync(foreverPath)) {
    try {
      const data = loadJsonFile(foreverPath);
      const entries = data.entries || [];
      if (entries.length > 0) {
        const now = Date.now();
        const scored = entries.map((entry, idx) => {
          const weight = (typeof entry === "object" ? entry.weight : null) || 1;
          const lastTriggered =
            typeof entry === "object" && entry.last_triggered
              ? new Date(entry.last_triggered).getTime()
              : now - idx * 86400000;
          const daysSince = Math.max(0, (now - lastTriggered) / 86400000);
          const recencyScore = 1 / (1 + daysSince * 0.1);
          return { entry, score: weight * recencyScore };
        });
        scored.sort((a, b) => b.score - a.score);
        const _foreverTopK = Math.max(1, opts.foreverTopK || 100);
        const topK = scored.slice(0, _foreverTopK);
        lines.push(`\n* 永远记住的事情 (${topK.length}/${entries.length}条):`);
        // R5：接通悬空强化回路——被真注入(opts.recordHit)命中的条目刷新 last_triggered，让 Top-K
        //   recency 真实反映命中。节流：仅 last_triggered 距今 >1 天才刷(同日多次注入不重复写盘)；
        //   仅 recordHit 路径(主对话真注入 getPromptHandler)落盘，预览/P系列不传=不污染命中。
        let _hitDirty = false;
        for (const { entry } of topK) {
          const text =
            typeof entry === "string"
              ? entry
              : entry.content || entry.event || JSON.stringify(entry);
          lines.push(`  - ${text}`);
          if (opts.recordHit && typeof entry === "object") {
            const _lt = entry.last_triggered ? new Date(entry.last_triggered).getTime() : 0;
            if (now - _lt > 86400000) { entry.last_triggered = new Date(now).toISOString(); _hitDirty = true; }
          }
        }
        if (opts.recordHit && _hitDirty) {
          try { saveJsonFile(foreverPath, data); }
          catch (e) { wbD(null, "table", "tableEngine:forever_hit_save_fail", false, "forever.json 命中刷新写盘失败(last_triggered 未持久化)", { path: foreverPath, err: e.message }); diag.warn(`[tableEngine] forever 命中刷新写盘失败: ${e.message}`); }
        }
      }
    } catch (e) {
      // S4：原空 catch 静默吞坏 forever.json → 加 wbD 观测（非致命，跳过 forever 注入继续）
      wbD(null, "table", "tableEngine:forever_file_skip", false, "跳过坏 forever.json", { err: e.message });
    }
  }

  // 约定/任务/计划
  const appointmentsPath = path.join(hotDir, "appointments.json");
  if (fs.existsSync(appointmentsPath)) {
    try {
      const data = loadJsonFile(appointmentsPath);
      const entries = data.entries || [];
      if (entries.length > 0) {
        lines.push("\n* 约定/任务/计划:");
        for (const entry of entries) {
          const text =
            typeof entry === "string"
              ? entry
              : entry.content || entry.task || JSON.stringify(entry);
          lines.push(`  - ${text}`);
        }
      }
    } catch (e) {
      wbD(null, "table", "tableEngine:hot_context_skip", false, "跳过坏 context.json", { err: e.message });
    }
  }

  // 用户自我介绍
  const profilePath = path.join(hotDir, "user_profile.json");
  if (fs.existsSync(profilePath)) {
    try {
      const data = loadJsonFile(profilePath);
      const entries = data.entries || [];
      if (entries.length > 0) {
        lines.push("\n* 关于{{user}}:");
        for (const entry of entries) {
          const text =
            typeof entry === "string"
              ? entry
              : entry.content || JSON.stringify(entry);
          lines.push(`  - ${text}`);
        }
      }
    } catch (e) {
      wbD(null, "table", "tableEngine:hot_profile_skip", false, "跳过坏 user_profile.json", { err: e.message });
    }
  }

  // 温记忆层月总结索引
  const warmIndexPath = path.join(hotDir, "warm_monthly_index.json");
  if (fs.existsSync(warmIndexPath)) {
    try {
      const data = loadJsonFile(warmIndexPath);
      const months = data.months || [];
      if (months.length > 0) {
        lines.push("\n* 历史记忆索引:");
        for (const m of months) {
          lines.push(`  - ${m.year}年${m.month}月: ${m.summary || "(无摘要)"}`);
        }
      }
    } catch (e) {
      wbD(null, "table", "tableEngine:warm_index_skip", false, "跳过坏 warm_monthly_index.json", { err: e.message });
    }
  }

  return lines.join("\n");
}
