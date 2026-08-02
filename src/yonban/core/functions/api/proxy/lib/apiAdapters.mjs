import { wbT, wbD } from "../../../../../../server/wbStub.mjs";
/**
 * proxy/lib/apiAdapters.mjs
 * API 专用消息适配器
 *
 * 在通用消息组装之后、发送之前执行。
 * 针对不同 API 的消息格式要求做最终适配，保护提示词效力。
 *
 * 分流设计：
 *   - Claude: 头部 system 提取为顶层 system 字段（由 interceptor 处理，这里不动）
 *   - Gemini: 合并头部 system 为一条（兼容层转 systemInstruction）
 *   - DeepSeek R1: 保留 system role，仅清理不可回传的 reasoning_content
 *   - OpenAI o-series: system → developer role
 *   - 通用: 合并多条 system 为一条（本地推理兼容性）
 *
 * 导出：
 *   PROVIDER_ENUM → string[]（provider 值域单源：resolveProvider 校验 + display.mjs 下拉选项共用）
 *   resolveProvider({ url, model, declared }) → string（声明优先，未声明回退 URL/模型名探测）
 *   detectProvider(url, model) → string（仅探测；外部调用一律走 resolveProvider）
 *   adaptForProvider(messages, { url, model, provider? }) → { messages, extraFields? }
 */

// ============================================================
// Provider 检测
// ============================================================

// provider 值域单源（2026-07-08 显式声明制：凛倾裁决"isClaude 是字符串猜测，在猜测上做
// 静默消息改写不合法"——四模式已改用户显式选，provider 声明是同一裁决在路由层的推广。
// 前端下拉选项、resolveProvider 校验、adaptForProvider 分发均以此表为准，不得另建枚举）
export const PROVIDER_ENUM = [
  "claude",
  "openrouter-claude",
  "openrouter",
  "gemini",
  "deepseek-r1",
  "deepseek",
  "kimi",
  "qwen",
  "openai-reasoning",
  "openai",
  "generic",
];

// 渠道元数据单源（2026-07-11 渠道下拉恢复）：label/默认端点/已核实的坑提示三件套与 PROVIDER_ENUM 同处，
// 前端（beilu-chat 设置面板渠道下拉/本生成器 display 面板）均由此表下发，禁在前端另写 URL/文案/枚举
// （凛倾：「url不要硬编码,也就是可以删除和更改.然后也可以恢复默认」——defaultUrl 只是「恢复默认」
// 的回填值与新建缺省，用户可改可清空）。hint 只做前端可见提示，禁驱动任何静默参数改写
// （2026-07-08 裁决：参数冲突让 API 报错可见，不替用户改）。各默认端点与坑均经官方文档核实
// （调研出处：工作日志 claude选项消失调查_20260711/采集_四家API机制调研.md）。
// Claude 不提供官方 OpenAI-compatible chat-completions 端点。本生成器出站是 OpenAI 格式，
// 因此默认 URL 必须留空，要求用户填真实中转；Anthropic 原生 /v1/messages 属 claude-api 生成器。
export const PROVIDER_META = {
  "": { label: "自动检测（按 URL/模型名，不推荐）", defaultUrl: "https://api.openai.com/v1/chat/completions", hint: "" },
  claude: { label: "Anthropic Claude（OpenAI 兼容中转）", defaultUrl: "", hint: "Anthropic 官方原生端点是 /v1/messages，不提供 /v1/chat/completions。此 proxy 发送 OpenAI 格式，必须填写真实兼容中转地址；官方直连请使用 claude-api 生成器" },
  "openrouter-claude": { label: "OpenRouter → Claude", defaultUrl: "https://openrouter.ai/api/v1/chat/completions", hint: "Claude 系：temperature 与 top_p 不能同时设置（同传返回 400）" },
  openrouter: { label: "OpenRouter", defaultUrl: "https://openrouter.ai/api/v1/chat/completions", hint: "" },
  gemini: { label: "Gemini（OpenAI 兼容端点）", defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", hint: "reasoning_effort 与 thinking_config 功能重叠，不能同传" },
  "deepseek-r1": { label: "DeepSeek R1（推理系）", defaultUrl: "https://api.deepseek.com/chat/completions", hint: "deepseek-reasoner 官方标注 2026-07-24 弃用，建议迁 V4 系 + 思考模式" },
  deepseek: { label: "DeepSeek", defaultUrl: "https://api.deepseek.com/chat/completions", hint: "思考模式下 temperature/top_p/惩罚参数会被静默忽略" },
  kimi: { label: "Kimi（Moonshot）", defaultUrl: "https://api.moonshot.cn/v1/chat/completions", hint: "思维链经 thinking.type 开关；kimi-k2.7-code 强制思考，传关闭会报错（2026-08-01 官方文档核实）" },
  qwen: { label: "Qwen（通义 DashScope）", defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", hint: "开启思考（enable_thinking）必须用流式；temperature 不能为 0；不同地区站点 base_url 不同" },
  "openai-reasoning": { label: "OpenAI 推理系（o1/o3/o4）", defaultUrl: "https://api.openai.com/v1/chat/completions", hint: "" },
  openai: { label: "OpenAI", defaultUrl: "https://api.openai.com/v1/chat/completions", hint: "" },
  generic: { label: "通用 OpenAI 兼容（本地/自部署）", defaultUrl: "http://localhost:1234/v1/chat/completions", hint: "LM Studio/vLLM/llama.cpp server/koboldcpp 等本地引擎的 OpenAI 兼容端点均走此渠道" },
};

/**
 * 解析 provider：用户显式声明（convert_config.provider）优先，未声明回退 URL/模型名探测。
 * 声明值不在 PROVIDER_ENUM 内视为无声明（防旧配置残值静默驱动分支）。
 * @param {{ url?: string, model?: string, declared?: string }} ctx
 * @returns {string} PROVIDER_ENUM 之一
 */
export function resolveProvider({ url = "", model = "", declared = "" } = {}) {
  if (declared && PROVIDER_ENUM.includes(declared)) {
    wbT(null, "ai:adapter", "provider_declared", { provider: declared, model });
    return declared;
  }
  const guessed = detectProvider(url, model);
  wbT(null, "ai:adapter", "provider_guessed", { provider: guessed, model, declared: declared || undefined });
  return guessed;
}

/**
 * 根据 URL 和模型名识别 API 提供商（探测兜底；正路是 resolveProvider 的显式声明）
 * @param {string} url
 * @param {string} model
 * @returns {'claude'|'openrouter-claude'|'openrouter'|'gemini'|'deepseek-r1'|'deepseek'|'kimi'|'qwen'|'openai-reasoning'|'openai'|'generic'}
 */
export function detectProvider(url, model) {
  const u = (url || "").toLowerCase();
  const m = (model || "").toLowerCase();

  // OpenRouter（优先检测，因为可以代理任何模型）
  if (u.includes("openrouter.ai")) {
    if (m.includes("claude") || m.includes("anthropic")) return "openrouter-claude";
    return "openrouter";
  }

  if (u.includes("claude") || u.includes("anthropic") || m.includes("claude"))
    return "claude";

  if (
    u.includes("generativelanguage.googleapis.com") ||
    u.includes("aistudio.google") ||
    m.includes("gemini")
  )
    return "gemini";

  if (u.includes("deepseek") || m.includes("deepseek")) {
    if (m.includes("reasoner") || m.includes("-r1")) return "deepseek-r1";
    return "deepseek";
  }

  // Kimi/Moonshot
  if (u.includes("moonshot") || u.includes("kimi") || m.includes("kimi") || m.includes("moonshot"))
    return "kimi";

  // Qwen/DashScope（qwq=通义 thinking-only 系模型名）
  if (u.includes("dashscope") || m.includes("qwen") || m.includes("qwq"))
    return "qwen";

  if (/\bo[134]-/.test(m) || /\bo[134][-\s]/.test(m)) return "openai-reasoning";
  if (u.includes("openai.com") || m.includes("gpt-")) return "openai";

  return "generic";
}

// ============================================================
// 辅助函数
// ============================================================

/** 从 content (string | array) 中提取纯文本 */
function extractText(msg) {
  if (!msg?.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n\n");
  }
  return "";
}

/**
 * 提取头部连续 system 消息
 * @returns {{ headSystem: object[], rest: object[] }}
 */
function splitHeadSystem(messages) {
  let splitIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") splitIdx = i + 1;
    else break;
  }
  return {
    headSystem: messages.slice(0, splitIdx),
    rest: messages.slice(splitIdx),
  };
}

/**
 * 合并多条 system 消息为一条（保留在 messages 数组首位）
 */
function mergeHeadSystemIntoOne(messages) {
  const { headSystem, rest } = splitHeadSystem(messages);
  if (headSystem.length <= 1) return messages;

  const mergedText = headSystem.map(extractText).join("\n\n");
  return [{ role: "system", content: mergedText }, ...rest];
}

// ============================================================
// Provider 专用适配
// ============================================================

/**
 * Claude: 保护性修复（不变换结构，interceptor 负责 system 提取和缓存）
 *
 * 处理：
 *   1. 空 text → 零宽空格（Claude API 拒绝空 text content）
 *   2. assistant 消息中的图片移到下一条 user（Claude 不允许 assistant 含图片）
 *   3. 剥离 reasoning_content（回传会导致 400）
 */
function adaptClaude(messages) {
  const result = [...messages];
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && !part.text) part.text = "\u200b";
      }
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const images = msg.content.filter((p) => p.type === "image_url" || p.type === "image");
      if (images.length > 0) {
        msg.content = msg.content.filter((p) => p.type !== "image_url" && p.type !== "image");
        if (msg.content.length === 0) msg.content = [{ type: "text", text: "\u200b" }];
        let nextUser = result[i + 1];
        if (!nextUser || nextUser.role !== "user") {
          nextUser = { role: "user", content: [] };
          result.splice(i + 1, 0, nextUser);
        }
        if (!Array.isArray(nextUser.content))
          nextUser.content = [{ type: "text", text: nextUser.content || "\u200b" }];
        nextUser.content.push(...images);
      }
    }
    if (msg.reasoning_content !== undefined) delete msg.reasoning_content;
    if (msg.reasoning !== undefined) delete msg.reasoning;
  }
  return { messages: result };
}

/** OpenRouter (Claude模型): 同 Claude 保护 */
function adaptOpenRouterClaude(messages) {
  return adaptClaude(messages);
}

/** OpenRouter (非Claude模型): 透传，OpenRouter 自身处理 */
function adaptOpenRouter(messages) {
  return { messages };
}

/**
 * Gemini OpenAI-compatible：合并连续头部 system，保留中段 system。
 *
 * Google 官方 OpenAI compatibility 示例直接使用 role:"system"；不能把原生 Gemini
 * contents 只有 user/model 的限制错误套到 OpenAI 兼容端点。连续头部 system 合并仅整理
 * 同权限消息，不改变中段 system 的角色或位置。
 */
function adaptGemini(messages) {
  const merged = mergeHeadSystemIntoOne([...messages]);
  return { messages: merged };
}

/**
 * DeepSeek R1 / reasoner：保留 system 权限。
 *
 * 当前 DeepSeek Chat Completion 官方 schema 明确包含 system message。旧实现依据过期假设，
 * 把所有 system 删除后包装成首条 user XML，属于静默降权。推理消息仍复用标准 DeepSeek
 * 的 reasoning_content 清理，除此之外不改 role。
 */
function adaptDeepSeekR1(messages) {
  return adaptDeepSeek(messages);
}

/**
 * DeepSeek (标准): 合并多条 system 为一条 + 剥离 reasoning_content
 * 标准 DeepSeek 支持 system 但不推荐多条。
 * reasoning_content 回传会导致 400 错误。
 */
function adaptDeepSeek(messages) {
  const merged = mergeHeadSystemIntoOne([...messages]);
  for (const msg of merged) {
    if (msg.reasoning_content !== undefined) delete msg.reasoning_content;
  }
  return { messages: merged };
}

/**
 * OpenAI o-series (o1/o3/o4): system → developer role
 *
 * OpenAI reasoning 模型要求用 developer role 替代 system。
 * developer 消息的指令优先级高于 user（类似旧版 system 的地位）。
 *
 * 提示词效力保护：
 *   - developer role 在 OpenAI 体系中等同于 system 的指令权重
 *   - 不损失效力，反而是正确的使用方式
 */
function adaptOpenAIReasoning(messages) {
  const result = messages.map((msg) =>
    msg.role === "system" ? { ...msg, role: "developer" } : msg,
  );
  return { messages: result };
}

/**
 * OpenAI (标准 GPT 系列): 透传
 * GPT-4o 等标准模型完整支持 system role，无需变换。
 */
function adaptOpenAI(messages) {
  return { messages };
}

/**
 * 通用 (本地推理 / 未知 API): 合并多条 system 为一条
 *
 * 大多数本地推理引擎（Ollama/vLLM/LM Studio）的 chat template
 * 只支持一条 system 消息。多条行为取决于模型 template，不可靠。
 *
 * 提示词效力保护：
 *   - 合并到一条 system 而非降级为 user，保持 system 角色的指令权重
 *   - 用 \n\n 分隔，保留原始结构可读性
 */
function adaptGeneric(messages) {
  return { messages: mergeHeadSystemIntoOne([...messages]) };
}

// ============================================================
// 主入口
// ============================================================

/**
 * 根据目标 API 适配消息格式
 *
 * @param {Array<{role: string, content: string|object[]}>} messages - 已经过通用后处理的消息
 * @param {{ url: string, model: string, provider?: string }} context - provider 传入时直接使用（httpFetch 已 resolve 一次），缺省才就地解析
 * @returns {{ messages: Array, extraFields?: object }}
 */
export function adaptForProvider(messages, { url, model, provider: _resolved }) {
  const provider = _resolved && PROVIDER_ENUM.includes(_resolved) ? _resolved : resolveProvider({ url, model });
  wbT(null, "ai:adapter", "adapt_entry", { provider, model, inLen: messages?.length || 0 });

  let result;
  switch (provider) {
    case "claude":
      result = adaptClaude(messages);
      break;
    case "openrouter-claude":
      result = adaptOpenRouterClaude(messages);
      break;
    case "openrouter":
      result = adaptOpenRouter(messages);
      break;
    case "gemini":
      result = adaptGemini(messages);
      break;
    case "deepseek-r1":
      result = adaptDeepSeekR1(messages);
      break;
    case "deepseek":
      result = adaptDeepSeek(messages);
      break;
    case "openai-reasoning":
      result = adaptOpenAIReasoning(messages);
      break;
    case "openai":
      result = adaptOpenAI(messages);
      break;
    case "qwen":
      // DashScope compatible-mode 是标准 OpenAI 格式（messages 内 system 角色），零改写透传；
      // 思考模式约束（enable_thinking 非流式报错/temp≠0）不在此静默修正，由 API 报错可见（0708 裁决）
      result = adaptOpenAI(messages);
      break;
    case "kimi":
      // Moonshot 是标准 OpenAI 格式，零改写透传；思维链开关走 body.thinking（providerPatch applyThinkingMode）
      result = adaptOpenAI(messages);
      break;
    default:
      wbD(null, "ai:adapter", "unknown_provider", false, `未知provider兜底generic: ${provider}`, { provider, url, model });
      result = adaptGeneric(messages);
  }

  if (result.messages.length !== messages.length || provider !== "claude") {
    console.log(
      `[apiAdapters] provider=${provider}, messages: ${messages.length} → ${result.messages.length}`,
    );
  }

  return result;
}
