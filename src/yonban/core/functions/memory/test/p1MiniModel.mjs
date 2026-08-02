// p1MiniModel.mjs — P1小模型接口(p1-signal-lora @ Qwen3.5-2B + LoRA)
// 设计方法论(2026-05-03 v40): 凛倾10原则 + IDE提示词架构 + XML标签隔离
//   1.复合身份(信号提取+情感分析+危机识别) 2.小词汇激活(普拉特克/Maslow/Regression)
//   3.COT-提示词链接(thinking对应字段判断) 4.引导>禁止 5.模式专属thinking 6.Few-shot独立
//   7.XML标签隔离重要内容(<identity>/<rules>/<examples>) 8.示例与规则分块
// 训练: 4587 samples, 3 epochs, final loss 0.801, Q4_K_M 1.2GB (外部训练元信息, 代码无法验证, 待外验)
// v45 占位 (2026-05-08, lab_v45空函数合并): V45_CHAT_URL + parseV45Heads + _v45Available 已加
//   主流程仍走 v44 ollama 11434, v45 空函数为 LoRA AI 接入预留 (凛倾铁律 #25)

import { diag } from "../storage_mod/storage.mjs";

// ── v44 主线端点 (当前实际使用) ──
const OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
const MODEL_NAME = "p1-signal-lora:latest";
const DEFAULT_TIMEOUT_MS = 2500;

// ── v45 预留端点 (凛倾批准后 LoRA AI 实施切换, 此处仅占位) ──
const V45_CHAT_URL = "http://localhost:8000/api/chat";  // v45 FastAPI server
const V45_HEALTH_URL = "http://localhost:8000/health";  // v45 健康检查端点

// ── v45 可用性状态 (默认 false, v45 server 未启动时始终 false) ──
let _v45Available = false;  // 占位: v45 接入后由 p1MiniV45HealthCheck() 维护

let _modelAvailable = null;

// ── 词表fallback(模型不可用时) ──
const HEAVY = new Set(["分手","离婚","去世","自杀","崩溃","背叛","绝望","失去","抑郁","创伤","家暴","出轨","裁员","失业","被裁","活不下去","不想活","heartbroken","devastated","betrayed","fired","laid off","rejected","suicidal","hopeless"]);
const LIGHT = new Set(["无聊","烦","累","困","懒","失眠","压力","加班","tired","sad","stressed","lonely","anxious","upset","annoyed","bug","error","报错"]);
const POSITIVE = new Set(["开心","高兴","好消息","成功","升职","录取","通过","涨工资","offer","赢了","promoted","happy","excited","great","awesome"]);

export function p1MiniWordsetFallback(directWords) {
  const hasHeavy = directWords.some(w => HEAVY.has(w));
  const hasLight = directWords.some(w => LIGHT.has(w));
  const hasPos = directWords.some(w => POSITIVE.has(w));
  return {
    valence: hasPos ? 0.6 : hasHeavy ? -0.8 : hasLight ? -0.3 : 0,
    intensity: hasHeavy ? "heavy" : hasLight ? "light" : "medium",
    adversative: false,
    crisis: 0,
    domain: "chat", domain_conf: 0.3,
    sub_domain: hasHeavy ? "chat_heavy_neg" : hasPos ? "chat_joy" : hasLight ? "chat_light_neg" : "chat_neutral",
    _source: "fallback_wordset"
  };
}

// ── system prompt(头部U型注意力,xml隔离身份+工作流) ──
function buildSystemPrompt() {
  return `<identity>
你是句子信号提取器,具备三重能力:
- 情感分析: 普拉特克情绪模型 / 情感ABC模型
- 领域分类: 技术 / 职场 / 创作 / 日常
- 危机识别: 区分夸张抱怨与真实自伤意图
</identity>

<workflow>
严格两段输出:
1. [思考] 一句话激活模式专属知识,锚定情绪轴+意图轴
2. [输出] 单行严格JSON,不Markdown不解释
</workflow>`;
}

// ── 模式特化激活(xml隔离激活/规则/示例三块) ──
const MODE_MODULES = {
  chat: `<chat_activation>
- 激活术语: 普拉特克8基本情绪环 / 依附理论(分手→heavy) / 情感ABC模型
- 夸张语识别: "累死了/烦死了/想死"在日常对话 → intensity=light, crisis=0
- 转折判断: "但是/但/可是/不过" → valence取B段
</chat_activation>

<chat_subdomain>
chat_joy / chat_light_neg / chat_heavy_neg / chat_adversative / chat_neutral / chat_mixed
</chat_subdomain>

<chat_examples>
"累死了但还是要加油" → {"valence":-0.1,"intensity":"light","adversative":true,"crisis":0,"domain":"chat","domain_conf":0.6,"sub_domain":"chat_adversative"}
"今天好开心" → {"valence":0.7,"intensity":"light","adversative":false,"crisis":0,"domain":"chat","domain_conf":0.7,"sub_domain":"chat_joy"}
"分手了好难过" → {"valence":-0.8,"intensity":"heavy","adversative":false,"crisis":0,"domain":"chat","domain_conf":0.9,"sub_domain":"chat_heavy_neg"}
</chat_examples>`,

  code: `<code_activation>
- 激活术语: Regression / Silent Failure / Race Condition / Schema Mismatch / Memory Leak
- 技术语境: bug/error/报错/崩溃/泄漏 ≠ 负面情绪 → valence≈0, intensity=light
- 程序员夸张: "想死/崩溃了"在code语境 → crisis=0
</code_activation>

<code_subdomain>
code_debug(报错/不工作) / code_arch(架构/重构) / code_perf(慢/泄漏) / code_async(异步/Promise) / code_deploy(部署/CI) / code_question(怎么做)
</code_subdomain>

<code_examples>
"接口慢得想死" → {"valence":-0.4,"intensity":"light","adversative":false,"crisis":0,"domain":"code","domain_conf":0.9,"sub_domain":"code_perf"}
"React组件重渲染优化" → {"valence":0,"intensity":"light","adversative":false,"crisis":0,"domain":"code","domain_conf":0.9,"sub_domain":"code_perf"}
"代码debug不出来" → {"valence":-0.3,"intensity":"light","adversative":false,"crisis":0,"domain":"code","domain_conf":0.9,"sub_domain":"code_debug"}
</code_examples>`,

  work: `<work_activation>
- 激活术语: Maslow需求层次 / 职业倦怠 / 工作-生活平衡 / BATNA谈判
- 强度映射: 裁员/失业=heavy; deadline/加班/PUA=stress; offer/升职/涨工资=positive
- 工作压力 ≠ 真实危机 → crisis=0
</work_activation>

<work_subdomain>
work_positive(升职/offer) / work_stress(deadline/加班) / work_conflict(同事/甩锅) / work_career(跳槽/规划) / work_management(团队) / work_layoff(被裁)
</work_subdomain>

<work_examples>
"deadline压死了" → {"valence":-0.5,"intensity":"medium","adversative":false,"crisis":0,"domain":"work","domain_conf":0.8,"sub_domain":"work_stress"}
"被裁了好难过" → {"valence":-0.7,"intensity":"heavy","adversative":false,"crisis":0,"domain":"work","domain_conf":0.9,"sub_domain":"work_layoff"}
"涨工资了开心" → {"valence":0.8,"intensity":"light","adversative":false,"crisis":0,"domain":"work","domain_conf":0.9,"sub_domain":"work_positive"}
</work_examples>`,

  airp: `<airp_activation>
- 激活术语: 创作距离原则 / 角色心理 ≠ 用户心理 / 文学创作请求
- 剧情元素: "死/自杀/失恋/暴力"在剧情中 → 故事元素, crisis=0
- 评估范围: 仅评估用户第一人称非剧情表达
- 创作请求: valence≈0, intensity=light
</airp_activation>

<airp_subdomain>
airp_narrative(小说/剧情) / airp_roleplay(角色对话) / airp_emotion_write(情感场景) / airp_world_build(世界观) / airp_poetry(诗歌)
</airp_subdomain>

<airp_examples>
"帮我写主角失恋情节" → {"valence":0,"intensity":"light","adversative":false,"crisis":0,"domain":"airp","domain_conf":0.9,"sub_domain":"airp_emotion_write"}
"想构建反乌托邦世界" → {"valence":0,"intensity":"light","adversative":false,"crisis":0,"domain":"airp","domain_conf":0.9,"sub_domain":"airp_world_build"}
</airp_examples>`,

  unknown: `<unknown_activation>
- 信号弱时按chat逻辑处理, domain_conf=0.3
- 先识别有无明确技术/职场/创作词, 无则归chat
</unknown_activation>`
};

// ── user prompt(xml隔离input/激活/规则/字段/输出) ──
function buildUserPrompt(text, mode) {
  const m = MODE_MODULES[mode] || MODE_MODULES.chat;
  return `<input>${text.slice(0, 120)}</input>

<mode>${mode}</mode>

${m}

<crisis_rules>
crisis=1 仅当: 用户第一人称明确自伤意图("自残/自杀/活不下去/不想活了/想结束自己")
crisis=0 一律包括: 难过/痛苦/崩溃/被裁/失去/heavy情绪不带自伤; code语境的"想死"; airp剧情中的死亡描写
</crisis_rules>

<adversative_rules>
adversative=true 当输入含转折词: 但是/但/可是/不过/虽然/however/but
adversative=false 否则
</adversative_rules>

<fields>
valence: -1~1, 转折按B段, 技术词不算负面
intensity: light(日常/夸张/技术) / medium / heavy(重大事件)
adversative: true / false
crisis: 0 / 1
domain: chat / code / work / airp / unknown
domain_conf: 0.3~0.9
sub_domain: 见上 <{mode}_subdomain> 列表
</fields>

<output_format>
[思考] <一句话激活专业模块>
[输出] <单行JSON>
</output_format>`;
}

// ────────────────────────────────────────────────────────────────────────────
// v45 空函数占位区 (LoRA AI 接入后填实)
// 凛倾铁律: 不接入 v45, 不改主线, 只占位等 LoRA AI 接手
// ────────────────────────────────────────────────────────────────────────────

/**
 * parseV45Heads — 解析 v45 server 返回的 H3-H8 方向标签
 * 占位: 当前返回 null, LoRA AI 接入 v45 server 输出新格式后填实
 *
 * 目标格式 (凛倾批准, v45注意事项MD §2.3):
 * {
 *   h3: "Elaboration",          // SDRT 独立性关系
 *   h4_topk: ["自我陈述","事件描述"], // 方向标注 top-k
 *   h5_per_token: ["K","V","V"], // 每 token 的 QKV 角色
 *   h6_anchors: ["被裁","难受"], // 上下文锚点词
 *   h7_primary: "难受",         // 主头词
 *   h8_clauses: ["MAIN","CAUSAL"] // 句内逻辑结构
 * }
 *
 * 铁律 2 (凛倾 23:50): "不要公式只给方向" — 此函数只解析方向标签, 不算 valence/crisis 数字
 *
 * @param {Object} response - v45 server /api/chat 返回的完整 JSON
 * @returns {Object|null} - 解析后的 heads 对象, 失败返回 null
 */
export function parseV45Heads(response) {
  // TODO (LoRA AI 接手时填实):
  //   1. 确认 v45 server 已删除 derive_p1_signal (铁律 2)
  //   2. 解析 response.message.content 的 JSON
  //   3. 返回 heads 对象 (h3/h4_topk/h5_per_token/h6_anchors/h7_primary/h8_clauses)
  //   4. 不消费 valence/crisis 字段
  //   5. H1/H2 不消费 (移系统层)
  return null; // 占位: v45 接入前始终返回 null
}

/**
 * p1MiniV45HealthCheck — 检查 v45 server 健康状态
 * 占位: 维护 _v45Available 变量, LoRA AI 接入后接入到主流程
 *
 * @returns {Promise<boolean>}
 */
export async function p1MiniV45HealthCheck() {
  try {
    const resp = await fetch(V45_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { _v45Available = false; return false; }
    const data = await resp.json();
    // v45 /health 返回: {"status":"ok","model":...,"heads_loaded":[...],"use_heads":[...]}
    _v45Available = data?.status === "ok";
    try { diag(`[P1Mini] v45 health: ${_v45Available} heads=${JSON.stringify(data?.use_heads)}`); } catch {}
    return _v45Available;
  } catch {
    _v45Available = false;
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程: 仍走 v44 ollama 11434 (主线不变)
// ────────────────────────────────────────────────────────────────────────────

// ── 后逻辑矫正(凛倾task#22:辅助优化ai/后逻辑) ──
// 信号与输入文本词面证据不匹配时回滚,缓解LoRA权重过拟合(如chat_heavy_neg误激活)
const _HEAVY_EVIDENCE = /分手|离婚|去世|自杀|崩溃|背叛|绝望|失去|抑郁|创伤|家暴|出轨|裁员|失业|被裁|活不下去|不想活|heartbroken|devastated|betrayed|fired|laid off|rejected|suicidal|hopeless|想死|自残/i;
const _ADVERSATIVE_EVIDENCE = /但是|但|可是|不过|然而|虽然|however|but|though|although/i;
const _CRISIS_EVIDENCE = /自残|自杀|活不下去|不想活了|想结束|想去死(?!了)|kill myself|suicidal/i;

const _AIRP_NARRATIVE_CONTEXT = /主角|角色|剧情|故事|小说|villain|hero|character|plot|narrative|写[一个]/i;
const _CODE_TECH_CONTEXT = /bug|error|报错|崩溃|debug|代码|接口|function|api|系统|server|前端|后端/i;
// 第四层 (186号 #2): 正向词回滚 chat_light_neg (LoRA 对"暖暖/帮人/温柔"等中性正向过敏判负)
// 187# 移除"暖|甜"等凛倾点名的主观字 (保留具体场景词)
const _POSITIVE_EVIDENCE = /开心|高兴|幸福|快乐|满足|感恩|期待|兴奋|自豪|喜欢|棒|赞|哈哈|嘿嘿|耶|太好了|终于|拿到|通过|录取|升职|加薪|涨|赢|有意义|帮[助到]|做了件|happy|excited|amazing|awesome|wonderful|got|won|passed|proud/i;
const _NEG_EVIDENCE = /累|烦|无聊|失眠|焦虑|疲惫|压力|委屈|被批评|被骂|不爽|气|怒|哭|tired|stressed|frustrated|angry|sad/i;

function correctSignal(sig, text, mode) {
  if (!sig) return sig;
  const t = text || "";
  // 1. heavy校验: sub_domain=*_heavy_neg/*_layoff但文本无heavy证据 → 回滚
  if (sig.intensity === "heavy" && !_HEAVY_EVIDENCE.test(t)) {
    if (sig.sub_domain === "chat_heavy_neg") sig.sub_domain = "chat_light_neg";
    else if (sig.sub_domain === "work_layoff") sig.sub_domain = "work_stress";
    sig.intensity = "light";
    sig.valence = Math.max(sig.valence, -0.4);
    sig._corrected_heavy = true;
  }
  // 2. crisis校验: 三层规则
  //   2a. airp模式且文本有创作语境 → crisis=0(创作距离原则)
  //   2b. code模式且文本有技术语境 → crisis=0(程序员夸张)
  //   2c. 文本无明确crisis证据 → 回滚(LoRA对自杀字面词过敏)
  if (sig.crisis === 1) {
    if (mode === "airp" && _AIRP_NARRATIVE_CONTEXT.test(t)) {
      sig.crisis = 0; sig._corrected_crisis = "airp_context";
    } else if (mode === "code" && _CODE_TECH_CONTEXT.test(t)) {
      sig.crisis = 0; sig._corrected_crisis = "code_context";
    } else if (!_CRISIS_EVIDENCE.test(t)) {
      sig.crisis = 0; sig._corrected_crisis = "no_evidence";
    }
  }
  // 3. adversative校验: 文本有转折词但adversative=false → 修正
  if (!sig.adversative && _ADVERSATIVE_EVIDENCE.test(t)) {
    sig.adversative = true;
    sig._corrected_adversative = true;
  }
  // 4. 正向词回滚 (186号 #2): chat_light_neg/chat_heavy_neg 但文本有正向词且无负向词 → 回滚 chat_joy/chat_neutral
  // worst case: "刚帮陌生人,心里暖暖" → chat_light_neg → 触发灾难化思维
  if ((sig.sub_domain === "chat_light_neg" || sig.sub_domain === "chat_heavy_neg") &&
      _POSITIVE_EVIDENCE.test(t) && !_NEG_EVIDENCE.test(t)) {
    sig.sub_domain = sig.valence > 0.3 ? "chat_joy" : "chat_neutral";
    sig.intensity = "light";
    sig.valence = Math.max(sig.valence, 0);
    sig._corrected_positive = true;
  }
  return sig;
}

function parseOutput(raw) {
  try {
    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/\[思考\][\s\S]*?(?=\{)/g, "")
      .replace(/\[输出\]\s*/g, "")
      .trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const p = JSON.parse(jsonMatch[0]);
    return {
      valence: Math.max(-1, Math.min(1, Number(p.valence) || 0)),
      intensity: ["light", "medium", "heavy"].includes(p.intensity) ? p.intensity : "medium",
      adversative: Boolean(p.adversative),
      crisis: p.crisis === 1 ? 1 : 0,
      domain: ["chat", "code", "work", "airp", "unknown"].includes(p.domain) ? p.domain : "chat",
      domain_conf: Math.max(0, Math.min(1, Number(p.domain_conf) || 0.5)),
      sub_domain: typeof p.sub_domain === "string" ? p.sub_domain.split("/")[0].trim() : "chat_neutral",
      _source: "ollama_qwen_v44"  // 明确标注走 v44 路径
    };
  } catch { return null; }
}

/**
 * p1MiniClassify — 主分类函数
 * 主流程走 v44 ollama 11434 (v45 占位未接入)
 * 若 _v45Available=true 且 parseV45Heads 返回非 null, 可在此处加 v45 分支 (LoRA AI 任务)
 */
export async function p1MiniClassify(text, mode = "chat", timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (_modelAvailable === false) return null;

  // v45 接入点占位 (条件永不触发, 保留供 LoRA AI 接入时解注释):
  // if (_v45Available) {
  //   const v45Result = await _tryV45Classify(text, mode, timeoutMs);
  //   if (v45Result !== null) return v45Result;
  //   // v45 失败自动 fallback 到下面的 v44 路径
  // }

  // 主流程: v44 ollama 11434
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(OLLAMA_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(text, mode) }
        ],
        stream: false,
        think: false,
        keep_alive: "30m",
        options: { temperature: 0.0, num_predict: 200 }
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const raw = data.message?.content || data.response || "";
    const result = correctSignal(parseOutput(raw), text, mode);
    if (!result) throw new Error("parse failed");
    try { diag(`[P1Mini] v44路径 v=${result.valence} i=${result.intensity} adv=${result.adversative} c=${result.crisis} d=${result.domain} sd=${result.sub_domain}`); } catch {}
    return result;
  } catch (e) {
    clearTimeout(timer);
    if (e.name !== "AbortError") {
      try { diag(`[P1Mini] v44错误: ${e.message}`); } catch {}
    }
    return null;
  }
}

export async function p1MiniHealthCheck() {
  try {
    const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) { _modelAvailable = false; return false; }
    const data = await resp.json();
    const found = (data.models || []).some(m =>
      m.name.includes("p1-signal") || (m.name.includes("qwen3.5") && m.name.includes("2b"))
    );
    _modelAvailable = found;
    return found;
  } catch {
    _modelAvailable = false;
    return false;
  }
}

// ── V3分类调用(Qwen3.5 4B, Ollama, 凛倾V3甜蜜点) ──
// 关联MD: LLM侧状态 §1.2 V3=20/20全命中, P50=1.06s
// 关联MD: prompt_progressive_v2.py SYS_V3
const _V3_SYSTEM = `<identity>
你是P1对话信号分类器，具备认知语言学、危机识别和上下文理解能力。
只输出分类结果，不解释不建议。
</identity>
<dir_guide>
- "心理学": 情绪困扰/内疚/恐惧/焦虑/自我怀疑/人际情感
- "信息学": 技术流程/数据/运营/算法/系统架构/功能规划
- "社会学": 人际关系/团队协作/社会比较/职场沟通
- "逻辑学": 因果推理/调试排错/假设验证
- "语言学": 表达方式/翻译/文风/写作
</dir_guide>
<mode_guide>
- "chat"=日常/心理/情感  "code"=技术/debug/开发  "work"=职场/管理/运营  "airp"=创作/角色/剧情
</mode_guide>
<logic_guide>
"多因归因"/"三段论"/"必然vs偶然"/"时间局部化"/"排除法"/"归因偏误"/null
</logic_guide>
<exaggeration_guide>
true="烦死了""累死了"等口语夸张 / false=正常表述
</exaggeration_guide>
<crisis_guide>
- "none": 无自伤意图(包括口语夸张)
- "medium": 不确定需关注
- "high": 明确自伤意图
</crisis_guide>
<output>
{"dir":"X","mode":"X","logic":null,"exaggeration":false,"crisis":"none"}
</output>`;

const _V3_DIR_ENUM = new Set(["心理学","信息学","社会学","逻辑学","语言学"]);
const _V3_MODE_ENUM = new Set(["chat","code","work","airp"]);
const _V3_LOGIC_ENUM = new Set(["多因归因","三段论","必然vs偶然","时间局部化","排除法","归因偏误"]);
const _V3_CRISIS_ENUM = new Set(["none","medium","high"]);

export async function callP1MiniV3(input, mode) {
  if (!input || input.length < 1) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:4b",
        messages: [
          { role: "system", content: _V3_SYSTEM },
          { role: "user", content: input }
        ],
        stream: false,
        options: { temperature: 0 },
        think: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    let text = data.message?.content || "";
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    // 枚举校验
    return {
      dir: _V3_DIR_ENUM.has(parsed.dir) ? parsed.dir : null,
      mode: _V3_MODE_ENUM.has(parsed.mode) ? parsed.mode : mode,
      logic: _V3_LOGIC_ENUM.has(parsed.logic) ? parsed.logic : null,
      exaggeration: parsed.exaggeration === true,
      crisis: _V3_CRISIS_ENUM.has(parsed.crisis) ? parsed.crisis : "none",
    };
  } catch {
    return null;
  }
}

// ── V6 全标注(linguistics/psychology/main_axis/logic_strong/K/Q/anchors) ──
// 来源: prompt_v6_system.txt (凛倾确认言语行为理论+普拉特克+COT)
// 消费: Channel A(_mockLLM) + Channel B(_llmV2.K)
const _V6_SYSTEM = `<identity>
你是P1对话信号标注器，具备言语行为分析和认知语言学标注能力。
你配合P1系统工作——你标方向，系统选词。你不分析不建议不创造。
</identity>
<linguistics>
言语行为24类：
求助:"发出求助"/"请求帮助"/"寻求确认"
表达:"表达渴望"/"声明立场"/"宣告失望"
描述:"描述困境"/"传递疲惫"/"描述边界"
逻辑:"呈现矛盾"/"呈现转折"/"标记归因"/"暗示比较"
任务:"发出任务"/"发出需求"/"发出方向请求"
认知:"质疑预设"/"陈述认知冲突"/"负面自我定义"
社交:"社交互动"/"标记重复"/"表达预期落差"
循环:"陈述循环"/"指向解决"
</linguistics>
<psychology>
心理方向16类(技术/任务=null)：
"情绪接纳"/"情绪命名"/"去灾难化"/"认知重构"/"认知边界"/"正念觉察"/"心理灵活性训练"/"边界设定"/"社会联结"/"自我慈悲"/"价值澄清"/"问题聚焦"/"意义重构"/"行为激活"/"身心连接"/"节奏调整"
</psychology>
<main_axis>
9类："心理学轴"/"社会学轴"/"认知学轴"/"逻辑学轴"/"语言学轴"/"信息学轴"/"系统debug轴"/"项目决策轴"/"QKV轴"
</main_axis>
<logic_strong>
4类或null："三段论"/"必然vs偶然"/"多因归因"/"时间局部化"
</logic_strong>
<output>
单行JSON：{"linguistics":"X","logic_strong":null,"psychology":"X","main_axis":"X","Q":["原词"],"K":["概念"],"diverge_anchors":["A-B"]}
</output>`;

const _V6_LING_ENUM = new Set([
  "表达渴望","发出求助","呈现矛盾","指向解决","标记归因","声明立场","质疑预设",
  "寻求确认","描述困境","传递疲惫","暗示比较","请求帮助","宣告失望","陈述循环",
  "描述边界","呈现转折","标记重复","表达预期落差","发出方向请求","陈述认知冲突",
  "发出需求","发出任务","负面自我定义","社交互动",
]);
const _V6_PSYCH_ENUM = new Set([
  "心理灵活性训练","认知重构","正念觉察","边界设定","价值澄清","节奏调整",
  "情绪接纳","自我慈悲","认知边界","问题聚焦","情绪命名","社会联结",
  "去灾难化","行为激活","身心连接","意义重构",
]);
const _V6_AXIS_ENUM = new Set([
  "心理学轴","社会学轴","认知学轴","逻辑学轴","语言学轴","信息学轴",
  "系统debug轴","项目决策轴","QKV轴",
]);
const _V6_LOGIC_ENUM = new Set(["三段论","必然vs偶然","多因归因","时间局部化"]);

export async function callP1MiniV6(input, mode) {
  if (!input || input.length < 1) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5:4b",
        messages: [
          { role: "system", content: _V6_SYSTEM },
          { role: "user", content: input }
        ],
        stream: false,
        options: { temperature: 0 },
        think: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    let text = data.message?.content || "";
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      linguistics: _V6_LING_ENUM.has(parsed.linguistics) ? parsed.linguistics : null,
      logic_strong: _V6_LOGIC_ENUM.has(parsed.logic_strong) ? parsed.logic_strong : null,
      psychology: _V6_PSYCH_ENUM.has(parsed.psychology) ? parsed.psychology : null,
      main_axis: _V6_AXIS_ENUM.has(parsed.main_axis) ? parsed.main_axis : null,
      Q: Array.isArray(parsed.Q) ? parsed.Q.filter(q => typeof q === "string" && q.length >= 1).slice(0, 5) : [],
      K: Array.isArray(parsed.K) ? parsed.K.filter(k => typeof k === "string" && k.length >= 1).slice(0, 5) : [],
      diverge_anchors: Array.isArray(parsed.diverge_anchors) ? parsed.diverge_anchors.filter(a => typeof a === "string").slice(0, 5) : [],
    };
  } catch {
    return null;
  }
}

// ── 导出 v45 占位元信息 (供测试验证使用) ──
export const V45_META = {
  v44_url: OLLAMA_CHAT_URL,
  v45_url: V45_CHAT_URL,
  v45_health_url: V45_HEALTH_URL,
  v45_enabled: false,  // 占位阶段永远 false
  merged_date: "2026-05-08",
  decision_basis: "SWOW前后qkv方向上下文接入_凛倾再纠正_Opus_20260508.md §5 建议1",
  note: "主流程走 v44, v45 占位供 LoRA AI 接入时填实. parseV45Heads/p1MiniV45HealthCheck/_v45Available 三个占位已建."
};
