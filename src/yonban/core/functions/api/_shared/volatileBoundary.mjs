// ============================================================================
// _shared/volatileBoundary.mjs — 易变区边界判定单一真源（0722 审计 M1/M2/H1 收口）
// ----------------------------------------------------------------------------
// 背景：同一"易变区起点"此前有两份独立实现、两套判据（providerPatch 只认元数据
//   _identifier/-data/_section；claude-api 只认正文 volatile 标签正则），且回看窗 8 /
//   兜底倒数第 3 条两处魔数各写死一次——判据漂移=断点定位分裂（J2 审计 M1【高】）。
//   本模块把【判据全集 + 扫描算法 + 常量】收成单源，两侧消费方 import 同一实现。
// 语义：易变区 = below 段（depth:0 的 -data 数据条目/afterChat/记忆数据等每轮变化内容），
//   缓存断点必须打在它之前（bp = volatileStart - BP_SEAM_OFFSET）。
// !!!禁止放入提示词!!! 本模块只做边界判定，禁止产生任何进 messages 的文本。
// 镜像契约：CLI 侧上游代理参考实现（interceptor）的
//   metaVolatileStart/volatileStart 判据须与本模块 VOLATILE_TAG_RE + 元数据集合逐字对齐
//   （0722 审计 J3-A：两侧曾各自演进漂移，修改任一侧判据时必须双侧同步）。
// ============================================================================

// 正文标签回看窗口（条）：只在尾部 N 条内扫文本标签——窗口过大会把历史正文里偶含的
// 标签误判为边界。组装元数据不受此窗限制，findVolatileStart 会从头扫描可信元数据。
export const VOLATILE_LOOKBACK = 8;

// 断点相对易变起点的前移量：易变区前 2 条（回看余量，interceptor bp3=volatileStart-2 同款）。
export const BP_SEAM_OFFSET = 2;

// 无易变检出时的兜底断点位：倒数第 3 条（每轮追加 2 条，此前全是稳定前缀）。
export const BP_FALLBACK_FROM_TAIL = 3;

// 正文易变标签全集（与 CLI interceptor 逐字对齐；claude-api 原 _VOL_RE 同集）：
//   <volatile_data＝数据块包裹；</chat_history>＝聊天收尾层；<ide_dynamic_data＝IDE 动态清单；
//   </beilu_think>／<execution_logic>＝生成尾部易变结构。
export const VOLATILE_TAG_RE = /<volatile_data|<\/chat_history>|<ide_dynamic_data|<\/beilu_think>|<execution_logic>/;

/** 通用取文（content 可为 string 或 parts 数组） */
function msgText(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

/** 结构元数据判据。它由当前轮组装层产生，不会被历史正文伪造，因此允许全序列扫描。 */
export function hasVolatileMetadata(msg) {
  if (!msg) return false;
  const id = msg._identifier ? String(msg._identifier) : "";
  const sec = msg._section ? String(msg._section) : "";
  return id.includes("-data") || sec === "afterChat" || sec === "injectionBelow";
}

/**
 * 单条消息是否属于易变区（判据全集 = 元数据 ∪ 正文标签）。
 * 元数据判据：_identifier 含 "-data"（数据条目）/ _section 为 afterChat 或 injectionBelow（below 段）。
 * 正文判据：VOLATILE_TAG_RE（直连渠道格式转换剥元数据后仍可判——claude-api 被迫用文本判据的根因）。
 * @param {object} msg - {role, content, _identifier?, _section?}
 * @returns {boolean}
 */
export function isVolatileBoundaryMsg(msg) {
  return hasVolatileMetadata(msg) || VOLATILE_TAG_RE.test(msgText(msg));
}

/**
 * 定位易变区起点：全序列扫描组装元数据，正文标签只扫描尾部回看窗。
 * @param {Array<object>} messages
 * @param {{lookback?: number}} [opts]
 * @returns {number} 易变起点下标；未检出返回 -1
 */
export function findVolatileStart(messages, { lookback = VOLATILE_LOOKBACK } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  let volStart = -1;

  // 元数据来自本轮 commander 五段装配，可信且不会误中用户历史正文，必须从头扫描。
  // 旧实现只回看 8 条；当 injectionBelow 有 9+ 条时，首批动态 data 被纳入缓存前缀。
  for (let i = 0; i < messages.length; i++) {
    if (hasVolatileMetadata(messages[i])) {
      volStart = i;
      break;
    }
  }

  // 正文标签仍只看尾窗：旧聊天里可能讨论同名字面标签，全扫会把缓存边界误拉到历史深处。
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - lookback); i--) {
    if (VOLATILE_TAG_RE.test(msgText(messages[i]))) {
      volStart = volStart < 0 ? i : Math.min(volStart, i);
    }
  }
  return volStart;
}

/**
 * 由易变起点换算消息级断点下标（bp = volStart-2；无检出=倒数第 3 兜底）。
 * @param {number} volStart - findVolatileStart 结果或组装现场权威 volatileStart（-1=未知）
 * @param {number} len - messages 长度
 * @returns {number} 断点下标；不可打（<=0）返回 -1
 */
export function resolveBpIndex(volStart, len) {
  const idx = volStart >= 0 && volStart <= len ? volStart - BP_SEAM_OFFSET : len - BP_FALLBACK_FROM_TAIL;
  return idx > 0 ? idx : -1;
}
