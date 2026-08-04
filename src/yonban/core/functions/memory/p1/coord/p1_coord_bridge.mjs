// ════════════════════════════════════════════════════════════════════
// p1_coord_bridge.mjs — C1 收尾: coord-bridge 运行时 loader（node3 axisDiverge 桥接词扩展靶空间）
//
// 功能链：p1_node3_axis6:axisDiverge → getBridgeIndex() → [{term,vec,norm,dom,axes47,src}]（桥接词 NB 索引）
//         p1_transfer:_findTermInAT → getBridgeAxes47(word) → axes_47 稀疏坐标（AT 无此词时回退）
// why：AT 术语仅 4452 个，node3 axisDiverge 发散靶太少；桥接库词（DLUT 情感/narrative/cn_daily/Domain 词）
//      通过预计算 axes_47 坐标并入靶空间，让心理/语言/信息等轴各有专属词库词可发散吐新词。
// 关联链：
//   ← p1_node3_axis6.mjs（axisDiverge 检索 getBridgeIndex）
//   ← p1_transfer.mjs（_findTermInAT 回退 getBridgeAxes47 挂坐标→node6 空间投票）
//   → numberbatch.mjs（getNumberbatch，运行时取 NB300 向量建索引）
//   → p1_coord_bridge_precompute.mjs（离线生成 p1_coord_bridge.json 数据源）
// 影响范围：只读 p1_coord_bridge.json（缺失则桥接退化为空，不崩）；clearBridgeCache 由 pipeline 30s 热重载清
// ════════════════════════════════════════════════════════════════════
//
// 【做什么】读预计算的 p1_coord_bridge.json(各轴物理词库词→axes_47 坐标), 建 per-组 NB 索引,
//   供 p1_node3_axis6.mjs 的 axisDiverge 把发散靶从"仅 AT 术语"扩为"AT + 桥接物理库词"。
//   实现凛倾框架§六节点3"每个轴都有对应的资源…发散吐新词"——心理轴用 DLUT 情感词发散, 语言轴用
//   narrative_terms/语言域发散, 信息/社会/逻辑轴各用对应 Domain 域发散(node3:212-214 coord-bridge 缺口收尾)。
//
// 【数据来源】p1_coord_bridge.json 由 p1_coord_bridge_precompute.mjs 离线生成(见该脚本头注: 库词 NB300→chat AT
//   top5 cosine≥0.3 加权平均 axes_47)。json 不在 = 桥接退化为空(node3 axisDiverge 只搜 AT, 不崩=向后兼容)。
//
// 【索引结构】getBridgeIndex() → [{term, vec:Float32Array, norm, dom, axes47, src}]:
//   · term  = 库中文词(2-4字, 桥接吐的新词)
//   · vec/norm = NB300 向量(运行时由 getNumberbatch().get(term) 取, 与 AT 靶同空间)
//   · dom   = axes_47 主组(psy/info/soc/logic/lang) = 库声明轴, 供 axisDiverge AXIS_AWARE_DIVERGE 主组门
//   · axes47 = 稀疏 axes_47 坐标(供 transfer:_findTermInAT 挂坐标→node6/node9 空间投票, 这是 coord-bridge 的核心:
//             桥接词有 axes_47 才不会在 node6 dim0Skip 被丢=node3:213 雏形 directionWords=0 根因的解)
//   · src   = 来源库名(白盒溯源: 吐的词来自哪个词库)
//
// 【getBridgeAxes47(word)】→ word 的 axes_47(桥接词)或 null。供 transfer 给桥接词挂坐标(AT 无此词时回退查桥接表)。
//
// 【白盒/软隔离】NB 未命中的桥接词建索引时跳过(计 _skippedNoNb), 不硬造向量; 缓存一次建好, 30s 热重载由 clearBridgeCache 清。
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNumberbatch } from "../../nlp/numberbatch.mjs";
import { getResDir } from "../p1_resdir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_FILE = path.join(getResDir(), "p1_coord_bridge.json");

let _bridgeData = null;     // {meta, entries} 原始 json
let _bridgeIndex = null;    // [{term,vec,norm,dom,axes47,src}] NB 索引(发散靶)
let _bridgeAxesMap = null;  // Map<word, axes47> (transfer 挂坐标用)
let _stats = null;          // {loaded, indexed, skippedNoNb}

function _loadRaw() {
  if (_bridgeData) return _bridgeData;
  try {
    _bridgeData = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf-8"));
  } catch (e) {
    // json 缺失 → 桥接退化为空(axisDiverge 只搜 AT, 不崩)
    console.warn("[coord_bridge] p1_coord_bridge.json 未加载(桥接退化为空):", e.message);
    _bridgeData = { meta: {}, entries: [] };
  }
  return _bridgeData;
}

// 桥接词 NB 索引(发散靶): 给每个桥接词查 NB300 向量, 建与 AT 靶同结构的索引。
//   nb 复用 node3 已加载的 getNumberbatch() 实例, 不重复加载 NB300。
export function getBridgeIndex() {
  if (_bridgeIndex) return _bridgeIndex;
  const data = _loadRaw();
  const nb = getNumberbatch();
  _bridgeIndex = [];
  _bridgeAxesMap = new Map();
  let skipped = 0;
  if (nb && typeof nb.get === "function") {
    for (const e of data.entries) {
      _bridgeAxesMap.set(e.word, e.axes47);   // 坐标表(即使无 NB 向量也存, transfer 挂坐标用)
      const vec = nb.get(e.word);
      if (!vec) { skipped++; continue; }       // NB 未命中→不作发散靶(软隔离, 不硬造向量)
      let norm = 0; for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) _bridgeIndex.push({ term: e.word, vec, norm, dom: e.dom, axes47: e.axes47, src: e.src });
    }
  }
  _stats = { loaded: data.entries.length, indexed: _bridgeIndex.length, skippedNoNb: skipped };
  return _bridgeIndex;
}

// 桥接词的 axes_47(transfer 给桥接词挂坐标用): AT 无此词时回退查桥接表。
export function getBridgeAxes47(word) {
  if (!_bridgeAxesMap) getBridgeIndex();
  return _bridgeAxesMap ? (_bridgeAxesMap.get(word) || null) : null;
}

// 白盒统计(发散靶规模 + 跳过数): 供 node3 埋点溯源。
export function getBridgeStats() {
  if (!_stats) getBridgeIndex();
  return { ..._stats, meta: _loadRaw().meta };
}

// 热重载清缓存(30s mtime polling 复用同一机制)。
export function clearBridgeCache() {
  _bridgeData = null; _bridgeIndex = null; _bridgeAxesMap = null; _stats = null;
}

// 非加载型运行时统计: 卸载验证使用，不因读取 stats 反向触发 NB/JSON 重载。
export function getBridgeCacheStats() {
  return {
    dataLoaded: _bridgeData !== null,
    dataBuckets: Array.isArray(_bridgeData?.entries) ? _bridgeData.entries.length : 0,
    indexLoaded: _bridgeIndex !== null,
    indexBuckets: _bridgeIndex?.length || 0,
    axesLoaded: _bridgeAxesMap !== null,
    axesBuckets: _bridgeAxesMap?.size || 0,
    statsLoaded: _stats !== null,
  };
}

export default { getBridgeIndex, getBridgeAxes47, getBridgeStats, clearBridgeCache, getBridgeCacheStats };
