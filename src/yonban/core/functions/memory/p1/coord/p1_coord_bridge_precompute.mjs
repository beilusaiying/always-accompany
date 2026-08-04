// ════════════════════════════════════════════════════════════════════
// p1_coord_bridge_precompute.mjs — C1 收尾: coord-bridge 离线预计算脚本（跑一次，生成 p1_coord_bridge.json）
//
// 功能链：node p1_coord_bridge_precompute.mjs（离线一次）→ 各物理词库词 × NB300 cosine 对比 chat AT 术语
//         → top-K 近邻 axes_47 加权平均 → 写 p1_coord_bridge.json
// why：运行时无法实时给 34K+ 库词计算桥接坐标（约 25-40s）；离线预计算一次，运行时 loader 直接读 json，
//      桥接词获得 axes_47 坐标后才能参与 node6 空间投票（否则被 dim0Skip 丢弃=directionWords=0 的根因）。
// 关联链：
//   → numberbatch.mjs（getNumberbatch，NB300 向量源）
//   → P1资源库/（DLUT情感/narrative_terms/cn_daily/DomainWordsDict 各轴物理词库）
//   → p1_coord_bridge.json（输出文件，被 p1_coord_bridge.mjs loader 读取）
// 影响范围：写 lib/p1_coord_bridge.json；约需 14s(NB 加载) + 20s(桥接计算)；库词 NB 未命中跳过不硬造（软隔离铁律）
// ════════════════════════════════════════════════════════════════════
//
// 【做什么】把节点3 各轴专属物理词库的【中文词】桥接进 axes_47 坐标空间, 让 axisDiverge 的
//   发散靶从"仅 AT 术语(4452)"扩为"AT + 桥接物理库词", 实现凛倾框架"每个轴用对应的资源发散吐新词"
//   (框架§六节点3:192 "每个轴都有对应的资源"; p1_node3_axis6.mjs:212-214 "接 6 物理词库需先把其词桥接进 axes_47")。
//
// 【桥接原理】(node3 头注:214 "词→NB300 向量→投影/近邻到 axes_47 坐标"):
//   库词 w → 查 NB300 向量(无向量则跳过并计数, 不硬造坐标=软隔离铁律#48)
//        → 对 chat-mode AT 术语索引(4452 个带 axes_47 + 有 NB 向量的术语)算 NB300 cosine
//        → 取 sim≥MINSIM 的 top-K 近邻 AT 术语
//        → 它们的 axes_47 按 cosine 【加权平均】(加性, 非连乘; 距离核非质量系数 → 不违禁乘法铁律)
//        → 得桥接词的 axes_47(47维稠密坐标, 与 AT 术语同空间)。
//   ★为什么 axes_47 用 chat AT 当基准: chat 发散靶最全(4452/4 mode 最大), 47 维覆盖最完整;
//     axes_47 的 47 维定义跨 mode 一致, 故桥接坐标 mode 无关, 运行时可并入任何 mode 靶空间。
//
// 【接哪几个库 = 2026-06-13 实测命中率决定(C:/tmp/probe_bridge_coverage.mjs)】:
//   ✓接(中文+NB命中可观): DLUT情感26470/命中10530(心理) · narrative_terms170/命中150(语言) ·
//      cn_daily2144/命中1389(社会常识) · DomainWordsDict各轴域(信息/社会/逻辑/语言, 命中率7-14%但绝对数可观)
//   ✗不接(英文库, 中文 axisDiverge 接不进=node3:73 实测"VAD覆盖AT0%/lancaster0.8%"印证):
//      NRC-VAD(英文 term) · lancaster_sensorimotor(英文 Word) · cognitive-bias(194英文偏差名) · NRC-Emotion(英文)
//   ✗不接(distance=1 同义死红线, 框架§三): cilin 同义词林(GBK, 同义扩展=distance1, 用于 node5 确认非 node3 发散)
//   ⊘cognitive 轴: axes_47 无 cognitive 组(只有 psy/info/soc/logic/lang/mode 47维)=轴盲, 是否造组待凛倾,
//      本脚本不给 cognitive 库桥接(世界哲学等不接), 维持轴盲现状(node3:74 "cognitive 无对应组→保持轴盲")。
//
// 【输出 p1_coord_bridge.json】{ meta:{...统计...}, entries:[{word, axes47:{...稀疏坐标...}, src:"库名", axis:"轴名", dom:"组名"}] }
//   运行时由 p1_coord_bridge.mjs loader 读入, 建 NB 索引并入 axisDiverge 靶空间。
//   ★dom = 库声明轴对应的 axes_47 组(psy/info/soc/logic/lang), 【直接由资源来源轴给定, 不靠 axes_47 argmax 反推】:
//     实测(2026-06-13)桥接坐标 argmax 89% 落 psy(axes_47 psy 组 9 维最大 + chat AT 偏心理 = p1_axis:45 "psy 结构性独大"在桥接层重现),
//     若 dom 用 argmax 则 info/logic/lang 库词主组全变 psy → 被各自轴的 AXIS_AWARE_DIVERGE 主组门挡掉 = 桥接白费。
//     凛倾框架"每个轴都有对应的资源"=资源归属轴是【设计给定】的(DLUT=心理资源/Domain计算机=信息资源), 故 dom 直接 = src 轴组(正解, 非反推)。
//
// 【加性/软隔离白盒诚实】: 加权平均=加性融合(禁乘法); 库词 NB 未命中/无近邻 → 跳过并计入 skip 计数(不硬造);
//   每库桥接成功数/跳过数写进 meta 供白盒溯源。axes_47 稀疏存储(只存 >COORD_FLOOR 维, 减小文件)。
//
// 【用法】node p1_coord_bridge_precompute.mjs  (在 lib 目录跑; 约 25-40s, NB 加载 ~14s + 桥接 ~20s)
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getNumberbatch } from "../../nlp/numberbatch.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getResDir } from "../p1_resdir.mjs";
const RES_DIR = getResDir();
const OUT_FILE = path.join(RES_DIR, "p1_coord_bridge.json");

// ── 桥接参数(魔法数字 = CFG 常量 + [待实验定]) ──
const TOPK = 5;        // [待实验定] 每个库词取最近 K 个 AT 术语做 axes_47 加权平均
const MINSIM = 0.30;   // [待实验定] NB300 cosine 下限(<此值的 AT 术语不参与桥接, 太远=噪声)
const COORD_FLOOR = 0.05;   // [待实验定] axes_47 稀疏存储: 只存 >此值的维(减小文件; 桥接坐标是加权平均, 小维=噪声)
const ZH_RE = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/;
const MIN_LEN = 2, MAX_LEN = 4;   // 桥接词长度门(2-4字中文, 与 axisDiverge maxLen 一致)
const AXIS_TO_GROUP = { psychology: "psy", informatics: "info", sociology: "soc", logic: "logic", linguistics: "lang" };   // node3 轴→axes_47 组(dom 直接由 src 轴给定)

function nbVec(nb, w) {
  const v = nb.get(w);
  if (!v) return null;
  let n = 0; for (let i = 0; i < 300; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  return n > 0 ? { vec: v, norm: n } : null;
}

// ── 库 loader: 每个返回 中文2-4字去重词数组 ──
function loadDLUT() {
  const fp = path.join(RES_DIR, "DLUT-Emotionontology/情感词汇/情感词汇.csv");
  return fs.readFileSync(fp, "utf-8").split("\n").slice(1).map(l => l.split(",")[0]?.trim()).filter(Boolean);
}
function loadNarrative() {
  return fs.readFileSync(path.join(RES_DIR, "narrative_terms.txt"), "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
}
function loadCnDaily() {
  const fp = path.join(__dirname, "..", "cn_daily_index.json");
  if (!fs.existsSync(fp)) return [];
  return Object.keys(JSON.parse(fs.readFileSync(fp, "utf-8")));
}
function loadDomain(file) {
  const fp = path.join(RES_DIR, "DomainWordsDict/data", file);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, "utf-8").split("\n").map(l => { const t = l.indexOf("\t"); return (t > 0 ? l.slice(0, t) : l).trim(); }).filter(Boolean);
}

// ── 库 → 轴 配置(每个库标注它喂哪个 node3 轴; 一库可多域合并) ──
//   词量大的 Domain 域只接命中 NB 的词(命中率低但绝对数可观), 自然成"高置信子集"(在 NB 空间有坐标的词)。
const SOURCES = [
  { name: "DLUT情感", axis: "psychology", load: loadDLUT },
  { name: "narrative_terms", axis: "linguistics", load: loadNarrative },
  { name: "Domain语言域", axis: "linguistics", load: () => [].concat(loadDomain("汉语言学.txt"), loadDomain("文学名著.txt"), loadDomain("诗词歌赋.txt"), loadDomain("网络文学.txt")) },
  { name: "cn_daily常识", axis: "sociology", load: loadCnDaily },
  { name: "Domain社会域", axis: "sociology", load: () => [].concat(loadDomain("社会科学.txt"), loadDomain("法律诉讼.txt"), loadDomain("金融财经.txt"), loadDomain("人力招聘.txt")) },
  { name: "Domain信息域", axis: "informatics", load: () => [].concat(loadDomain("计算机业.txt"), loadDomain("电子工程.txt"), loadDomain("通信工程.txt")) },
  { name: "Domain逻辑域", axis: "logic", load: () => [].concat(loadDomain("数学科学.txt"), loadDomain("物理科学.txt"), loadDomain("化学化工.txt")) },
  // cognitive 轴轴盲(axes_47 无 cognitive 组) → 不接库, 待凛倾拍是否造组。
];

async function main() {
  const t0 = Date.now();
  const nb = getNumberbatch();
  if (!nb || typeof nb.get !== "function") { console.error("[bridge] NB300 加载失败, 中止"); process.exit(1); }
  console.log(`[bridge] NB300 加载: ${nb.size} 词, ${Date.now() - t0}ms`);

  // 建 chat AT 靶索引(带 axes_47 + 有 NB 向量)
  const at = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "activation_terms_chat.json"), "utf-8"));
  const atIdx = [];
  for (const terms of Object.values(at)) for (const [t, meta] of Object.entries(terms)) {
    if (!meta || !meta.axes_47) continue;
    const nv = nbVec(nb, t); if (!nv) continue;
    atIdx.push({ term: t, vec: nv.vec, norm: nv.norm, axes47: meta.axes_47 });
  }
  console.log(`[bridge] chat AT 靶索引: ${atIdx.length} 术语(带 axes_47 + NB 向量)`);

  // 桥接一个词 → axes_47(或 null)
  function bridgeWord(word) {
    const nv = nbVec(nb, word); if (!nv) return null;
    const sims = [];
    for (const e of atIdx) {
      if (e.term === word) continue;   // 库词恰是 AT 术语 → 不自桥(它本身已在靶空间)
      let dot = 0; for (let i = 0; i < 300; i++) dot += nv.vec[i] * e.vec[i];
      const s = dot / (nv.norm * e.norm);
      if (s >= MINSIM) sims.push({ s, axes47: e.axes47 });
    }
    if (sims.length === 0) return null;
    sims.sort((a, b) => b.s - a.s);
    const top = sims.slice(0, TOPK);
    const acc = {}; let wsum = 0;
    for (const { s, axes47 } of top) { wsum += s; for (const k in axes47) acc[k] = (acc[k] || 0) + s * axes47[k]; }   // 加权平均(加性)
    // 稀疏化: 归一后只保留 >COORD_FLOOR 的维(小维=加权平均噪声, 删之减小文件; 软隔离不硬过滤词本身, 只裁坐标噪声维)
    const out = {};
    for (const k in acc) { const v = +(acc[k] / wsum).toFixed(3); if (v > COORD_FLOOR) out[k] = v; }
    return Object.keys(out).length ? out : null;
  }

  const entries = [];
  const seen = new Set();   // 跨库去重(同词多库出现→只取首库, 避免重复发散靶)
  const atTermSet = new Set(atIdx.map(e => e.term));   // 已在 AT 靶里的词不重复桥接
  const perSrc = [];
  for (const src of SOURCES) {
    const tb = Date.now();
    const raw = [...new Set(src.load())];
    const cand = raw.filter(w => ZH_RE.test(w) && w.length >= MIN_LEN && w.length <= MAX_LEN && !atTermSet.has(w) && !seen.has(w));
    let ok = 0, skip = 0;
    for (const w of cand) {
      const axes47 = bridgeWord(w);
      if (!axes47) { skip++; continue; }
      // dom 直接由库声明轴给定(非 argmax 反推, 见头注: 避 psy 结构性独大把非心理轴库词主组全染成 psy)
      entries.push({ word: w, axes47, src: src.name, axis: src.axis, dom: AXIS_TO_GROUP[src.axis] });
      seen.add(w); ok++;
    }
    perSrc.push({ name: src.name, axis: src.axis, raw: raw.length, candidate: cand.length, bridged: ok, skipped: skip, ms: Date.now() - tb });
    console.log(`[bridge] ${src.name}(${src.axis}): 原始${raw.length} 候选${cand.length} 桥接✓${ok} 跳过${skip} ${Date.now() - tb}ms`);
  }

  const meta = {
    generated: new Date().toISOString(),
    method: "库词 NB300 → chat AT(axes_47+NB) top" + TOPK + " cosine≥" + MINSIM + " 加权平均 axes_47",
    topK: TOPK, minSim: MINSIM, lenRange: [MIN_LEN, MAX_LEN],
    atTargetCount: atIdx.length,
    totalBridged: entries.length,
    perSource: perSrc,
    note: "英文库(NRC-VAD/lancaster/cognitive-bias/NRC-Emotion)+cilin(distance1同义)+cognitive轴(轴盲)未接, 见脚本头注。",
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify({ meta, entries }, null, 0));
  console.log(`\n[bridge] 落盘 ${OUT_FILE}`);
  console.log(`[bridge] 桥接总词数: ${entries.length}, 总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // 轴分布
  const byAxis = {};
  for (const e of entries) byAxis[e.axis] = (byAxis[e.axis] || 0) + 1;
  console.log("[bridge] 轴分布:", JSON.stringify(byAxis));
}

main();
