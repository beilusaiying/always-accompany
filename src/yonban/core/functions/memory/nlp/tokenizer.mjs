/**
 * tokenizer.mjs — Token 计数工具（js-tiktoken GPT-4 编码，CJK 字符估算兜底）
 *
 * 功能链：getPromptHandler / context 管理 → countTokens(text) → number（token 数）
 * why：Claude 提示词注入量需精确计算 token 防超限；GPT-4 tiktoken 与 Claude 计数高度接近；
 *      js-tiktoken 加载失败时 fallback 到 CJK 字符估算（不崩）。
 * 关联链：
 *   ← getPromptHandler.mjs（上下文长度控制）
 *   ← 各 handler（注入前 token 预算检查）
 * 影响范围：异步懒加载 js-tiktoken 单例；无 I/O 无副作用
 */

let _encoding = null;

// 内容寻址 LRU 缓存（0720 切卡分钟级卡顿根修·凛倾拍板框架归位）：
//   tiktoken enc.encode 是同步 CPU（MB 级文本=数十秒），且 fake-send/preset 预算裁剪/注入
//   预算检查对同一批不变内容反复全量重编码=后端事件循环被钉死的根因。
//   缓存收口在本功能层单源（countTokens/countTokensSync 同一张表），消费方零改动全受益。
//   key=内容字符串本身（Map 按值哈希）；仅缓存真实编码结果，fallback 估算便宜不入表。
//   双上限钳制（条数+字符量）防内存失控，超限逐出最久未用项。
const _tokenCache = new Map(); // content → tokens（Map 迭代序=插入序，get 时 delete+set 重排实现 LRU）
let _tokenCacheChars = 0;
const _TOKEN_CACHE_MAX_ENTRIES = 4096;
const _TOKEN_CACHE_MAX_CHARS = 32 * 1024 * 1024;

function _cacheGet(text) {
  const v = _tokenCache.get(text);
  if (v === undefined) return undefined;
  _tokenCache.delete(text);
  _tokenCache.set(text, v);
  return v;
}

function _cachePut(text, tokens) {
  if (_tokenCache.has(text)) {
    _tokenCache.delete(text);
    _tokenCacheChars -= text.length;
  }
  _tokenCache.set(text, tokens);
  _tokenCacheChars += text.length;
  while (
    (_tokenCache.size > _TOKEN_CACHE_MAX_ENTRIES || _tokenCacheChars > _TOKEN_CACHE_MAX_CHARS) &&
    _tokenCache.size > 1
  ) {
    const oldest = _tokenCache.keys().next().value;
    _tokenCacheChars -= oldest.length;
    _tokenCache.delete(oldest);
  }
}

const _CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
function _estimateTokensFallback(text) {
  const cjkChars = (text.match(_CJK_RE) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.round(cjkChars * 1.5 + otherChars / 4);
}

/**
 * 获取或初始化 tiktoken 编码器（懒加载单例）
 */
async function getEncoding() {
  if (_encoding) return _encoding;
  try {
    const { encodingForModel } = await import("npm:js-tiktoken");
    _encoding = encodingForModel("gpt-4");
    return _encoding;
  } catch (e) {
    console.warn("[tokenizer] js-tiktoken 加载失败，回退到字符估算:", e.message);
    return null;
  }
}

/**
 * 计算文本的 token 数
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function countTokens(text) {
  if (!text) return 0;
  const enc = await getEncoding();
  if (enc) {
    const cached = _cacheGet(text);
    if (cached !== undefined) return cached;
    const n = enc.encode(text, "all", []).length;
    _cachePut(text, n);
    return n;
  }
  return _estimateTokensFallback(text);
}

/**
 * 同步版本 — 编码器已初始化时精确计算，否则回退估算
 * 用于不方便 await 的场景
 * @param {string} text
 * @returns {number}
 */
export function countTokensSync(text) {
  if (!text) return 0;
  if (_encoding) {
    const cached = _cacheGet(text);
    if (cached !== undefined) return cached;
    const n = _encoding.encode(text, "all", []).length;
    _cachePut(text, n);
    return n;
  }
  return Math.round(text.length / 3.5);
}

/**
 * 计算 messages 数组的总 token 数
 * 每条消息额外 +4 tokens (消息格式开销)
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<number>}
 */
export async function countMessagesTokens(messages) {
  if (!messages || !Array.isArray(messages)) return 0;
  const enc = await getEncoding();
  let total = 0;
  for (const msg of messages) {
    total += 4; // 消息格式开销
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
    if (enc) {
      const cached = _cacheGet(content);
      if (cached !== undefined) {
        total += cached;
      } else {
        const n = enc.encode(content, "all", []).length;
        _cachePut(content, n);
        total += n;
      }
    } else {
      total += _estimateTokensFallback(content);
    }
  }
  return total;
}

/**
 * 预热编码器（启动时调用，避免首次计算延迟）
 */
export async function warmupTokenizer() {
  try {
    const enc = await getEncoding();
    if (enc) {
      enc.encode("warmup", "all", []);
      console.log("[tokenizer] js-tiktoken (gpt-4 encoding) 已就绪");
    }
  } catch (e) {
    console.warn("[tokenizer] 预热失败:", e.message);
  }
}
