/**
 * replyParser.mjs — AI 回复标签解析器（纯解析层，无副作用）。
 *
 * 【功能链】
 *   从 AI 回复原始文本中提取并解析各类结构化标签，返回操作列表供 replyHandler / aiRunner 驱动副作用。
 *   自身不写磁盘、不改状态——只做"文本 → 结构化数据"的转换。
 *   覆盖：<tableEdit>（括号计数法解析，兼容 AI 放在代码块里的情况）、<memoryArchive>、
 *   <memorySearch>、<memoryNote>、<presetSwitch>，及 P8 联网三件套
 *   <searchQuery> / <noSearch> / <searchResult>。
 *
 * 【why】
 *   把解析逻辑从 replyHandler（副作用分派）和 aiRunner（AI 调用）中抽出来独立成模块，
 *   原因是两个模块都需要解析同样的标签，共用解析器可以避免重复、保证格式兼容性一致。
 *   括号计数法（非正则）解析 tableEdit 是因为 AI 生成的参数值中可能含 `)` 等特殊字符，
 *   正则匹配会在这些字符处提前截断。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块（纯后端工具库）。
 *   数据流：AI 回复文本 → replyHandler.handleReply() → parseTableEditTags() / parseMemoryArchiveTags() 等
 *   → 操作列表 → replyHandler 各副作用分支执行（executeTableOperations / executeMemoryArchiveOps 等）
 *   → 结果通过 reply.extension 或 WS 广播传回前端。
 *
 * 【关联链】
 *   ← replyHandler.mjs（消费全部解析函数驱动副作用）
 *   ← aiRunner.mjs（消费 parseTableEditTags / parseMemoryArchiveTags / parseSearchQueryTags 等
 *      用于多轮 P1/P8 AI 调用内部的标签处理）
 *   → storage.mjs（getMemoryDir / loadJsonFile / saveJsonFile — 仅 computeTableEditHash 持久化 hash）
 *
 * 【影响范围】
 *   纯读取解析，不写业务数据（T5-4 校准：原 parseMemoryNoteTags 曾在此直写 _config.json 的
 *   pending_tasks——违反本契约，已把落盘挪到 handler 层走 storage.appendPendingTasks 收口，
 *   本模块恢复"只解析返回、由调用方落盘"）。
 *   唯一写操作：computeTableEditHash 把 hash 落到 _tableEditHash.json（防重处理，幂等）。
 *
 * 【使用效果】
 *   replyHandler 和 aiRunner 都能拿到统一格式的操作列表，
 *   同一份解析逻辑保证标签格式兼容，hash 防重避免同一条 tableEdit 被执行两次。
 *
 * 导出函数：
 *   parseTableEditTags / parseMemoryArchiveTags / parseMemorySearchTags / parseMemoryNoteTags /
 *   parseSearchQueryTags / parseNoSearchTag / parseSearchResultTags /
 *   parseOperationArgs / parseObjectLiteral / parseArchiveOperations /
 *   computeTableEditHash（lastProcessedTableEditHash 重复份已删,单源=aiRunner.mjs:206）
 *
 * 依赖：仅 storage.mjs（getMemoryDir / loadJsonFile / saveJsonFile）
 */

import fs from "node:fs";
import path from "node:path";

import { getMemoryDir, loadJsonFile, saveJsonFile } from "../storage_mod/storage.mjs";

// ============================================================
// <tableEdit> 解析器
// ============================================================

/**
 * 从 AI 回复内容中提取 <tableEdit> 标签并解析操作
 * @param {string} content - AI 回复内容
 * @returns {{ operations: Array<{type: string, rawArgs: string}>, cleanContent: string }}
 */
export function parseTableEditTags(content) {
  if (!content) return { operations: [], cleanContent: content };

  // ★ 适配AI把tableEdit放在代码块(```)里的情况
  // 提取代码块中的tableEdit标签，移到外面
  content = content.replace(/```[\w]*\s*(<tableEdit>[\s\S]*?<\/tableEdit>)\s*```/gi, "$1");

  const tagRegex = /<tableEdit>([\s\S]*?)<\/tableEdit>/gi;
  const operations = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const body = match[1]
      .replace(/<!--([\s\S]*?)-->/g, "$1") // 去掉 HTML 注释包裹
      .trim();

    // 使用括号计数法解析操作（取代脆弱的正则），支持值中含 ) 等特殊字符
    const opNames = [
      "insertRow",
      "updateRow",
      "deleteRow",
      "insert_row",
      "update_row",
      "delete_row",
      "archiveRows",
      "archive_rows",
      "moveToStash",
      "move_to_stash",
    ]; // 兼容 snake_case；moveToStash=表#5随身物品归档教的词，无独立仓库表→等价 deleteRow(移出随身)
    // archiveRows（凛倾 2026-07-16「可以加」）：AI 正规归档指令——行移入热层归档文件（可恢复），
    //   区别于 deleteRow（不留档）。执行不走 executeTableOperations（内存 CRUD），由 replyHandler
    //   分流到 archiveTableRowsGeneric 引擎（热层单源+去重+快照，与设置弹窗/自动归档同一条链）。
    const OP_MAP = {
      insertrow: "insertRow",
      insert_row: "insertRow",
      updaterow: "updateRow",
      update_row: "updateRow",
      deleterow: "deleteRow",
      delete_row: "deleteRow",
      archiverows: "archiveRows",
      archive_rows: "archiveRows",
      movetostash: "deleteRow",
      move_to_stash: "deleteRow",
    };
    let pos = 0;
    while (pos < body.length) {
      let found = false;
      for (const opName of opNames) {
        if (
          !body
            .substring(pos, pos + opName.length)
            .toLowerCase()
            .startsWith(opName.toLowerCase())
        )
          continue;
        // 确认不是某个更长标识符的一部分
        const before = pos > 0 ? body[pos - 1] : " ";
        if (/[a-zA-Z_]/.test(before)) continue;

        // 找到开括号
        let parenStart = pos + opName.length;
        while (parenStart < body.length && body[parenStart] !== "(") {
          if (!/\s/.test(body[parenStart])) break;
          parenStart++;
        }
        if (parenStart >= body.length || body[parenStart] !== "(") continue;

        // 括号计数法找到匹配的闭括号
        let depth = 1;
        let parenEnd = parenStart + 1;
        let inString = false;
        let stringChar = "";

        while (parenEnd < body.length && depth > 0) {
          const ch = body[parenEnd];
          if (inString) {
            if (ch === "\\") {
              parenEnd += 2;
              continue;
            }
            if (ch === stringChar) inString = false;
          } else {
            if (ch === '"' || ch === "'" || ch === "`") {
              inString = true;
              stringChar = ch;
            } else if (ch === "(") depth++;
            else if (ch === ")") depth--;
          }
          parenEnd++;
        }

        if (depth === 0) {
          const rawArgs = body.slice(parenStart + 1, parenEnd - 1).trim();
          const normalizedType = OP_MAP[opName.toLowerCase()] || opName;
          operations.push({ type: normalizedType, rawArgs });
          pos = parenEnd;
          found = true;
          break;
        }
      }
      if (!found) pos++;
    }
  }

  // 清除标签
  const cleanContent = content
    .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, "")
    .trim();

  return { operations, cleanContent };
}

/**
 * 解析操作参数
 * insertRow(tableIndex, {colIndex: "value", ...})
 * updateRow(tableIndex, rowIndex, {colIndex: "value", ...})
 * deleteRow(tableIndex, rowIndex)
 * archiveRows(tableIndex, rowIndex, rowIndex...) — 归档（热层文件，可恢复）
 *
 * @param {string} type
 * @param {string} rawArgs
 * @returns {{ tableIndex: number, rowIndex?: number, values?: Record<number, string> } | null}
 */
export function parseOperationArgs(type, rawArgs) {
  try {
    switch (type) {
      case "insertRow": {
        // insertRow(tableIndex, {0: "val", 1: "val"})
        const commaIdx = rawArgs.indexOf(",");
        if (commaIdx === -1) return null;
        const tableIndex = parseInt(rawArgs.slice(0, commaIdx).trim(), 10);
        const valuesStr = rawArgs.slice(commaIdx + 1).trim();
        const values = parseObjectLiteral(valuesStr);
        if (isNaN(tableIndex) || !values) return null;
        return { tableIndex, values };
      }
      case "updateRow": {
        // updateRow(tableIndex, rowIndex, {0: "val"})
        const firstComma = rawArgs.indexOf(",");
        if (firstComma === -1) return null;
        const tableIndex = parseInt(rawArgs.slice(0, firstComma).trim(), 10);
        const rest = rawArgs.slice(firstComma + 1).trim();
        const secondComma = rest.indexOf(",");
        if (secondComma === -1) return null;
        const rowIndex = parseInt(rest.slice(0, secondComma).trim(), 10);
        const valuesStr = rest.slice(secondComma + 1).trim();
        const values = parseObjectLiteral(valuesStr);
        if (isNaN(tableIndex) || isNaN(rowIndex) || !values) return null;
        return { tableIndex, rowIndex, values };
      }
      case "deleteRow": {
        // deleteRow(tableIndex, rowIndex)
        const parts = rawArgs.split(",").map((s) => parseInt(s.trim(), 10));
        if (parts.length < 2 || parts.some(isNaN)) return null;
        return { tableIndex: parts[0], rowIndex: parts[1] };
      }
      case "archiveRows": {
        // archiveRows(tableIndex, rowIndex, rowIndex...) — 行移入热层归档文件（可恢复）
        const parts = rawArgs.split(",").map((s) => parseInt(s.trim(), 10));
        if (parts.length < 2 || parts.some(isNaN)) return null;
        return { tableIndex: parts[0], rowIndices: [...new Set(parts.slice(1))] };
      }
      default:
        return null;
    }
  } catch (e) {
    console.error("[beilu-memory] parseOperationArgs error:", e.message);
    return null;
  }
}

/**
 * 解析类似 {0: "value", 1: "value"} 的对象字面量
 * 支持双引号和单引号的值
 * @param {string} str
 * @returns {Record<number, string> | null}
 */
export function parseObjectLiteral(str) {
  try {
    // 尝试直接 JSON 解析（将未加引号的 key 修复为字符串 key）
    // {0: "val", 1: "val"} → {"0": "val", "1": "val"}
    // 注意：只替换作为分隔符的单引号/反引号，不替换值内部的单引号（如 it's）
    // 策略：提取单引号/反引号包裹的值，转义内部双引号后改用双引号包裹
    const jsonStr = str
      .replace(/[`']([\s\S]*?)[`']/g, (_, inner) => {
        // 转义内部双引号，保留单引号原样
        return '"' + inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      })
      .replace(/(\d+)\s*:/g, '"$1":'); // 数字key加引号
    const obj = JSON.parse(jsonStr);
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[parseInt(k, 10)] = String(v);
    }
    return result;
  } catch (e) {
    // 回退1：手动正则提取（支持双引号、单引号、反引号包裹的值）
    const result = {};
    const quotedRegex = /(\d+)\s*:\s*["'`]([\s\S]*?)["'`]\s*(?=[,}]|$)/g;
    let m;
    while ((m = quotedRegex.exec(str)) !== null) {
      result[parseInt(m[1], 10)] = m[2];
    }
    // 回退2：如果引号方式没提取到，尝试无引号值（AI 有时省略引号）
    if (Object.keys(result).length === 0) {
      const unquotedRegex = /(\d+)\s*:\s*([^,}]+)/g;
      while ((m = unquotedRegex.exec(str)) !== null) {
        const val = m[2].trim();
        if (val) result[parseInt(m[1], 10)] = val;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }
}

// ============================================================
// <memoryArchive> 解析器
// ============================================================

/**
 * 从 AI 回复中提取 <memoryArchive> 标签并解析操作
 * @param {string} content
 * @returns {{ archiveOps: Array, cleanContent: string }}
 */
export function parseMemoryArchiveTags(content) {
  if (!content) return { archiveOps: [], cleanContent: content };

  const tagRegex = /<memoryArchive>([\s\S]*?)<\/memoryArchive>/gi;
  const archiveOps = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    archiveOps.push(match[1].trim());
  }

  const cleanContent = content
    .replace(/<memoryArchive>[\s\S]*?<\/memoryArchive>/gi, "")
    .trim();
  return { archiveOps, cleanContent };
}

/**
 * 从 <memoryArchive> 原始文本中解析操作调用
 * 使用括号计数法处理嵌套的 JSON 参数
 * @param {string} body - 去掉 HTML 注释后的文本
 * @returns {Array<{name: string, rawArgs: string}>}
 */
export function parseArchiveOperations(body) {
  const ops = [];
  const opNames = [
    "createFile",
    "create_file",
    "appendToFile",
    "append_to_file",
    "updateFile",
    "update_file",
    "updateIndex",
    "update_index",
    "moveEntries",
    "move_entries",
    "clearTable",
    "clear_table",
    "deleteFile",
    "delete_file",
  ];
  const ARCHIVE_OP_MAP = {
    create_file: "createFile",
    createfile: "createFile",
    append_to_file: "appendToFile",
    appendtofile: "appendToFile",
    update_file: "updateFile",
    updatefile: "updateFile",
    update_index: "updateIndex",
    updateindex: "updateIndex",
    move_entries: "moveEntries",
    moveentries: "moveEntries",
    clear_table: "clearTable",
    cleartable: "clearTable",
    delete_file: "deleteFile",
    deletefile: "deleteFile",
  };

  let pos = 0;
  while (pos < body.length) {
    let found = false;
    for (const opName of opNames) {
      if (
        !body
          .substring(pos, pos + opName.length)
          .toLowerCase()
          .startsWith(opName.toLowerCase())
      )
        continue;

      // 确认不是某个更长标识符的一部分
      const before = pos > 0 ? body[pos - 1] : " ";
      if (/[a-zA-Z_]/.test(before)) continue;

      // 找到开括号
      let parenStart = pos + opName.length;
      while (parenStart < body.length && body[parenStart] !== "(") {
        if (!/\s/.test(body[parenStart])) break;
        parenStart++;
      }
      if (parenStart >= body.length || body[parenStart] !== "(") continue;

      // 括号计数法找到匹配的闭括号
      let depth = 1;
      let parenEnd = parenStart + 1;
      let inString = false;
      let stringChar = "";

      while (parenEnd < body.length && depth > 0) {
        const ch = body[parenEnd];
        if (inString) {
          if (ch === "\\") {
            parenEnd += 2;
            continue;
          }
          if (ch === stringChar) inString = false;
        } else {
          if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
          } else if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        parenEnd++;
      }

      if (depth === 0) {
        const rawArgs = body.slice(parenStart + 1, parenEnd - 1).trim();
        const normalizedName = ARCHIVE_OP_MAP[opName.toLowerCase()] || opName;
        ops.push({ name: normalizedName, rawArgs });
        pos = parenEnd;
        found = true;
        break;
      }
    }
    if (!found) pos++;
  }

  return ops;
}

// ============================================================
// <memorySearch> 解析器
// ============================================================

/**
 * 从 AI 回复中提取 <memorySearch> 标签
 * @param {string} content
 * @returns {{ searchOps: Array, cleanContent: string }}
 */
export function parseMemorySearchTags(content) {
  if (!content) return { searchOps: [], cleanContent: content };

  const tagRegex = /<memorySearch>([\s\S]*?)<\/memorySearch>/gi;
  const searchOps = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    searchOps.push(match[1].trim());
  }

  const cleanContent = content
    .replace(/<memorySearch>[\s\S]*?<\/memorySearch>/gi, "")
    .trim();
  return { searchOps, cleanContent };
}

// ============================================================
// <memoryNote> 解析器
// ============================================================

/**
 * 从 AI 回复中提取 <memoryNote type="..."> 标签（T5-4：纯解析层，无副作用）。
 * 【why 改签名】原实现在此解析函数内直写 _config.json 的 pending_tasks（磁盘副作用），
 *   违反 replyParser「纯解析、无副作用」契约（头注释曾谎报"不写业务数据"）。现落盘挪到调用它的
 *   handler 层：本函数只返回解析结果 { notes, cleanContent }，由 replyHandler/aiRunner 走
 *   storage.appendPendingTasks 收口写口落盘（withFileLock 串行，不再解析层直写无锁）。
 * @param {string} content
 * @returns {{ notes: Array<{type:string,content:string}>, cleanContent: string }}
 *   notes=解析出的条目（供 handler 落盘）；cleanContent=剥除 memoryNote 标签后的正文。
 */
export function parseMemoryNoteTags(content) {
  if (!content) return { notes: [], cleanContent: content };

  const tagRegex = /<memoryNote\s+type="([\w-]+)">([\s\S]*?)<\/memoryNote>/gi;
  const notes = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    notes.push({ type: match[1], content: match[2].trim() });
  }

  const cleanContent = content
    .replace(/<memoryNote\s+type="\w+">[\s\S]*?<\/memoryNote>/gi, "")
    .trim();
  return { notes, cleanContent };
}

// ============================================================
// <presetSwitch> 解析器
// ============================================================

/**
 * 从 P1 AI 回复中提取 <presetSwitch> 标签
 * @param {string} content
 * @returns {{ presetName: string|null, cleanContent: string }}
 */
export function parsePresetSwitchTag(content) {
  if (!content) return { presetName: null, cleanContent: content };
  // 优先匹配完整闭合标签
  const match = content.match(/<presetSwitch>([\s\S]*?)<\/presetSwitch>/i);
  if (match) {
    const presetName = match[1].trim();
    const cleanContent = content
      .replace(/<presetSwitch>[\s\S]*?<\/presetSwitch>/gi, "")
      .trim();
    return { presetName: presetName || null, cleanContent };
  }
  // 兜底：匹配开标签但闭合标签被截断的情况（AI输出被max_tokens截断）
  const partialMatch = content.match(/<presetSwitch>([^<]+)/i);
  if (partialMatch) {
    const presetName = partialMatch[1].trim();
    if (presetName) {
      console.warn(
        `[beilu-memory] parsePresetSwitchTag: 检测到截断的 presetSwitch 标签，提取预设名: "${presetName}"`,
      );
      const cleanContent = content
        .replace(/<presetSwitch>[^<]*/i, "")
        .replace(/<\/p\w*$/i, "") // 清理截断的闭合标签残余如 </p
        .trim();
      return { presetName, cleanContent };
    }
  }
  return { presetName: null, cleanContent: content };
}

// ============================================================
// <searchQuery> / <noSearch> / <searchResult> 解析器（P8 联网搜索）
// ============================================================

/**
 * 从 P8 AI 回复中提取 <searchQuery> 标签（搜索关键词）
 * @param {string} content
 * @returns {{ queries: string[], cleanContent: string }}
 */
export function parseSearchQueryTags(content) {
  if (!content) return { queries: [], cleanContent: content };

  const tagRegex = /<searchQuery>([\s\S]*?)<\/searchQuery>/gi;
  const queries = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const query = match[1].trim();
    if (query) queries.push(query);
  }

  const cleanContent = content
    .replace(/<searchQuery>[\s\S]*?<\/searchQuery>/gi, "")
    .trim();
  return { queries, cleanContent };
}

/**
 * 从 P8 AI 回复中提取 <noSearch> 标签（不需要搜索的判定）
 * @param {string} content
 * @returns {{ noSearch: boolean, reason: string, cleanContent: string }}
 */
export function parseNoSearchTag(content) {
  if (!content) return { noSearch: false, reason: "", cleanContent: content };

  const match = content.match(/<noSearch>([\s\S]*?)<\/noSearch>/i);
  if (match) {
    const reason = match[1].trim();
    const cleanContent = content
      .replace(/<noSearch>[\s\S]*?<\/noSearch>/gi, "")
      .trim();
    return { noSearch: true, reason, cleanContent };
  }

  return { noSearch: false, reason: "", cleanContent: content };
}

/**
 * 从 P8 AI 回复中提取 <searchResult> 标签（二次过滤后的精选结果）
 * @param {string} content
 * @returns {{ searchResults: string[], cleanContent: string }}
 */
export function parseSearchResultTags(content) {
  if (!content) return { searchResults: [], cleanContent: content };

  const tagRegex = /<searchResult>([\s\S]*?)<\/searchResult>/gi;
  const searchResults = [];
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const result = match[1].trim();
    if (result) searchResults.push(result);
  }

  const cleanContent = content
    .replace(/<searchResult>[\s\S]*?<\/searchResult>/gi, "")
    .trim();
  return { searchResults, cleanContent };
}

// ============================================================
// 内容级防重 hash
// ============================================================

// [已删除] lastProcessedTableEditHash 重复 Map——活版本单源在 aiRunner.mjs:206（replyHandler:191 import 的
//   是那份）；本文件这份全库零 import 零内部使用（W4 复扫+主 AI 复核），凛倾 07-03 授权删除。
//   同文件 computeTableEditHash 纯函数是活码（replyHandler:196 import）保留。

/**
 * 计算 tableEdit 内容的简单 hash（用于内容级防重）
 * @param {string} content - AI 回复原始内容
 * @returns {string} hash 值
 */
export function computeTableEditHash(content) {
  if (!content) return "";
  // 提取所有 <tableEdit> 标签内容，拼接后计算简易 hash
  const tagRegex = /<tableEdit>([\s\S]*?)<\/tableEdit>/gi;
  const parts = [];
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    parts.push(match[1].trim());
  }
  if (parts.length === 0) return "";
  // 简单 hash：取内容长度 + 前100字符 + 后100字符
  const combined = parts.join("|");
  const head = combined.substring(0, 100);
  const tail = combined.substring(Math.max(0, combined.length - 100));
  return `${combined.length}:${head}:${tail}`;
}
