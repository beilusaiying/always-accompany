// [bccTokenize] — BCC 词频字典 + 贪心分词(runStep1Extract),主线共享底层。
// why:原实现在 test/selfDrivenP1_utils.mjs(P1 自驱动工具库);P1 系列 2026-07-16 整体
//     归档不随开源发布,但主线两处消费这 3 个函数,故抽出为独立模块(实现逐行保形未改逻辑):
//     ← storage_mod/memoryRecall.mjs(_getBccFreq/_getBccDict:超高频词过滤判据)
//     ← nlp/queryExpand.mjs(runStep1Extract:查询词提取)
// 资源:memory 根 multi_domain_total_word_freq.txt(BCC multi_domain 436K 词频);
//      缺失时 _getBccDict 返回空 Map → 分词走贪心 fallback,不崩。
// 契约(改动须知):_getBccDict 返回 Map<string,number>(词→频次),runStep1Extract
//      返回 { words: string[], text }——消费方按此解构,改类型即断链。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findResource as _resdirFind } from "../p1/p1_resdir.mjs"; // P1 单一资源根

const __bcc_dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // nlp/ → memory 根(数据文件所在)

function resolveResource(filename) {
  const candidates = [
    path.join(__bcc_dirname, filename),
    path.join(__bcc_dirname, "resources", filename),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return _resdirFind(filename);
}

let _bccDictCache = null;
/** @contract 返回: Map<string,number> — 词→BCC频率
 *  @breaking 改Map类型→分词+召回过滤链崩 */
export function _getBccDict() {
  if (_bccDictCache) return _bccDictCache;
  try {
    const f = resolveResource("multi_domain_total_word_freq.txt");
    if (!f) { _bccDictCache = new Map(); return _bccDictCache; }
    _bccDictCache = new Map();
    const lines = fs.readFileSync(f, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || i === 0 && line.startsWith("token")) continue;
      const sep = line.includes("\t") ? "\t" : ",";
      const idx = line.lastIndexOf(sep);
      if (idx < 0) continue;
      const w = line.substring(0, idx).trim();
      const freq = parseInt(line.substring(idx + 1));
      if (w && !isNaN(freq)) _bccDictCache.set(w, freq);
    }
  } catch { _bccDictCache = new Map(); }
  return _bccDictCache;
}
export function _getBccFreq(w) { return _getBccDict().get(w) || 0; }

let _jiebaCut = null;
try { const _jm = await import("jieba-wasm"); _jiebaCut = _jm.cut; } catch { _jiebaCut = null; } // 缺包→贪心 fallback,不崩
export function runStep1Extract(text) {
  if (!text) return { words: [], text: "" };
  const seen = new Set();
  const words = [];
  if (_jiebaCut) {
    const tokens = _jiebaCut(text, true);
    for (const w of tokens) {
      if (w.length < 2) continue;
      if (seen.has(w)) continue;
      if (/^[a-zA-Z]/.test(w)) { words.push(w); seen.add(w); continue; }
      if (/^[\u4e00-\u9fff]/.test(w)) {
        const freq = _getBccFreq(w);
        if (freq > 500000) continue;
        words.push(w); seen.add(w);
      }
    }
  } else {
    const zhSegs = text.match(/[\u4e00-\u9fff]+/g) || [];
    const en = text.match(/[a-zA-Z]{2,}/g) || [];
    for (const seg of zhSegs) {
      let pos = 0;
      while (pos < seg.length) {
        let best = null, bestLen = 1, bestFreq = 0;
        for (let len = Math.min(4, seg.length - pos); len >= 2; len--) {
          const w = seg.substring(pos, pos + len);
          const f = _getBccFreq(w);
          if (f > 0 && (len > bestLen || (len === bestLen && f > bestFreq))) { best = w; bestLen = len; bestFreq = f; }
        }
        if (best && bestFreq > 0) { if (!seen.has(best)) { words.push(best); seen.add(best); } pos += bestLen; }
        else { pos++; }
      }
    }
    for (const w of en) { if (!seen.has(w)) { words.push(w); seen.add(w); } }
  }
  return { words, text };
}
