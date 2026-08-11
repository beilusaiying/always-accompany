/**
 * proxy/lib/httpFetch.mjs
 * HTTP 请求、流式解析、URL 重试逻辑
 *
 * 导出：
 *   fetchChatCompletion(messages, config, options) → Promise<result>
 *   fetchChatCompletionWithRetry(messages, options, config) → Promise<result>
 */

import { createHash } from "node:crypto";
import { postProcessMessages, stripReasoningTags } from "./messageTransform.mjs";
import { wbT, wbD } from "../../../../../../server/wbStub.mjs";
import { adaptForProvider } from "./apiAdapters.mjs";
import {
  applyTailPrefill,
  applyThinkingMode,
  normalizeProviderError,
  patchBodyForClaude,
  patchBodyForDeepSeek,
} from "./providerPatch.mjs";
// SEC-F4（红方 round2，多用户）：server 部署下，用户自配 chat 端点 + 模型吐回的 image URL 都不可指内网。
import { assertSafeOutboundInServerMode } from "../../../security/safe_fetch.mjs";
// 参数缺省单源（2026-07-08 链路2）：thinking_budget 兜底改读 PARAM_SCHEMA
import { paramDefault } from "../../../prompt/preset/engine/paramSchema.mjs";
// [0727 并发闸] 用户级 AI 同时运行上限（凛倾：3窗×5分身=18路同飞需要可调节）
import { acquireAiSlot } from "./aiConcurrencyGate.mjs";
import {
  findVolatileStart,
  VOLATILE_TAG_RE,
} from "../../_shared/volatileBoundary.mjs";

const LOCAL_CODEX_SUBSCRIPTION_UNSUPPORTED_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "top_k",
  "top_a",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "seed",
  "n",
  "user",
  "prompt_cache_options",
  "prompt_cache_retention",
];

function isLocalCodexSubscriptionGateway(url) {
  try {
    const parsed = new URL(String(url || ""));
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1";
    const path = parsed.pathname.replace(/\/+$/g, "") || "/";
    return (
      isLoopback &&
      parsed.port === "8317" &&
      (path === "/v1" || path === "/v1/chat/completions")
    );
  } catch {
    return false;
  }
}

/**
 * OpenAI 参数边界：公开 Chat 使用当前字段名；固定本机 8317 则遵循 Codex 订阅
 * Responses 请求契约。这里只处理顶层 API 参数，不读取或改写 messages。
 */
function applyOpenAIRequestParameterContract(body, { provider, url }) {
  if (provider !== "openai" && provider !== "openai-reasoning") return body;

  if (isLocalCodexSubscriptionGateway(url)) {
    const removed = [];
    for (const field of LOCAL_CODEX_SUBSCRIPTION_UNSUPPORTED_FIELDS) {
      if (!Object.hasOwn(body, field)) continue;
      delete body[field];
      removed.push(field);
    }
    if (removed.length > 0) {
      console.log(
        `[proxy/httpFetch] 本机 Codex 订阅网关不接受这些公开 API 参数，发送前已移除: ${removed.join(", ")}`,
      );
      wbT(null, "ai:request", "codex_subscription_parameter_omit", {
        fields: removed,
      });
    }
    return body;
  }

  if (Object.hasOwn(body, "max_tokens")) {
    if (
      Object.hasOwn(body, "max_completion_tokens") &&
      body.max_completion_tokens !== body.max_tokens
    ) {
      throw new Error(
        "OpenAI 请求同时设置了不同值的 max_tokens 与 max_completion_tokens；请只保留一个输出上限",
      );
    }
    if (!Object.hasOwn(body, "max_completion_tokens")) {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;
    console.log(
      "[proxy/httpFetch] OpenAI Chat: 已把旧字段 max_tokens 转为 max_completion_tokens",
    );
  }

  return body;
}

function buildPromptCacheKey(chatId) {
  const normalizedChatId = String(chatId ?? "").trim();
  if (!normalizedChatId) return null;

  return createHash("sha256")
    .update(JSON.stringify(["beilu-openai-prompt-cache-v1", normalizedChatId]), "utf8")
    .digest("hex");
}

const OPENAI_CACHEABLE_BLOCK_TYPES = new Set([
  "text",
  "image_url",
  "input_audio",
  "file",
  "refusal",
]);

function splitMessageBeforeVolatileTag(message) {
  const content = message?.content;
  const splitText = (text) => {
    const match = String(text || "").match(VOLATILE_TAG_RE);
    if (!match || match.index === undefined) return null;
    let index = match.index;
    // mergeConsecutiveRoles 用两个换行拼接消息。把该拼接符留在易变侧，确保本轮
    // 最新 user 的断点前缀与下一轮历史中的同一 user 保持逐字一致。
    if (index >= 2 && text.slice(0, index).endsWith("\n\n")) index -= 2;
    return index;
  };

  if (typeof content === "string") {
    const index = splitText(content);
    if (index === null || index <= 0) return -1;
    message.content = [
      { type: "text", text: content.slice(0, index) },
      { type: "text", text: content.slice(index) },
    ];
    return 0;
  }

  if (!Array.isArray(content)) return -1;
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const index = splitText(part.text);
    if (index === null) continue;

    const next = content.map((item) => ({ ...item }));
    const replacement = [];
    let stablePartIndex = i - 1;
    if (index > 0) {
      replacement.push({ ...part, text: part.text.slice(0, index) });
      stablePartIndex = i;
    }
    replacement.push({ ...part, text: part.text.slice(index) });
    next.splice(i, 1, ...replacement);
    message.content = next;
    return stablePartIndex;
  }
  return -1;
}

function markOpenAICacheBreakpoint(message, maxPartIndex = Infinity) {
  const content = message?.content;
  if (typeof content === "string") {
    if (!content) return false;
    message.content = [
      {
        type: "text",
        text: content,
        prompt_cache_breakpoint: { mode: "explicit" },
      },
    ];
    return true;
  }
  if (!Array.isArray(content)) return false;

  for (let i = Math.min(content.length - 1, maxPartIndex); i >= 0; i--) {
    const part = content[i];
    if (!part || !OPENAI_CACHEABLE_BLOCK_TYPES.has(part.type)) continue;
    content[i] = {
      ...part,
      prompt_cache_breakpoint: { mode: "explicit" },
    };
    return true;
  }
  return false;
}

/**
 * 在最终 Chat Completions 消息形状上放两个滚动 user 断点：上一 user 用于匹配
 * 上一轮写入的精确前缀，最新 user 为下一轮写入。只改变 content block 结构，文本拼接不变。
 */
function applyOpenAIExplicitPromptCache(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const cloned = messages.map((message) => ({
    ...message,
    content: Array.isArray(message?.content)
      ? message.content.map((part) => ({ ...part }))
      : message?.content,
  }));
  messages.splice(0, messages.length, ...cloned);

  const volatileStart = findVolatileStart(messages);
  const stableMessageEnd = volatileStart >= 0 ? volatileStart : messages.length;
  const candidates = [];

  for (let i = 0; i < stableMessageEnd; i++) {
    if (messages[i]?.role === "user") candidates.push({ messageIndex: i });
  }

  if (volatileStart >= 0 && messages[volatileStart]?.role === "user") {
    const stablePartIndex = splitMessageBeforeVolatileTag(messages[volatileStart]);
    if (stablePartIndex >= 0) {
      candidates.push({ messageIndex: volatileStart, maxPartIndex: stablePartIndex });
    }
  }

  let marked = 0;
  for (const candidate of candidates.slice(-2)) {
    if (
      markOpenAICacheBreakpoint(
        messages[candidate.messageIndex],
        candidate.maxPartIndex,
      )
    ) {
      marked++;
    }
  }
  return marked;
}

/**
 * 调用基础模型。
 * @param {Array<object>} messages - 消息数组。
 * @param {object} config - 配置对象。
 * @param {object} options - 选项对象。
 * @param {AbortSignal} options.signal - 用于中止请求的 AbortSignal。
 * @param {(result: {content: string, files: any[]}) => void} options.previewUpdater - 处理部分结果的回调函数。
 * @param {{content: string, files: any[]}} options.result - 包含内容和文件的结果对象。
 * @returns {Promise<{content: string, files: any[]}>} 模型返回的内容。
 */
export async function fetchChatCompletion(
  messages,
  config,
  // [0717 断流续接] _resumePrefix 由 fetchChatCompletionWithRetry 在重试尝试间设置（已收正文作预填充续写）
  { signal, previewUpdater, result, _resumePrefix },
) {
  let imgIndex = 0;

  // （2026-08-01 删 reasoning_effort 静默重映射——原 none→low/max→high 把"关思考"反转成
  //   "开低档思考"，与 0708「不静默改写用户参数」裁决相逆；值域不匹配时端点报错可见。
  //   用户显式设置原样透传；三态 thinking_mode 的映射在下方 applyThinkingMode 单点做。）
  const normalizedModelArgs = { ...(config.model_arguments || {}) };

  // （2026-07-08 NON_OPENAI_PARAMS 过滤已删——凛倾:「错误肯定有返回,直接给提醒啊」：
  //   旧实现按"URL 是否 openrouter.ai"字符串猜测删除用户显式设置的 top_k/min_p/top_a/
  //   repetition_penalty——自部署 vLLM/本地引擎全支持这些参数，被静默删=改写用户设置。
  //   端点不认识的参数：OpenAI 兼容端点普遍忽略未知参数；严格端点返回错误=可见提醒。）
  const filteredModelArgs = { ...normalizedModelArgs };

  // 过滤空内容消息（Claude 等模型不接受空 content 的 assistant 消息，会导致返回空响应）
  const cleanedMessages = messages.filter((msg, idx) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content || "");
    if (!content.trim() && msg.role === "assistant") {
      return false;
    }
    return true;
  });

  // ★ provider 解析单次收口（2026-07-08 显式声明制）：用户在源配置 convert_config.provider 声明的
  // 值优先，未声明回退 URL/模型名探测。本次 resolve 结果沿 context 传给下方全部消费点
  // （postProcess 决策/adaptForProvider/patchBodyForDeepSeek/patchBodyForClaude），
  // 消灭旧"五处各自独立 includes 猜测"（中转别名不含关键词=专化处理静默失效的根因）。
  const { resolveProvider } = await import("./apiAdapters.mjs");
  const _provider = resolveProvider({
    url: config.url,
    model: config.model,
    declared: config.convert_config?.provider,
  });

  // ★ API 专用消息适配（provider 传已 resolve 的结果，不再内部重猜）
  const adapted = adaptForProvider(cleanedMessages, {
    url: config.url,
    model: config.model,
    provider: _provider,
  });

  let requestBodyObj = {
    model: config.model,
    messages: adapted.messages,
    stream: config.use_stream,
    ...filteredModelArgs,
    ...(adapted.extraFields || {}),
  };

  // 只对 UI 中明确的 OpenAI / OpenAI 推理系 provider 写入官方缓存路由键。
  // 哈希前的 chat id 只存在于进程内 callConfig，不进入上游请求。
  let beiluPromptCacheKey = null;
  if (_provider === "openai" || _provider === "openai-reasoning") {
    beiluPromptCacheKey = buildPromptCacheKey(config._prompt_cache_chat_id);
    if (beiluPromptCacheKey) requestBodyObj.prompt_cache_key = beiluPromptCacheKey;
  }

  // DeepSeek 专项预处理（top_p 兜底 + tools required 清理 + 参数过滤）
  requestBodyObj = patchBodyForDeepSeek(requestBodyObj, {
    provider: _provider,
    url: config.url,
    model: config.model,
  });

  // ★ 尾部预填充（通用机制，无条件——2026-07-08 凛倾:「什么叫做包含claude,预填充才生效」）：
  //   用户显式选择的四模式对任何渠道生效，不受"URL/模型名包含 claude"字符串猜测门控。
  //   Claude 专属的 off 漏网兜底仍在 patchBodyForClaude（非 Claude 渠道尾部 assistant 合法）。
  requestBodyObj = applyTailPrefill(requestBodyObj, {
    url: config.url,
    claudePrefillMode: config.convert_config?.claude_prefill_mode || "off",
  });

  // [0717 断流续接] 消费 fetchChatCompletionWithRetry 设置的已收正文预填充（见该函数内注释）。
  //   放在 applyTailPrefill 之后 = 不被四模式转换搅动：尾部已是 assistant（prefill 模式/预设预填充）
  //   则续接文本接其内容末尾；否则追加独立 assistant 尾条。string/parts 两形状都处理。
  if (_resumePrefix && Array.isArray(requestBodyObj.messages) && requestBodyObj.messages.length > 0) {
    const _rp = _resumePrefix;
    const _tail = requestBodyObj.messages[requestBodyObj.messages.length - 1];
    if (_tail?.role === "assistant") {
      if (typeof _tail.content === "string") {
        _tail.content = _tail.content ? `${_tail.content}${_rp}` : _rp;
      } else if (Array.isArray(_tail.content)) {
        const _lastText = [..._tail.content].reverse().find((p) => p.type === "text");
        if (_lastText) _lastText.text = `${_lastText.text || ""}${_rp}`;
        else _tail.content.push({ type: "text", text: _rp });
      }
    } else {
      requestBodyObj.messages.push({ role: "assistant", content: _rp });
    }
  }

  // ★ 提示词后处理（先 prefill 再按用户明确选择处理）：
  //   旧管线 pp(:115) 在 prefill(:157) 之前跑，applyTailPrefill(user_assistant) 把尾部
  //   assistant 改 user → 产生新 user+user，此后无 re-merge → 连续同角色原样发出(0718 实证)。
  //   ST 同构设计：convertClaudeMessages 内部 :329-335 追加 prefill assistant → :339-346 同函数内
  //   merge 兜底；chat-completions.js:1736 用户 pp 也在 source 分发前跑(全 provider 生效)。
  //   现管线：adapt → prefill → resumePrefix → 【pp 在此】 → patchClaude → 发送。
  //   pp 在 prefill/resume 之后 = 任何改角色操作产生的连续同 role 都被 pp 兜住。
  //   2026-07-29 契约：none 必须是真关闭。旧代码把 none/空值按 provider 偷换成
  //   merge 或 semi（DeepSeek），造成 UI/存储显示关闭而最终请求仍被改写。
  //   provider 的协议差异只允许在 adaptForProvider/patch 层显式处理，不能冒充 PP 默认值。
  //   共享 builder 已按同一配置处理一次；这里在 tail/resume 之后再执行是为了收拢尾部改形
  //   新产生的连续同角色。merge/semi/strict 均幂等，none 原样返回。
  const postProcessType =
    config.convert_config?.prompt_post_processing || "none";
  requestBodyObj.messages = postProcessMessages(requestBodyObj.messages, postProcessType);

  // 思维链三态（2026-08-01 凛倾收口「开关放这里(AI源面板)」）：唯一入口=per-源 config.thinking_mode。
  //   旧覆盖链（预设/子模式/runtime/分身）producer 已全删；requestBodyObj 里若仍有存量污染键
  //   （旧 char 模板/外部注入）一律剥离，不参与决策。
  //   存量迁移：无 thinking_mode 时，旧 boolean extended_thinking===true 视同 standard；
  //   false/缺失 = ""（渠道默认，不发任何 thinking 参数——注意 DeepSeek 等渠道默认思考【开启】，
  //   真要关必须选 off 显式发 disabled）。
  const _thinkingMode = (config.thinking_mode !== undefined && config.thinking_mode !== null && config.thinking_mode !== "")
    ? String(config.thinking_mode)
    : (config.extended_thinking ? "standard" : "");
  delete requestBodyObj.extended_thinking;
  delete requestBodyObj.thinking_budget;
  // Claude 专项预处理（预填充 off 漏网兜底 + image_url 转换 + 缓存断点）
  requestBodyObj = patchBodyForClaude(requestBodyObj, {
    provider: _provider,
    url: config.url,
    model: config.model,
    claudePrefillMode: config.convert_config?.claude_prefill_mode || "off",
    cacheBreakpoints: config.convert_config?.cache_breakpoints,
  });
  // 三态映射单点（全渠道，按显式声明的 provider 分发；""=不发参数）
  requestBodyObj = applyThinkingMode(requestBodyObj, { provider: _provider, mode: _thinkingMode });

  // 公开 OpenAI GPT-5.6+ 可选显式缓存：只在用户按源开启、存在本地 chatid 派生 key、
  // 且最终消息确实插入断点时启用 request-wide explicit policy。没有静默兼容重试；
  // 旧模型/中转拒绝该字段时，现有 HTTP 错误链会把 400 原样交给用户。
  if (
    (_provider === "openai" || _provider === "openai-reasoning") &&
    config.convert_config?.openai_explicit_prompt_cache === true &&
    beiluPromptCacheKey
  ) {
    const marked = applyOpenAIExplicitPromptCache(requestBodyObj.messages);
    if (marked > 0) {
      const existingOptions =
        requestBodyObj.prompt_cache_options &&
        typeof requestBodyObj.prompt_cache_options === "object" &&
        !Array.isArray(requestBodyObj.prompt_cache_options)
          ? requestBodyObj.prompt_cache_options
          : {};
      requestBodyObj.prompt_cache_options = {
        ...existingOptions,
        mode: "explicit",
      };
    }
  }

  // OpenAI 顶层参数只在最终出站边界处理一次。公开 Platform 保留输出上限语义并换成
  // 当前 Chat 字段；固定本机 8317 Codex 订阅端点没有这些字段，按其官方请求形状省略。
  // 该适配不接触 messages，因此不会改变提示词文本、角色或顺序。
  requestBodyObj = applyOpenAIRequestParameterContract(requestBodyObj, {
    provider: _provider,
    url: config.url,
  });

  // ★ 内部元数据剥离（2026-08-10 OpenAI 本机端点根修）：
  //   _identifier/_section/_name/_source 等 _ 前缀字段只供 beilu 本地展示/定位，不是 OpenAI 字段。
  //   旧逻辑把所有 localhost 都视为 metadata 代理并保留，导致显式 OpenAI 指向本机 Codex API 时
  //   严格 schema 返回 400。provider 是用户选择的协议真源：OpenAI 两渠道无论地址是否本机都剥离；
  //   其他本机代理仍保留既有 metadata 模式，外部端点仍按原规则剥离。
  {
    const _isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(config.url || ""));
    const _usesOpenAIWireSchema = _provider === "openai" || _provider === "openai-reasoning";
    if ((_usesOpenAIWireSchema || !_isLocalUrl) && Array.isArray(requestBodyObj.messages)) {
      let _stripped = 0;
      for (const _m of requestBodyObj.messages) {
        for (const _k of Object.keys(_m)) {
          if (_k.startsWith("_")) { delete _m[_k]; _stripped++; }
        }
      }
      if (_stripped > 0) {
        const _stripReason = _usesOpenAIWireSchema ? `OpenAI渠道(${_provider})` : "外部端点";
        console.log(`[proxy/httpFetch] ${_stripReason}: 剥离 ${_stripped} 个内部元数据字段(_*)`);
      }
    }
  }

  const requestBody = JSON.stringify(requestBodyObj);

  wbT(null, "ai:request", "fetch_start", { url: config.url, model: config.model, stream: config.use_stream, bodyBytes: requestBody.length });
  // ★ 连接/响应头超时（亲读 httpFetch 全链坐实）：原 fetch 只挂用户 signal、无超时——服务器接受连接却
  //   迟迟不回响应头时此 await 永挂（:298 的 5 分钟流读取超时只在拿到 reader=响应头之后才生效）。
  //   故对「等响应头」阶段加独立 120s 硬超时（合法 API 收到请求后不会 >120s 还不回响应头）；拿到响应头即
  //   clearTimeout，body 流式仍由下方 reader 的用户 signal 监听 + STREAM_READ_TIMEOUT_MS(5分钟) 接管。
  const _connectController = new AbortController();
  const _forwardAbort = () => { try { _connectController.abort(signal?.reason); } catch { _connectController.abort(); } };
  if (signal) {
    if (signal.aborted) _connectController.abort(signal.reason);
    else signal.addEventListener?.("abort", _forwardAbort, { once: true });
  }
  // [0718 可配] 实测: 部分网关挂起时每候选 URL 硬等 120s, 生成/构建从 10s 变 2 分钟。
  //   connect_timeout_ms 进 config（操作界面三原则: 限值禁硬编码）；缺省 120s 语义不变
  //   （非流式长推理响应头可 >60s, 默认不激进收紧, 网关慢的源由用户按源调小）。
  const _CONNECT_TIMEOUT_MS = Number(config.connect_timeout_ms) > 0 ? Number(config.connect_timeout_ms) : 120000;
  const _connectTimer = setTimeout(
    () => _connectController.abort(new Error(`[proxy] 等待响应头超时（${Math.round(_CONNECT_TIMEOUT_MS / 1000)}s 无响应，判连接死）`)),
    _CONNECT_TIMEOUT_MS,
  );
  let response;
  try {
    await assertSafeOutboundInServerMode(config.url); // SEC-F4：server 下拒内网目标
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.apikey ? "Bearer " + config.apikey : undefined,
        "HTTP-Referer": "https://localhost/",
        "X-Title": "beilu",
        ...config?.custom_headers,
      },
      body: requestBody,
      signal: _connectController.signal,
    });
  } finally {
    // 响应头已到（或 fetch 失败）→ 撤销 pre-headers 守卫；body 中止交回用户 signal(:242 listener) + 流超时(:298)
    clearTimeout(_connectTimer);
    if (signal && !signal.aborted) signal.removeEventListener?.("abort", _forwardAbort);
  }

  wbT(null, "ai:request", "fetch_response", { status: response.status, ok: response.ok });
  if (!response.ok) {
    wbD(null, "ai:request", "http_status", false, `非2xx响应 ${response.status} ${response.statusText}`, { status: response.status });
    let rawText = "";
    let parsed = null;
    try {
      rawText = await response.text();
      try {
        parsed = JSON.parse(rawText);
      } catch {
        /* rawText 保留原文 */
      }
    } catch {
      rawText = "(无法读取响应体)";
    }
    const normalized = normalizeProviderError(
      response.status,
      response.statusText,
      rawText,
      parsed,
    );
    console.error(
      `[proxy/fetchChatCompletion] API 错误 ${normalized.status}: ${normalized.message}` +
        (normalized.type ? ` [type=${normalized.type}]` : "") +
        (normalized.code ? ` [code=${normalized.code}]` : ""),
    );
    const err = new Error(
      `API Error ${normalized.status}: ${normalized.message}`,
    );
    err.status = normalized.status;
    err.detail = normalized;
    throw err;
  }

  const reader = response.body.getReader();
  signal?.addEventListener?.(
    "abort",
    () => {
      try {
        const err = new Error("User Aborted");
        err.name = "AbortError";
        reader.cancel(err).catch(() => {});
      } catch (_) { /* reader already released */ }
    },
    { once: true },
  );

  const decoder = new TextDecoder();
  let buffer = "";
  // [0808 根修·SSE 判定按响应头] 原仅靠 body 出现 "data:" 行才认定 SSE（下方正则嗅探）：上游以
  //   SSE 注释行（":ok"/":heartbeat"，SSE 规范中冒号开头=注释）开头且未产出任何 data 事件就收尾时，
  //   永远嗅探不中 → 整个 buffer 被当 JSON 解析报 "Failed to parse response as JSON"、真实为
  //   「上游空流」的故障被折叠成静默空回复（0808 实证 buffer=":ok\n\n"）。Content-Type:
  //   text/event-stream 是上游对流式的一等声明，以它为权威判定；body 嗅探保留作无头/错头上游的
  //   兜底——两判定只增不减，对既有正常流零行为变化。
  let isSSE = /text\/event-stream/i.test(response.headers?.get?.("content-type") || "");
  if (isSSE) wbT(null, "ai:stream", "sse_start", { via: "content-type" });

  const imageProcessingPromises = [];

  /**
   * 处理图片 URL 数组
   * @param {string[]} imageUrls - 图片 URL 数组。
   */
  const processImages = (imageUrls) => {
    if (!imageUrls || !Array.isArray(imageUrls)) return;

    const promise = (async () => {
      const newFiles = await Promise.all(
        imageUrls.map(async (url) => {
          try {
            await assertSafeOutboundInServerMode(url); // SEC-F4/F2：server 下模型输出的 image URL 不可指内网
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) }); // 冷路径超时（图片下载）
            if (!resp.ok) return null;
            return {
              name: `image${imgIndex++}.png`,
              buffer: await resp.arrayBuffer(),
              mime_type: "image/png",
            };
          } catch (e) {
            console.error("Failed to fetch image:", url, e);
            return null;
          }
        }),
      );

      const validFiles = newFiles.filter(Boolean);
      if (validFiles.length > 0) {
        result.files.push(...validFiles);
        // [2026-08-01 严重bug修·Call路径TypeError] previewUpdater 是可选回调（proxy main.mjs Call()
        //   与 fallback/change-prompt 调用方不传）——use_stream 默认 true 下首个 delta 裸调即炸。
        //   按契约可选化（?.），本文件三处同修。
        previewUpdater?.(result);
      }
    })();
    imageProcessingPromises.push(promise);
  };

  let totalChunks = 0;
  let totalBytes = 0;

  // 流读取超时：如果 5 分钟没有收到任何数据，认为连接已死
  const STREAM_READ_TIMEOUT_MS = 5 * 60 * 1000;
  const readWithTimeout = () => {
    let timer;
    return Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("[proxy] SSE 流读取超时（5分钟无数据）")),
          STREAM_READ_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };

  // [0808 根修·尾行 flush 配套] SSE 单行解析——原 while 循环内 for 循环体原样提取
  //   （continue→return，行为不变）。提取成单一实现使「流中逐行」与「流结束后残余 buffer
  //   补处理」共用一份解析逻辑，不复制两份。
  const _handleSseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;

    // 过滤非JSON内容（某些反代在流末尾发送纯文本错误信息如 "unexpected EOF"）
    if (!data.startsWith("{") && !data.startsWith("[")) {
      if (data.length > 0) {
        console.warn(
          `[proxy/stream] 跳过非JSON SSE data: "${data.substring(0, 100)}"`,
        );
      }
      return;
    }

    try {
      const json = JSON.parse(data);

      // 检测 SSE 流中的 API 错误（反代返回 HTTP 200 但 body 中含错误）
      if (json.error) {
        const errMsg =
          json.error.message ||
          json.error.status ||
          JSON.stringify(json.error);
        const errCode = json.error.code || "UNKNOWN";
        console.error(
          `[proxy/fetchChatCompletion] SSE 流中检测到 API 错误: code=${errCode}, message=${errMsg}`,
        );
        wbD(null, "ai:stream", "sse_body_error", false, `SSE流内API错误 code=${errCode}`, { code: errCode, message: errMsg });
        // [0727 吞错收口] 本 throw 原被下方 JSON 解析 catch 就地吞掉（只 warn 不上抛），
        //   真实 API 错误被折叠成"空回复"——调用方按空回空转重试（0727 CLONE_2 卡 600s 实证）。
        //   打 _sseApiError 标记让解析 catch 放行；errCode 是 HTTP 形态数字时挂 err.status，
        //   withRetry 的 429/5xx 分类器即可正确决定退避重试。
        const _sseErr = new Error(`API Error (${errCode}): ${errMsg}`);
        _sseErr._sseApiError = true;
        const _numCode = Number(errCode);
        if (Number.isInteger(_numCode) && _numCode >= 100 && _numCode < 600) _sseErr.status = _numCode;
        throw _sseErr;
      }

      const delta = json.choices?.[0]?.delta;
      const message = json.choices?.[0]?.message; // Some non-standard streams might send full message

      // [0727 终止原因入链] finish_reason 是上游对"为什么停"的一等声明（stop=自然完成/
      //   length=截断/content_filter 等），此前解析层直接丢弃——"干净截断"与"自然完成"在
      //   本体全链不可区分（0727 A窗 20字残句被当成功收尾实证）。单点捕获挂 result，
      //   下游（StructCall 回灌 extension → 回合末续写决策/外显）消费。取最后一个非空值。
      const _finishReason = json.choices?.[0]?.finish_reason;
      if (_finishReason) result.finish_reason = _finishReason;

      // 处理思维链/推理内容（Gemini/DeepSeek 等模型的 thinking 阶段）
      const reasoning =
        delta?.reasoning_content ||
        delta?.reasoning ||
        message?.reasoning_content ||
        "";
      if (reasoning) {
        if (!result._reasoning_started) {
          result._reasoning_started = true;
          result.content += "<think>\n";
        }
        result.content += reasoning;
        previewUpdater?.(result); // [2026-08-01] 可选回调，同 processImages 处注释
      }

      const content = delta?.content || message?.content || "";
      if (content) {
        // 思维链结束，关闭 <think> 标签
        if (result._reasoning_started && !result._reasoning_ended) {
          result._reasoning_ended = true;
          result.content += "\n</think>\n";
        }
        result.content += content;
        previewUpdater?.(result); // [2026-08-01] 可选回调，同 processImages 处注释
      }

      // Handle images if present in delta or message (Custom extension support)
      const images = delta?.images || message?.images;
      if (images) processImages(images);
    } catch (e) {
      if (e && e._sseApiError) throw e; // 流内 API 错误上抛给重试层，不当解析噪音吞掉
      console.warn("Error parsing stream data:", e);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        const err = new Error("User Aborted");
        err.name = "AbortError";
        throw err;
      }
      const { done, value } = await readWithTimeout();
      if (done) break;

      totalChunks++;
      totalBytes += value?.length || 0;
      buffer += decoder.decode(value, { stream: true });

      // Detect SSE format
      if (!isSSE && /^data:/m.test(buffer)) { isSSE = true; wbT(null, "ai:stream", "sse_start", { chunk: totalChunks }); }

      if (isSSE) {
        const lines = buffer.split("\n");
        buffer = lines.pop(); // Keep incomplete line
        for (const line of lines) _handleSseLine(line);
      }
    }

    // [0808 根修·尾行 flush] 上游最后一个 chunk 若无结尾换行，最后一条 "data:" 行会留在 buffer
    //   里被整段丢弃（SSE 分支只在收到新 chunk 时切行，流结束后不回头处理残余 buffer）——
    //   「官方 API 结果被我们这边截断」同族根因。流结束后把残余 buffer 按同一行解析器补处理，不丢尾。
    if (isSSE && buffer.trim()) {
      const _tail = buffer;
      buffer = "";
      for (const line of _tail.split("\n")) _handleSseLine(line);
    }

    wbT(null, "ai:stream", "stream_end", { isSSE, chunks: totalChunks, bytes: totalBytes, contentLen: result.content?.length || 0 });
    // 流结束后关闭未闭合的 <think> 标签
    if (result._reasoning_started && !result._reasoning_ended) {
      result.content += "\n</think>\n";
      result._reasoning_ended = true;
    }

    // If not SSE, try parsing as standard JSON
    if (!isSSE && buffer.trim())
      try {
        const json = JSON.parse(buffer);
        // [0727 终止原因入链] 非流式分支同捕（与上方 SSE 分支同语义）
        if (json.choices?.[0]?.finish_reason) result.finish_reason = json.choices[0].finish_reason;
        const message = json.choices?.[0]?.message;
        if (message) {
          let fullContent = "";
          // 处理思维链内容（非流式响应）
          if (message.reasoning_content) {
            fullContent +=
              "<think>\n" + message.reasoning_content + "\n</think>\n";
          }
          fullContent += message.content || "";
          result.content = fullContent;
          if (message.images) processImages(message.images);
        }
      } catch (e) {
        if (!result.content)
          console.error("Failed to parse response as JSON:", e);
      }
  } catch (e) {
    if (e.name === "AbortError") { wbT(null, "ai:stream", "stream_abort", { msg: e.message }); throw e; }
    // [0727 断连收口] 非用户中止的流失败（读超时/流内API错）原先只 releaseLock 不 cancel：
    //   底层连接不终止，上游生成在孤儿连接上继续跑（占资源+计费），而外层 withRetry 可能已
    //   发出新一轮 POST（对单槽型网关还是并发放大器）。cancel 把取消传播到连接层，
    //   挂起中的 read() 以 done 收尾；用户中止路径(:278-288)已有 cancel，此处只补失败路径。
    try { reader.cancel(e).catch(() => {}); } catch { /* reader 已释放，无需处理 */ }
    wbD(null, "ai:stream", "stream_read_error", false, e?.message || "流读取错误", { name: e?.name });
    console.error("Stream reading error:", e);
    throw e;
  } finally {
    reader.releaseLock();
  }

  // Wait for all image processing to complete
  if (imageProcessingPromises.length > 0)
    await Promise.allSettled(imageProcessingPromises);

  // 清理内部追踪标记
  delete result._reasoning_started;
  delete result._reasoning_ended;

  // ⚠ 思维链从 content 分离 — content 存纯正文（给AI上下文+存储），content_for_show 保留完整内容（给前端显示）
  // 支持 <think>/<thinking>/自定义标签
  if (result.content) {
    const stripped = stripReasoningTags(result.content, config?.username);
    if (stripped !== result.content) {
      result.content_for_show = result.content;
      // DeepSeek 推理模型可能把全部回复放在 reasoning_content 中，delta.content 为空
      // 剥离后 content 为空 → 保留 reasoning 文本作为实际回复（前端 thinking 折叠会处理显示）
      result.content = stripped.trim() || result.content;
    }
  }

  if (!result.content && result.files?.length === 0) {
    wbD(null, "ai:stream", "empty_content", false, "AI返回空内容", { bufferTail: buffer?.substring(0, 100) });
    console.warn(
      `[proxy/fetchChatCompletion] ⚠️ AI返回空内容！buffer剩余(前200):`,
      JSON.stringify(buffer?.substring(0, 200)),
    );
  }

  return result;
}

/**
 * 调用基础模型（带重试）。
 * @param {Array<object>} messages - 消息数组。
 * @param {{ signal?: AbortSignal, previewUpdater?: (result: {content: string, files: any[]}) => void, result: {content: string, files: any[]} }} options - 包含信号、预览更新器和结果的选项对象。
 * @param {object} config - 配置对象。
 * @returns {Promise<{content: string, files: any[]}>} 模型返回的内容。
 */
export async function fetchChatCompletionWithRetry(messages, options, config) {
  const errors = [];

  // ★ 重试前还原 result 快照（0715）：fetchChatCompletion 流式路径对 options.result 累加
  //   （content += :407-437，processImages push files :315），入口不重置——中途断流（ECONNRESET/
  //   读超时等）后内外两层重试（限流退避循环 + URL 候选循环）复用同一 result 继续流，
  //   新响应整份追加在半份旧正文之后 = 正文/图片重复。每次尝试前还原到进入本函数时的快照
  //   （files 只截断回快照长度：数组引用被 proxy main :274/:414 共享，不可换新数组）。
  //   已知边缘未覆盖：失败尝试遗留的 processImages 浮动 promise 可能在下一尝试期间迟到 push（罕见路径，见报告）。
  const _res0 = options?.result;
  const _snapContent = _res0?.content ?? "";
  const _snapShow = _res0?.content_for_show;
  const _snapFilesLen = Array.isArray(_res0?.files) ? _res0.files.length : 0;
  const _restoreResultSnapshot = () => {
    if (!_res0) return;
    _res0.content = _snapContent;
    if (_snapShow === undefined) delete _res0.content_for_show;
    else _res0.content_for_show = _snapShow;
    if (Array.isArray(_res0.files)) _res0.files.length = _snapFilesLen;
  };

  /**
   * 构造 URL 候选列表（统一规范化，避免字符串盲拼导致 Invalid URL / 重复路径）
   * @param {string} rawUrl
   * @returns {string[]}
   */
  function buildRetryUrls(rawUrl) {
    const parsed = (() => {
      try {
        return new URL((rawUrl || "").trim());
      } catch {
        return null;
      }
    })();
    if (!parsed) return [];

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (nextUrl) => {
      if (!nextUrl || seen.has(nextUrl)) return;
      seen.add(nextUrl);
      candidates.push(nextUrl);
    };
    const withPath = (pathname) => {
      const next = new URL(parsed.toString());
      next.pathname = pathname;
      return next.toString();
    };

    const normalizedPath = parsed.pathname.replace(/\/+$/g, "") || "/";

    if (!normalizedPath.endsWith("/chat/completions")) {
      if (normalizedPath.endsWith("/v1")) {
        // .../v1 -> 优先 .../v1/chat/completions，原始 URL 作为回退
        pushCandidate(withPath(`${normalizedPath}/chat/completions`));
        pushCandidate(parsed.toString()); // 原始 /v1 作为回退
      } else {
        // 非 /v1 结尾：原始优先，再补全路径候选
        pushCandidate(parsed.toString());
        pushCandidate(withPath(`${normalizedPath}/v1/chat/completions`));
        pushCandidate(withPath(`${normalizedPath}/chat/completions`));
      }
    } else {
      // 已经是完整路径，直接使用
      pushCandidate(parsed.toString());
    }

    return candidates;
  }

  /**
   * 限流/慢/网络错重试
   * 最多重试 MAX_RATE_LIMIT_RETRIES 次；无 Retry-After 时按 +15s 线性递增退避（第 N 次等 N*15s）。
   * 慢 API（429/5xx/网络超时 ETIMEDOUT）由此覆盖；调用方主动 abort（用户取消）不在此重试。
   * @param {string} candidateUrl
   * @returns {Promise<{content: string, files: any[]}>}
   */
  const MAX_RATE_LIMIT_RETRIES = 10; // 慢 API 持久重试 ~10 次
  const BACKOFF_STEP_MS = 15000; // 每次 +15s 线性递增（第 N 次等 N*15s）
  const BACKOFF_CAP_MS = 150000; // 单次封顶 150s，避免无界等待

  async function fetchWithRateLimitRetry(candidateUrl) {
    const currentConfig = { ...config, url: candidateUrl };
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      if (attempt > 0) {
        // 从响应头读取 Retry-After（秒），优先使用；否则按 +15s 线性递增（15s,30s,...）
        const retryAfterSec = lastError?.detail?.retryAfter;
        const backoffMs = retryAfterSec
          ? Math.min(retryAfterSec * 1000, 120000) // Retry-After 最长等 120 秒
          : Math.min(BACKOFF_STEP_MS * attempt, BACKOFF_CAP_MS);
        wbD(null, "ai:request", "rate_limit_backoff", false, `退避重试 ${attempt}/${MAX_RATE_LIMIT_RETRIES}`, { backoffMs, retryAfterSec, url: candidateUrl });
        console.warn(
          `[proxy] 限流/慢/网络错，第 ${attempt}/${MAX_RATE_LIMIT_RETRIES} 次退避等待 ${(backoffMs / 1000).toFixed(1)}s... (URL: ${candidateUrl})`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }

      try {
        // [0717 断流续接·凛倾指令] 中流断且已收到正文时不再从头重跑（参照上游代理实现的
        //   handleStreamingResponse 续接范式：已收内容作尾部 assistant 预填充，模型只生成剩余部分）。
        //   beilu 化差异：①零注入文本——不加 "Continue" user 指令（铁律:代码禁产生进对话文本），
        //   纯预填充续写（ST 同款）②预填充内容剥 thinking（未闭合 <think> 段整段去掉，防把思维链
        //   发回渠道）③result 不还原快照 = 新流 delta 继续累加在已收内容后，previewUpdater 全量
        //   预览天然连续（用户无感，不再"重复重流"）。开关 convert_config.stream_resume!==false（默认开）。
        //   partial 为空（429/5xx/建连失败=没收到任何正文）时走原快照还原路径，行为与旧版全同。
        const _resumeOn = currentConfig.convert_config?.stream_resume !== false;
        let _resumePrefix = "";
        if (_resumeOn && _res0 && _res0.content.length > _snapContent.length) {
          let _p = stripReasoningTags(_res0.content.slice(_snapContent.length), currentConfig?.username);
          const _ti = _p.lastIndexOf("<think");
          if (_ti >= 0 && !_p.slice(_ti).includes("</think")) _p = _p.slice(0, _ti);
          _resumePrefix = _p.trimEnd();
        }
        if (_resumePrefix.trim()) {
          options._resumePrefix = _resumePrefix;
          console.log(`[proxy] ★ 断流续接: 已收 ${_resumePrefix.length} 字符作预填充续写（不从头重跑）`);
          wbT(null, "ai:request", "stream_resume", { prefixLen: _resumePrefix.length, attempt });
        } else {
          delete options._resumePrefix;
          _restoreResultSnapshot(); // 覆盖两层重试：限流退避每 attempt + URL 候选每轮都从干净快照起流
        }
        return await fetchChatCompletion(messages, currentConfig, options);
      } catch (err) {
        if (err.name === "AbortError") throw err;
        lastError = err;

        const status = err.status || 0;
        const is429 = status === 429;
        const isRetryable5xx =
          status === 500 || status === 502 || status === 503 || status === 529;
        // 网络层错误（UND_ERR_SOCKET / ECONNREFUSED / ENOTFOUND / ETIMEDOUT 等）
        // 没有 HTTP status，说明连接都没建立成功，也应该重试。
        // [0716 网络波动容错·凛倾定案] 补「中流断线」形态：响应头 200 已到、读 body 中途断
        //   （undici "terminated" / "error reading a body from connection" / UND_ERR_BODY_TIMEOUT / other side closed）——
        //   原清单只认建连失败，中流断被判不可重试直接跳 URL 候选（候选 404 再合并抛错），
        //   等于网络抖一下就整轮报废（凛倾 0716 实证）。中流重试安全：每次尝试前 _restoreResultSnapshot 已保证不重复累加。
        const _errMsgAll = `${err.message || ""} ${err.cause?.message || ""}`;
        const isNetworkError =
          status === 0 &&
          (err.cause?.code === "UND_ERR_SOCKET" ||
            err.cause?.code === "ECONNREFUSED" ||
            err.cause?.code === "ECONNRESET" ||
            err.cause?.code === "ENOTFOUND" ||
            err.cause?.code === "ETIMEDOUT" ||
            err.cause?.code === "UND_ERR_BODY_TIMEOUT" ||
            err.message?.includes("UND_ERR_SOCKET") ||
            err.message?.includes("fetch failed") ||
            _errMsgAll.includes("terminated") ||
            _errMsgAll.includes("error reading a body") ||
            _errMsgAll.includes("other side closed"));

        if (
          (is429 || isRetryable5xx || isNetworkError) &&
          attempt < MAX_RATE_LIMIT_RETRIES
        ) {
          if (isNetworkError) {
            wbD(null, "ai:request", "network_error_retry", false, `网络错误重试 ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}`, { code: err.cause?.code || err.message });
            console.warn(
              `[proxy] 网络连接错误 (${err.cause?.code || err.message})，第 ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES} 次重试...`,
            );
          }
          // 继续退避重试
          continue;
        }
        // 非限流/非网络错误或已达重试上限 → 抛给外层
        throw err;
      }
    }

    // 所有退避尝试均失败
    throw lastError;
  }

  const urlCandidates = buildRetryUrls(config.url);
  if (urlCandidates.length === 0) {
    throw new Error(
      `[proxy] 非法 AI URL 配置: "${config.url}". 需要完整绝对 URL（例如 https://api.openai.com/v1/chat/completions）`,
    );
  }

  // [0727 并发闸] 用户级 AI 同时运行上限（yonban_config.ai_max_concurrent，0/缺省=不限）：
  //   本函数是 proxy 生成器全部出站流量的必经点（主对话/分身/记忆AI/联网AI）= 单点收口。
  //   上限每次现读 → 设置面板改动即时生效；排队等待可被用户停止(signal)打断（抛 AbortError，
  //   与既有中止语义同族）。释放在下方 finally，异常/中止路径不漏槽。
  const _releaseAiSlot = await acquireAiSlot(config.username, options?.signal, options?.aiPriority);
  // [0717 断流续接] options 是调用方 generation_options（跨请求复用），_resumePrefix 只在本次
  //   withRetry 生命周期内有效——无论成功/失败，退出前必须清掉，否则残留污染下一轮全新请求。
  try {
    // [0718 快速失败] 同主机连接死跳过：某候选以"等待响应头超时"失败=该 host 挂起,
    //   同 host 其余候选(路径变体)必然同样挂满超时——逐个再等只把失败拖成 N×timeout
    //   （实测慢网关挂起=2 分钟才报错）。跳过项记入 errors 保留可见诊断面。
    const _deadHosts = new Set();
    for (const candidateUrl of urlCandidates) {
      let _host = "";
      try { _host = new URL(candidateUrl).host; } catch { /* 非法候选交给 fetch 自己报 */ }
      if (_host && _deadHosts.has(_host)) {
        errors.push(new Error(`[proxy] 跳过 ${candidateUrl}（同主机 ${_host} 已判连接死，不再等待）`));
        continue;
      }
      try {
        const result = await fetchWithRateLimitRetry(candidateUrl);

        if (candidateUrl !== config.url) {
          console.info(
            `[proxy] URL 候选重试成功: ${config.url} -> ${candidateUrl}（不改写配置）`,
          );
        }

        return result;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        if (_host && String(error?.message || "").includes("等待响应头超时")) _deadHosts.add(_host);
        console.warn(
          `[proxy] 请求失败 (${candidateUrl}): ${error.message || String(error)}`,
        );
        errors.push(error);
      }
    }

    // 抛出时提供有意义的错误信息
    if (errors.length === 1) throw errors[0];
    const combined = new Error(
      `所有 URL 尝试均失败:\n${errors.map((e, i) => `  [${i + 1}] ${e.message || String(e)}`).join("\n")}`,
    );
    combined.errors = errors;
    throw combined;
  } finally {
    _releaseAiSlot(); // [0727 并发闸] 幂等释放：成功/失败/中止全路径归还槽位（或移交给排队者）
    if (options) delete options._resumePrefix;
  }
}
