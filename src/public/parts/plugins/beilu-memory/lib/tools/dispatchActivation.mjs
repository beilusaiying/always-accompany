/**
 * dispatchActivation.mjs — 统一激活分发入口（v3 §9 #1）。
 *
 * 【功能链】
 *   把"触发来源（定时/事件/立即）→ 动作类型（inject/auto_reply/wake/message/table_update）
 *   → 目标（chatid/角色名）"三正交旋钮收口到单一函数 dispatchActivation(intent)。
 *   - inject / table_update：由既有 GetPrompt / 表格路径处理，本模块直接返回 dispatched:false 不重复触发。
 *   - auto_reply / wake：动态 import beilu-chat generation.mjs → triggerCharReply()，
 *     后台非阻塞触发（不 await）、自去重、自 loadChat。
 *     区别：auto_reply 目标默认=创建该 intent 的当前会话；wake 由调用方显式给 target.chatid（唤醒其他窗口）。
 *   - message：先往目标会话插入用户位消息（addUserReply），再触发其生成一轮（适用于跨窗口传话）。
 *
 * 【why】
 *   scheduler（定时）、replyHandler 标签（AI 主动）、setDataActions（用户 UI）、
 *   gameCompanion（感知反馈）等多个 producer 都需要触发 AI 生成，
 *   如果各自直接 import generation.mjs 会产生循环依赖（generation → replyHandler → aiRunner → generation）。
 *   dispatchActivation 通过动态 import（运行时懒加载）打断静态循环依赖，
 *   同时作为策略无关的纯分发层，producer 侧不需要关心底层怎么触发。
 *
 * 【前端调用方式】
 *   前端不直接调用本模块（纯后端分发层）。
 *   被调链路：
 *     scheduler._tick() → dispatchActivation({ source:"user_schedule", action:{type:"auto_reply",...} })
 *     replyHandler <scheduleWakeup> → dispatchActivation({ source:"ai", action:{type:"wake",...} })
 *     replyHandler <sendToWindow> → dispatchActivation({ source:"ai", action:{type:"message",...} })
 *     setDataActions("triggerReply") → dispatchActivation({ source:"user_ui", action:{type:"auto_reply",...} })
 *   前端感知：触发的 AI 生成走正常对话流水线，前端通过正常消息事件/WS 感知结果，无专属广播。
 *
 * 【关联链】
 *   ← scheduler.mjs（到期任务触发 auto_reply/wake/inject）
 *   ← replyHandler.mjs（<scheduleWakeup> / <wakeWindow> / <sendToWindow> 标签处理）
 *   ← setDataActions.mjs（用户手动触发 auto_reply）
 *   → generation.mjs（动态 import triggerCharReply — 运行时懒加载防静态循环依赖）
 *   → chatOps.mjs（动态 import addUserReply — message 类型跨窗口传话）
 *
 * 【影响范围】
 *   - 不写磁盘，不写内存状态（纯分发，无自身状态）
 *   - 副作用完全由下游 triggerCharReply / addUserReply 产生（AI 生成、消息落盘、WS 广播等）
 *   - 动态 import 缓存（_triggerCharReply）：首次调用后复用，无需重复动态 import
 *
 * 【使用效果】
 *   所有后台触发（定时、AI 自主、用户按钮）都经过单一分发点，
 *   producer 侧只需构造 intent 对象描述意图，不需关心底层触发机制，
 *   循环依赖由动态 import 解决，策略由 producer 侧完全自定义（UI 动作选择器 / 提示词标签）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

let _triggerCharReply = null;

async function _resolveTrigger() {
  if (_triggerCharReply) return _triggerCharReply;
  // beilu-memory/lib → beilu-chat/src/lib/generation.mjs（跨 part 动态 import，避免静态循环依赖）
  const genPath = path.join(
    import.meta.dirname,
    "../../../shells/beilu-chat/src/lib/generation.mjs",
  );
  const mod = await import(pathToFileURL(genPath).href);
  _triggerCharReply = mod.triggerCharReply || null;
  return _triggerCharReply;
}

/**
 * 统一激活分发。
 * @param {object} intent
 * @param {string} [intent.source]   - "user_schedule" | "ai" | "user_ui" | "event"
 * @param {object} intent.action     - { type:"inject"|"auto_reply"|"wake"|"table_update", target?:{chatid?,charname?} }
 * @param {string} [intent.chatid]   - 默认目标 chatid（action.target.chatid 优先）
 * @param {string} [intent.charname]
 * @returns {Promise<{dispatched:boolean, targetChatId?:string, reason?:string}>}
 */
export async function dispatchActivation(intent) {
  const action = intent?.action || {};
  const type = action.type || "inject";

  // 非生成型动作：注入/表格由既有路径处理，激活入口不重复触发
  if (type === "inject" || type === "table_update") {
    return { dispatched: false, reason: `non-generative action: ${type}` };
  }

  // message：跨窗口传话——目标会话插入用户位消息（addUserReply 正门，自带广播/timeSlice），再触发其生成一轮。
  // 与 wake 的区别：wake 只触发生成不带内容；message 先落消息再生成（与 POST /message autoReply 同序）。
  if (type === "message") {
    const targetChatId = action.target?.chatid || intent.chatid || null;
    if (!targetChatId) return { dispatched: false, reason: "no target chatid" };
    const content = action.content || "";
    if (!content) return { dispatched: false, reason: "empty content" };
    try {
      const opsPath = path.join(
        import.meta.dirname,
        "../../../shells/beilu-chat/src/lib/chatOps.mjs",
      );
      const { addUserReply } = await import(pathToFileURL(opsPath).href);
      await addUserReply(targetChatId, { content, files: [] });
      const trigger = await _resolveTrigger();
      if (typeof trigger === "function")
        trigger(targetChatId, action.target?.charname, { userInitiated: true }).catch(() => {});
      return { dispatched: true, targetChatId };
    } catch (e) {
      return { dispatched: false, reason: e?.message || String(e) };
    }
  }

  if (type === "auto_reply" || type === "wake") {
    const targetChatId = action.target?.chatid || intent.chatid || null;
    if (!targetChatId) return { dispatched: false, reason: "no target chatid" };
    const charname = action.target?.charname || intent.charname || undefined;
    try {
      const trigger = await _resolveTrigger();
      if (typeof trigger !== "function") {
        return { dispatched: false, reason: "triggerCharReply unavailable" };
      }
      // 非阻塞：triggerCharReply 内部自去重 + 自 loadChat + 后台跑
      trigger(targetChatId, charname).catch(() => {});
      return { dispatched: true, targetChatId };
    } catch (e) {
      return { dispatched: false, reason: e?.message || String(e) };
    }
  }

  return { dispatched: false, reason: `unknown action type: ${type}` };
}
