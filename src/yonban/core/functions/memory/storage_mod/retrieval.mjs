import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * retrieval.mjs — 记忆文件关键词搜索与检索引擎（<memorySearch> 标签执行层）
 *
 * 功能链：replyHandler(解析 <memorySearch>) → executeMemorySearchOps(async) → searchMemoryFiles → 遍历 memDir/*.json → 返回匹配行
 *         关键词零结果 → tools/vectorBridge semanticFallback（vectordb 语义搜索补位，0722 接入；未启用=恒[]）
 *         → formatSearchResultsForAI → 格式化字符串供注入 AI（向量结果标 [VEC|layer] 与字面命中区分）
 * why：AI 需通过 <memorySearch> 主动检索指定关键词的记忆条目（区别于 P1 自驱动召回），
 *      本模块提供字面关键词多词 AND/OR 搜索 + 按日期排序 + 统计，是记忆主动查询的唯一入口。
 * 关联链：
 *   ← replyHandler（执行 <memorySearch> 操作）
 *   ← getPromptHandler（获取记忆统计数据）
 *   → storage.mjs（getMemoryDir / memoryCache，取目录路径）
 * 影响范围：纯只读（遍历 memDir 下 .json 文件，不写任何文件；召回统计只读不写，写点在 getPromptHandler）；搜索结果走内存返回不缓存
 * 使用效果：多关键词空格=AND / "|"分隔=OR；单文件最大 500KB；每文件最多返回 5 条匹配；
 *          结果排序=日期序 → 层级权重(冷→温→hot→data 靠后=重要)+层内召回热度 top-k（recallStats.mjs 单源）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getMemoryDir, memoryCache, isPathSafe } from "./storage.mjs";
import { semanticFallback } from "../tools/vectorBridge.mjs"; // 关键词零结果→向量语义 fallback（演进规划§1.3 拍板）；未启用=恒[]
import { applyLayerTopkOrder, getTopRecalled } from "./recallStats.mjs"; // 层级权重+召回热度 top-k 二次排序 / getStats 常用文件提示（只读统计，不破坏本模块纯只读性质）

// P0-1: lib/目录（.../src/public/parts/plugins/beilu-memory/lib），供搜索根相对推算用，不写死 D:\
const __retrievalDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const _isWindows = process.platform === "win32";

/** 系统路径安全检查——跨平台收口（Windows 盘符 + POSIX 系统目录） */
function _isSystemPath(normalized) {
  if (_isWindows) {
    return /^[A-Za-z]:\\Windows/i.test(normalized) || /^C:\\/i.test(normalized);
  }
  return /^\/(System|Library|usr|bin|sbin|boot|dev|proc|sys|etc|private|var)\b/.test(normalized);
}

// ============================================================
// 记忆文件搜索
// ============================================================

/**
 * 在记忆目录中搜索关键词
 * @param {string} baseDir - 搜索根目录
 * @param {string} keyword - 搜索关键词
 * @param {object} [options] - 搜索选项
 * @returns {object[]} 文件匹配结果
 */
export function searchMemoryFiles(baseDir, keyword, options = {}) {
  wbT(null, "retrieval", "searchMemoryFiles:enter", { baseDir, keyword });
  const {
    maxResults = 30,
    // 172#37 修复: 50KB → 500KB (长期对话日志/累积归档不被截断)
    maxFileSize = 500 * 1024,
    maxMatchesPerFile = 5,
  } = options;

  const results = [];
  // 支持多关键词: 空格分隔=AND, |分隔=OR
  const hasOr = keyword.includes("|");
  const lowerKeyword = keyword.toLowerCase();
  const keywords = hasOr
    ? lowerKeyword.split("|").map(k => k.trim()).filter(Boolean)
    : lowerKeyword.split(/\s+/).filter(Boolean);
  const matchLine = (line) => {
    const lower = line.toLowerCase();
    if (keywords.length <= 1) return lower.includes(lowerKeyword);
    return hasOr
      ? keywords.some(k => lower.includes(k))   // OR: 任一匹配
      : keywords.every(k => lower.includes(k));  // AND: 全部匹配
  };
  let totalMatches = 0;

  function walk(dir) {
    if (totalMatches >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (totalMatches >= maxResults) return;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      // 修8（20260716）：扩 .md——原只扫 .json 使全部 md 域（code/work 热层 active、归档 md）
      //   对关键词检索不可达；归档 md 叠加温层扫描跳子目录=归档即对 AI 永久消失（分身E 链3 确诊）。
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".md")) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxFileSize) continue;

        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        const fileMatches = [];

        for (let i = 0; i < lines.length; i++) {
          if (matchLine(lines[i])) {
            const contextLines = lines.slice(Math.max(0, i - 1), i + 2);
            fileMatches.push({
              line: i + 1,
              context: contextLines.join(" ").trim().substring(0, 200),
            });
            if (fileMatches.length >= maxMatchesPerFile) break;
          }
        }

        if (fileMatches.length > 0) {
          totalMatches += fileMatches.length;
          results.push({
            file: path.relative(baseDir, fullPath).replace(/\\/g, "/"),
            matchCount: fileMatches.length,
            matches: fileMatches,
          });
        }
      } catch (e) {
        /* skip unreadable files */
      }
    }
  }

  walk(baseDir);
  wbT(null, "retrieval", "searchMemoryFiles:done", { keyword, matchCount: results.length });
  return results;
}

/**
 * 按日期排序搜索结果（较新的排后面，hot层排最后）
 */
export function sortSearchResultsByDate(fileMatches) {
  if (!fileMatches || fileMatches.length <= 1) return;

  fileMatches.sort((a, b) => {
    const dateA = a.file.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    const dateB = b.file.match(/(\d{4})\/(\d{2})\/(\d{2})/);

    if (dateA && dateB) return dateA[0].localeCompare(dateB[0]);

    const aIsHot = a.file.startsWith("hot/");
    const bIsHot = b.file.startsWith("hot/");
    if (aIsHot && !bIsHot) return 1;
    if (!aIsHot && bIsHot) return -1;
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;

    return 0;
  });
}

// ============================================================
// 记忆统计
// ============================================================

/**
 * 获取记忆目录的统计信息
 */
export function getMemoryStats(memDir) {
  const stats = {
    totalFiles: 0,
    totalSize: 0,
    layers: {
      hot: { files: 0, size: 0, details: {} },
      warm: { files: 0, size: 0, months: [] },
      cold: { files: 0, size: 0, years: [] },
    },
    tablesSummary: "",
  };

  function scanDir(dir, layerKey) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, layerKey);
      } else if (entry.isFile()) {
        try {
          const s = fs.statSync(fullPath);
          stats.totalFiles++;
          stats.totalSize += s.size;
          if (layerKey && stats.layers[layerKey]) {
            stats.layers[layerKey].files++;
            stats.layers[layerKey].size += s.size;
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  scanDir(path.join(memDir, "hot"), "hot");
  scanDir(path.join(memDir, "warm"), "warm");
  scanDir(path.join(memDir, "cold"), "cold");

  // hot 层详细信息
  const hotDir = path.join(memDir, "hot");
  if (fs.existsSync(hotDir)) {
    try {
      const hotFiles = fs.readdirSync(hotDir, { withFileTypes: true });
      for (const f of hotFiles) {
        if (f.isFile()) {
          try {
            stats.layers.hot.details[f.name] =
              `${(fs.statSync(path.join(hotDir, f.name)).size / 1024).toFixed(1)}KB`;
          } catch {
            /* skip */
          }
        } else if (f.isDirectory()) {
          try {
            stats.layers.hot.details[f.name + "/"] =
              `${fs.readdirSync(path.join(hotDir, f.name)).length} files`;
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // warm 层月份列表
  const warmDir = path.join(memDir, "warm");
  if (fs.existsSync(warmDir)) {
    try {
      const years = fs.readdirSync(warmDir).filter((f) => /^\d{4}$/.test(f));
      for (const y of years) {
        const yearDir = path.join(warmDir, y);
        try {
          const months = fs
            .readdirSync(yearDir)
            .filter((f) => /^\d{2}$/.test(f));
          for (const m of months) stats.layers.warm.months.push(`${y}-${m}`);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }

  // cold 层年份列表
  const coldDir = path.join(memDir, "cold");
  if (fs.existsSync(coldDir)) {
    try {
      stats.layers.cold.years = fs
        .readdirSync(coldDir)
        .filter((f) => /^\d{4}$/.test(f));
    } catch {
      /* skip */
    }
  }

  // 表格概况
  const tablesPath = path.join(memDir, "tables.json");
  if (fs.existsSync(tablesPath)) {
    try {
      const tablesData = JSON.parse(fs.readFileSync(tablesPath, "utf8"));
      const tables = tablesData.tables || [];
      stats.tablesSummary = tables
        .map(
          (t) =>
            `#${t.id}(${t.name}): ${t.rows?.length || 0}行, ${t.columns?.length || 0}列, ${t.enabled !== false ? "启用" : "禁用"}`,
        )
        .join("\n");
    } catch {
      /* skip */
    }
  }

  return stats;
}

// ============================================================
// <memorySearch> 执行器
// ============================================================

/**
 * 执行记忆搜索操作
 * @param {string[]} searchOpsRaw - <memorySearch> 标签内的原始文本数组
 * @param {string} username - 用户名
 * @param {string} charName - 角色名
 * @returns {object[]} 操作结果数组
 */
export async function executeMemorySearchOps(searchOpsRaw, username, charName) {
  wbT(null, "retrieval", "executeMemorySearchOps:enter", { username, charName, blockCount: searchOpsRaw?.length });
  const results = [];
  const memDir = getMemoryDir(username, charName);
  const resolvedMemDir = path.resolve(memDir);
  const _cachedData = memoryCache.get(`${username}/${charName}`);
  const _cfgMaxFileSize = _cachedData?.config?.retrieval?.max_file_size || 512000;

  const OP_NORMALIZE = {
    readfile: "readFile", read_file: "readFile",
    listdir: "listDir", list_dir: "listDir",
    searchkeyword: "searchKeyword", search_keyword: "searchKeyword",
    searchregex: "searchRegex", search_regex: "searchRegex",
    getstats: "getStats", get_stats: "getStats",
    readprojectfile: "readProjectFile", read_project_file: "readProjectFile",
    listprojectdir: "listProjectDir", list_project_dir: "listProjectDir",
    searchprojectfile: "searchProjectFile", search_project_file: "searchProjectFile",
  };

  for (const rawBlock of searchOpsRaw) {
    const body = rawBlock.replace(/<!--([\s\S]*?)-->/g, "$1").trim();

    // 增强正则：支持有引号和无引号的参数，支持 snake_case 操作名
    const opRegex =
      /(readFile|read_file|listDir|list_dir|searchKeyword|search_keyword|searchRegex|search_regex|getStats|get_stats|readProjectFile|read_project_file|listProjectDir|list_project_dir|searchProjectFile|search_project_file)\s*\(\s*(?:["']([^"']*)["']|([^,)"'\s][^,)"']*))?(?:\s*,\s*(?:["']([^"']*)["']|([^,)"'\s][^,)"']*)))?\s*\)/gi;
    let match;

    while ((match = opRegex.exec(body)) !== null) {
      const [, rawOpType] = match;
      // 合并引号参数和无引号参数（优先引号版本）
      const arg = (match[2] ?? match[3] ?? "").trim();
      const arg2 = (match[4] ?? match[5] ?? "").trim();
      const opType = OP_NORMALIZE[rawOpType.toLowerCase()] || rawOpType;

      // 路径规范化：去除尾部斜杠（防止目录路径误传）
      const normArg = arg.replace(/\/+$/, "") || undefined;
      const normArg2 = arg2.replace(/\/+$/, "") || undefined;

      switch (opType) {
        case "getStats":
          results.push(_searchOpGetStats(memDir));
          break;
        case "searchKeyword":
          results.push(await _searchOpKeyword(normArg, normArg2, memDir, resolvedMemDir));
          break;
        case "searchRegex":
          results.push(_searchOpRegex(normArg, normArg2, memDir, resolvedMemDir));
          break;
        case "readFile":
          results.push(_searchOpReadFile(normArg, memDir, resolvedMemDir));
          break;
        case "listDir":
          results.push(_searchOpListDir(normArg, memDir, resolvedMemDir));
          break;
        case "readProjectFile":
          results.push(_searchOpReadProjectFile(normArg));
          break;
        case "listProjectDir":
          results.push(_searchOpListProjectDir(normArg));
          break;
        case "searchProjectFile":
          results.push(_searchOpSearchProjectFile(normArg, normArg2));
          break;
        default:
          wbD(null, "retrieval", "executeMemorySearchOps:unknownOp", false, "未知搜索操作", { opType });
          results.push({ op: opType, error: "未知搜索操作" });
      }
    }
  }

  wbT(null, "retrieval", "executeMemorySearchOps:done", { resultCount: results.length });
  return results;
}

// --- 搜索子操作 ---

function _searchOpGetStats(memDir) {
  try {
    const stats = getMemoryStats(memDir);
    const lines = [];
    lines.push(`总文件数: ${stats.totalFiles}`);
    lines.push(`总大小: ${(stats.totalSize / 1024).toFixed(1)}KB`);
    lines.push(
      `\n热层 (${stats.layers.hot.files}文件, ${(stats.layers.hot.size / 1024).toFixed(1)}KB):`,
    );
    for (const [name, info] of Object.entries(stats.layers.hot.details)) {
      lines.push(`  ${name}: ${info}`);
    }
    lines.push(
      `\n温层 (${stats.layers.warm.files}文件, ${(stats.layers.warm.size / 1024).toFixed(1)}KB):`,
    );
    lines.push(
      stats.layers.warm.months.length > 0
        ? `  月份: ${stats.layers.warm.months.join(", ")}`
        : "  (空)",
    );
    lines.push(
      `\n冷层 (${stats.layers.cold.files}文件, ${(stats.layers.cold.size / 1024).toFixed(1)}KB):`,
    );
    lines.push(
      stats.layers.cold.years.length > 0
        ? `  年份: ${stats.layers.cold.years.join(", ")}`
        : "  (空)",
    );
    if (stats.tablesSummary) lines.push(`\n表格概况:\n${stats.tablesSummary}`);
    // [0728 top-k] 常被召回文件提示：P1 第一轮即可直接 readFile 热门文件，省掉盲搜轮次（瞬时性优化）
    const topRecalled = getTopRecalled(memDir, 5);
    if (topRecalled.length > 0) {
      lines.push(`\n常被召回文件 (按热度):`);
      for (const t of topRecalled) {
        lines.push(`  ${t.file} (${t.count}次, 最近 ${String(t.last).slice(0, 10)})`);
      }
    }
    return { op: "getStats", statsText: lines.join("\n") };
  } catch (e) {
    return { op: "getStats", error: e.message };
  }
}

async function _searchOpKeyword(keyword, subDirRel, memDir, resolvedMemDir) {
  wbT(null, "retrieval", "searchKeyword:enter", { keyword, subDirRel });
  if (!keyword)
    return { op: "searchKeyword", keyword: "", error: "缺少搜索关键词" };

  try {
    let searchDir = memDir;
    if (subDirRel) {
      const subDir = path.join(memDir, subDirRel);
      if (
        isPathSafe(subDir, resolvedMemDir) && // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
        fs.existsSync(subDir)
      ) {
        searchDir = subDir;
      } else {
        return {
          op: "searchKeyword",
          keyword,
          error: `子目录不存在或越界: ${subDirRel}`,
        };
      }
    }

    const fileMatches = searchMemoryFiles(searchDir, keyword, { maxFileSize: _cfgMaxFileSize });

    // 如果搜的是子目录，结果路径需要前缀子目录
    if (subDirRel && searchDir !== memDir) {
      for (const fm of fileMatches) {
        fm.file = subDirRel.replace(/\\/g, "/") + "/" + fm.file;
      }
    }

    sortSearchResultsByDate(fileMatches);
    applyLayerTopkOrder(memDir, fileMatches); // 层级(冷→温→hot→data)+层内召回热度重排；日期序经稳定排序成为层内末级 tiebreak

    // 关键词零结果 → 向量语义 fallback（演进规划§1.3 拍板：字面 includes 抓不到同义/改写表述，
    // 语义搜索补位；vectordb 未启用/索引空/异常时 semanticFallback 恒返 []=原行为零回归）。
    // 注意搜索域用 memDir 而非 searchDir：向量索引按 memDir 分区，子目录限定由字面搜索承担。
    if (fileMatches.length === 0) {
      const vectorMatches = await semanticFallback(memDir, keyword);
      if (vectorMatches.length > 0) {
        applyLayerTopkOrder(memDir, vectorMatches); // 向量结果同享层级+热度重排（结果对象同有 .file；稳定排序保语义分序为层内末级 tiebreak）
        wbT(null, "retrieval", "searchKeyword:vectorFallback", { keyword, hits: vectorMatches.length });
        return { op: "searchKeyword", keyword, fileMatches, vectorMatches, vectorFallback: true };
      }
    }
    return { op: "searchKeyword", keyword, fileMatches };
  } catch (e) {
    wbD(null, "retrieval", "searchKeyword:error", false, e.message, { keyword });
    return { op: "searchKeyword", keyword, error: e.message };
  }
}

function _searchOpRegex(pattern, subDirRel, memDir, resolvedMemDir) {
  if (!pattern)
    return { op: "searchRegex", keyword: "", error: "缺少正则表达式" };

  try {
    let searchDir = memDir;
    if (subDirRel) {
      const subDir = path.join(memDir, subDirRel);
      if (
        isPathSafe(subDir, resolvedMemDir) && // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
        fs.existsSync(subDir)
      ) {
        searchDir = subDir;
      } else {
        return {
          op: "searchRegex",
          keyword: pattern,
          error: `子目录不存在或越界: ${subDirRel}`,
        };
      }
    }

    let regex;
    try {
      if (pattern.length > 200) return { op: "searchRegex", keyword: pattern, error: "正则过长(>200字符)，拒绝执行" };
      if (/(\(.+\))\1{2,}|(\.\*){3,}|\(\?[^)]*\(\?/.test(pattern)) return { op: "searchRegex", keyword: pattern, error: "正则疑似回溯炸弹，拒绝执行" };
      regex = new RegExp(pattern, "gi");
    } catch (e) {
      return { op: "searchRegex", keyword: pattern, error: `正则语法错误: ${e.message}` };
    }
    const maxFileSize = _cfgMaxFileSize;
    const fileMatches = [];
    let totalMatches = 0;

    function walkRegex(dir) {
      if (totalMatches >= 30) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (totalMatches >= 30) return;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walkRegex(fullPath);
          continue;
        }
        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".md")) continue; // 修8：同 :81 扩 .md（regex 检索同病同修）

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > maxFileSize) continue;
          const content = fs.readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          const matches = [];

          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const contextLines = lines.slice(Math.max(0, i - 1), i + 2);
              matches.push({
                line: i + 1,
                context: contextLines.join(" ").trim().substring(0, 200),
              });
              if (matches.length >= 5) break;
            }
          }

          if (matches.length > 0) {
            totalMatches += matches.length;
            fileMatches.push({
              file: path.relative(searchDir, fullPath).replace(/\\/g, "/"),
              matchCount: matches.length,
              matches,
            });
          }
        } catch {
          /* skip */
        }
      }
    }

    walkRegex(searchDir);

    if (subDirRel && searchDir !== memDir) {
      for (const fm of fileMatches) {
        fm.file = subDirRel.replace(/\\/g, "/") + "/" + fm.file;
      }
    }

    sortSearchResultsByDate(fileMatches);
    applyLayerTopkOrder(memDir, fileMatches); // 同 searchKeyword：层级+召回热度重排（同病同修）
    return { op: "searchRegex", keyword: pattern, fileMatches };
  } catch (e) {
    wbD(null, "retrieval", "searchRegex:error", false, e.message, { pattern });
    return { op: "searchRegex", keyword: pattern, error: e.message };
  }
}

function _searchOpReadFile(relPath, memDir, resolvedMemDir) {
  wbT(null, "retrieval", "readFile:enter", { relPath });
  if (!relPath) return { op: "readFile", path: "", error: "缺少路径参数" };

  const fullPath = path.join(memDir, relPath);
  if (!isPathSafe(fullPath, resolvedMemDir)) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
    return { op: "readFile", path: relPath, error: "路径越界" };
  }

  try {
    if (!fs.existsSync(fullPath)) {
      return { op: "readFile", path: relPath, error: "文件不存在" };
    }

    // 如果目标是目录，自动降级为 listDir（AI 可能误用 readFile 读目录）
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      console.warn(
        `[beilu-memory] readFile("${relPath}") 目标是目录，自动降级为 listDir`,
      );
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      return {
        op: "listDir",
        path: relPath,
        entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
        _note: `AI 使用 readFile 读取了目录路径，已自动转为 listDir。如需读取文件内容，请指定具体文件名。`,
      };
    }

    return {
      op: "readFile",
      path: relPath,
      content: fs.readFileSync(fullPath, "utf8"),
    };
  } catch (e) {
    wbD(null, "retrieval", "readFile:error", false, e.message, { relPath });
    return { op: "readFile", path: relPath, error: `读取失败: ${e.message}` };
  }
}

function _searchOpListDir(relPath, memDir, resolvedMemDir) {
  // 允许空路径：列出记忆根目录
  const effectivePath = relPath || "";
  const fullPath = effectivePath ? path.join(memDir, effectivePath) : memDir;

  if (!isPathSafe(fullPath, resolvedMemDir)) { // 0716 路径前缀边界修复：收口到 isPathSafe（含 path.sep 边界 + .. 检查）
    return { op: "listDir", path: effectivePath, error: "路径越界" };
  }

  try {
    if (!fs.existsSync(fullPath)) {
      return { op: "listDir", path: effectivePath, error: "目录不存在" };
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      // AI 可能误用 listDir 读文件，给出友好提示
      return {
        op: "listDir",
        path: effectivePath,
        error: `"${effectivePath}" 是文件而非目录，请使用 readFile("${effectivePath}") 读取内容`,
      };
    }

    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    return {
      op: "listDir",
      path: effectivePath || "/",
      entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    };
  } catch (e) {
    return {
      op: "listDir",
      path: effectivePath,
      error: `列目录失败: ${e.message}`,
    };
  }
}

// ============================================================
// 搜索结果格式化
// ============================================================

/**
 * 将搜索结果格式化为可注入AI上下文的文本
 * [0728 截断保尾] 排序惯例=重要的排后面（层级+热度，recallStats.mjs 单源），原实现超限从尾部
 *   截断=结果越多越重要的越先被砍（方向冲突）。现改为：各结果块独立渲染 → 字符预算从尾部块
 *   向前分配 → 省略的是头部（最不重要）块，输出顺序不变；有省略时头部给 [WARN] 提示省略数。
 * @param {object[]} searchResults - executeMemorySearchOps 的返回值
 * @param {number} [charLimit=50000] - 字符上限
 * @returns {string} 格式化文本
 */
export function formatSearchResultsForAI(searchResults, charLimit) {
  if (!searchResults || searchResults.length === 0) return "(无搜索结果)";

  const limit = charLimit || 50000;
  const blocks = searchResults.map((r) => _renderSearchResultBlock(r)).filter((b) => b.length > 0);
  const head = "[记忆文件搜索结果]";
  const tail = "[/记忆文件搜索结果]";
  let budget = limit - head.length - tail.length - 80; // 80=省略提示行裕量

  const kept = [];
  let omittedCount = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.length <= budget) {
      kept.unshift(b);
      budget -= b.length;
    } else if (kept.length === 0 && budget > 500) {
      // 连最重要（最尾）的一块都放不下：保块头截块尾（标题/摘要在块头），保证至少有内容
      kept.unshift(b.slice(0, budget) + `\n... (本块超长已截断，原${b.length}字符)`);
      omittedCount = i;
      break;
    } else {
      // 中间块放不下：连同其前所有块一起省略（保持连续尾段，不跳块乱序）
      omittedCount = i + 1;
      break;
    }
  }

  const lines = [head];
  if (omittedCount > 0) {
    lines.push(`[WARN] 超过字符上限，已省略前 ${omittedCount} 项（保留的是排序靠后的重要结果）`);
  }
  lines.push(...kept);
  lines.push(tail);
  return lines.join("\n");
}

/** 渲染单个搜索结果块（块内格式与原实现逐字一致；readFile 内容 8000 字符块内上限不变） */
function _renderSearchResultBlock(r) {
  const lines = [];
  if (r.error) {
    return `\n[ERR] ${r.op}("${r.path || r.keyword || ""}"): ${r.error}`;
  }
  switch (r.op) {
    case "readFile": {
      lines.push(`\n[FILE] readFile("${r.path}"):`);
      const content = r.content || "";
      if (content.length > 8000) {
        lines.push(content.substring(0, 8000) + `\n... (内容已截断，共${content.length}字符)`);
      } else {
        lines.push(content);
      }
      break;
    }
    case "listDir": {
      lines.push(`\n[DIR] listDir("${r.path}"):`);
      // 如果有降级提示（readFile→listDir），输出提示让 AI 知道
      if (r._note) lines.push(`  [提示] ${r._note}`);
      for (const entry of r.entries || []) {
        lines.push(`  ${entry.isDir ? "[D]" : "[F]"} ${entry.name}`);
      }
      break;
    }
    case "searchKeyword":
    case "searchRegex": {
      const icon = r.op === "searchKeyword" ? "[SEARCH]" : "[REGEX]";
      lines.push(`\n${icon} ${r.op}("${r.keyword}"):`);
      if (r.fileMatches && r.fileMatches.length > 0) {
        lines.push(`  找到 ${r.fileMatches.length} 个文件匹配`);
        for (const fm of r.fileMatches) {
          lines.push(`  [FILE] ${fm.file} (${fm.matchCount}处匹配):`);
          for (const m of fm.matches || []) {
            lines.push(`    L${m.line}: ${m.context}`);
          }
        }
      } else if (r.vectorMatches && r.vectorMatches.length > 0) {
        // 关键词零命中、向量 fallback 有结果：标明来源是语义近似（非字面命中），AI 按需甄别
        lines.push(`  字面无匹配；以下 ${r.vectorMatches.length} 条为向量语义近似结果:`);
        for (const vm of r.vectorMatches) {
          const snippet = String(vm.content || "").replace(/\s+/g, " ").slice(0, 300);
          lines.push(`  [VEC|${vm.layer || "?"}] ${vm.file || "?"} (score ${typeof vm.score === "number" ? vm.score.toFixed(3) : "?"}): ${snippet}`);
        }
      } else {
        lines.push("  (无匹配)");
      }
      break;
    }
    case "getStats": {
      lines.push(`\n[STATS] getStats():`);
      lines.push(r.statsText || "(无统计数据)");
      break;
    }
    default:
      return "";
  }
  return lines.join("\n");
}

// --- W65: P1项目文件只读访问 ---

/**
 * 只读读取项目文件（P1用，禁止写入）
 * 路径安全：禁止访问系统路径(Windows C:/盘符 + POSIX /usr /System等)、node_modules、.git、.env等敏感路径
 */
function _searchOpReadProjectFile(filePath) {
  if (!filePath) return { op: "readProjectFile", path: "", error: "缺少路径参数" };
  // 安全检查
  const normalized = path.resolve(filePath);
  if (_isSystemPath(normalized)) {
    return { op: "readProjectFile", path: filePath, error: "系统路径禁止访问" };
  }
  if (/node_modules|\.git[\/\\]|\.env|credentials|secret/i.test(filePath)) {
    return { op: "readProjectFile", path: filePath, error: "敏感路径禁止访问" };
  }
  try {
    if (!fs.existsSync(filePath)) {
      return { op: "readProjectFile", path: filePath, error: "文件不存在" };
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 200 * 1024) {
      return { op: "readProjectFile", path: filePath, error: "文件过大(>200KB)，请指定具体函数或行号范围" };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    // 截断到前5000字符（P1不需要完整文件）
    const truncated = content.length > 5000 ? content.substring(0, 5000) + "\n...(截断，共" + content.length + "字符)" : content;
    return { op: "readProjectFile", path: filePath, content: truncated };
  } catch (e) {
    return { op: "readProjectFile", path: filePath, error: e.message };
  }
}

/**
 * 只读列出项目目录（P1用）
 */
function _searchOpListProjectDir(dirPath) {
  if (!dirPath) return { op: "listProjectDir", path: "", error: "缺少路径参数" };
  const normalized = path.resolve(dirPath);
  if (_isSystemPath(normalized)) {
    return { op: "listProjectDir", path: dirPath, error: "系统路径禁止访问" };
  }
  try {
    if (!fs.existsSync(dirPath)) {
      return { op: "listProjectDir", path: dirPath, error: "目录不存在" };
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const list = entries
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist")
      .slice(0, 100)
      .map(e => (e.isDirectory() ? e.name + "/" : e.name));
    return { op: "listProjectDir", path: dirPath, entries: list };
  } catch (e) {
    return { op: "listProjectDir", path: dirPath, error: e.message };
  }
}

/**
 * 项目文件正则搜索（P1用，返回路径+行号+上下文）
 * searchProjectFile("正则关键词") — 搜索整个项目
 * searchProjectFile("正则关键词", "子目录路径") — 搜索指定目录
 */
function _searchOpSearchProjectFile(pattern, searchDir) {
  if (!pattern) return { op: "searchProjectFile", error: "缺少搜索关键词" };

  // P0-1 去硬编码绝对路径：parts 根从本文件目录相对推算（项目内必在）；项目外的 wiki 走 env(P1_RESOURCE_DIR)
  // + 相对回退。全部 existsSync 过滤——他机/开源缺某目录就跳过该根，不再写死本机 D:\ 致他机搜空。
  const defaultDirs = [
    path.resolve(__retrievalDir, "..", "..", ".."),                                            // .../src/public/parts
    process.env.P1_RESOURCE_DIR,                                                                // 可配的外部资源根
    path.resolve(__retrievalDir, "..", "..", "..", "..", "..", "..", "..", "beilu的工作日志和项目日志", "项目框架+wiki"), // 真实 wiki 位置回退（原硬编码 D:\...\项目框架+wiki 指向不存在目录=死根）
  ].filter(Boolean).filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
  const dirs = searchDir ? [path.resolve(searchDir)] : defaultDirs;

  // 安全检查
  for (const dir of dirs) {
    if (_isSystemPath(dir)) return { op: "searchProjectFile", pattern, error: "系统路径禁止访问" };
  }

  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    // 如果正则无效，当作普通字符串搜索
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const results = [];
  const MAX_RESULTS = 20;
  const CONTEXT_LINES = 10;

  function searchInDir(dirPath, depth) {
    if (depth > 5 || results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "package-lock.json") continue;

      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        searchInDir(fullPath, depth + 1);
      } else if (/\.(mjs|js|ts|json|md|txt|css|html)$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 500 * 1024) continue; // 跳过大文件
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              // 提取上下文（前后各N行）
              const start = Math.max(0, i - CONTEXT_LINES);
              const end = Math.min(lines.length, i + CONTEXT_LINES + 1);
              const context = lines.slice(start, end).map((l, idx) => {
                const lineNum = start + idx + 1;
                const marker = (start + idx === i) ? ">>>" : "   ";
                return `${marker} ${lineNum}: ${l}`;
              }).join("\n");

              results.push({
                file: fullPath,
                line: i + 1,
                match: lines[i].trim().substring(0, 120),
                context,
              });
              break; // 每个文件只取第一个匹配
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  for (const dir of dirs) {
    if (fs.existsSync(dir)) searchInDir(dir, 0);
  }

  if (results.length === 0) {
    return { op: "searchProjectFile", pattern, searchDir: searchDir || "(默认)", message: "未找到匹配" };
  }

  return {
    op: "searchProjectFile",
    pattern,
    searchDir: searchDir || "(默认)",
    matchCount: results.length,
    matches: results,
  };
}
