// node0_recall.mjs — 召回预处理（自驱动召回新管线 第1节）
//
// 设计来源: <local-dev-path> §召回·流程线
// 功能链: 聊天历史+data记录 →【本模块: 选取/排除/短句合并】→ node1 分词过滤 → 发散 → 混合排序
//
// 职责边界(为什么截断不在这里做): 设计规定截断"分词后按词数计,不按字符数",
// 词数只有分词后才存在,故本模块只导出 truncateTokens 供 node1 在分词后立即调用,
// 保持设计顺序(每条消息先截断再过滤)不变。
//
// 所有参数集中在 PARAMS,禁止魔法数字散落;可调项走 env,来源见各行注释。
//
// 出口数据形状(下游 node1 tokenizeUnits 消费):
//   {units: [{type: user_current|user_context|data, raw, excluded, excludeReason, sentences[]}], params}
//   excluded 单元 sentences=[] 不进分词,但 raw 保留可追溯(误杀兜底同思路)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const envInt = (name, dflt) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : dflt;
};

export const PARAMS = {
  // 上下文窗口: 当前输入单列 + 最近5条用户对话 + data。
  // assistant 只可作为复制检测参照，不得成为召回单元（凛倾 2026-08-03 合同）。
  CONTEXT_COUNT: clamp(envInt('P1_RECALL_CONTEXT_COUNT', 5), 0, 5),
  DATA_COUNT: clamp(envInt('P1_RECALL_DATA_COUNT', 2), 0, 20),
  // 短句(<10字)先并入邻句再算 [待实验定]
  SHORT_SENT_MIN: clamp(envInt('P1_RECALL_SHORT_SENT_MIN', 10), 2, 50),
  // 复制文本排除: 字符 bigram Jaccard 超过此阈值即排除；0.7 是实验前默认值，
  // 每次请求可由服务配置 copyJaccardThreshold 经 config_map 覆盖。
  COPY_JACCARD_THRESHOLD: 0.7,
  // 截断: 超过80词取头尾,用户可调 P1_RECALL_MAX_WORDS clamp [20,500] (162号MD)
  MAX_WORDS: clamp(envInt('P1_RECALL_MAX_WORDS', 80), 20, 500),
  // 头段预算占比: 设计=0.5(head40+tail40);历史0731定档0.3有A/B数据(字口径进池41.7%→52.8%),
  // 词口径下的取值待白盒读校,env 可调
  TRUNC_HEAD_RATIO: Math.min(0.9, Math.max(0.1, parseFloat(process.env.P1_TRUNC_HEAD_RATIO) || 0.5)),
};

// 对AI指令检测: 设计给定前缀正则 + 常见指令模板(可扩展,均为"对AI说话"而非内容本身)
const AI_CMD_PATTERNS = [
  /^(你[是要能可会]|帮我|请[你]?|给我)/,
  /^(继续|重新(来|写|说|生成)|换(个|一种)|翻译|总结(一下)?|解释(一下)?|停|算了)/,
];

// ---- 复制文本检测: 字符 bigram Jaccard ----
// J(A,B) = |A∩B| / |A∪B|, A/B 为字符 bigram 集合(设计 §排除检测)
export function charBigrams(text) {
  const s = String(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  return set;
}

export function jaccardBigram(a, b) {
  const A = charBigrams(a), B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- 排除判定(只作用于上下文用户消息,当前输入是召回触发源永不排除) ----
export function classifyExclusion(userText, prevAssistantText) {
  const t = String(userText).trim();
  const threshold = PARAMS.COPY_JACCARD_THRESHOLD;
  const similarity = prevAssistantText ? jaccardBigram(t, prevAssistantText) : null;
  const copyDiagnostics = {
    jaccard: similarity === null ? null : +similarity.toFixed(3),
    threshold,
    copyMatched: similarity !== null && similarity > threshold,
  };
  for (const re of AI_CMD_PATTERNS) {
    if (re.test(t)) return { excluded: true, reason: 'ai_command', ...copyDiagnostics };
  }
  if (copyDiagnostics.copyMatched) {
    return { excluded: true, reason: 'copy', ...copyDiagnostics };
  }
  return { excluded: false, ...copyDiagnostics };
}

// ---- 分句 + 短句合并 ----
// 短句判据 len(trim)<10;向后合并(短句+下一句),无下一句则向前(设计 §短句合并)
export function splitSentences(text) {
  // 后行断言切分 → 分隔标点保留在句尾: 短句合并/白盒回显不丢标点,长度判定另行剔标点
  const parts = String(text).split(/(?<=[。！？!?；;\n])/);
  return parts.map(s => s.trim()).filter(s => s.length > 0);
}

export function mergeShortSentences(sentences, minLen = PARAMS.SHORT_SENT_MIN) {
  const out = [];
  let carry = '';
  for (const s of sentences) {
    const cur = carry + s;
    // 计长剔除标点/空白: "短句<10字"按内容字符算(设计语义是信息量不足,标点不算信息)
    if (cur.replace(/[。！？!?；;\s]/g, '').length < minLen) {
      carry = cur; // 短句挂起,并入下一句
    } else {
      out.push(cur);
      carry = '';
    }
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] += carry; // 无下一句 → 向前合并
    else out.push(carry);
  }
  return out;
}

// ---- 截断(供 node1 分词后调用) ----
// tokens 超过 maxWords → 保留头尾各半,中间丢弃(设计: head40+tail40)
export function truncateTokens(tokens, maxWords = PARAMS.MAX_WORDS) {
  if (tokens.length <= maxWords) return { tokens, truncated: false };
  const head = Math.max(1, Math.round(maxWords * PARAMS.TRUNC_HEAD_RATIO)); // max(1)防 ratio 极小时 head=0 丢光头部
  const tail = maxWords - head;
  return {
    tokens: [...tokens.slice(0, head), ...tokens.slice(tokens.length - tail)],
    truncated: true,
    dropped: tokens.length - maxWords,
  };
}

// ---- 主入口 ----
// messages: 完整聊天历史 [{role, content}](不含当前输入,当前输入单独传)
// dataRecords: data 记录数组,取尾部 DATA_COUNT 条,文本字段兼容 text/content/字符串
// 返回 units: 每条一个召回单元,排除的保留占位(filtered不丢弃,与"误杀兜底"同思路)
export function recallSelect({
  currentUserText,
  messages = [],
  dataRecords = [],
  contextCount = PARAMS.CONTEXT_COUNT,
  dataCount = PARAMS.DATA_COUNT,
} = {}) {
  const units = [];
  const effectiveContextCount = clamp(Number.isFinite(Number(contextCount)) ? Math.trunc(Number(contextCount)) : PARAMS.CONTEXT_COUNT, 0, 5);
  const effectiveDataCount = clamp(Number.isFinite(Number(dataCount)) ? Math.trunc(Number(dataCount)) : PARAMS.DATA_COUNT, 0, 20);

  // 1. 当前用户内容
  units.push(makeUnit('user_current', currentUserText, { excluded: false }));

  // 2. 最近 N 条上下文用户消息(按"一次user输出"为单位),各自做排除判定
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIdx.push(i);
  }
  // 0 是合法的“关闭上下文”，不可让 slice(-0) 反转成全量历史。
  const picked = effectiveContextCount > 0 ? userIdx.slice(-effectiveContextCount) : [];
  for (const i of picked) {
    // "前面的复制文本"判定基准: 该条 user 之前最近的一条 assistant 回复(设计 §排除检测)
    let prevAssistant = null;
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j]?.role === 'assistant') { prevAssistant = messages[j].content; break; }
    }
    const ex = classifyExclusion(messages[i].content, prevAssistant);
    units.push(makeUnit('user_context', messages[i].content, ex));
  }

  // 3. data 最近 M 条(data 是记忆记录,不做对AI指令/复制排除)
  const dataPicked = effectiveDataCount > 0 ? dataRecords.slice(-effectiveDataCount) : [];
  for (const r of dataPicked) {
    const text = typeof r === 'string' ? r : (r?.text ?? r?.content ?? '');
    units.push(makeUnit('data', text, { excluded: false }));
  }

  return {
    units,
    params: {
      ...PARAMS,
      CONTEXT_COUNT: effectiveContextCount,
      DATA_COUNT: effectiveDataCount,
      AI_OUTPUT_COUNT: 0,
    },
  };
}

function makeUnit(type, text, exclusion) {
  const raw = String(text ?? '');
  return {
    type,
    raw,
    excluded: exclusion.excluded,
    excludeReason: exclusion.reason ?? null,
    ...(exclusion.jaccard !== undefined ? { jaccard: exclusion.jaccard } : {}),
    ...(exclusion.threshold !== undefined ? { threshold: exclusion.threshold } : {}),
    ...(exclusion.copyMatched !== undefined ? { copyMatched: exclusion.copyMatched } : {}),
    // 排除的单元不分句(不进分词),但原文保留可追溯
    sentences: exclusion.excluded ? [] : mergeShortSentences(splitSentences(raw)),
  };
}
