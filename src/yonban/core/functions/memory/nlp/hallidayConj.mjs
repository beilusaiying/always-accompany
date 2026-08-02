// hallidayConj.mjs — Halliday 虚词分类器（连接词→坐标偏移向量，8 类方向信号）
//
// 功能链：p1_node1_tokenize / p1_pipeline → detectConjunction(text) → {type, offsetVector}（连接词类型 + 方向偏移）
// why："虚词不是垃圾，是方向信号"（凛倾）——"但是"表转折、"因为"表因果，各有不同的轴偏移方向；
//      Halliday 4类扩展到 8 类（再加 emphasis/uncertainty/concessive/conditional），覆盖对话常见连接词。
// 关联链：
//   ← p1_node1_tokenize.mjs（intensifiers 采集时顺带检测连接词信号）
//   ← p1_pipeline.mjs（linguisticSignals 字段传入 node3 第6参）
//   → halliday_patterns_v2.json（lib/nlp/，扩展模式文件，缺失时 fallback 到内建 CONJUNCTION_MAP）
// 影响范围：只读 halliday_patterns_v2.json（懒加载）+ 内建 Map；纯计算无副作用

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __halliday_dirname = path.dirname(fileURLToPath(import.meta.url));

let _patternsV2 = null;
function _loadPatternsV2() {
  if (_patternsV2) return;
  try {
    const f = path.join(__halliday_dirname, "..", "halliday_patterns_v2.json");
    if (fs.existsSync(f)) _patternsV2 = JSON.parse(fs.readFileSync(f, "utf-8"));
  } catch {}
  if (!_patternsV2) _patternsV2 = {};
}

// 正向判断词(用于区分"补充转折" vs "预期落空")
const _POSITIVE_TRIGGERS = new Set([
  "有理有据", "合理", "说得对", "确实", "没错", "有道理", "正确",
  "灵光", "想法好", "不错", "很好", "对的", "就是这种", "棒",
  "学到", "收获", "喜欢", "开心", "厉害", "精彩", "到位",
]);
const _NEGATIVE_INDICATORS = new Set([
  "根本", "完全不行", "行不通", "不可能", "没用", "废话", "失败",
  "糟糕", "差", "烂", "不对", "错的", "假的", "瞎",
]);

// 一阶: 单个虚词→维度偏移
const CONJUNCTION_MAP = {
  // 对比/转折(Adversative) → valence翻转
  "但是": { type: "adversative", shift: { valence: -1.0 } },
  "但": { type: "adversative", shift: { valence: -0.8 } },
  "然而": { type: "adversative", shift: { valence: -1.0 } },
  "可是": { type: "adversative", shift: { valence: -0.8 } },
  "不过": { type: "adversative", shift: { valence: -0.6 } },
  "却": { type: "adversative", shift: { valence: -0.8 } },
  "虽然": { type: "adversative", shift: { valence: -0.5 } },
  "尽管": { type: "adversative", shift: { valence: -0.5 } },
  "反而": { type: "adversative", shift: { valence: -1.2 } },
  "相反": { type: "adversative", shift: { valence: -1.2 } },

  // 因果(Causal) → arousal升高
  "因为": { type: "causal", shift: { arousal: 0.5, logic: "causal" } },
  "所以": { type: "causal", shift: { arousal: 0.3, logic: "causal" } },
  "因此": { type: "causal", shift: { arousal: 0.4, logic: "causal" } },
  "导致": { type: "causal", shift: { arousal: 0.6, logic: "causal" } },
  "于是": { type: "causal", shift: { arousal: 0.3, logic: "causal" } },
  "既然": { type: "causal", shift: { arousal: 0.3, logic: "causal" } },

  // 时序(Temporal) → script推进
  "然后": { type: "temporal", shift: { script_advance: 1, logic: "sequential" } },
  "接着": { type: "temporal", shift: { script_advance: 1, logic: "sequential" } },
  "之后": { type: "temporal", shift: { script_advance: 1, logic: "sequential" } },
  "最后": { type: "temporal", shift: { script_advance: 2, logic: "sequential" } },
  "首先": { type: "temporal", shift: { script_advance: 0, logic: "sequential" } },
  "其次": { type: "temporal", shift: { script_advance: 0.5, logic: "sequential" } },
  "终于": { type: "temporal", shift: { script_advance: 2, arousal: 0.5 } },
  "突然": { type: "temporal", shift: { script_advance: 1, arousal: 0.8 } },

  // 添加(Additive) → 同域扩展
  "而且": { type: "additive", shift: { breadth: 0.5 } },
  "并且": { type: "additive", shift: { breadth: 0.5 } },
  "另外": { type: "additive", shift: { breadth: 0.8 } },
  "还有": { type: "additive", shift: { breadth: 0.5 } },
  "同时": { type: "additive", shift: { breadth: 0.6 } },
  "也": { type: "additive", shift: { breadth: 0.3 } },

  // 强调(Emphasis) → 情绪强度
  "真的": { type: "emphasis", shift: { intensity: 0.8 } },
  "确实": { type: "emphasis", shift: { intensity: 0.6 } },
  "一定": { type: "emphasis", shift: { intensity: 0.7 } },
  "必须": { type: "emphasis", shift: { intensity: 0.9 } },
  "绝对": { type: "emphasis", shift: { intensity: 1.0 } },
  "肯定": { type: "emphasis", shift: { intensity: 0.7 } },
  "特别": { type: "emphasis", shift: { intensity: 0.6 } },
  "非常": { type: "emphasis", shift: { intensity: 0.7 } },
  "超级": { type: "emphasis", shift: { intensity: 0.8 } },

  // 不确定(Uncertainty) → uncertainty升高
  "也许": { type: "uncertainty", shift: { uncertainty: 0.7 } },
  "可能": { type: "uncertainty", shift: { uncertainty: 0.6 } },
  "大概": { type: "uncertainty", shift: { uncertainty: 0.5 } },
  "或许": { type: "uncertainty", shift: { uncertainty: 0.7 } },
  "似乎": { type: "uncertainty", shift: { uncertainty: 0.8 } },
  "好像": { type: "uncertainty", shift: { uncertainty: 0.6 } },

  // 让步(Concessive)
  "即使": { type: "concessive", shift: { uncertainty: 0.6, resilience: 0.5 } },
  "哪怕": { type: "concessive", shift: { uncertainty: 0.8, resilience: 0.6 } },
  "就算": { type: "concessive", shift: { uncertainty: 0.7, resilience: 0.5 } },

  // 条件(Conditional)
  "如果": { type: "conditional", shift: { uncertainty: 0.5, logic: "conditional" } },
  "假如": { type: "conditional", shift: { uncertainty: 0.6, logic: "conditional" } },
  "要是": { type: "conditional", shift: { uncertainty: 0.5, logic: "conditional" } },
  "否则": { type: "conditional", shift: { valence: -0.5, logic: "conditional" } },
};

// 二阶: 虚词对→完整语义模式
const CONJUNCTION_PATTERNS = [
  { pair: ["虽然", "但是"], name: "concession_failure", shift: { valence: -1.2, uncertainty: 0.4 } },
  { pair: ["虽然", "却"], name: "concession_failure", shift: { valence: -1.2, uncertainty: 0.4 } },
  { pair: ["尽管", "但是"], name: "concession_failure", shift: { valence: -1.0, uncertainty: 0.4 } },
  { pair: ["因为", "所以"], name: "causal_chain", shift: { arousal: 0.6, certainty: 0.5 } },
  { pair: ["既然", "就"], name: "causal_acceptance", shift: { arousal: 0.3, certainty: 0.6 } },
  { pair: ["即使", "也"], name: "counterfactual_resilience", shift: { uncertainty: 0.8, resilience: 0.5 } },
  { pair: ["如果", "就"], name: "conditional_plan", shift: { uncertainty: 0.5, logic: "conditional" } },
  { pair: ["不是", "而是"], name: "correction", shift: { valence: 0.3, certainty: 0.7 } },
  { pair: ["一方面", "另一方面"], name: "dual_perspective", shift: { breadth: 1.0, uncertainty: 0.3 } },
  { pair: ["越", "越"], name: "intensification", shift: { intensity: 1.0, arousal: 0.5 } },
];

export function classifyConjunctions(tokens, rawText = "") {
  _loadPatternsV2();
  const signals = [];
  const ADVERSATIVE_WORDS = new Set(["但是", "但", "然而", "可是", "不过", "却"]);

  // 二阶模式优先(最长匹配)
  for (const pattern of CONJUNCTION_PATTERNS) {
    const [c1, c2] = pattern.pair;
    if (tokens.includes(c1) && tokens.includes(c2)) {
      signals.push({
        type: "pattern",
        name: pattern.name,
        tokens: pattern.pair,
        shift: pattern.shift,
      });
    }
  }

  // ★ V2语境感知: 检测"补充转折" vs "预期落空"
  if (rawText) {
    for (const aw of ADVERSATIVE_WORDS) {
      if (!tokens.includes(aw)) continue;
      if (signals.some(s => s.tokens?.includes(aw))) continue;
      const idx = rawText.indexOf(aw);
      if (idx < 0) continue;
      const preText = rawText.slice(Math.max(0, idx - 30), idx);
      const postText = rawText.slice(idx + aw.length, idx + aw.length + 30);
      const hasPositivePre = [..._POSITIVE_TRIGGERS].some(t => preText.includes(t));
      const hasNegativePre = [..._NEGATIVE_INDICATORS].some(t => preText.includes(t));
      const hasPositivePost = [..._POSITIVE_TRIGGERS].some(t => postText.includes(t));
      if (hasPositivePre && !hasNegativePre) {
        signals.push({
          type: "contextual_v2",
          name: hasPositivePost ? "additive_complement" : "additive_contrast",
          tokens: [aw],
          shift: { breadth: 0.6, valence: 0.0 },
          v2: true,
        });
        continue;
      }
      if (hasNegativePre && !hasPositivePre) {
        signals.push({
          type: "contextual_v2",
          name: "adversative",
          tokens: [aw],
          shift: { valence: -1.0 },
          v2: true,
        });
        continue;
      }
    }
  }

  // 一阶匹配(未被覆盖的)
  const patternTokens = new Set(signals.flatMap(s => s.tokens));
  for (const token of tokens) {
    if (patternTokens.has(token)) continue;
    const entry = CONJUNCTION_MAP[token];
    if (entry) {
      signals.push({
        type: "single",
        name: entry.type,
        tokens: [token],
        shift: entry.shift,
      });
    }
  }

  return signals;
}

export function getConjunctionSummary(tokens, rawText = "") {
  const signals = classifyConjunctions(tokens, rawText);
  if (signals.length === 0) return null;

  const summary = {
    signals,
    dominantType: signals[0].name,
    combinedShift: {},
  };

  for (const s of signals) {
    for (const [dim, val] of Object.entries(s.shift)) {
      if (typeof val === "number") {
        summary.combinedShift[dim] = (summary.combinedShift[dim] || 0) + val;
      } else {
        summary.combinedShift[dim] = val;
      }
    }
  }

  return summary;
}

// ====== 语气词心理画像(注意力机制) ======
// 凛倾: "可以像LLM那样进行联系,语气词也可以有意义,反应用户心理状况"
// 凛倾: "麻烦死了,就是麻烦+严重的标签" — 组合式推理,不是查字典
//
// 设计: 类似techAttention的注意力机制
//   1. 基础情绪词 → 连续注意力分数(0→1.0)
//   2. 强度放大器(死了/太/好/非常) → 乘性修饰
//   3. 组合模式(多个信号→心理状态推理)
//   4. 输出: 不是标签列表,而是用户心理状态画像

// 基础情绪词: 每个词有base attention score + 情绪轴
const MOOD_BASE = {
  // 困惑轴(用户不理解发生了什么)
  "为什么": { axis: "confusion", attn: 0.7 },
  "怎么": { axis: "confusion", attn: 0.6 },
  "怎么办": { axis: "confusion", attn: 0.7 },
  "怎么回事": { axis: "confusion", attn: 0.8 },
  "什么情况": { axis: "confusion", attn: 0.7 },
  "咋": { axis: "confusion", attn: 0.5 },
  "啥": { axis: "confusion", attn: 0.4 },

  // 挫败轴(用户尝试过但未解决)
  "还是": { axis: "frustration", attn: 0.6 },
  "又": { axis: "frustration", attn: 0.5 },
  "老是": { axis: "frustration", attn: 0.7 },
  "总是": { axis: "frustration", attn: 0.6 },
  "一直": { axis: "frustration", attn: 0.5 },

  // 不解轴(认知失调——预期与现实不符)
  "明明": { axis: "dissonance", attn: 0.8 },
  "居然": { axis: "dissonance", attn: 0.7 },
  "竟然": { axis: "dissonance", attn: 0.8 },

  // 已排除轴(用户已尝试过的, 主AI别重复)
  "当然": { axis: "excluded", attn: 0.5 },

  // 疲惫轴
  "累": { axis: "fatigue", attn: 0.5 },
  "困": { axis: "fatigue", attn: 0.4 },

  // 烦躁轴
  "烦": { axis: "annoyance", attn: 0.6 },
  "麻烦": { axis: "annoyance", attn: 0.5 },
  "讨厌": { axis: "annoyance", attn: 0.6 },

  // 无助轴
  "受不了": { axis: "overwhelm", attn: 0.8 },
  "崩溃": { axis: "overwhelm", attn: 0.9 },
  "不想": { axis: "avoidance", attn: 0.5 },

  // 空虚轴
  "无聊": { axis: "emptiness", attn: 0.4 },
  "无语": { axis: "emptiness", attn: 0.6 },

  // 悲伤轴
  "难过": { axis: "sadness", attn: 0.6 },
  "伤心": { axis: "sadness", attn: 0.7 },
  "难受": { axis: "sadness", attn: 0.6 },

  // 正向轴
  "终于": { axis: "relief", attn: 0.7 },
  "开心": { axis: "joy", attn: 0.6 },
  "高兴": { axis: "joy", attn: 0.6 },
  "棒": { axis: "joy", attn: 0.5 },

  // 补充(Gemini真实数据测试发现缺失)
  "急": { axis: "annoyance", attn: 0.5 },
  "委屈": { axis: "sadness", attn: 0.7 },
  "离谱": { axis: "dissonance", attn: 0.6 },
  "气人": { axis: "annoyance", attn: 0.7 },
  "气": { axis: "annoyance", attn: 0.5 },
  "吓": { axis: "overwhelm", attn: 0.5 },
  "废": { axis: "emptiness", attn: 0.6 },
  "敷衍": { axis: "annoyance", attn: 0.6 },
  "认可": { axis: "joy", attn: 0.5 },
  "和好": { axis: "relief", attn: 0.6 },
  "误会": { axis: "confusion", attn: 0.4 },
  "烦躁": { axis: "annoyance", attn: 0.7 },
  "焦虑": { axis: "overwhelm", attn: 0.6 },
  "着急": { axis: "annoyance", attn: 0.6 },
  "紧张": { axis: "overwhelm", attn: 0.5 },

  // ===== 英文情绪词(面向全球用户) =====
  // confusion
  "why": { axis: "confusion", attn: 0.5 },
  "confused": { axis: "confusion", attn: 0.6 },
  "stuck": { axis: "confusion", attn: 0.5 },
  // frustration
  "again": { axis: "frustration", attn: 0.4 },
  "frustrated": { axis: "frustration", attn: 0.7 },
  "annoying": { axis: "annoyance", attn: 0.6 },
  "annoyed": { axis: "annoyance", attn: 0.6 },
  // overwhelm
  "overwhelmed": { axis: "overwhelm", attn: 0.7 },
  "stressed": { axis: "overwhelm", attn: 0.6 },
  "exhausted": { axis: "fatigue", attn: 0.7 },
  "tired": { axis: "fatigue", attn: 0.5 },
  "burned": { axis: "fatigue", attn: 0.6 },
  // sadness
  "sad": { axis: "sadness", attn: 0.6 },
  "lonely": { axis: "sadness", attn: 0.6 },
  "miss": { axis: "sadness", attn: 0.5 },
  "heartbroken": { axis: "sadness", attn: 0.8 },
  // joy/relief
  "finally": { axis: "relief", attn: 0.7 },
  "happy": { axis: "joy", attn: 0.6 },
  "excited": { axis: "joy", attn: 0.6 },
  "grateful": { axis: "joy", attn: 0.5 },
  "proud": { axis: "joy", attn: 0.5 },
  // dissonance
  "supposed": { axis: "dissonance", attn: 0.5 },
  "apparently": { axis: "dissonance", attn: 0.4 },
  // avoidance
  "avoid": { axis: "avoidance", attn: 0.5 },
  "escape": { axis: "avoidance", attn: 0.6 },
  // feedback_to_ai (English)
  "wrong": { axis: "feedback_to_ai", attn: 0.5 },
};

// 强度放大器: 修饰相邻的基础情绪词(乘性)
const AMPLIFIERS = {
  "死了": 1.6,    // 极端: 无聊死了=无聊×1.6, 麻烦死了=麻烦×1.6
  "太": 1.4,      // 程度: 太累=累×1.4
  "好": 1.3,      // 程度: 好烦=烦×1.3
  "很": 1.2,      // 一般程度
  "非常": 1.4,    // 正式强调
  "超": 1.5,      // 口语极端
  "特别": 1.3,    // 特殊程度
  "真": 1.3,      // 强调真实
  "实在": 1.4,    // 无可奈何
  "真的": 1.3,    // 强调真实感受
  "简直": 1.5,    // 极端
  "完全": 1.3,    // 完全否定/肯定
  "彻底": 1.5,    // 极端程度
  // 英文放大器
  "so": 1.3,
  "really": 1.3,
  "extremely": 1.5,
  "absolutely": 1.5,
  "totally": 1.4,
  "completely": 1.4,
};

// 心理状态组合推理: 多轴组合→深层心理
// 凛倾: "语气词组合反映用户心理状况"
// guide文本是纯行为指令——主AI应内化这些指令去行动,而不是说出来
// 错误: 主AI说"我理解你的认知失调" → 把内部分析外泄
// 正确: 主AI直接按guide行动,语言自然
// ★ 整体词库优化 2026-05-07: guide从主观体验词→方向词(凛倾铁律#9: 给方向不给路线)
//   - 不用DSM/CBT诊断词贴用户标签
//   - 只描述行动方向,不描述用户内在状态
//   - state名保留(内部枚举,不输出给主AI), 只改guide文本(输出字段)
const PSY_PATTERNS = [
  { axes: ["dissonance", "confusion"], state: "cognitive_dissonance",
    guide: "矛盾信息整合方向" },
  { axes: ["dissonance", "excluded"], state: "validated_confusion",
    guide: "排查盲区方向" },
  { axes: ["frustration", "confusion"], state: "persistent_failure",
    guide: "反复卡点行动方向" },
  { axes: ["frustration", "overwhelm"], state: "learned_helplessness",
    guide: "控制感弱化方向" },
  { axes: ["fatigue", "annoyance"], state: "emotional_exhaustion",
    guide: "能量消耗调整方向" },
  { axes: ["dissonance", "emptiness"], state: "self_doubt",
    guide: "方向确认支持方向" },
  { axes: ["overwhelm", "avoidance"], state: "anxiety_avoidance",
    guide: "压力适应推进方向" },
  { axes: ["relief", "joy"], state: "positive_breakthrough",
    guide: "积极突破方向" },
  // ★ 用户对AI行为不满(凛倾: 不安慰,反思改正)
  { axes: ["feedback_to_ai"], state: "user_correcting_ai",
    guide: "反思刚才的行为哪里做错了,承认问题,立即调整做法" },
  { axes: ["feedback_to_ai", "frustration"], state: "repeated_ai_mistake",
    guide: "这个问题之前也犯过,认真道歉,说明具体会怎么改" },
];

// 文本级模式(不依赖分词)
const MOOD_TEXT_PATTERNS = [
  { re: /我(已经|都).{0,4}(试|做|重启|检查|看)了/, axis: "excluded", attn: 0.7 },
  { re: /都试了|试过了|做过了/, axis: "excluded", attn: 0.8 },
  { re: /是不是我|我是不是/, axis: "self_doubt_text", attn: 0.6 },
  { re: /不知道(该|怎么)/, axis: "confusion", attn: 0.7 },
  // ★ 对AI行为的愤怒(凛倾: "用户对ai愤怒时不应安慰,应该反思改正")
  { re: /你(怎么|为什么|能不能|可不可以|别|不要|又).{0,8}(了|啊|吗|呢)/, axis: "feedback_to_ai", attn: 0.9 },
  { re: /说了(多少遍|好几次|很多次)/, axis: "feedback_to_ai", attn: 0.8 },
  { re: /你(听|看|注意|理解)(没有|了吗|了没)/, axis: "feedback_to_ai", attn: 0.7 },
  { re: /你(做|写|给|说)的.{0,4}(不对|不行|有问题|错|差|慢|不好)/, axis: "feedback_to_ai", attn: 0.8 },
  { re: /你这个.{0,6}(不对|太慢|太差|有问题|不行)/, axis: "feedback_to_ai", attn: 0.7 },
  { re: /你(到底|瞎|乱).{0,6}(了|啊|吗)/, axis: "feedback_to_ai", attn: 0.8 },
  { re: /你.{0,4}(行不行|懂不懂|会不会)/, axis: "feedback_to_ai", attn: 0.8 },
  { re: /你(故意|敷衍|随便|糊弄)/, axis: "feedback_to_ai", attn: 0.9 },
  { re: /你(有没有|认不认真|仔不仔细)/, axis: "feedback_to_ai", attn: 0.7 },
  // 自我怀疑(文本级)
  { re: /我(不够|太[差笨弱慢])/, axis: "self_doubt_text", attn: 0.6 },
  { re: /我(干啥啥不行|一事无成|什么都做不好)/, axis: "self_doubt_text", attn: 0.8 },
  // 长句情绪(文本级补充)
  { re: /烦死(我|了)/, axis: "annoyance", attn: 0.9 },
  { re: /急死(我|了)/, axis: "annoyance", attn: 0.8 },
  { re: /累死(我|了)/, axis: "fatigue", attn: 0.8 },
  { re: /气死(我|了)/, axis: "annoyance", attn: 0.9 },
  { re: /吓死(我|了)/, axis: "overwhelm", attn: 0.7 },
  { re: /好委屈/, axis: "sadness", attn: 0.7 },
  { re: /太离谱/, axis: "dissonance", attn: 0.7 },
];

export function getMoodProfile(tokens, rawText = "") {
  // Step 1: 扫描所有token,计算每个基础情绪的注意力分数
  const axisScores = {};  // axis → { totalAttn, tokens, amplified }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const base = MOOD_BASE[token];
    if (!base) continue;

    let attn = base.attn;
    // 检查相邻的放大器(前一个或后一个token)
    let amp = 1.0;
    if (i > 0 && AMPLIFIERS[tokens[i - 1]]) amp = Math.max(amp, AMPLIFIERS[tokens[i - 1]]);
    if (i + 1 < tokens.length && AMPLIFIERS[tokens[i + 1]]) amp = Math.max(amp, AMPLIFIERS[tokens[i + 1]]);
    attn *= amp;

    if (!axisScores[base.axis]) axisScores[base.axis] = { totalAttn: 0, tokens: [], amplified: false };
    axisScores[base.axis].totalAttn += attn;
    axisScores[base.axis].tokens.push(token);
    if (amp > 1.0) axisScores[base.axis].amplified = true;
  }

  // 也检查放大器是否直接跟在情绪词后(文本级: "烦死了"可能分词为"烦"+"死了")
  for (let i = 0; i < tokens.length; i++) {
    if (AMPLIFIERS[tokens[i]] && !MOOD_BASE[tokens[i]]) {
      // 放大器本身不是情绪词,看前一个token是否命中
      if (i > 0 && MOOD_BASE[tokens[i - 1]]) {
        const axis = MOOD_BASE[tokens[i - 1]].axis;
        if (axisScores[axis] && !axisScores[axis].amplified) {
          axisScores[axis].totalAttn *= AMPLIFIERS[tokens[i]];
          axisScores[axis].amplified = true;
        }
      }
    }
  }

  // Step 1b: 文本级模式补充
  if (rawText) {
    for (const pat of MOOD_TEXT_PATTERNS) {
      const m = rawText.match(pat.re);
      if (m) {
        if (!axisScores[pat.axis]) axisScores[pat.axis] = { totalAttn: 0, tokens: [], amplified: false };
        axisScores[pat.axis].totalAttn += pat.attn;
        axisScores[pat.axis].tokens.push(m[0]);
      }
    }
  }

  const activeAxes = Object.entries(axisScores).filter(([_, v]) => v.totalAttn > 0);
  if (activeAxes.length === 0) return null;

  // Step 2: 组合推理 — 多轴激活→心理状态
  const activeAxisNames = new Set(activeAxes.map(([k]) => k));
  const psyStates = [];
  for (const pat of PSY_PATTERNS) {
    if (pat.axes.every(a => activeAxisNames.has(a))) {
      const strength = pat.axes.reduce((s, a) => s + axisScores[a].totalAttn, 0) / pat.axes.length;
      psyStates.push({ state: pat.state, guide: pat.guide, strength });
    }
  }

  // Step 3: 情绪对象追踪(凛倾: "追踪情绪的出发点")
  // 判断情绪指向: ai(对AI不满) / self(对自己不满) / external(对外部事物)
  let emotionTarget = "external";
  if (activeAxisNames.has("feedback_to_ai")) {
    emotionTarget = "ai";
  } else if (rawText) {
    // "你"字头+负面情绪轴 → 指向AI
    if (/你.{0,4}(错|问题|不对|不行|不好|差|慢|烂)/.test(rawText)) emotionTarget = "ai";
    // "我"字头+自我怀疑/消极 → 指向自己
    else if (/我(是不是|怎么|总是|老是|不够|太[差笨弱])/.test(rawText)) emotionTarget = "self";
    // 特定代词指向AI
    else if (/你(这|那|给我|帮我|说的|做的)/.test(rawText) && (activeAxisNames.has("annoyance") || activeAxisNames.has("frustration"))) emotionTarget = "ai";
  }

  // Step 4: 综合注意力(sigmoid截断)
  const totalAttn = activeAxes.reduce((s, [_, v]) => s + v.totalAttn, 0);
  const intensity = 1.0 / (1.0 + Math.exp(-(totalAttn - 0.5)));

  activeAxes.sort((a, b) => b[1].totalAttn - a[1].totalAttn);
  const dominantAxis = activeAxes[0][0];

  // 根据emotionTarget调整guide
  let guide = psyStates.length > 0 ? psyStates[0].guide : null;
  if (emotionTarget === "ai" && !guide) {
    guide = "反思刚才的行为哪里做错了,承认问题,立即调整做法";
  }

  return {
    axes: Object.fromEntries(activeAxes.map(([k, v]) => [k, { score: +v.totalAttn.toFixed(2), tokens: v.tokens, amplified: v.amplified }])),
    intensity: +intensity.toFixed(2),
    dominantAxis,
    emotionTarget,
    psyStates: psyStates.sort((a, b) => b.strength - a.strength),
    guide,
  };
}
