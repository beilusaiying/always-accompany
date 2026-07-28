import { wbT, wbD } from "../../../../../server/wbStub.mjs";
/**
 * recallStats.mjs — 记忆召回频率统计与层级 Top-K 排序（单点收口模块）
 *
 * 功能链：getPromptHandler(AI P1 真注入 INJ-p1-retrieval-data) → recordRecall(本轮读过的文件)
 *         → _recall_stats.json 累计 {count, last}
 *         retrieval(_searchOpKeyword/_searchOpRegex 日期排序后) → applyLayerTopkOrder
 *         → 层级权重排序(冷→温→hot→data 根文件) + 层内按召回热度二次排序
 * why：宣发.md 记忆设计的两个缺口——①top-k：按最近召回在每个层级内部二次排序（此前仅
 *      hot/forever.json 有 weight×recency，tableEngine.mjs:420-460，其余层全无）；
 *      ②层级权重递减（data>hot>温>冷）在搜索链上无统一体现。本模块 own 整个"召回热度域"
 *      （记录+打分+排序），消费方只调用，禁止在调用点散记散排（收口铁律）。
 *      粒度=文件级（凛倾 2026-07-28 拍板：看 aip1 读取的文件+实际输出即可得调用频率，
 *      无需先建条目级 ID 体系）。
 * 关联链：
 *   ← handler/getPromptHandler.mjs（唯一写点：AI P1 结果真注入时 recordRecall；
 *      预览/P2-P8/无结果轮不记，语义对齐 tableEngine forever recordHit 注释 :442-444）
 *   ← storage_mod/retrieval.mjs（唯一读点：搜索结果排序 applyLayerTopkOrder，
 *      主AI <memorySearch>(replyHandler) 与 AI P1(aiRunner) 两条链共享此执行口=自动全覆盖）
 *   → storage_mod/storage.mjs（loadJsonFileIfExists / saveJsonFile）
 *   ⇢ 未来自驱动 P1（p1/p1_node0_data_recall.mjs LAYER_W 同域，成熟后可消费同一统计文件）
 * 影响范围：新增 <memDir>/_recall_stats.json（下划线元数据文件，同 _pseries_runs.json 惯例，
 *      per-user/per-char 隔离随 memDir）；排序只重排已命中结果，不增删条目=零漏检回归
 * 使用效果：常被召回的记忆文件在搜索结果中排到所在层级靠后位置（本项目惯例=靠后注意力更高，
 *      同 sortSearchResultsByDate "较新的排后面, hot排最后"），冷门文件仍可见不清零
 */

import path from "node:path";

import { loadJsonFileIfExists, saveJsonFile } from "./storage.mjs";

const RECALL_STATS_FILE = "_recall_stats.json";
// 文件条目上限：超出按 last 最旧淘汰（防长期运行无界增长；300 ≈ 一年日归档+热层全集裕量）
const MAX_TRACKED_FILES = 300;

/** 相对路径归一：反斜杠→斜杠、剥前导 ./ 与 /（AI 手写路径与 path.relative 产物统一键形） */
function _normKey(relPath) {
  return String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
}

function _statsPath(memDir) {
  return path.join(memDir, RECALL_STATS_FILE);
}

/**
 * 记录一次召回事件（唯一写点=AI P1 真注入处）
 * @param {string} memDir - getMemoryDir(username, charName) 的返回值
 * @param {string[]} files - 本轮 P1 run 实际读到内容的记忆文件相对路径集合
 */
export function recordRecall(memDir, files) {
  if (!memDir || !Array.isArray(files) || files.length === 0) return;
  try {
    const fp = _statsPath(memDir);
    const data = loadJsonFileIfExists(fp, { version: 1, files: {} });
    if (!data.files || typeof data.files !== "object") data.files = {};
    const nowIso = new Date().toISOString();
    // 归一后去重：一次 run 内同一文件（含 readFile 反斜杠/搜索斜杠等不同写法）只计 1 次召回
    const runKeys = new Set(files.map(_normKey));
    runKeys.delete("");
    if (runKeys.size === 0) return;
    for (const key of runKeys) {
      const rec = data.files[key] || { count: 0, last: nowIso };
      rec.count = (rec.count || 0) + 1;
      rec.last = nowIso;
      data.files[key] = rec;
    }
    // 淘汰：超上限按 last 最旧删（count 不参与淘汰序——久未召回的高频旧档也该让位）
    const keys = Object.keys(data.files);
    if (keys.length > MAX_TRACKED_FILES) {
      keys
        .sort((a, b) => String(data.files[a].last || "").localeCompare(String(data.files[b].last || "")))
        .slice(0, keys.length - MAX_TRACKED_FILES)
        .forEach((k) => delete data.files[k]);
    }
    saveJsonFile(fp, data);
    wbT(null, "recallStats", "recordRecall:done", { files: runKeys.size, tracked: Object.keys(data.files).length });
  } catch (e) {
    // 统计失败不影响主链（记忆注入照常）——可见告警不静默吞
    wbD(null, "recallStats", "recordRecall:fail", false, "召回统计写入失败", { err: e.message });
    console.warn("[beilu-memory] 召回统计写入失败:", e.message);
  }
}

/**
 * 从 executeMemorySearchOps 结果提取"实际读到内容的文件"（单源，aiRunner/replyHandler 共用，禁复制）
 * listDir/getStats 是目录/元信息不算读到记忆内容；readFile 需 content 存在（错误/目录降级不算）
 * @param {object[]} searchResults
 * @returns {string[]} 相对路径数组（未归一，recordRecall 内统一归一去重）
 */
export function collectTouchedFiles(searchResults) {
  const files = [];
  for (const sr of searchResults || []) {
    if (!sr || sr.error) continue;
    if (sr.op === "readFile" && sr.path && sr.content) files.push(sr.path);
    for (const fm of sr.fileMatches || []) if (fm?.file) files.push(fm.file);
    for (const vm of sr.vectorMatches || []) if (vm?.file) files.push(vm.file);
  }
  return files;
}

/**
 * 最常召回文件 Top-N（读点：getStats 输出"常用文件"提示，帮 P1 少摸索轮数直达 readFile）
 * @returns {{file:string,count:number,last:string}[]} 按热度分降序
 */
export function getTopRecalled(memDir, n = 5) {
  if (!memDir) return [];
  let statsFiles = {};
  try {
    statsFiles = loadJsonFileIfExists(_statsPath(memDir), { files: {} }).files || {};
  } catch {
    return [];
  }
  const now = Date.now();
  return Object.entries(statsFiles)
    .map(([file, rec]) => ({ file, count: rec?.count || 0, last: rec?.last || "", _s: _recallScore(rec, now) }))
    .sort((a, b) => b._s - a._s)
    .slice(0, Math.max(1, n))
    .map(({ file, count, last }) => ({ file, count, last }));
}

/** 召回热度分：log1p(count) 抑制高频霸榜 × recency 衰减(同 forever recencyScore 半衰形状)  // [待实验定] */
function _recallScore(rec, now) {
  if (!rec) return 0;
  const last = rec.last ? new Date(rec.last).getTime() : 0;
  const daysSince = last > 0 ? Math.max(0, (now - last) / 86400000) : 3650;
  return Math.log1p(rec.count || 0) * (1 / (1 + daysSince * 0.1));
}

/** 层级权重序（宣发.md:35 上下文>data>hot>温>冷；上下文不经搜索链，故此处 data 为最高）
 *  数值=排序位（本项目惯例重要的排后面），非注入权重值本身 */
const _LAYER_RANK = { cold: 0, warm: 1, hot: 2, data: 3 };

function _layerOf(relPath) {
  const key = _normKey(relPath);
  if (key.startsWith("cold/")) return "cold";
  if (key.startsWith("warm/")) return "warm";
  if (key.startsWith("hot/")) return "hot";
  return "data"; // 根文件=tables.json 等 data 层
}

/**
 * 搜索结果层级 Top-K 排序（唯一读点=retrieval 两个搜索子操作）
 * 排序键：①层级权重（冷→温→hot→data，重要靠后）②层内召回热度（热的靠后）
 * ③同热度保持入参相对序（sort 稳定性 → 上游日期序自然成为层内末级 tiebreak）
 * 纯重排不增删；无统计文件/读失败=只按层级排（热度全 0），不抛不断链
 * @param {string} memDir
 * @param {object[]} fileMatches - searchMemoryFiles/walkRegex 产物（原地排序，与上游惯例一致）
 */
export function applyLayerTopkOrder(memDir, fileMatches) {
  if (!memDir || !Array.isArray(fileMatches) || fileMatches.length <= 1) return;
  let statsFiles = {};
  try {
    statsFiles = loadJsonFileIfExists(_statsPath(memDir), { files: {} }).files || {};
  } catch {
    statsFiles = {};
  }
  const now = Date.now();
  const scoreOf = (fm) => _recallScore(statsFiles[_normKey(fm.file)], now);
  fileMatches.sort((a, b) => {
    const lr = _LAYER_RANK[_layerOf(a.file)] - _LAYER_RANK[_layerOf(b.file)];
    if (lr !== 0) return lr;
    return scoreOf(a) - scoreOf(b);
  });
}
