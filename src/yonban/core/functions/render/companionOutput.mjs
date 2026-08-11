/**
 * 陪伴可见输出单源：主生成流 → 去思维链/操作标签 → Web 陪伴与桌宠共同消费。
 * 这里只投影显示，不写 chat；最终权威仍是主对话 message_replaced + chats/{chatid}.json。
 */
import { stripReasoningTags } from "../hide/stripThinking.mjs";

const _bindings = new Map(); // username → {chatid,charName,petTags}
const _states = new Map();   // username → latest payload
const _seq = new Map();

// 陪伴气泡不承载工具卡/控制卡，所有带内容的操作标签连同 body 隐藏。
// 本清单是“陪伴纯正文投影”语义，不改变主聊天可折叠思维链/工具卡的显示契约。
const HIDDEN_BLOCK_TAGS = [
  "tableEdit", "taskPlan", "taskCheck", "memoryArchive", "memorySearch", "needWebSearch",
  "memoryNote", "codeMemoryWrite", "workMemoryWrite", "modeSwitch", "subModeSwitch", "ideToolCall",
  "ppt_op", "scheduleTask", "delegate", "parallelDelegate", "report", "approval", "createFlowGroup",
  "contextClean", "captureControl", "browserAction", "mcpConnect", "progress", "needHelp", "file_op",
  "search", "bot_reply", "toggle", "orbMessage", "emotion", "motion", "completionVerify", "sendToWindow",
  "fileDelivery", "presetSwitch", "chatRename", "wakeWindow", "scheduleWakeup",
];

function _escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// [2026-08-10] 陪伴/桌宠投影是无折叠 UI 的纯文本面：beilu_thinking 恒剥离（不受「对 AI 隐藏」开关影响）。
//   开关=关时 getReasoningTags 不再 push beilu_thinking（AI 上下文链保留供 AI 看），但此投影面若原样透出思维链
//   会污染纯正文气泡——故用 stripReasoningTags 的 extraTags 参数在本调用点无条件追加剥离，与 bot 出站同策略。
const _COMPANION_STRIP_EXTRA = [{ open: "<beilu_thinking>", close: "</beilu_thinking>" }];

export function projectCompanionVisibleText(rawText, username, petTags = []) {
  let text = stripReasoningTags(String(rawText || ""), username, _COMPANION_STRIP_EXTRA);
  const names = [...new Set([...HIDDEN_BLOCK_TAGS, ...petTags].filter((x) => typeof x === "string" && /^[\w\u4e00-\u9fff-]+$/.test(x)))];
  for (const name of names) {
    const n = _escape(name);
    text = text
      .replace(new RegExp(`<${n}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${n}>`, "gi"), "")
      .replace(new RegExp(`<${n}(?:\\s[^>]*)?\\s*\\/>`, "gi"), "")
      // 流中标签尚未闭合时，从开标签到当前末尾都不可见。
      .replace(new RegExp(`<${n}(?:\\s[^>]*)?>[\\s\\S]*$`, "gi"), "");
  }
  text = text
    .replace(/<mcp-[\w-]+\b[^>]*>[\s\S]*?<\/mcp-[\w-]+>/gi, "")
    .replace(/<mcp-[\w-]+\b[^>]*\/?\s*>[\s\S]*$/gi, "")
    .replace(/<分身\d+[^>]*>[\s\S]*?<\/分身\d+>/gi, "")
    .replace(/<stopContinue\s*\/?>/gi, "")
    // 未知展示标签只剥标签壳，保留普通正文，避免把合法 XML/HTML 整段吞掉。
    .replace(/<\/?[A-Za-z_][\w:-]*(?:\s[^>]*)?>/g, "")
    // 流式 token 可能暂时只有“<thi”或“<ideTool”；任何未闭合标签壳都先暂缓显示，
    // 等后续 token 能判定为正文/完整标签后再投影，避免隐藏内容前缀闪现一帧。
    .replace(/<[^>]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function bindCompanionOutput(username, chatid, charName = "", petTags = []) {
  if (!username || !chatid) return;
  _bindings.set(username, { chatid, charName, petTags: Array.isArray(petTags) ? petTags : [] });
  _states.delete(username);
}

export function unbindCompanionOutput(username, chatid = "") {
  const cur = _bindings.get(username);
  if (!cur || (chatid && cur.chatid !== chatid)) return;
  _bindings.delete(username);
  _states.delete(username);
}

/** 发布完整快照；返回非 null 表示该 chat 是当前陪伴承载对话。 */
export function publishCompanionOutput(username, chatid, { messageId = "", phase = "stream", rawText = "", charName = "" } = {}) {
  const binding = _bindings.get(username);
  if (!binding || binding.chatid !== chatid) return null;
  const text = projectCompanionVisibleText(rawText, username, binding.petTags);
  const prev = _states.get(username);
  if (prev && prev.messageId === messageId && prev.phase === phase && prev.text === text) return null;
  const seq = (_seq.get(username) || 0) + 1;
  _seq.set(username, seq);
  const payload = {
    seq, chatid, messageId, phase, text,
    charName: charName || binding.charName || "",
    timestamp: Date.now(),
  };
  _states.set(username, payload);
  return payload;
}

export function getCompanionOutputSince(username, since = 0) {
  const state = _states.get(username);
  return state && state.seq > Number(since || 0) ? { ...state } : null;
}
