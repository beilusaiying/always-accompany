import { wbT, wbD } from "../../../../../../server/wbStub.mjs";
// 参数缺省单源（2026-07-08 链路2）：thinking_budget 兜底改读 PARAM_SCHEMA（原 8000 三处独立写死）
import { paramDefault } from "../../../prompt/preset/engine/paramSchema.mjs";
import { findVolatileStart, resolveBpIndex } from "../../_shared/volatileBoundary.mjs";
/**
 * proxy/lib/providerPatch.mjs
 * Provider 专化预处理 + 错误标准化 + 尾部预填充（通用，非 provider 专属）
 *
 * 导出：
 *   applyTailPrefill(requestBody, context) → object
 *   patchBodyForClaude(requestBody, context) → object
 *   patchBodyForDeepSeek(requestBody, context) → object
 *   normalizeProviderError(status, statusText, rawText, parsed) → object
 */

// ============================================================
// 尾部预填充（通用机制，2026-07-08 从 patchBodyForClaude 拆出）
// ============================================================

/**
 * 尾部预填充：对请求 messages 的最后一条做用户显式选择的处理。
 *
 * 凛倾 2026-07-08:「什么叫做包含claude,预填充才生效」——预填充=尾部最后一条的设置，是用户
 * 显式选择的通用机制，不受"URL/模型名包含 claude"字符串猜测门控（旧病：中转 URL/模型别名
 * 不含 claude 字样时 patchBodyForClaude 整个 early return，用户选的模式静默失效）。
 * httpFetch 对所有渠道无条件调用本函数；Claude 专属的 off 漏网兜底仍在 patchBodyForClaude。
 *
 * 四模式（凛倾定稿）：
 *   off            = 不处理（Claude 渠道的漏网兜底由 patchBodyForClaude 负责）
 *   prefill        = 尾部 assistant 原样保留（ST 式真预填充，渠道支持时效力最强）
 *   to_user        = 尾部 assistant 直接改 role 为 user（内容原样；旧自造名"claude"迁移归此）
 *   user_assistant = 改 user 且内容末尾加 "\nassistant:"（ST convertTextCompletionPrompt:930
 *                    同款 text-completion 引导，加强有效性）
 *
 * @param {object} requestBody
 * @param {{ url?: string, claudePrefillMode?: string }} context
 * @returns {object} 处理后的请求体（原对象就地修改后返回）
 */
export function applyTailPrefill(requestBody = {}, { url = "", claudePrefillMode = "off" } = {}) {
  const body = requestBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  const lastMsg = body.messages[body.messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant" || claudePrefillMode === "off") return body;

  // 内容末尾追加文本（string / parts 数组两形状）
  const _appendTail = (mm, text) => {
    if (typeof mm.content === "string") {
      mm.content = mm.content ? `${mm.content}${text}` : text.trimStart();
    } else if (Array.isArray(mm.content)) {
      for (let i = mm.content.length - 1; i >= 0; i--) {
        if (mm.content[i].type === "text") { mm.content[i] = { ...mm.content[i], text: `${mm.content[i].text || ""}${text}` }; return; }
      }
      mm.content.push({ type: "text", text: text.trimStart() });
    }
  };

  if (claudePrefillMode === "prefill") {
    // 尾部 assistant：原样保留=ST 式真预填充，不做任何转换
    console.log(`[applyTailPrefill] prefill: 尾部 assistant 原样保留（ST 式真预填充）`);
  } else if (claudePrefillMode === "user_assistant") {
    // user 后面加 assistant:（凛倾:「尾部user之后内容在加assistant:这样去加强有效性」）
    lastMsg.role = "user";
    _appendTail(lastMsg, "\nassistant:");
    console.log(`[applyTailPrefill] user_assistant: 尾部改 user + 内容末尾 assistant: 引导`);
  } else {
    // to_user（含旧值 claude/wrap_system/append_user 迁移归此）：尾部 assistant 直接改 user，内容原样
    lastMsg.role = "user";
    console.log(`[applyTailPrefill] to_user: 尾部 assistant 直接改 user（内容原样）`);
  }
  return body;
}

// ============================================================
// Provider 特化辅助函数（Claude 分支）
// ============================================================

/**
 * 对 OpenAI 兼容请求做 Claude 特化预处理
 * 触发条件：url 或 model 名称命中 claude/anthropic
 *
 * 处理内容（0711 注释校准=与函数体现状一致；旧步骤 1/2/5 均已在 2026-07-08 裁决中删除）：
 *   3. Extended Thinking 参数注入：开启时追加 thinking:{type:"enabled",budget_tokens}（钳 [1024,100000]）；
 *      不再静默删除 temperature/top_p（0708：两个显式设置冲突时机制不替用户做主，API 错误直达前端）
 *   4. image_url → Claude 原生 image 格式转换（base64 data URL → source 块）
 *   6. 缓存断点注入：bp1=头部 system 末尾 + bp2=尾部易变区前 2 条（cache_control ephemeral，
 *      convert_config.cache_breakpoints=false 可关）
 *   尾部形态与本函数零关联：四模式统一在 applyTailPrefill（通用机制，httpFetch 无条件调用）
 *
 * @param {object} requestBody - 原始请求体对象
 * @param {{ provider?: string, url?: string, model?: string, claudePrefillMode?: string, extendedThinking?: boolean, thinkingBudget?: number, cacheBreakpoints?: boolean }} context
 *   - provider：httpFetch resolveProvider 的结果（用户显式声明优先）。2026-07-08 起门控以它为准，
 *     不再函数内独立 includes 猜测（旧 isClaude 猜测=中转别名不含"claude"字样时整套预处理静默 skip 的根因）
 * @returns {object} 处理后的请求体
 */
export function patchBodyForClaude(
  requestBody = {},
  {
    provider = "",
    url = "",
    model = "",
    claudePrefillMode = "off",
    extendedThinking = false,
    thinkingBudget = paramDefault("thinking_budget"),
    cacheBreakpoints = true,
  } = {},
) {
  const isClaude = provider === "claude" || provider === "openrouter-claude";

  if (!isClaude) { wbT(null, "ai:patch", "claude_skip", { model, provider }); return requestBody; }
  wbT(null, "ai:patch", "claude_hit", { model, claudePrefillMode, extendedThinking });

  const body = { ...requestBody };

  // （2026-07-08 静默参数改写已删——凛倾:「如果是top,tok冲突,那么错误肯定有返回,直接给提醒啊」
  //   +「你不能100%确认用户用的是claude」：原步骤1"temp+top_p 互斥删 top_p"与步骤2
  //   "CLAUDE_UNSUPPORTED 7 参数预防性删除"都是在字符串猜测的渠道判定上静默改写用户参数——
  //   官方 API 的约束按名字强加给自部署/中转源。参数冲突/不支持时 API 自己返回错误
  //   （httpFetch normalizeProviderError → 前端错误气泡），用户按提示自行调整。）

  // 3) Extended Thinking 参数注入
  // 当 extendedThinking=true 时，向请求体追加 thinking 字段
  // Claude API 格式：{ type: "enabled", budget_tokens: N }
  // 注意：thinking 模式下必须删除 temperature（两者不兼容）
  if (extendedThinking) {
    const budget = Math.max(
      1024,
      Math.min(Number(thinkingBudget) || paramDefault("thinking_budget"), 100000),
    );
    body.thinking = { type: "enabled", budget_tokens: budget };
    // （2026-07-08 删"thinking 时静默删除 temperature/top_p"——用户两个显式设置冲突时
    //   机制不替用户做主，API 返回的冲突错误直达前端提醒，用户自行调整。）
    console.log(
      `[patchBodyForClaude] Extended Thinking 已启用: budget_tokens=${budget}`,
    );
  } else {
    // 确保不残留 thinking 字段（内部字段清理，非用户参数）
    delete body.thinking;
  }

  // 4) image_url → Claude 原生 image 格式转换（双保险：反代也会转，但 beilu 侧先转更稳妥）
  if (Array.isArray(body.messages)) {
    let _imgConverted = 0;
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map(part => {
          if (part.type === "image_url" && part.image_url?.url) {
            const match = part.image_url.url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
            if (match) {
              _imgConverted++;
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2],
                }
              };
            }
          }
          return part;
        });
      }
    }
    if (_imgConverted > 0) {
      console.log(`[patchBodyForClaude] image_url → Claude image 转换: ${_imgConverted}张`);
    }
  }

  // 5) 尾部预填充处理（2026-07-08 四模式定稿+正名——凛倾:「一个是默认,一个是尾部assistant,
  //    一个是claude的变体,一个是user后面加assistant」+「什么又叫做claude模式?互联网上有这个名词吗?」
  //    ——"claude模式"是自造名词，公认概念只有 prefill（Anthropic 官方 Prefilling Claude's response），
  //    枚举值正名为描述性命名，旧值经迁移表自愈）
  //
  //   预填充=尾部最后一条的设置（与提示词后处理零耦合，pp 是消息形状规范化另一机制）：
  //     off            = 默认关闭（漏网 assistant 尾巴走下方 fail-closed 兜底防 400）
  //     prefill        = 尾部 assistant 原样保留（ST 式真预填充，prompt-converters.js:329-335
  //                      直接发 role:assistant 结尾；渠道支持 prefill 时效力最强，
  //                      现代 Claude 直连会 400=用户按渠道自选，与 ST 同约定）
  //     to_user        = 尾部 assistant 直接改 role 为 user（内容原样，Claude 强制 user 结尾；
  //                      零改动贴缓存边界；旧名"claude"经迁移表归此）
  //     user_assistant = 改 user 且内容末尾加 "\nassistant:"（text-completion 式引导，
  //                      ST convertTextCompletionPrompt:930 同款收尾，加强预填充有效性）
  //   Claude Code CLI 代理分支保留原成熟做法（删 prefill+user 引导）。
  //   ★ 2026-07-08 尾部处理全部拆离本函数（凛倾:「什么叫做包含claude,预填充才生效」+
  //   「什么叫做你可以100%确认用户用的是claude」）：四模式在 applyTailPrefill（httpFetch 无条件
  //   调用）；原 off"漏网兜底"（静默转 user）已删——isClaude 是字符串猜测，在猜测上做静默消息
  //   改写不合法。off=纯不处理，渠道拒绝尾部 assistant 时报错可见，用户自选模式。

  // 6) 缓存断点注入（2026-07-07，基于本机代理参考实现 interceptor 的后处理做法优化）
  //    （2026-07-08 删原 6a"护头"：往对话前插硬编码 user "." = 未确诊场景的预防性补丁
  //    + 代码注入文本，双重不合格，照抄参考实现未审查。）
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    // 6b) cache_control 两断点（凛倾 2026-06-15 两断点设计，interceptor cleanRequestBody bp1/bp3 同构）：
    //     bp1=头部 system 块末尾（中转提取顶层 system 时 cache_control 跟随 → system 独立缓存条目）
    //     bp2=尾部易变区前 2 条（-data 数据块/afterChat 每轮变，断点须在其前；无元数据时按
    //         位置启发式=倒数第 3 条——每轮追加 user+assistant 两条，此前全是稳定前缀）。
    //     content part 内嵌 cache_control 是 Anthropic 合法字段，OpenRouter 官方支持、多数中转透传；
    //     不带 ttl（默认 5m）——1h 需 anthropic-beta 头，中转透传与否不可控，要 1h 走 custom_headers 自配。
    //     兼容出口：convert_config.cache_breakpoints=false 显式关（严格中转若拒 cache_control 字段时用）。
    if (cacheBreakpoints !== false) {
      const _CACHE_MARK = { type: "ephemeral" };
      const _mark = (mm) => {
        if (typeof mm.content === "string") {
          if (!mm.content) return false;
          mm.content = [{ type: "text", text: mm.content }];
        }
        if (!Array.isArray(mm.content) || mm.content.length === 0) return false;
        mm.content[mm.content.length - 1].cache_control = _CACHE_MARK;
        return true;
      };
      let _bps = 0;
      // bp1：头部 system（postProcess merge 已把头部连续 system 并成单条）
      if (body.messages[0].role === "system" && _mark(body.messages[0])) _bps++;
      // bp2：尾部易变区检测——[0722 审计 M1/H1 收口] 换 volatileBoundary 单源（判据全集=元数据
      //   ∪ 正文标签，原本地只认元数据=与 claude-api/interceptor 判据漂移的一侧；魔数 8/-2/-3 随迁共享常量）。
      const _len = body.messages.length;
      const _volStart = findVolatileStart(body.messages);
      let _bp2idx = resolveBpIndex(_volStart, _len);
      if (_bp2idx > 0 && _bp2idx < _len - 1 && _mark(body.messages[_bp2idx])) _bps++;
      else _bp2idx = -1;
      if (_bps > 0) {
        console.log(`[patchBodyForClaude] 缓存断点: ${_bps} 个 (bp1=system首条, bp2=@${_bp2idx}/${_len})`);
      }
    }
  }

  console.log(
    `[proxy/patchBodyForClaude] Claude 预处理已应用: prefillMode=${claudePrefillMode}, messages=${body.messages?.length}`,
  );

  return body;
}

// ============================================================
// Provider 特化辅助函数（DeepSeek 分支）
// ============================================================

/**
 * 对 OpenAI 兼容请求做 DeepSeek 特化预处理
 * 触发条件：provider 解析结果为 deepseek / deepseek-r1（用户显式声明优先，httpFetch resolve 一次传入；
 * 2026-07-08 起不再函数内独立 includes 猜测）
 *
 * @param {object} requestBody - 原始请求体对象
 * @param {{ provider?: string, url?: string, model?: string }} context - url/model 仅用于诊断警告，不驱动门控
 * @returns {object} 处理后的请求体
 */
export function patchBodyForDeepSeek(
  requestBody = {},
  { provider = "", url = "", model = "" } = {},
) {
  const u = String(url || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  const isDeepSeek = provider === "deepseek" || provider === "deepseek-r1";

  if (!isDeepSeek) { wbT(null, "ai:patch", "deepseek_skip", { model, provider }); return requestBody; }
  wbT(null, "ai:patch", "deepseek_hit", { model });

  const body = { ...requestBody };

  // 1) top_p 保底：DeepSeek 不接受 top_p=0 或 undefined，用 Number.EPSILON
  if (!(Number(body.top_p) > 0)) body.top_p = Number.EPSILON;

  // 2) tools required: [] 清理（DeepSeek 拒绝空 required 数组）
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => {
      const t = structuredClone(tool);
      const req = t?.function?.parameters?.required;
      if (Array.isArray(req) && req.length === 0) {
        delete t.function.parameters.required;
      }
      return t;
    });
  }

  // （2026-07-08 官方限制集已删——凛倾:「是叫做去把deepseek的源变成官方单一而不是用户自己
  //   部署的」：max_tokens 8192/16384 硬裁剪与"不支持参数"预防性删除是 DeepSeek 官方 API 的
  //   限制，按"名字含 deepseek"强加给自部署源（vLLM/ollama 支持这些参数与更大 max_tokens）
  //   =改写用户参数。官方源超限/拒参时自己报错=可见诊断面。保留的仅两项协议修复：
  //   top_p=0 值域修复与 tools 空 required 清理——格式修复非能力限制。）

  // 3) 模型名校验警告：URL 含 deepseek 但 model 不含 deepseek
  if (u.includes("deepseek") && !m.includes("deepseek")) {
    wbD(null, "ai:patch", "deepseek_model_mismatch", false, "URL是DeepSeek但模型名不含deepseek", { model });
    console.warn(
      `[patchBodyForDeepSeek] ⚠️ URL 是 DeepSeek 但模型名不含 deepseek: "${model}". ` +
        `推荐使用 deepseek-chat 或 deepseek-reasoner`,
    );
  }

  console.log(
    `[proxy/patchBodyForDeepSeek] DeepSeek 预处理已应用: top_p=${body.top_p}, tools=${body.tools?.length ?? "无"}`,
  );

  return body;
}

/**
 * 统一提取 provider 错误信息为结构化对象
 * 兼容 OpenAI / DeepSeek / Claude / 各类中转的错误格式
 *
 * @param {number} status - HTTP 状态码
 * @param {string} statusText - HTTP 状态文本
 * @param {string} rawText - 原始响应文本
 * @param {object|null} parsed - 已解析的 JSON（如果有）
 * @returns {{ status: number, statusText: string, message: string, type: string|null, code: string|null, param: string|null, raw: object|string|null }}
 */
export function normalizeProviderError(
  status,
  statusText,
  rawText = "",
  parsed = null,
) {
  const p =
    parsed ||
    (() => {
      try {
        return JSON.parse(rawText);
      } catch {
        return null;
      }
    })();

  const err = p?.error || p?.detail?.error || null;
  wbD(null, "ai:patch", "provider_error", false, `provider错误 ${status} ${err?.type || ""}`.trim(), { status, type: err?.type || null, code: err?.code || null });
  return {
    status,
    statusText,
    message:
      err?.message ||
      p?.message ||
      rawText?.slice?.(0, 500) ||
      "Provider request failed",
    type: err?.type || null,
    code: err?.code || null,
    param: err?.param || null,
    raw: p || rawText || null,
  };
}
