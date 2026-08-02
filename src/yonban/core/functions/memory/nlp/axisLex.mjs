// axisLex.mjs — 多轴语义词集（用资源库替代硬编码 10-20 词，扩广度到 300-34K）
//
// 功能链：p1_node3_axis6 / memoryRecall → getAxisWords(axis) → Set<string>（acg/tech/emotion 等轴专属词集）
// why：硬编码 10-20 词的轴词集覆盖太窄（"使用场景广度对不上"）；动态加载 P1 资源库词典扩广度，
//      资源缺失时静默降级到硬编码集合，测试/部署兼容。
// 关联链：
//   ← p1_node3_axis6.mjs（每轴发散前取 getAxisWords 作种子集）
//   ← escalationLex.mjs / hallidayConj.mjs（部分轴词复用）
//   → P1资源库/（acg-chinese-words/THUOCL_IT/cilin 等，P1_RESOURCE_DIR 环境变量可覆盖路径）
// 影响范围：只读 P1 资源库文件（进程级 Map 缓存，资源缺失不崩）
//
// 解决问题:
//   - acg_reference 轴: ACG_WORDS 硬编码 14 词 → 用 acg-chinese-words(34K) + bilibili_acg(2.4M)
//   - tech_emotion 轴: TECH_WORDS 硬编码 ~10 词 → 用 THUOCL_IT(16K) + caijing(3.8K)
//   - self_eval_swing 轴: control/dependent 各 ~9 词 → 词林同小类扩散(凛倾§16.34 新增)
//   - time_projection 轴: future/now 各 ~8 词 → 词林同小类扩散(凛倾§16.34 新增)
//   - 后续可扩: medical/law/food 等领域词
//
// 借入方式: 动态加载 P1 资源库目录(凛倾"可以借入"), 不打包到 plugin(plugin 体积不变)
// 资源缺失时静默降级到硬编码集合(测试/部署兼容)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P0-2 起统一走 p1_resdir.mjs(env P1_RESOURCE_DIR > memory/p1_res > 旧运行位)。原本地候选含 "<PROJECT_ROOT>" 字面量死路径。
import { findResource } from "../p1/p1_resdir.mjs";

// 加载格式: "词\tcount\n" 或 "词\n"
function loadWordList(absPath, minCount = 0) {
  if (!absPath) return new Set();
  const set = new Set();
  try {
    const text = fs.readFileSync(absPath, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const word = parts[0];
      const count = parts.length >= 2 ? parseInt(parts[1]) : 1;
      if (word && word.length >= 2 && (Number.isFinite(count) ? count >= minCount : true)) {
        set.add(word);
      }
    }
  } catch (e) {
    console.warn(`[axisLex] load ${absPath} fail:`, e.message);
  }
  return set;
}

// 词林同小类扩散(与 escalationLex.mjs 同逻辑, 但在此处独立实现避免循环依赖)
// 同小类 = 编码前 5 字符相同(Aa01A 级别)
function expandByCilin(cilin, seeds) {
  const result = new Set();
  const w2c = cilin.word2codes || {};
  const c2w = cilin.code2words || {};
  for (const seed of seeds) {
    result.add(seed);
    const codes = w2c[seed] || [];
    for (const code of codes) {
      for (const w of (c2w[code] || [])) result.add(w);
      const prefix = code.substring(0, 5);
      for (const [otherCode, words] of Object.entries(c2w)) {
        if (otherCode.startsWith(prefix) && otherCode !== code) {
          for (const w of words) result.add(w);
        }
      }
    }
  }
  return result;
}

let _cilin = null;
function loadCilin() {
  if (_cilin) return _cilin;
  try {
    _cilin = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "cilin.json"), "utf-8"));
  } catch (e) {
    console.warn("[axisLex] cilin.json load fail:", e.message);
    _cilin = { word2codes: {}, code2words: {} };
  }
  return _cilin;
}

let _lex = null;
let _loaded = false;

// ★ 修法 B-v2 (acg_fix_合主线 2026-05-09): 过滤 acg Set 中的污染词
// A: 纯ASCII≤3字符词过滤 — 防子串误匹配技术英文 (如 "ff"→"useeffect", "ac","ks" 等)
// 保留: 含汉字/含日文/≥4字符英文词 (如 "miku","haku","vocaloid","mmd")
function isAcgWordSafe(word) {
  if (/^[a-zA-Z0-9]{1,3}$/.test(word)) return false;  // 纯ASCII≤3字 → 过滤
  return true;
}

// B: moetype 专用过滤 — 排除通用中文词 (如"感觉"/"不知道"/"独立")
// moetype (萌娘百科) 含大量通用中文词，误激活技术/情感输入
// 保留: 含日文假名/含英文字母混搭/非常见通用词
const _MOETYPE_COMMON_BLACKLIST = new Set([
  "感觉","不知道","独立","使用","觉得","没有","可以","因为","所以","如果","但是","虽然",
  "其实","已经","还是","一直","只是","这样","那么","什么","怎么","知道","开始","结束",
  "发现","看到","听到","想到","说到","做到","回到","走到","来到","找到","用到",
  "关注","关系","问题","方法","方式","情况","原因","结果","影响","变化","发展",
  "提高","增加","减少","改变","控制","管理","处理","解决","实现","完成","支持","帮助",
  "需要","希望","相信","认为","感到","想要","能够","应该","必须","可能","还有",
]);
function isAcgMoetypeSafe(word) {
  if (/^[a-zA-Z0-9]{1,3}$/.test(word)) return false;        // A: 纯ASCII短词
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(word)) return true; // 含日文假名 → 保留
  if (/[a-zA-Z]/.test(word)) return true;                    // 含英文字母混搭 → 保留
  if (_MOETYPE_COMMON_BLACKLIST.has(word)) return false;      // B: 通用词黑名单
  return true;
}

function ensureLoaded() {
  if (_loaded) return _lex;
  _loaded = true;

  // ACG 轴(凛倾§16.31 计划 B)
  const acgPaths = [
    "acg-chinese-words/动画.txt",
    "acg-chinese-words/游戏.txt",
    "acg-chinese-words/宅舞.txt",
    "acg-chinese-words/鬼畜.txt",
  ];
  const acg = new Set();
  for (const rel of acgPaths) {
    const p = findResource(rel);
    if (p) for (const w of loadWordList(p, 100)) {
      if (isAcgWordSafe(w)) acg.add(w);  // ★ B-v2 A: 过滤纯ASCII≤3字符词
    }
  }
  // moetype 萌娘百科 ACG 专名(凛倾§16.34 F): 限制 2-3 字避免长全名稀释
  const moePath = findResource("moetype/tone_moe.dict.yaml");
  if (moePath) {
    try {
      const text = fs.readFileSync(moePath, "utf-8");
      let count = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("---") || line.startsWith("...") || line.startsWith("name:") ||
            line.startsWith("version:") || line.startsWith("sort:") || !line.trim()) continue;
        const word = line.split("\t")[0].trim();
        // 只取 2-3 字 ACG 核心词(角色/作品简称), 5+ 字全名跳过
        // ★ B-v2 B: 加 isAcgMoetypeSafe 过滤通用中文词("感觉"/"不知道"/"独立" 等)
        if ((word.length === 2 || word.length === 3) && isAcgMoetypeSafe(word)) { acg.add(word); count++; }
        if (count >= 20000) break;  // 上限避免 set 过大
      }
    } catch (e) { console.warn("[axisLex] moetype load fail:", e.message); }
  }
  // 硬编码 fallback(资源缺失时还能跑)
  if (acg.size === 0) {
    ["小圆", "杏子", "晓美焰", "魔法少女", "vocaloid", "初音", "番剧", "二次元",
     "galgame", "airp", "角色卡", "立绘", "嘴硬", "傲娇"].forEach(w => acg.add(w));
  }

  // tech_emotion 技术轴(THUOCL 清华领域词典)
  const techPaths = [
    "THUOCL/data/THUOCL_IT.txt",        // 16K 编程
    "THUOCL/data/THUOCL_caijing.txt",   // 3.8K 财经
  ];
  const tech = new Set();
  for (const rel of techPaths) {
    const p = findResource(rel);
    if (p) for (const w of loadWordList(p, 1000)) tech.add(w);  // 高频技术词
  }
  if (tech.size === 0) {
    ["代码", "bug", "function", "import", "项目", "系统", "调试", "运行",
     "api", "数据库", "前端", "后端", "算法", "服务器"].forEach(w => tech.add(w));
  }

  // 医学/法律/食物 领域词(供 sceneFrame 路由 + escalation 增强)
  const medical = loadWordList(findResource("THUOCL/data/THUOCL_medical.txt"), 500);
  const law = loadWordList(findResource("THUOCL/data/THUOCL_law.txt"), 500);
  const food = loadWordList(findResource("THUOCL/data/THUOCL_food.txt"), 500);
  const chengyu = loadWordList(findResource("THUOCL/data/THUOCL_chengyu.txt"), 0);
  const poem = loadWordList(findResource("THUOCL/data/THUOCL_poem.txt"), 0);

  // self_eval_swing 轴: 掌控感/依赖感 — 词林扩散(凛倾§16.34)
  // 种子选取原则: 避免高歧义虚词(可以/强/不行)导致过度扩散(>1000)
  const CONTROL_SEEDS = ["限制", "决定", "聪明", "厉害", "做到", "完成", "胜任", "掌控", "主导"];
  const DEPENDENT_SEEDS = ["害怕", "失去", "笨", "无能", "依赖", "恐惧", "脆弱", "怯弱", "无助"];
  const cilin = loadCilin();
  let control = expandByCilin(cilin, CONTROL_SEEDS);
  let dependent = expandByCilin(cilin, DEPENDENT_SEEDS);
  // fallback: 词林为空时退回硬编码种子
  if (control.size <= CONTROL_SEEDS.length) {
    ["可以", "限制", "决定", "强", "聪明", "厉害", "做到", "搞定", "完成"].forEach(w => control.add(w));
  }
  if (dependent.size <= DEPENDENT_SEEDS.length) {
    ["怕", "害怕", "失去", "需要你", "离不开", "笨", "做不到", "不行", "无能"].forEach(w => dependent.add(w));
  }

  // time_projection 轴: 未来时/当下时 — 词林扩散
  const TIME_FUTURE_SEEDS = ["以后", "未来", "终于", "永远", "一直", "下次"];
  const TIME_NOW_SEEDS = ["现在", "今天", "立刻", "刚才", "刚刚"];
  let time_future = expandByCilin(cilin, TIME_FUTURE_SEEDS);
  let time_now = expandByCilin(cilin, TIME_NOW_SEEDS);
  if (time_future.size <= TIME_FUTURE_SEEDS.length) {
    ["以后", "未来", "终于", "永远", "一直", "下次", "下一", "10年", "20年"].forEach(w => time_future.add(w));
  }
  if (time_now.size <= TIME_NOW_SEEDS.length) {
    ["现在", "今天", "马上", "立刻", "刚才", "刚刚"].forEach(w => time_now.add(w));
  }

  // SentiBridge 情感桥(凛倾§16.34: 取右列形容词扩 emotion 集)
  const sentiPath = findResource("SentiBridge/Entity_Emotion_Express/CCF_data/pair_mine_result");
  const sentiEmotion = new Set();
  if (sentiPath) {
    try {
      const text = fs.readFileSync(sentiPath, "utf-8");
      for (const line of text.split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 2) {
          const emo = parts[1].trim();
          if (emo && emo.length >= 2 && emo.length <= 4) sentiEmotion.add(emo);
        }
      }
    } catch (e) { console.warn("[axisLex] SentiBridge load fail:", e.message); }
  }

  // near-synonym 反义词(凛倾§16.34: P1 唯一缺的反义资源, "对比律")
  // 格式: "词A——词B"
  const antonymMap = new Map();
  const antPath = findResource("near-synonym/tet/dict/antonym.txt");
  if (antPath) {
    try {
      for (const line of fs.readFileSync(antPath, "utf-8").split("\n")) {
        const parts = line.split("——");
        if (parts.length === 2) {
          const a = parts[0].trim();
          const b = parts[1].trim();
          if (a && b && a.length >= 2 && b.length >= 2) {
            antonymMap.set(a, b);
            antonymMap.set(b, a);
          }
        }
      }
    } catch (e) { console.warn("[axisLex] antonym load fail:", e.message); }
  }

  // Chinese-Synonyms 同义词(narrow 3.3MB, 与 cilin 互补覆盖口语/新词)
  const synonymsMap = new Map();
  const synPath = findResource("Chinese-Synonyms/synonyms_expanded_narrow.json");
  if (synPath) {
    try {
      const json = JSON.parse(fs.readFileSync(synPath, "utf-8"));
      for (const [k, v] of Object.entries(json)) {
        if (Array.isArray(v) && v.length > 0) synonymsMap.set(k, v);
      }
    } catch (e) { console.warn("[axisLex] synonyms load fail:", e.message); }
  }

  // ★ 领域专业词库(DomainWordsDict 68领域 + 手动整理)
  // 凛倾: "每个领域有词库" + "专业词汇(转折/情节/调试/重构)"
  const narrative = loadWordList(findResource("narrative_terms.txt"), 0);
  const coding = loadWordList(findResource("coding_terms.txt"), 0);
  const domComputer = loadWordList(findResource("DomainWordsDict/data/计算机业.txt"), 10);
  const domAnime = loadWordList(findResource("DomainWordsDict/data/新番动漫.txt"), 0);
  // 合并: coding += domComputer(>10频次), acg += domAnime
  // narrative 不加 domSocial(太杂), 手动 narrative_terms.txt 质量更高
  for (const w of domComputer) { if (w.length >= 2 && w.length <= 6) coding.add(w); }
  for (const w of domAnime) { if (isAcgWordSafe(w)) acg.add(w); }  // ★ B-v2 A: 过滤纯ASCII短词

  _lex = { acg, tech, medical, law, food, chengyu, poem,
           control, dependent, time_future, time_now,
           sentiEmotion, antonymMap, synonymsMap,
           narrative, coding };

  console.log(
    `[axisLex] loaded: acg=${acg.size} tech=${tech.size} medical=${medical.size} ` +
    `law=${law.size} food=${food.size} chengyu=${chengyu.size} poem=${poem.size} ` +
    `control=${control.size} dependent=${dependent.size} time_future=${time_future.size} time_now=${time_now.size} ` +
    `sentiEmo=${sentiEmotion.size} ant=${antonymMap.size} syn=${synonymsMap.size} ` +
    `narrative=${narrative.size} coding=${coding.size}`
  );

  return _lex;
}

export function getAxisLex() {
  return ensureLoaded();
}

// 工具: 文本中含某轴词的数量
// 遍历整个轴词集做 includes, n>=20 即早停(命中 20 已足够判轴, 避免大词集全扫开销)
export function countAxisWords(text, axisName) {
  const lex = ensureLoaded();
  const set = lex[axisName];
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const w of set) if (text.includes(w)) { n++; if (n >= 20) break; }
  return n;
}
