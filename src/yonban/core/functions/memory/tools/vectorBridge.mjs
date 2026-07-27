/**
 * vectorBridge.mjs — beilu-vectordb 接入记忆系统的收口模块（own 整个集成域）
 *
 * 【功能链】三条消费线 + 一条生产线，全部经本模块，镜像散点禁止：
 *   ①生产（双写）：storage.mjs saveJsonFile（记忆 json 写收口）→ notifyMemoryWrite(filepath, data)
 *     → 相关性判定（路径含 /chars/<c>/memory/ 且非 _ 前缀机制文件）→ 去抖 → 插件 indexDocument
 *   ②fallback：retrieval.mjs _searchOpKeyword 关键词 0 结果 → semanticFallback(memDir, keyword)
 *     （演进规划_全智能助手.md §1.3 拍板：关键词搜索无结果时→vectordb 语义搜索）
 *   ③初筛：getPromptHandler AI P1 调用前 → vectorPrefilter(username, charName, query)
 *     （未来探讨/beilu_未来技术演进.md §1.2 拍板：向量初筛 Top-K → P1 精选）
 *
 * 【why · 启用门读盘不 import 插件】
 *   插件 main.mjs 顶层 import npm:@orama —— 若本模块静态 import 它，storage.mjs 的每个
 *   isolate 都会为一个默认关闭的功能背上 Orama 装载。故启用门 = 直接读
 *   data/plugins/beilu-vectordb/config.json（盘为真相，与插件同一权威源，mtime 缓存），
 *   只有 enabled 才动态 import 插件单例。未启用路径 = 纯路径判断 + 一次 statSync，零行为回归。
 *
 * 【影响范围】
 *   storage.mjs（写钩子）/ retrieval.mjs（fallback）/ getPromptHandler.mjs（初筛）消费本模块；
 *   本模块只依赖 node:fs/path（插件动态 import），无回环。
 *   索引失败/插件异常一律吞入 diag 告警不外抛——记忆写链与检索主链不因索引层故障中断
 *   （向量=索引层，JSON 是数据源头，凛倾拍板）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 <root>/src/yonban/core/functions/memory/tools → 上 6 级 = 项目根
const _rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const _vecConfigFile = path.join(_rootDir, "data", "plugins", "beilu-vectordb", "config.json");

// ---- 启用门（盘为真相 + mtime 缓存） ----
let _cfgCache = { mtime: -2, enabled: false, hasApi: false };

function _vectorActive() {
  let mt = 0;
  try { mt = fs.statSync(_vecConfigFile).mtimeMs || 0; } catch { mt = 0; }
  if (mt !== _cfgCache.mtime) {
    let enabled = false, hasApi = false;
    if (mt > 0) {
      try {
        const j = JSON.parse(fs.readFileSync(_vecConfigFile, "utf-8"));
        enabled = !!j?.enabled;
        hasApi = !!j?.embeddingApiUrl;
      } catch { /* 配置损坏=当未启用 */ }
    }
    _cfgCache = { mtime: mt, enabled, hasApi };
  }
  return _cfgCache.enabled && _cfgCache.hasApi;
}

async function _plugin() {
  const mod = await import("../../../../../public/parts/plugins/beilu-vectordb/main.mjs");
  return mod.default;
}

// ---- 路径→(memDir, rel, layer) 解析 ----
/**
 * 判定一次 saveJsonFile 写入是否属于"应入向量索引的记忆内容文件"。
 * 记忆目录形状 = .../data/users/<u>/chars/<c>/memory/<rel>（storage.mjs getMemoryDir）。
 * 排除：任何 _ 前缀段（_config.json/_vector/ 等机制文件）；非 .json。
 * layer 语义与插件 rebuildIndex 遍历一致：hot/warm/cold 子目录名，tables.json=table，其余=root。
 * @returns {{memDir:string, rel:string, layer:string}|null}
 */
export function parseMemoryContentPath(filepath) {
  if (!filepath || !String(filepath).endsWith(".json")) return null;
  const norm = String(filepath).replace(/\\/g, "/");
  // 不锚死 /data/ 前缀：BEILU_DATA_DIR/UserDictionary 覆盖时数据根可在任意路径，
  // 但 users/<u>/chars/<c>/memory 的形状由 getUserDataDir+getMemoryDir 恒定
  const m = norm.match(/^(.*\/users\/[^/]+\/chars\/[^/]+\/memory)\/(.+)$/);
  if (!m) return null;
  const rel = m[2];
  const segs = rel.split("/");
  if (segs.some((s) => s.startsWith("_"))) return null;
  let layer = "root";
  if (segs.length > 1 && ["hot", "warm", "cold"].includes(segs[0])) layer = segs[0];
  else if (rel === "tables.json") layer = "table";
  return { memDir: m[1], rel, layer };
}

// ---- ①生产：写收口通知（去抖增量索引） ----
// 同文件 2s 内连写只索引最后一次（记忆文件常被 read-modify-write 连续触发，
// 每次都打 embedding API 既慢又费）。fire-and-forget：不阻塞写链。
const _pendingIndex = new Map(); // filepath → timer
const INDEX_DEBOUNCE_MS = 2000;

export function notifyMemoryWrite(filepath, jsonData) {
  try {
    if (!_vectorActive()) return;
    const parsed = parseMemoryContentPath(filepath);
    if (!parsed) return;
    const prev = _pendingIndex.get(filepath);
    if (prev) clearTimeout(prev);
    const content = typeof jsonData === "string" ? jsonData : JSON.stringify(jsonData);
    if (!content || content.length > 100 * 1024) return; // 与 rebuildIndex 的大文件上限同口径
    _pendingIndex.set(filepath, setTimeout(async () => {
      _pendingIndex.delete(filepath);
      try {
        const p = await _plugin();
        await p.interfaces.config.SetData({
          _action: "indexDocument",
          memDir: parsed.memDir, file: parsed.rel, content,
          layer: parsed.layer, timestamp: Date.now(),
        });
      } catch (e) {
        console.warn("[vectorBridge] 增量索引失败（记忆已正常落盘，仅索引层缺此文件）:", filepath, e?.message || e);
      }
    }, INDEX_DEBOUNCE_MS));
  } catch (e) {
    // 通知层任何异常都不许打断 saveJsonFile 写链
    console.warn("[vectorBridge] notifyMemoryWrite 异常:", e?.message || e);
  }
}

// ---- ②fallback：关键词零结果 → 语义搜索 ----
/**
 * @param {string} memDir - 记忆目录（与 searchMemoryFiles 的 baseDir 同源）
 * @param {string} keyword - 原关键词（AND 空格/OR | 语法转为空格自然语句）
 * @returns {Promise<object[]>} [{score,content,file,layer,timestamp}]；未启用/异常=[]
 */
export async function semanticFallback(memDir, keyword) {
  try {
    if (!_vectorActive()) return [];
    const query = String(keyword || "").replace(/\|/g, " ").replace(/\s+/g, " ").trim();
    if (!query) return [];
    const p = await _plugin();
    const res = await p.interfaces.config.SetData({
      _action: "search", memDir, query, mode: "hybrid",
    });
    return Array.isArray(res?.results) ? res.results : [];
  } catch (e) {
    console.warn("[vectorBridge] semanticFallback 失败（按无结果处理）:", e?.message || e);
    return [];
  }
}

// ---- ③初筛：AI P1 前置向量 Top-K ----
/**
 * @param {string} memDir - 记忆目录
 * @param {string} queryText - 最近用户消息文本
 * @param {number} [topK]
 * @returns {Promise<object[]>} 候选数组；未启用/空索引/异常=[]（P1 走原链零回归）
 */
export async function vectorPrefilter(memDir, queryText, topK) {
  try {
    if (!_vectorActive()) return [];
    const query = String(queryText || "").trim();
    if (!query) return [];
    const p = await _plugin();
    const res = await p.interfaces.config.SetData({
      _action: "search", memDir, query, mode: "hybrid", ...(topK ? { topK } : {}),
    });
    return Array.isArray(res?.results) ? res.results : [];
  } catch (e) {
    console.warn("[vectorBridge] vectorPrefilter 失败（P1 走原链）:", e?.message || e);
    return [];
  }
}

/** 候选列表 → 注入文本块（供 {candidates} 占位符填充；文案头归 system_texts 覆盖链） */
export function formatVectorCandidates(results, maxItems = 5, maxCharsPerItem = 200) {
  const lines = [];
  for (const r of (results || []).slice(0, maxItems)) {
    const content = String(r.content || "").replace(/\s+/g, " ").slice(0, maxCharsPerItem);
    lines.push(`- [${r.layer || "?"}|${r.file || "?"}] ${content}`);
  }
  return lines.join("\n");
}
