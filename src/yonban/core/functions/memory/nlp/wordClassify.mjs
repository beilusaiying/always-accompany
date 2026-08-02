// ════════════════════════════════════════════════════════════════════
// wordClassify.mjs — 词分类（停用词→drop / 其余→content，给召回判定每个词的角色）
//
// 功能链：queryExpand.mjs → classifyWord(word) → "drop" | "content"
// why：单资源（只 BCC 频率）区分填充/内容太粗（误杀"医院"）；改用 chinese-stopwords union 精准挡填充词，
//      OOV 专名一律归 content 保召回，词强弱区分移至 memoryRecall 打分层（IDF）。
// 关联链：
//   ← queryExpand.mjs（classifyWord 过滤 jieba 分词结果）
//   → P1资源库/chinese-stopwords（baidu1396+hit767+cn746 union，进程级缓存）
// 影响范围：只读停用词表（_stop Set，进程级懒加载一次），纯查表无 I/O
// ════════════════════════════════════════════════════════════════════
// 凛倾 2026-06-02: "POS会让单字词失效, 重新优化设计, 先拆分然后分类".
//   单一资源(只BCC频率)区分填充/内容太粗(误杀"医院"); 单一POS对单字失效(查不到→误杀"焰").
//   解法 = 分词后给每个词分类, 按类别决定召回角色:
//     · drop      虚词/停用/填充词 → 不进召回(不搜不驱动)
//     · content   实义内容词(含 OOV 专名)→ 驱动召回
//
// 【现状=实际代码为准, 头注释勿信腐烂版】classifyWord 只用单资源做二分:
//   · 标点 _isPunct → drop.
//   · 中文停用词表 chinese-stopwords(baidu1396+hit767+cn746 union) → drop(精准抓填充词 因为/让/时候/什么,
//     实测不误含内容词 医院/失眠/焰). 其余一律 content.
//   POS(CoreNatureDictionary)分支已删(对单字失效, 误标 m); proper 角色已废(OOV 词落 content 照样召回).
//   词的强弱区分(IDF/自信息加权)不在分类层做, 移到 memoryRecall 打分层(点11), 资源=BCC 词频. 见 03b_记忆召回重写§2/§5b.
// ════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getResDir } from "../p1/p1_resdir.mjs";  // P0-2 统一资源定位(env P1_RESOURCE_DIR > memory/p1_res > 旧运行位)
const RES_DIR = getResDir();

const _isPunct = (w) => /^[\s，。！？,.!?；;：:、…—\-~·"'"'（）()【】\[\]]+$/.test(w);

// ── 停用词表 union(P1资源库 chinese-stopwords, 进程级缓存) ──
let _stop = null;
function _loadStop() {
  if (_stop) return _stop;
  _stop = new Set();
  for (const f of ["baidu_stopwords.txt", "hit_stopwords.txt", "cn_stopwords.txt"]) {
    try {
      for (const line of fs.readFileSync(path.join(RES_DIR, "chinese-stopwords", f), "utf-8").split("\n")) {
        const w = line.trim();
        if (w) _stop.add(w);
      }
    } catch { /* 缺某表不致命, union 其余 */ }
  }
  return _stop;
}
export function isStopword(w) { return _loadStop().has(w); }

// ── 主分类: 词 → "drop" | "content" ──
//   drop=虚词/停用/填充(不召回); content=实义内容词(驱动召回, 含OOV生僻词).
export function classifyWord(w) {
  if (!w || !w.trim() || _isPunct(w)) return "drop";
  const stop = _loadStop();
  if (stop.has(w)) return "drop"; // 停用词(填充/虚词) — 多字单字通用
  return "content";
}

export default classifyWord;
