/**
 * [reasoningTags.mjs] — 思维链标签保存链唯一写点（P2 一致性审计①散写收口）。
 *
 * 功能链：面板收集 rTags（自定义标签对；0720 硬化后内置 think/thinking 恒剥离恒显示不再可配）→ saveReasoningTags()
 *   → sendAction functions:hide#setReasoningTags（后端写单点 stripThinking.mjs:112，写后清 _userTagsCache 立即生效）
 *   → 派生标签名写 localStorage BEILU_THINKING_TAGS（displayRegex.getThinkingTagList 前端折叠消费，逗号分隔）
 *   → reloadBeautify(30) 刷新规则缓存+重渲染最近消息（新标签立刻应用到已上屏消息）
 *
 * why：历史上 extendMenuW28「显示设置」与 tokenProgressBar「Token 设置」各带一份同款保存逻辑
 *   （后端调用/名字派生/本地镜像/重渲染四步逐行复制，改一处漏一处）——先收写路到本函数；
 *   0714 凛倾拍板入口收口：思维链设定唯一 UI 入口=设置→AI服务源「思维链显示」（settingsSlots.initApiSlot 装配），
 *   extendMenuW28 思维链段/smart 折叠开关/airp 隐藏开关已删。
 *
 * 关联链：被 settingsSlots.mjs（唯一编辑入口）/ tokenProgressBar.mjs（仅开机镜像 mirrorReasoningTagsFromConfig）import；
 *   → sendAction.mjs（functions:hide#setReasoningTags）
 *   → storage.mjs（KEYS.BEILU_THINKING_TAGS 本地镜像，后端为权威源）
 *   → virtualQueue.mjs reloadBeautify（动态 import 防环）
 *
 * 使用效果：设置面板保存思维链标签 → 后端剥离与前端折叠口径同步更新，已显示消息即时重渲染
 */
import { sendAction } from "../transport/sendAction.mjs";
import { storage, KEYS } from "./storage.mjs";

/**
 * 保存思维链标签（后端权威写 + 本地折叠镜像 + 即时重渲染）。
 * [0720 硬化] builtinCfg 参数已删：内置 think/thinking 恒剥离恒显示（凛倾硬性核心）,只存自定义标签对。
 * @param {{open:string,close:string}[]} rTags 自定义标签对
 * @param {{hadPrevTags?:boolean}} [opts] 之前是否已有自定义标签（清空也要落盘，否则删了又复活）
 */
/**
 * 开机镜像回填：后端 reasoning 配置（权威单源 _config.json）→ localStorage 折叠标签。
 * why：只在保存时桥接写的话，新浏览器/清缓存后前端折叠与后端剥离口径脱节
 *   （自定义标签在新端不折叠但后端照剥="用户看不见 AI 也看不见"的消失段）。
 *   与保存路 saveReasoningTags / YonBan ChatService.getThinkingTags 同口径。
 * @param {object} cfg beilu-memory getData 返回的 config（调用方已持有，不重复拉取）
 */
export function mirrorReasoningTagsFromConfig(cfg) {
  try {
    const c = cfg || {};
    // [0720 硬化] 内置 thinking/think 恒在折叠识别集（凛倾硬性核心：AI 禁见+人类恒可见）,
    //   不再读 reasoning_builtin（已废,后端写侧清存量键）；无 custom 也写盘=修正存量脏镜像。
    //   标签名过滤放宽（原 /^[\w-]+$/ 把中文等非 ASCII 标签静默丢弃=「加了没效」断点之一）,
    //   消费端 getThinkingTagList 构造正则时统一 escape。
    const names = (c.reasoning_tags || [])
      .map((t) => (t?.open || "").replace(/[<>/\s]/g, ""))
      .filter((n) => n.length > 0);
    // [2026-08-10] 内置 beilu_thinking 恒在折叠识别集（折叠恒生效，与「对 AI 隐藏」开关无关）。
    storage.set(KEYS.BEILU_THINKING_TAGS, [...new Set(["thinking", "think", "beilu_thinking", ...names])].join(","));
    // [2026-08-10] 开机镜像回填「对 AI 隐藏」开关状态（权威源=后端 _config.json beilu_thinking_strip）→
    //   前端镜像 BEILU_THINKING_STRIP，供折叠块 badge 诚实性渲染读取。缺省（无键）=剥离="1"。
    storage.set(KEYS.BEILU_THINKING_STRIP, c.beilu_thinking_strip === false ? "0" : "1");
  } catch { /* 同步失败保持本地值，折叠仍可用默认标签 */ }
}

export async function saveReasoningTags(rTags, { hadPrevTags = false } = {}) {
  // [0720 硬化] reasoning_builtin 不再发送（已废,内置恒剥离恒显示——凛倾硬性核心）；
  //   自定义标签名过滤放宽为非空（原 /^[\w-]+$/ 丢中文标签=「加了没效」断点之一）,
  //   与 mirrorReasoningTagsFromConfig 同口径,消费端 getThinkingTagList 构造正则统一 escape。
  await sendAction({
    verb: "setReasoningTags", target: "functions:hide", source: "web",
    payload: {
      ...((rTags.length > 0 || hadPrevTags) ? { reasoning_tags: rTags } : {}),
    },
  });
  const names = rTags.map((t) => (t.open || "").replace(/[<>/\s]/g, "")).filter((n) => n.length > 0);
  storage.set(KEYS.BEILU_THINKING_TAGS, [...new Set(["thinking", "think", "beilu_thinking", ...names])].join(","));
  import("../render/virtualQueue.mjs")
    .then((m) => m.reloadBeautify?.(30))
    .catch((err) => console.warn("[reasoningTags] reloadBeautify 失败:", err));
}

/**
 * [2026-08-10] 保存内置 beilu_thinking「对 AI 隐藏」开关（独立写路，与 saveReasoningTags 互不清对方字段）。
 * 走同一后端写单点 functions:hide#setReasoningTags，payload【只带 beilu_thinking_strip】——后端 setReasoningTags
 *   按 patch 语义只写此字段，不动盘上 reasoning_tags（防「只改开关把自定义标签冲掉」）。
 * 同步写前端镜像 BEILU_THINKING_STRIP（badge 诚实性渲染读取）。change 即调，无需重渲染（折叠恒生效不受开关影响，
 *   badge 文案在下一次消息渲染时按新镜像生效；已上屏消息可选重渲染，此处从简不强制）。
 * @param {boolean} strip true=开（剥离，AI 看不到）；false=关（不剥离，AI 与你都看得到）
 */
export async function saveBeiluThinkingStrip(strip) {
  await sendAction({
    verb: "setReasoningTags", target: "functions:hide", source: "web",
    payload: { beilu_thinking_strip: !!strip },
  });
  storage.set(KEYS.BEILU_THINKING_STRIP, strip ? "1" : "0");
  import("../render/virtualQueue.mjs")
    .then((m) => m.reloadBeautify?.(30))
    .catch((err) => console.warn("[reasoningTags] reloadBeautify 失败:", err));
}
