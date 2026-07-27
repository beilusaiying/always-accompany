/**
 * beilu-chat 生成层 — 管「触发→流式生成→落盘→自动续轮」全周期。不管提示词组装（那是 beilu-preset 的事）、
 * 不管工具执行（那是 ideClient/ToolExecutor 的事）、不管消息 CRUD（那是 chatOps 的事）。
 *
 * 链路：endpoints POST /message → triggerCharReply → executeGeneration → GetReply(插件链) → finalizeEntry → 自动续轮决策
 * 影响：写 chatLog（经 chatOps.addChatLogEntry）/ 广播 stream_start·stream_update·message_replaced·token_usage·auto_continue_fuse /
 *       设 _autoContinueTimers 定时器 / 更新 generationStats / 触发 runCodeRoundTriggers
 * 相交：← endpoints.mjs·chatOps.mjs（调用方）  → requestBuilder.getChatRequest·broadcast.StreamManager·chatOps.addChatLogEntry·
 *         ideClient.consumePendingResults·messageBuilder.BuildChatLogEntryFromCharReply
 */

import { getPartDetails } from "../../../../../../server/parts_loader.mjs";
import { config } from "../../../../../../server/server.mjs";

import {
  broadcastChatEvent,
  broadcastUserActiveChat,
  setOnStopGeneration,
  StreamManager,
  updateTypingStatus,
} from "./broadcast.mjs";
import { addChatLogEntry, addUserReply, deleteMessage, hideMessages, trimEntryFiles } from "./chatOps.mjs";
import { findLastActive, findLastActiveIndex } from "../../../../../../yonban/core/functions/hide/chatEntryUtils.mjs"; // T8·回切：改指 yonban 新位实现体
import { getYonbanConfigPath, loadJsonFileIfExists } from "../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"; // T048：group_worker per-user 持久化开关
import { chatMetadatas, loadChat, saveChat } from "./chatStorage.mjs"; // chatMetadatas: [0724 只许前端关] loop 延迟注入 fire 时的会话在载守卫
import { ideClient, formatToolResultsForInjection } from "../../../../../../yonban/core/transport/ideClient.mjs"; // T066：ideClient 迁 transport，改指 yonban 新位实现体（同 line 23/27 回切范式）
import { runCodeRoundTriggers } from "../../../../../../yonban/core/functions/notification/scheduler.mjs"; // T8·回切：改指 yonban 新位实现体
import {
  BuildChatLogEntryFromCharReply,
  classifyApiError,
} from "./messageBuilder.mjs";
import { chatLogEntry_t } from "./models.mjs";
import { getChatRequest } from "./requestBuilder.mjs";
import { stripReasoningTags } from "../../../../../../yonban/core/functions/api/proxy/lib/messageTransform.mjs"; // T8·回切：改指 yonban 新位实现体（原经 public 薄壳 re-export，已删壳）
import { broadcastBotError } from "../../../botErrorBroadcast.mjs";
import { wbTrace, wbSpan, wbDetect, runWithAmbientChatId } from "../../../../../../server/whitebox.mjs";

// [0723 slash_command 补线·凛倾拍板] ST 正则 placement=slash_command 的唯一消费收口：
//   语义=「AI 发指令→系统回执→写对话尾部」，beilu 对应物=IDE 工具结果注入文本
//   （formatToolResultsForInjection 产出，本文件 3 写点全部经此 helper，禁再散拼调用）。
//   规则源取法=aiRunner.mjs:1245 轻量范式（动态 import + getRegexStore(username) + 空 options）；
//   正则模块不可用/规则空 → 原文注入（诚实降级，仅用户自建 slash_command 规则不生效）。
//   此前状态：前端可勾选存库但后端从未消费（死码溯源判「没做」，报告见工作日志 0723 文件夹）。
async function _applySlashCommandRegex(text, username) {
  try {
    const { applyRegexRules, getRegexStore } = await import("../../../../../../yonban/core/functions/regex/main.mjs");
    const _rx = getRegexStore(username);
    if (_rx?.enabled && _rx.rules?.length) return await applyRegexRules(text, _rx.rules, "slash_command", {});
  } catch { /* 正则模块不可用→原文注入 */ }
  return text;
}

// 生成流统计（前端侧，供 backendMonitor 面板读取）
export const generationStats = {
  total: 0, success: 0, error: 0, aborted: 0, emptyRetries: 0,
  activeCount: 0, avgDurationMs: 0, _totalDurationMs: 0,
};

// ============================================================
// W66: 自动继续定时器管理 — 按 chatid 跟踪，支持取消
// ============================================================
const _autoContinueTimers = new Map();
const _autoContinueCounters = new Map();
// P0-3：fuzzy_edit 连续失败熔断 —— AI 用错误 old_string 反复重试 fuzzy_edit 会无限续轮，
//   浪费整轮对话。连续 N 次 fuzzy 匹配失败且无任何写入进展即提前停，提示改用 read_file 重读后再编辑。
//   计数器自愈：任一非 fuzzy-失败的回合归零，无需在各终止点散落 delete。
const _fuzzyFailCounters = new Map();
const FUZZY_FAIL_LIMIT = 3;
const EMPTY_REPLY_MAX_RETRIES = 3;
const EMPTY_REPLY_BASE_DELAY_MS = 3000;
// [0724 只许前端关·002拍板] 错误轮/空响应轮/中止轮不再终结 loop 自动化（自动化唯一关闭出口=前端
//   开关+二次确认）。原"错误轮杀 loop 防 API 空烧"改为节流不改为终止：这些轮的 loop 续轮延迟
//   垫此下限，API 持续故障时最快也只按此周期重试，不快转空烧。
const ERROR_LOOP_MIN_DELAY_MS = 10000;

/** 取消指定 chatid 的自动继续定时器 */
export function cancelAutoContinue(chatid) {
  const timerId = _autoContinueTimers.get(chatid);
  if (timerId) {
    clearTimeout(timerId);
    _autoContinueTimers.delete(chatid);
    console.log(`[chat] ★ 自动继续已取消 (chatid=${chatid})`);
  }
}

export function resetAutoContinueCounter(chatid) {
  _autoContinueCounters.delete(chatid);
  _fuzzyFailCounters.delete(chatid);
}

/** [0724 只许前端关] 探测 chatid 是否有 pending 自动续轮 timer。
 *  消费方：fileEditRegistry.onWriteStart——写前打断补偿判据（延迟窗内被清 timer 的窗口
 *  aborted=0，原判据漏出唤醒名单=自动化被无补偿静默杀死）。 */
export function hasAutoContinueTimer(chatid) {
  return _autoContinueTimers.has(chatid);
}

/**
 * 安排一次自动续轮（续轮定时器单一收口，[0717 时序修]）。
 *
 * 为什么收口：此前"安排续轮"散在 4 处——回合末三池（ideToolCall/file_op/web_search）各自
 *   cancel+setTimeout+登记，而审批完成续轮（setDataActions._triggerContinueAfterUserAction）
 *   只裸 setTimeout：无句柄不可取消、不登记 _autoContinueTimers → 与回合末 timer 不互斥
 *   （双 timer 可各 fire 一轮，第二轮空转）、用户发消息 cancelAutoContinue 也取消不到它、
 *   _releaseGenerationLock:650 的互斥判断看不见它。收口后四处同门：可取消 + 互斥 + 单 timer。
 *
 * 链路：executeGeneration 回合末三池 / setDataActions 审批完成 → 本函数 → setTimeout → triggerCharReply
 * 影响：cancelAutoContinue 旧 timer / _autoContinueTimers 登记新 timer
 *
 * @param {string} chatid - 会话 ID
 * @param {string} [charname] - 角色目录名（省略则 triggerCharReply 取 LastTimeSlice 第一个角色）
 * @param {number} [delayMs=0] - 延迟毫秒（来源 getAutoContinueConfig(username).delay_ms）
 * @param {string} [source="round_end"] - 触发源标识（仅日志/诊断用）
 */
export function scheduleAutoContinue(chatid, charname, delayMs = 0, source = "round_end") {
  cancelAutoContinue(chatid);
  const timerId = setTimeout(() => {
    _autoContinueTimers.delete(chatid);
    triggerCharReply(chatid, charname).catch(e =>
      console.warn(`[chat] ★ 自动继续触发失败 (${source}):`, e.message)
    );
  }, delayMs);
  _autoContinueTimers.set(chatid, timerId);
}

/**
 * 会话删除清理：清本会话残留的 per-chatid 续轮/计数/排队态（同 #85 泄漏类批，deleteChat 反向桥调用）。
 * 防 ①单调泄漏（异常路径未清计数器 + deleteChat 原不通知 generation）②已删会话上 timer fire 触发 triggerCharReply。
 * _genPromises/_generatingChats 由在飞 executeGeneration 的 finally 按 promise 身份自清，不在此动（避免干扰其身份判定）。
 *
 * 链路：chatStorage.deleteChat → 本函数
 * 影响：abortAll 在飞流 / clearTimeout 续轮定时器 / 清 _autoContinueCounters·_fuzzyFailCounters·_pendingUserInput
 *
 * @param {string} chatid - 要清理的会话 ID
 */
export function forgetChatGenState(chatid) {
  if (!chatid) return;
  // 删会话先停在飞流：唯一调用方 deleteChat 原只清续轮态、不 abort 活跃 stream，
  //   导致删 chat 时正在生成的那轮跑完撞已删 chatMetadata（saveChat no-op）+ 继续烧 API 配额。
  //   对齐既有约定：ws close(broadcast.mjs ws.on("close")) 与 deleteMessage/Range 都 abort。
  StreamManager.abortAll(chatid);
  cancelAutoContinue(chatid);        // clearTimeout + _autoContinueTimers.delete
  resetAutoContinueCounter(chatid);  // _autoContinueCounters + _fuzzyFailCounters
  _pendingUserInput.delete(chatid);
  _loopStopSignals.delete(chatid);   // [0724 双停退出] 删会话清连续停止计数
  _pendingAsyncWake.delete(chatid);  // [0726 分身异步] 删会话清排队中的分身完成补唤醒
}

// 注册停止回调——现仅 broadcast ws.on("close") 全断 5s 卸载路径调用：卸载后 chatMetadata 置 null，
//   残留 timer fire → triggerCharReply = 孤儿生成、工具结果不落盘（#79），必须取消。
// [0724 只许前端关] stop_generation（用户点停止键）已不再走此回调——停止只停在飞流，
//   不掐自动继续/Loop 自动化链（自动化唯一关闭出口=前端开关+二次确认）。
setOnStopGeneration(cancelAutoContinue);

// ============================================================
// executeGeneration — 流式生成核心
// ============================================================

// 多组并行 v4：gated 把「跑 GetReply」路由到 chat 所属组的常驻 worker（落法B 真并行）。
// ★ 默认字节不变：仅当该 user 持久化开关 group_worker_enabled===true 且该 chat 已绑组才路由；否则原地 GetReply。
//   动态 import → 默认路径不引入任何新静态依赖。任何异常都回退本地 GetReply（不阻断生成）。
//   worker 内工具调用的 pendingResults 由 runner consumePendingResults(chatid) 回传主进程（L89-93），
//   auto-continue 续轮注入对 grouped chat 已生效（v4 §3.3 跨界队列已实现）。
// 「操作后自动继续」用户配置单源（yonban_config.auto_continue ← 面板"自动触发AI继续"开关+延迟(秒)）。
// 半接线修复（2026-07-14）：该面板开关/延迟原只写 localStorage、全仓零业务消费者（前端触发方案
// 后端化为本文件回合末续轮时未跟迁）——现收口为后端单源：回合末续轮（ideToolCall/file_op 两处）
// 与审批完成续轮（setDataActions._broadcastToolResultsReady）同门控同延迟。写口=SetData
// "setAutoContinueConfig"（idePanel change 同步）。缺省 enabled=true/delay=0（未设置时行为与旧版全同）。
export function getAutoContinueConfig(username) {
  let _ac = {};
  try { _ac = loadJsonFileIfExists(getYonbanConfigPath(username), {}).auto_continue || {}; } catch { /* 读失败→默认 */ }
  return {
    enabled: _ac.enabled !== false,
    delay_ms: Math.max(0, Math.min(30000, Number(_ac.delay_ms) || 0)),
    loop_enabled: !!_ac.loop_enabled,
    loop_inject_text: typeof _ac.loop_inject_text === "string" ? _ac.loop_inject_text : "",
    // [0724 双停退出] AI 连续 N 轮都发 <stopContinue/> → 系统停 loop（002 拍板：单发只结束任务轮
    //   loop 照续；连续 N 发=AI 真没事做了）。0=禁用双停退出（loop 只有用户关开关才停）。默认 2=002 原话「连续输出两次停止」。
    loop_stop_threshold: Number.isInteger(_ac.loop_stop_threshold) && _ac.loop_stop_threshold >= 0 ? _ac.loop_stop_threshold : 2,
    // [0726 容错修·002「工具的容错…现在开始修」] 连续自动续轮轮数上限熔断——:711 注释承诺的"MAX 熔断"
    //   此前是腐烂注释（计数只递增从不比较，无限续轮无任何闸）。默认 50（正常施工 1 小时约 15-21 轮，
    //   50=数倍余量），0=禁用。达到→停续轮+banner 外显，用户消息（resetAutoContinueCounter）清零重新计。
    max_auto_rounds: Number.isInteger(Number(_ac.max_auto_rounds)) && Number(_ac.max_auto_rounds) >= 0 ? Math.min(999, Number(_ac.max_auto_rounds)) : 50,
  };
}

// [0726 分身异步·002] clone_async 用户配置单源读口（yonban_config.clone_async ← SetData "setCloneAsyncConfig"）。
//   enabled 默认 false（不改变既有同步行为，前端开关显式开启才异步）；wake_delay_ms=分身完成→唤醒主 AI 的延迟。
//   消费端：replyHandler 分身执行块只读 enabled 判分支（同文件同键，无口径复制）；本文件读 wake_delay_ms。
export function getCloneAsyncConfig(username) {
  let _ca = {};
  try { _ca = loadJsonFileIfExists(getYonbanConfigPath(username), {}).clone_async || {}; } catch { /* 读失败→默认 */ }
  return {
    enabled: _ca.enabled === true,
    wake_delay_ms: Math.max(0, Math.min(30000, Number(_ca.wake_delay_ms) || 0)),
  };
}

// [0726 分身异步·002] 异步分身完成 → 唤醒主 AI 的唯一入口（replyHandler 分身完成回调经跨 part 动态 import 调用）。
//   三态：①本会话生成中 → 排队 _pendingAsyncWake，_releaseGenerationLock 补唤醒（防 triggerCharReply 非
//   userInitiated 静默丢弃）②空闲且自动继续总开关开 → scheduleAutoContinue 收口（可取消/互斥/单 timer，
//   唤醒轮的 triggerCharReply 前置落地段会把池中 _clone_results 注入 prompt）③总开关关 → 尊重用户配置不唤醒，
//   结果留池等下一次生成回合。提醒文本不在此注入——聚合文本头部已带 injectTexts "clone.async_done_reminder"。
export function notifyAsyncCloneDone(chatid, charname, username) {
  if (!chatid) return;
  if (_generatingChats.has(chatid)) {
    _pendingAsyncWake.set(chatid, username);
    console.log(`[chat] ★ 分身异步完成: chatid=${chatid} 正在生成中，排队待本轮结束补唤醒`);
    return;
  }
  if (_autoContinueTimers.has(chatid)) {
    console.log(`[chat] ★ 分身异步完成: chatid=${chatid} 已有续轮 timer 在途，结果由该轮前置落地接住，不双触发`);
    return;
  }
  const _ac = getAutoContinueConfig(username);
  if (!_ac.enabled) {
    console.log(`[chat] ★ 分身异步完成: 自动继续总开关关闭，结果已入池等待下次生成（chatid=${chatid}）`);
    return;
  }
  scheduleAutoContinue(chatid, charname, getCloneAsyncConfig(username).wake_delay_ms, "clone_async_done");
}

// [0724 双停退出] per-chat 连续 stopContinue 计数：AI 在 loop 中每发一次 <stopContinue/> 计 1，
//   任何不带停止符的回复轮清零（说明 AI 又在干活）。达到 loop_stop_threshold → 停 loop。
//   用户新消息走 triggerCharReply 用户路径不经此计数（loop 重新从 0 算）。
const _loopStopSignals = new Map(); // chatid → 连续 stopContinue 次数

// B4 inline工具卡：把 pendingResults 压成结构化事件进 extension（卡头=工具+对象+状态）。
// 只进 extension 不进 content——对 AI 注入文本（formatToolResultsForInjection）零影响（G8 对用户折叠展示用）。
// 模块级共用：executeGeneration 回合末注入 + triggerCharReply 前置落地（审批续轮）两处同源。
const _buildIdeToolEvents = (prs) => (prs || []).map((r) => {
  const _p = r?.params || {};
  const _subject = _p.path || _p.command || _p.query || _p.pattern || "";
  return { tool: r?.tool || "?", subject: String(_subject).slice(0, 120), ok: r?.result?.success !== false };
});

/**
 * [0717 时序断链修] 工具产物图统一在回合末落 user 条（system 工具结果条之后、续轮之前）。
 * 为什么不能在 ReplyHandler 里直落：ReplyHandler 跑在 GetReply 内部，char 条落盘在其后——
 * 回合内 addUserReply 会把 timeLines 覆盖成 user 轮=时间线顺序颠倒+分叉
 * （gameCompanion 截图轮安全因其在回合外触发）。此处 char/system 条均已定稿，
 * user 图条成为续轮前最后一条 user 消息 → imageInjection pickLastUserImages 天然拾取。
 * 生产方契约：pendingResults 条目可带 userImage {content, files, marker, keepN}
 * （现有生产者：beilu-ppt fetch_image）。失败不阻断回合。
 */
async function _flushPendingUserImages(chatid, pendingResults) {
  for (const r of (pendingResults || [])) {
    const ui = r && r.userImage;
    if (!ui || !Array.isArray(ui.files) || !ui.files.length) continue;
    try {
      // 通讯形变兜底: worker 路由下条目经 postMessage 结构化克隆, Buffer 会变 Uint8Array——
      // 统一 Buffer.from 收口（主进程直产的 Buffer 原样通过, 零成本）
      const { Buffer: _Buf } = await import("node:buffer");
      const _files = ui.files.map((f) => ({ ...f, buffer: _Buf.from(f.buffer) }));
      await addUserReply(chatid, {
        content: ui.content || "",
        files: _files,
        extension: ui.marker ? { [ui.marker]: true } : {},
      });
      if (ui.marker && Number.isFinite(ui.keepN) && ui.keepN > 0)
        await trimEntryFiles(chatid, { keep: ui.keepN, marker: ui.marker });
    } catch (e) {
      console.warn(`[chat] 工具候选图落链失败(不阻断): ${e?.message}`);
    }
  }
}

// [0724 loop断链修] 用户级 Loop 注入+续轮。
// why: 原 loop 只挂在"无工具结果"分支，AI 输出 <stopContinue/> 即整链停——停止符语义=AI 结束当前任务轮，
//   不该终结用户配置的 loop 自动化（002 0723:「ai输出停止符号,也不会发送loop信息,链路断链」）。
// [0724 只许前端关·延迟注入重构] 原"立即落注入条→等 delay→触发"改为"timer 到点才落条+触发"
//   （scheduleLoopContinue）。why：①立即落条时，延迟窗内用户发言/停止/关开关会把已落盘的注入条
//   变成孤儿躺在上下文；②异常路径（错误轮/中止轮/regen 打断）若立即落条会污染正在重生成的对话；
//   ③到点重查三闸（会话在载/无在飞生成/开关仍开）= regen 天然去重 + 前端关闭在延迟窗内立即生效
//   + 会话删除/卸载后残留 timer 不产孤儿生成。调用点：stopContinue 分支/错误轮/空响应/中止轮/
//   无工具结果分支/executeGeneration catch 异常路径。
const _loopActive = (cfg) => cfg.enabled && cfg.loop_enabled && !!cfg.loop_inject_text;

async function _injectLoopEntry(chatid, chatMetadata, loopCfg) {
  const _loopCount = (_autoContinueCounters.get(chatid) || 0) + 1;
  _autoContinueCounters.set(chatid, _loopCount);
  const _loopEntry = new chatLogEntry_t();
  _loopEntry.role = "system";
  _loopEntry.name = "自动继续";
  _loopEntry.content = loopCfg.loop_inject_text;
  if (!_loopEntry.extension) _loopEntry.extension = {};
  _loopEntry.extension._opType = "loop_inject";
  _loopEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
  _loopEntry.time_stamp = new Date();
  _loopEntry.is_generating = false;
  await addChatLogEntry(chatid, _loopEntry);
  wbTrace(chatid, "generation", "autocontinue:loop", { count: _loopCount, textLen: loopCfg.loop_inject_text.length });
  console.log(`[chat] ★ 自动继续: Loop 注入 (第${_loopCount}次, ${loopCfg.loop_inject_text.length}字)`);
}

function scheduleLoopContinue(chatid, charId, delayMs) {
  cancelAutoContinue(chatid);
  const timerId = setTimeout(async () => {
    _autoContinueTimers.delete(chatid);
    try {
      // 闸1 会话在载：deleteChat / ws 全断 5s 卸载后 chatMetadata=null → 不续，防孤儿生成(#79)
      const _meta = chatMetadatas.get(chatid)?.chatMetadata;
      if (!_meta) return;
      // 闸2 无在飞：regen/用户消息已接管生成 → 本次让路，其回合末决策自会续 loop
      if (_generatingChats.has(chatid)) return;
      // 闸3 开关仍开：fire 时重读配置，前端关闭（含二次确认关闭）在延迟窗内立即生效
      const _cfg = getAutoContinueConfig(_meta.username);
      if (!_loopActive(_cfg)) return;
      await _injectLoopEntry(chatid, _meta, _cfg);
      await triggerCharReply(chatid, charId);
    } catch (e) {
      console.warn("[chat] ★ Loop 续轮触发失败:", e?.message || e);
    }
  }, delayMs);
  _autoContinueTimers.set(chatid, timerId);
}

async function _getReplyMaybeGrouped(chatid, request, stream) {
  // T048：按当前对话所属 user 读持久化开关（原 process.env 进程全局=不分用户+重启易失）。严格 ===true：缺失/怪值→OFF（默认字节不变）。
  const _gwCfg = loadJsonFileIfExists(getYonbanConfigPath(request.username), {});
  if (_gwCfg.group_worker_enabled === true) {
    try {
      // 一窗一线：env 开启时每条线（绑组=组键 / 未绑组=chatid 键）都路由进自己的 worker isolate。
      // 闸放到 dispatchReplyToGroup（线键恒真恒路由）；不再要求 chat 必须先绑组。
      const { dispatchReplyToGroup } = await import("./groupWorkerManager.mjs");
      const routed = await dispatchReplyToGroup(
        request.username,
        chatid,
        { charname: request.char_id },
        undefined,
        (chunk) => { if (chunk?.preview != null) stream.update({ content: chunk.preview, files: [] }); },
        stream.signal,
      );
      if (routed.routed) {
        // pendingResults 跨界回灌：worker 内工具结果（带 chatid）→ 主进程 ideClient，
        // 让下方 auto-continue（ideClient.pendingResults / consumePendingResults）续轮注入照常工作。
        const _pr = routed.result?.pendingResults;
        if (Array.isArray(_pr) && _pr.length) {
          for (const r of _pr) ideClient.enqueuePendingResult(r); // 经单源入队=受会话感知截断（旧 .pendingResults.push 绕过上限=M-05 无界膨胀）
        }
        return routed.result;
      }
    } catch (e) {
      // ★ 用户中止时不回退本地（否则一停止又重启一轮）；只有真错误才回退本地 GetReply。
      if (stream.signal?.aborted) throw e;
      wbDetect(chatid, "generation", "groupWorker:route:fallback", false, e?.message || String(e), { name: e?.name });
      console.error("[chat] 组 worker 路由失败，回退本地 GetReply:", e?.message);
      // #5：组 worker 降级回退本地生成 → 给用户一个轻量信号（对齐 auto_continue_fuse:384 的 toast 范式）。
      //   此前降级仅 dev 日志/backendMonitor，普通用户在对话 UI 完全无感。广播失败不影响主流程。
      try {
        broadcastChatEvent(chatid, {
          type: "group_worker_degraded",
          payload: { reason: e?.message || String(e), timestamp: new Date().toISOString() },
        });
      } catch { /* 广播失败不影响主流程 */ }
    }
  }
  return request.char.interfaces.chat.GetReply(request);
}

/**
 * 流式生成核心 — 发起 AI 调用、处理流式预览、落盘最终消息、决策自动续轮。
 *
 * 链路：triggerCharReply → 本函数 → _getReplyMaybeGrouped → GetReply(插件链 GetPrompt/TweakPrompt/ReplyHandler)
 *       → BuildChatLogEntryFromCharReply → finalizeEntry（先 saveChat 再广播 message_replaced，RT-4）
 *       → 自动续轮决策（ideToolCall/file_op 有结果则注入 system 条 + setTimeout triggerCharReply）
 * 影响：广播 stream_start/stream_update/emotion_changed/motion_triggered/message_replaced/token_usage/auto_continue_fuse；
 *       saveChat（finalizeEntry 内）；generationStats 更新；_autoContinueCounters/_fuzzyFailCounters 状态变更
 * 约束：调用前 placeholder 必须已 push 进 chatLog 且已广播 message_added（triggerCharReply 负责）；
 *       整段跑在 runWithAmbientChatId ALS 上下文内，插件 wbD/wbT 自动映射到本 chatid 前端面板
 *
 * @param {string} chatid - 会话 ID
 * @param {import('../prompt_struct.mjs').chatReplyRequest_t} request - getChatRequest 构建的请求对象
 * @param {ReturnType<typeof StreamManager.create>} stream - StreamManager.create 返回的流管理器
 * @param {import('./models.mjs').chatLogEntry_t} placeholderEntry - 已广播的占位气泡（is_generating=true）
 * @param {object} chatMetadata - loadChat 返回的会话元数据（含 chatLog/LastTimeSlice/username）
 */
export async function executeGeneration(
  chatid,
  request,
  stream,
  placeholderEntry,
  chatMetadata,
) {
  const entryId = placeholderEntry.id;

  const finalizeEntry = async (finalEntry, isError = false) => {
    stream.done();
    finalEntry.id = entryId;
    finalEntry.is_generating = false;

    // [0717 时序修·worker双写] 落盘前对齐权威态：worker 路由下 GetReply 内插件（contextClean 的
    //   purge/hideMessages，replyHandler.mjs:2951/:2960 等）会在 worker isolate 内直接写盘；本函数
    //   原用 triggerCharReply 开轮时的旧 chatMetadata 引用覆盖写 → worker 刚落盘的隐藏/清理改动被
    //   整体回滚（chatStorage.mjs:363 integrity 冲突"仍保存"即此路径实证）+ .conflict_ 备份堆积。
    //   loadChat 带 mtime 校验：盘新于基线才重载（拿到 worker 版），非 worker 路径 mtime 基线对齐
    //   永不重载=零行为变化。重赋闭包 chatMetadata 使后续 auto-continue 决策段读同一权威对象
    //   （placeholder 从未落盘，重载后 findIndex=-1 走既有 push 分支，语义不变）。
    try {
      const _freshMeta = await loadChat(chatid);
      if (_freshMeta) chatMetadata = _freshMeta;
    } catch { /* loadChat 失败用既有引用（原行为），不阻断落盘 */ }

    let idx = chatMetadata.chatLog.findIndex((e) => e.id === entryId);
    if (idx === -1) {
      chatMetadata.chatLog.push(finalEntry);
      idx = chatMetadata.chatLog.length - 1;
      chatMetadata.timeLines = [finalEntry];
      chatMetadata.timeLineIndex = 0;
    } else {
      chatMetadata.chatLog[idx] = finalEntry;
      const timelineIdx = chatMetadata.timeLines.findIndex(
        (e) => e.id === entryId,
      );
      if (timelineIdx !== -1) chatMetadata.timeLines[timelineIdx] = finalEntry;
    }

    chatMetadata.LastTimeSlice = finalEntry.timeSlice;

    let entryData;
    try {
      entryData = await finalEntry.toData(chatMetadata.username);
    } catch (toDataErr) {
      console.error(
        "[chat] toData failed in finalizeEntry:",
        toDataErr.message,
      );
      try {
        entryData =
          typeof finalEntry.toJSON === "function"
            ? finalEntry.toJSON()
            : finalEntry;
      } catch (fallbackErr) {
        entryData = {
          id: entryId,
          content: finalEntry?.content || "",
          role: finalEntry?.role || "char",
          error: "toData_and_toJSON_failed",
        };
      }
    }

    // RT-4：终态先落盘再广播——盘是权威，避免"广播后、落盘前"崩溃窗口里前端显示了未落盘的消息。
    //   isError 态按原逻辑不落盘（错误条目不持久化），但仍广播给前端。
    // T2 契约补严：saveChat 抛错时**不再吞错后广播成功态 message_replaced**。
    //   旧实现 catch 后仅 console.error 继续广播——前端会显示一条实际未落盘的成功气泡，
    //   刷新即丢且无提示，违反 RT-4"先落盘再广播"（盘是权威）。此处向上抛，让外层
    //   catch(e) 既有错误终态出口统一收敛：broadcastBotError(runtime 红点，用户可见)
    //   + classifyApiError 文案 + finalizeEntry(isError=true)（错误条目不落盘，但仍广播
    //   message_replaced 让前端 placeholder 从 is_generating 挂起态收敛到失败终态，
    //   不永久卡骨架屏）。成功路径行为一字不变。
    if (!isError) {
      try {
        await saveChat(chatid);
      } catch (saveErr) {
        console.error(
          "[chat] saveChat failed in finalizeEntry:",
          saveErr.message,
        );
        throw saveErr;
      }
    }

    broadcastChatEvent(chatid, {
      type: "message_replaced",
      payload: { index: idx, entry: entryData },
    });
    return finalEntry;
  };

  wbTrace(chatid, "generation", "executeGeneration:enter", { entryId, char: request.char_id });

  // 问题映射：整个回合（GetReply→插件 GetPrompt+ReplyHandler+内部 wbD）跑在 ambient chatid 上下文里，
  // 让插件传 null 的 wbD/wbT 也广播到本体前端面板。ALS 按异步上下文隔离，多 chat 并发不串话。
  return runWithAmbientChatId(chatid, async () => {
  try {
    broadcastChatEvent(chatid, {
      type: "stream_start",
      payload: { messageId: entryId },
    });
    // 跨客户端「当前对话」同步：生成开始 → 通知本用户其它客户端(本体↔YonBan)跟随到本 chat 看流，
    // 修「YonBan 生成完、本体停在别的对话故空白」。另一端默认跟随，可关；与 per-chatId 隔离正交。
    // reason="generation"：这是「某对话开始生成」，**不是**用户切了对话。消费端据此只刷新
    //   「在用」角标、不切界面——多线下后台线随时在生成，跟随过去等于把用户从他正在看的线上拽走。
    try { broadcastUserActiveChat(chatid, "generation"); } catch { /* 同步提示失败不阻断生成 */ }

    request.generation_options = {
      replyPreviewUpdater: (reply) => stream.update(reply),
      signal: stream.signal,
    };

    // ★ 空回复重试（最多3次）— API错误/截断由proxy层和反代抗截断机制处理
    // [批5 铁律收口 0713] 重试提示/空回复兜底文案走 injectTexts 单源（generation.empty_* 键，
    //   代码只持结构；:284 原字面 "/3" 硬编码同批改 {max}=EMPTY_REPLY_MAX_RETRIES 真值）。
    const { fillInjectText: _fiEmpty, getInjectText: _giEmpty } = await import("../../../../../../yonban/core/functions/injectTexts/main.mjs");
    let result = null;
    for (let _retry = 0; _retry < EMPTY_REPLY_MAX_RETRIES; _retry++) {
      if (!request.char?.interfaces?.chat?.GetReply) {
        throw new Error(`[chat] char has no GetReply interface (char=${request.char_id})`);
      }
      const _wbAI = wbSpan(chatid, "generation", "GetReply", { char: request.char_id, retry: _retry });
      result = await _getReplyMaybeGrouped(chatid, request, stream);
      _wbAI({ contentLen: (result?.content || "").length });
      // 有内容 → 正常
      if (result !== null && (result?.content || "").trim().length > 0) break;
      // 空回复 → 重试
      if (_retry < EMPTY_REPLY_MAX_RETRIES - 1) {
        const _delay = EMPTY_REPLY_BASE_DELAY_MS * (_retry + 1);
        generationStats.emptyRetries++;
        if (_retry === 0) console.log(`[chat] ★ AI返回空内容，${_delay/1000}s后重试 (${_retry + 1}/3)`);
        // N2：走 stream.update 进 generateDiff 契约（旧实现手捏 {type:"text"} 旁路，前端 applySlice 无此分支被静默丢弃）。
        //   提示作为消息状态进 lastMessage；下轮真内容到来时 generateDiff 情况3("Thinking..."→"Result")产 rewrite_tail 自动覆盖提示，零污染。
        stream.update({ content: _fiEmpty("generation.empty_retry_note", { n: _retry + 1, max: EMPTY_REPLY_MAX_RETRIES }), files: stream.lastFiles });
        await new Promise(r => setTimeout(r, _delay));
        if (stream.signal.aborted) break;
      }
    }

    if (result === null || (result?.content || "").trim().length === 0) {
      wbDetect(chatid, "generation", "empty_after_retries", false, "AI重试后仍空回复", { partialLen: stream.lastContent.length });
      stream.abort("Generation result was empty after retries.");
      const _partial = stream.lastContent;
      placeholderEntry.content = _partial.trim() || _giEmpty("generation.empty_reply_fallback");
      if (_partial.trim()) {
        placeholderEntry.content_for_show = _partial;
        placeholderEntry.content_for_edit = _partial;
      }
      placeholderEntry.is_generating = false;
      await finalizeEntry(placeholderEntry, true);
      _autoContinueCounters.delete(chatid);
      // [0726 容错修] 空回复占位路径此前不排任何续轮/loop——loop 开着也在这里断链，要人肉"请继续"
      //   （07-25 实证：#262 占位后停摆 46 分钟等 002 手动救）。对齐分支②(空 finalEntry)语义：
      //   loop 开启时垫底续轮，ERROR_LOOP_MIN_DELAY 下限防 API 故障期空转风暴；loop 关闭维持原停止行为。
      try {
        const _loopCfgEmpty = getAutoContinueConfig(chatMetadata.username);
        if (_loopActive(_loopCfgEmpty)) scheduleLoopContinue(chatid, request.char_id, Math.max(_loopCfgEmpty.delay_ms, ERROR_LOOP_MIN_DELAY_MS));
      } catch (_lre) { console.warn("[chat] ★ 空回复路径 loop 续轮排定失败:", _lre?.message || _lre); }
      return;
    }

    // ★ Phase 4: ReplyHandler 已在模板 GetReply 内部统一调用（含 regen 循环）
    // 此处不再重复调用，避免带副作用的插件（如 beilu-memory）被执行两次

    const finalEntry = await BuildChatLogEntryFromCharReply(
      result,
      placeholderEntry.timeSlice,
      request.char,
      request.char_id,
      chatMetadata.username,
    );

    generationStats.success++;
    if (stream._startTime) {
      const _dur = Date.now() - stream._startTime;
      generationStats._totalDurationMs += _dur;
      generationStats.avgDurationMs = Math.round(generationStats._totalDurationMs / generationStats.success);
    }

    await finalizeEntry(finalEntry, false);
    wbTrace(chatid, "generation", "generated", { contentLen: (finalEntry?.content || "").length, ms: stream._startTime ? Date.now() - stream._startTime : null });

    // ★ 广播 cache token 统计（供前端token bar显示）
    const _tokenUsage = result?.extension?._token_usage;
    if (_tokenUsage) {
      broadcastChatEvent(chatid, {
        type: "token_usage",
        payload: _tokenUsage,
      });
    }

    // W66: 事件驱动自动继续 — 生成完成即决定下一步
    // 三种结果：停止 / 等待工具结果 / 立即继续
    // B4 inline工具卡（_buildIdeToolEvents 已提升模块级：triggerCharReply 前置落地与此处共用）。
    const _ext = finalEntry?.extension || result?.extension || {};
    const _content = (finalEntry?.content || "").trim();
    const _hasToolCall = _content.includes("<ideToolCall") || _content.includes("<file_op");
    const _isError = _content.startsWith("⚠️") || _content.includes("生成失败");
    const _isEmpty = _content.length === 0;
    const _isAborted = !!_ext.aborted;
    // API截断由反代抗截断机制处理（自动续传），beilu不干预

    // ★ stopContinue：即使有pendingResults也先注入再停止（不触发继续）
    const _hasPending = ideClient.countPendingResults(chatid) > 0;
    wbTrace(chatid, "generation", "autocontinue:decide", { hasToolCall: _hasToolCall, hasPending: _hasPending, isError: _isError, isEmpty: _isEmpty, isAborted: _isAborted });
    // [0724 双停退出] 本轮不带停止符=AI 还在干活 → 连续停止计数清零（连续性定义在此单点维护）
    if (!_ext._stopContinue) _loopStopSignals.delete(chatid);
    if (_ext._stopContinue || _isError) {
      _autoContinueCounters.delete(chatid);
      if (_hasPending) {
        const _pendingResults = ideClient.consumePendingResults(chatid);
        const _resultText = await _applySlashCommandRegex(formatToolResultsForInjection(_pendingResults), chatMetadata.username); // [0723 slash_command 补线]
        const _sysEntry = new chatLogEntry_t();
        _sysEntry.role = "system";
        _sysEntry.name = "IDE工具结果";
        _sysEntry.content = _resultText;
        // ★ 容错：结构化操作类型标记，识别身份首选此字段（不依赖 content 字面串 [IDE工具执行结果]）
        if (!_sysEntry.extension) _sysEntry.extension = {};
        _sysEntry.extension._opType = "ide_tool_result";
        _sysEntry.extension.ideToolEvents = _buildIdeToolEvents(_pendingResults);
        _sysEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
        _sysEntry.time_stamp = new Date();
        _sysEntry.is_generating = false;
        await addChatLogEntry(chatid, _sysEntry);
        await _flushPendingUserImages(chatid, _pendingResults);
        console.log(`[chat] ★ 自动继续: 停止 (stopContinue, 注入了${_pendingResults.length}条结果但不继续)`);
      } else {
        console.log(`[chat] ★ 自动继续: 停止 (stopContinue=${!!_ext._stopContinue}, error=${_isError})`);
      }
      // [0724 loop断链修] 用户级 loop 优先于 AI 停止符：<stopContinue/> 只结束 AI 的当前任务轮，
      //   不终结用户配置的 loop 自动化（002 实证：AI 输出停止符后 loop 信息不再发送=断链）。
      //   排除：已排定时唤醒（_scheduleWakeup 自带续链，双发=重复激活）。
      // [0724 双停退出·002拍板] AI 停 loop 的唯一出口=连续 loop_stop_threshold 轮（默认2）都发
      //   <stopContinue/>：单发=结束任务轮 loop 照续；连发达阈=AI 真没事做，系统停 loop。
      //   检测在系统域（计数器），不靠 AI 自觉；0=关闭双停出口（只有用户关开关能停）。
      const _loopCfgS = getAutoContinueConfig(chatMetadata.username);
      if (!_ext._scheduleWakeup && _loopActive(_loopCfgS)) {
        if (_isError) {
          // [0724 只许前端关] 错误轮不再终结 loop（原 !_isError 排除=API 一次抖动/限流整条自动化
          //   静默死，面板开关还显示开）。防空烧从"终止"改"节流"：垫 ERROR_LOOP_MIN_DELAY_MS 下限。
          //   错误轮不是 AI 的停止决策，不计入双停计数。
          scheduleLoopContinue(chatid, request.char_id, Math.max(_loopCfgS.delay_ms, ERROR_LOOP_MIN_DELAY_MS));
        } else {
          const _stops = (_loopStopSignals.get(chatid) || 0) + 1;
          _loopStopSignals.set(chatid, _stops);
          if (_loopCfgS.loop_stop_threshold > 0 && _stops >= _loopCfgS.loop_stop_threshold) {
            _loopStopSignals.delete(chatid);
            wbTrace(chatid, "generation", "autocontinue:loopStopByAI", { consecutiveStops: _stops, threshold: _loopCfgS.loop_stop_threshold });
            console.log(`[chat] ★ 自动继续: Loop 终止 (AI 连续${_stops}轮 <stopContinue/> 达阈值${_loopCfgS.loop_stop_threshold})`);
          } else {
            scheduleLoopContinue(chatid, request.char_id, _loopCfgS.delay_ms);
          }
        }
      }
    } else if (_isEmpty || _isAborted) {
      _autoContinueCounters.delete(chatid);
      console.log(`[chat] ★ 自动继续: 停止 (空响应=${_isEmpty}, 已中止=${_isAborted})`);
      // [0724 只许前端关] 空响应/中止轮不再终结 loop：中止=用户停「当前这轮」（停整条自动化的唯一
      //   出口=前端开关+二次确认），空响应=上游抖动。垫延迟下限防快转空烧；regen 打断的中止由
      //   scheduleLoopContinue fire 时的在飞闸去重，不会双开。
      const _loopCfgA = getAutoContinueConfig(chatMetadata.username);
      if (!_ext._scheduleWakeup && _loopActive(_loopCfgA)) {
        scheduleLoopContinue(chatid, request.char_id, Math.max(_loopCfgA.delay_ms, ERROR_LOOP_MIN_DELAY_MS));
      }
    } else {
      const _pendingResults = ideClient.consumePendingResults(chatid);
      if (_pendingResults.length > 0) {
        const _resultText = await _applySlashCommandRegex(formatToolResultsForInjection(_pendingResults), chatMetadata.username); // [0723 slash_command 补线]

        // P0-8: 死循环熔断 — IDE未连接时全部失败则停止自动继续
        const _allDisconnected = _pendingResults.every(
          r => r.result && r.result.success === false &&
            (r.result.error || "").includes("未连接")
        );
        const _count = (_autoContinueCounters.get(chatid) || 0) + 1;
        _autoContinueCounters.set(chatid, _count);
        // 代码轮次触发源：每轮经统一激活入口 dispatchActivation fire 已注册的 code_round 触发器。
        // 触发策略（目标会话/每几轮）在 producer 侧由 job 决定，机制不写死；失败不影响生成主流程。
        try { runCodeRoundTriggers(chatMetadata.username, request.char_id, chatid, _count); } catch (_crtErr) { /* 触发失败静默，不阻断自动继续 */ }
        // P0-3: fuzzy_edit 连续失败熔断 —— 本轮有 fuzzy 内层失败(匹配不到 old_string)即累加；
        //   有任何写入进展则归零(自愈)。达阈值提前停，避免 AI 拿错串反复重试无限续轮。
        const _fuzzyFailedThisTurn = _pendingResults.some(
          r => r.tool === "fuzzy_edit" && r.result?.success === true && r.result?.result?.success === false
        );
        const _fuzzyFails = _fuzzyFailedThisTurn ? (_fuzzyFailCounters.get(chatid) || 0) + 1 : 0;
        if (_fuzzyFails > 0) _fuzzyFailCounters.set(chatid, _fuzzyFails); else _fuzzyFailCounters.delete(chatid);
        const _fuzzyFuse = _fuzzyFails >= FUZZY_FAIL_LIMIT;
        // [0726 容错修] 连续续轮轮数上限熔断（真实现 :711 腐烂注释承诺的 MAX；max_auto_rounds 可配 0=禁用）
        const _acCfgFuse = getAutoContinueConfig(chatMetadata.username);
        const _roundsFuse = _acCfgFuse.max_auto_rounds > 0 && _count >= _acCfgFuse.max_auto_rounds;
        const _shouldStop = _allDisconnected || _fuzzyFuse || _roundsFuse;

        if (_count <= 1 || _shouldStop) console.log(`[chat] ★ 工具结果: ${_pendingResults.length}条, ${_resultText.length}字符, 连续第${_count}次, allDisconnected=${_allDisconnected}, fuzzyFails=${_fuzzyFails}`);
        const _sysEntry = new chatLogEntry_t();
        _sysEntry.role = "system";
        _sysEntry.name = "IDE工具结果";
        // [批5 铁律收口 0713] 停止横幅+三种原因文案走 injectTexts 单源（generation.autostop_* 键）——
        //   本条 system entry 真落盘 chatLog 且进下一轮 AI 上下文=「代码禁产生进对话文本」铁律域，
        //   代码只留结构（\n\n 拼接、三分支选择=机制），文字归用户可配置域（:658 files 键同范式）。
        const { fillInjectText: _fiText } = await import("../../../../../../yonban/core/functions/injectTexts/main.mjs");
        const _stopSuffix = _allDisconnected
          ? _fiText("generation.autostop_reason_disconnected")
          : _roundsFuse
            ? _fiText("generation.autostop_reason_max_rounds", { count: _count })
            : _fiText("generation.autostop_reason_fuzzy", { count: _fuzzyFails });
        _sysEntry.content = _shouldStop
          ? _resultText + "\n\n" + _fiText("generation.autostop_banner", { reason: _stopSuffix })
          : _resultText;
        // ★ 容错：结构化操作类型标记，识别身份首选此字段（不依赖 content 字面串 [IDE工具执行结果]）
        if (!_sysEntry.extension) _sysEntry.extension = {};
        _sysEntry.extension._opType = "ide_tool_result";
        _sysEntry.extension.ideToolEvents = _buildIdeToolEvents(_pendingResults);
        _sysEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
        _sysEntry.time_stamp = new Date();
        _sysEntry.is_generating = false;
        await addChatLogEntry(chatid, _sysEntry);
        await _flushPendingUserImages(chatid, _pendingResults);

        if (_shouldStop) {
          const _reason = _allDisconnected ? "ide_disconnected" : _roundsFuse ? "max_rounds" : "fuzzy_fail";
          wbDetect(chatid, "generation", "autocontinue:fuse", false, `熔断 ${_reason}`, { count: _count, fuzzyFails: _fuzzyFails });
          console.warn(`[P0-8] ⚠️ 熔断触发: reason=${_reason}, count=${_count}, fuzzyFails=${_fuzzyFails}, chatid=${chatid}`);
          _autoContinueCounters.delete(chatid);
          _fuzzyFailCounters.delete(chatid);
          // P0-8诊断：广播熔断事件，测试/前端可监听。用文件顶部静态 import 的 broadcastChatEvent（同一符号），
          //   不走动态拼 Windows 路径 import（平台脆弱且多此一举）。
          try {
            broadcastChatEvent(chatid, {
              type: "auto_continue_fuse",
              payload: { reason: _reason, count: _count, timestamp: new Date().toISOString() },
            });
          } catch { /* 广播失败不影响主流程 */ }
        } else {
          const _acCfg = getAutoContinueConfig(chatMetadata.username);
          if (!_acCfg.enabled) {
            _autoContinueCounters.delete(chatid);
            wbTrace(chatid, "generation", "autocontinue:stop", { reason: "user_disabled" });
            console.log("[chat] ★ 自动继续: 面板开关已关，结果已注入等待手动继续");
          } else {
            wbTrace(chatid, "generation", "autocontinue:continue", { count: _count, results: _pendingResults.length, delayMs: _acCfg.delay_ms });
            // [0717 时序修] 续轮安排收口 scheduleAutoContinue（cancel旧timer+登记，行为与原内联等价）
            scheduleAutoContinue(chatid, request.char_id, _acCfg.delay_ms, "ide_tool");
          }
        }
      } else {
        // 框架级续轮统一：ideClient 池空时再查 file_op 池（beilu-files pendingOpResults）。
        //   修复 file_op 续轮原仅靠前端 pollFileOpResults（tab 绑定 + 无后端兜底）的后端缺口——
        //   让 file_op 与 ideToolCall 同走后端事件驱动续轮。file_op 结果由续轮的 GetPrompt
        //   drainPendingOpResultsForSession 注入(@D0)，故此处只判"要不要续轮"，不在此消费。
        //   peek 已模式感知（chat 模式返回 false，不空轮）；复用 _autoContinueCounters/MAX 熔断防无限轮。
        // 债-C：worker 路由时 file_op 在 worker isolate 的池，主进程池恒空 → 采信 worker 上报(result.pendingFileOps)。
        //   本地(非 worker)路由：result.pendingFileOps 为 undefined → 退回查主进程池(行为与原版等价)。
        let _fileOpPending = !!result?.pendingFileOps;
        if (!_fileOpPending) {
          try {
            const _fm = await import("../../../../plugins/beilu-files/main.mjs");
            // Y1 确诊修（07-03）：pendingOpResults 在 pluginData Proxy per-user 桶（写端 ReplyHandler 与
            // 消费端 GetPrompt drain 都在 _filesAls.run({username}) 内=username 桶），此 peek 原直调无 ALS
            // =读 _default 桶恒 false（被 worker 上报+前端轮询逃生阀掩盖的静默缺口）。与写/消费端同机制
            // 铺 ALS 对齐——分身Y1_files桶分裂确诊.md 双桶实测实锤。
            _fileOpPending = _fm._filesAls.run({ username: chatMetadata.username }, () => !!_fm.hasPendingOpResultsForSession?.(chatid));
          } catch { /* beilu-files 不可用 → 退回原停止行为 */ }
        }
        if (_fileOpPending) {
          const _foCount = (_autoContinueCounters.get(chatid) || 0) + 1;
          _autoContinueCounters.set(chatid, _foCount);
          const _acCfg2 = getAutoContinueConfig(chatMetadata.username);
          if (_acCfg2.max_auto_rounds > 0 && _foCount >= _acCfg2.max_auto_rounds) {
            // [0726 容错修] 轮数熔断（与 ide 池同闸；本池无 system entry 落点，结果由兜底注入不丢）
            _autoContinueCounters.delete(chatid);
            wbDetect(chatid, "generation", "autocontinue:fuse", false, "熔断 max_rounds(file_op)", { count: _foCount });
            console.warn(`[chat] ⚠️ 轮数熔断(file_op): 连续${_foCount}轮达上限${_acCfg2.max_auto_rounds}，停止续轮`);
          } else if (!_acCfg2.enabled) {
            _autoContinueCounters.delete(chatid);
            wbTrace(chatid, "generation", "autocontinue:stop", { reason: "user_disabled", source: "file_op" });
            console.log("[chat] ★ 自动继续: 面板开关已关（file_op），结果待手动继续");
          } else {
            wbTrace(chatid, "generation", "autocontinue:continue", { count: _foCount, source: "file_op", delayMs: _acCfg2.delay_ms });
            console.log(`[chat] ★ 自动继续: file_op 操作结果待注入，续轮 (第${_foCount}次)`);
            scheduleAutoContinue(chatid, request.char_id, _acCfg2.delay_ms, "file_op");
          }
        } else {
          // M1 同轮闭环（凛倾 0710「2立刻生成」，0716 落地）：第三级续轮池——聊天AI <needWebSearch>
          //   搜索结果（replyHandler 已 executeWebSearch → pendingChatSearchResults）。与 file_op 同形：
          //   此处只 peek 判"要不要续轮"不消费，消费仍由续轮 GetPrompt 的既有注入器 get+delete
          //   （getPromptHandler CHAT_SEARCH_RESULT）——原隔轮缓存机制原样保留为兜底（续轮被关/熔断时
          //   结果不丢，下次用户消息注入），不再是主路径。复用 _autoContinueCounters 跟踪续轮次数。
          // [0717 交叉债修] worker 路由时池在 worker isolate（主进程模块实例恒空）——优先采信
          //   worker 上报（result.pendingWebSearch，groupReplyRunner 与 pendingFileOps 同范式）；
          //   本地路由 result.pendingWebSearch 为 undefined → 退回查主进程池（行为与原版等价）。
          let _wsPending = !!result?.pendingWebSearch;
          if (!_wsPending) {
            try {
              const _ar = await import("../../../../../../yonban/core/functions/memory/ai/aiRunner.mjs");
              _wsPending = !!_ar.hasPendingChatSearchForChat?.(chatid);
            } catch { /* memory 组不可用 → 退回原停止行为 */ }
          }
          if (_wsPending) {
            const _wsCount = (_autoContinueCounters.get(chatid) || 0) + 1;
            _autoContinueCounters.set(chatid, _wsCount);
            const _acCfg3 = getAutoContinueConfig(chatMetadata.username);
            if (_acCfg3.max_auto_rounds > 0 && _wsCount >= _acCfg3.max_auto_rounds) {
              // [0726 容错修] 轮数熔断（与 ide 池同闸；搜索结果走隔轮兜底注入不丢）
              _autoContinueCounters.delete(chatid);
              wbDetect(chatid, "generation", "autocontinue:fuse", false, "熔断 max_rounds(web_search)", { count: _wsCount });
              console.warn(`[chat] ⚠️ 轮数熔断(web_search): 连续${_wsCount}轮达上限${_acCfg3.max_auto_rounds}，停止续轮`);
            } else if (!_acCfg3.enabled) {
              _autoContinueCounters.delete(chatid);
              wbTrace(chatid, "generation", "autocontinue:stop", { reason: "user_disabled", source: "web_search" });
              console.log("[chat] ★ 自动继续: 面板开关已关（web_search），结果按隔轮兜底注入");
            } else {
              wbTrace(chatid, "generation", "autocontinue:continue", { count: _wsCount, source: "web_search", delayMs: _acCfg3.delay_ms });
              console.log(`[chat] ★ 自动继续: 联网搜索结果待注入，续轮 (第${_wsCount}次)`);
              scheduleAutoContinue(chatid, request.char_id, _acCfg3.delay_ms, "web_search");
            }
          } else {
            // 第四级续轮池——beilu-browser 操作结果（0727 窗口静默死亡修）：
            //   ReplyHandler 执行 browser 操作后把结果（含 [Error] 自纠文本）压进插件私有队列、
            //   剥掉正文标签 → 回复被判"纯文本"停续 → 结果永远注入不到 AI，会话假死。
            //   与 file_op / web_search 同范式：此处只 peek 判"要不要续轮"不消费，
            //   消费由续轮 GetPrompt 的 _drainResults 注入。复用 _autoContinueCounters/MAX 熔断。
            let _brPending = false;
            try {
              const _bm = await import("../../../../plugins/beilu-browser/main.mjs");
              _brPending = !!_bm.hasPendingResultsForChat?.(chatid);
            } catch { /* beilu-browser 不可用 → 退回原停止行为 */ }
            if (_brPending) {
              const _brCount = (_autoContinueCounters.get(chatid) || 0) + 1;
              _autoContinueCounters.set(chatid, _brCount);
              const _acCfg4 = getAutoContinueConfig(chatMetadata.username);
              if (_acCfg4.max_auto_rounds > 0 && _brCount >= _acCfg4.max_auto_rounds) {
                _autoContinueCounters.delete(chatid);
                wbDetect(chatid, "generation", "autocontinue:fuse", false, "熔断 max_rounds(browser_op)", { count: _brCount });
                console.warn(`[chat] ⚠️ 轮数熔断(browser_op): 连续${_brCount}轮达上限${_acCfg4.max_auto_rounds}，停止续轮`);
              } else if (!_acCfg4.enabled) {
                _autoContinueCounters.delete(chatid);
                wbTrace(chatid, "generation", "autocontinue:stop", { reason: "user_disabled", source: "browser_op" });
                console.log("[chat] ★ 自动继续: 面板开关已关（browser_op），结果待下轮注入");
              } else {
                wbTrace(chatid, "generation", "autocontinue:continue", { count: _brCount, source: "browser_op", delayMs: _acCfg4.delay_ms });
                console.log(`[chat] ★ 自动继续: browser 操作结果待注入，续轮 (第${_brCount}次)`);
                scheduleAutoContinue(chatid, request.char_id, _acCfg4.delay_ms, "browser_op");
              }
            } else {
              // [0727 终止原因入链·消费端] 上游 finish_reason 声明非自然完成（length/content_filter 等）
              //   → 截断是一等事实：wb 探针 + 日志 + 广播外显，不再与"自然完成"混同
              //   （0727 A窗 20字残句被当成功收尾实证；生产链=httpFetch 捕获→StructCall 回灌 finish_reason）。
              //   是否自动续写属注入文本域（凛倾域），本层只做事实外显，不做静默续写。
              const _fr = result?.finish_reason;
              if (_fr && _fr !== "stop" && _fr !== "end_turn") {
                wbDetect(chatid, "generation", "reply:truncated", false, `上游终止原因=${_fr}（非自然完成，内容可能被截断）`, { finish_reason: _fr, contentLen: (result?.content || "").length });
                console.warn(`[chat] ⚠️ 回复非自然完成: finish_reason=${_fr}，内容可能被截断`);
                try { broadcastChatEvent(chatid, { type: "reply_truncated", payload: { finish_reason: _fr, timestamp: new Date().toISOString() } }); } catch { /* 广播失败不影响主流程 */ }
              }
              // Loop 自动继续：无工具结果时，若主开关+loop 均启用且有注入文本，排延迟注入续轮（单一实现见 scheduleLoopContinue）
              const _loopCfg = getAutoContinueConfig(chatMetadata.username);
              if (_loopActive(_loopCfg)) {
                scheduleLoopContinue(chatid, request.char_id, _loopCfg.delay_ms);
              } else {
                _autoContinueCounters.delete(chatid);
                wbTrace(chatid, "generation", "autocontinue:stop", { reason: "no_tool_results" });
                console.log("[chat] ★ 自动继续: 停止 (纯文本，无工具结果)");
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // W66: 出错/中止时取消自动继续，防止无限重试
    cancelAutoContinue(chatid);
    wbDetect(chatid, "generation", "executeGeneration:catch", false, e?.message || String(e), { name: e?.name });
    if (e.name === "AbortError") {
      generationStats.aborted++;
      const _partial = stream.lastContent;
      console.log(`[chat] ★ 用户中止生成，保留已有内容 (${_partial.length}字)`);
      if (_partial.trim()) {
        placeholderEntry.content_for_show = _partial;
        placeholderEntry.content_for_edit = _partial;
        placeholderEntry.content = stripReasoningTags(_partial, chatMetadata.username).trim() || _partial;
      }
      placeholderEntry.is_generating = false;
      placeholderEntry.extension = {
        ...placeholderEntry.extension,
        aborted: true,
      };
      // T2：finalizeEntry 契约化"落盘失败即抛"。中止路径终态不翻错误（用户主动中止，内容保留
      //   内存显示），但落盘失败必须进错误外显链路——刷新后内容会丢，用户有权看到红点。
      //   catch 不上抛：本分支已在最外层 catch 内，抛会逃逸成 unhandledRejection。
      try {
        await finalizeEntry(placeholderEntry, false);
      } catch (saveErr) {
        console.error("[chat] saveChat failed for aborted entry (kept in-memory only):", saveErr?.message || saveErr);
        broadcastBotError({ platform: "beilu-chat", botname: request.char_id || "", phase: "runtime", error: saveErr });
      }
    } else {
      generationStats.error++;
      console.error(
        "[chat] executeGeneration error:",
        e?.name || "Unknown",
        e?.message || String(e),
      );
      // BR2：GetReply 错误经 broadcastBotError 广播到全 UI（botSidePanels 红点计数），
      // 对齐 10 个 bot 壳已有的错误外显链路。broadcastBotError 契约=永不抛（内部全容错），不再包裹。
      broadcastBotError({ platform: "beilu-chat", botname: request.char_id || "", phase: "runtime", error: e });
      stream.abort(e?.message || String(e));
      // [0716 网络波动容错·凛倾定案] 已流出的内容（含 thinking）必须保留——原实现 content=classifyApiError(e)
      //   整条覆盖，网络中流断线后 AI 已产出的 think/正文全被错误文案吃掉（凛倾实证）。对齐同函数
      //   AbortError 分支既有救援范式（stream.lastContent → content_for_show/edit），错误文案追加在尾部。
      //   stream.lastContent 不受 httpFetch 重试快照还原影响（快照只重置 result 对象，不回推预览）。
      const _errPartial = stream.lastContent;
      const _errText = classifyApiError(e);
      if (_errPartial.trim()) {
        console.log(`[chat] ★ 生成出错但保留已流出内容 (${_errPartial.length}字) + 错误标注`);
        placeholderEntry.content_for_show = _errPartial + "\n\n" + _errText;
        placeholderEntry.content_for_edit = _errPartial;
        const _errStripped = stripReasoningTags(_errPartial, chatMetadata.username).trim();
        placeholderEntry.content = (_errStripped || _errPartial) + "\n\n" + _errText;
      } else {
        placeholderEntry.content = _errText;
      }
      await finalizeEntry(placeholderEntry, true);
    }
    // [0724 只许前端关] 异常路径（AbortError=用户点停止/regen 打断，或 GetReply 抛错=API 故障）
    //   不再是 loop 断头路——原 catch 只 cancel 不再排，任何一次异常整条自动化静默死。
    //   此处只负责排 timer，守卫全在 scheduleLoopContinue fire 时（在载/在飞/开关三闸）：
    //   deleteChat·ws 卸载晚于上方 cancelAutoContinue 也没关系，fire 时在载闸兜底不产孤儿生成。
    try {
      const _loopCfgE = getAutoContinueConfig(chatMetadata.username);
      if (_loopActive(_loopCfgE)) {
        scheduleLoopContinue(chatid, request.char_id, Math.max(_loopCfgE.delay_ms, ERROR_LOOP_MIN_DELAY_MS));
      }
    } catch (_lre) { console.warn("[chat] ★ 异常路径 loop 续轮排定失败:", _lre?.message || _lre); }
  } finally {
    updateTypingStatus(chatid, request.char_id, -1);
  }
  });
}

// ============================================================
// triggerCharReply — 触发角色回复（含生成锁）
// ============================================================

/** ★ Phase 4: per-chatid 生成锁，防止并发重复触发 */
const _generatingChats = new Set();
/** ★ BUG-1: per-chatid 在途生成 promise。regen 先 abortAll 再 await 它结算，确保 .finally 释放锁后再判锁，避免误判"正在生成中"跳过 */
const _genPromises = new Map();
/** 中途输入：生成进行中到达的「用户输入」→ 排队，本轮结束后补发一轮（消息已按序入 chatLog，保序）。
 *  仅对 userInitiated 排队；系统/auto-continue 的重复触发仍按去重忽略，不无限自激。
 *  [0726 时序修] Set→Map，值=该次输入随身携带的单次注入 {singleInject, onceInjectIds}。
 *  原先只记 chatid：排队分支把 options 整个丢掉、补发那轮也不带任何 inject ⇒ 「生成中途发消息」
 *  这条路径上用户为这条消息挑的注入静默蒸发（旧 singleInject 文本通道同样中招，非注入坞新增）。
 *  单次注入的语义是「跟这条消息一起送到」，排队只该推迟消息，不该丢它的附加物。
 *  多条中途输入合并而非覆盖：ids 取并集、文本去重后换行拼接——两次都是用户真说过的话。 */
const _pendingUserInput = new Map();
/** [0726 分身异步·002] 异步分身完成时若本会话正在生成 → 排队（chatid→username），本轮结束后补唤醒。
 *  与 _pendingUserInput 平行：triggerCharReply 非 userInitiated 重复触发会被静默忽略（:869），
 *  没有这条排队通道时"生成中到达的分身完成"会丢唤醒、结果滞留池中等下一次任意生成。 */
const _pendingAsyncWake = new Map();

function _releaseGenerationLock(chatid, charname, genPromise) {
  _generatingChats.delete(chatid);
  generationStats.activeCount--;
  if (_genPromises.get(chatid) === genPromise) _genPromises.delete(chatid);
  if (_pendingUserInput.has(chatid)) {
    // [0726] 排队时随身携带的单次注入随补发一起送出（原先补发不带 → 中途输入的注入蒸发）
    const _pending = _pendingUserInput.get(chatid) || {};
    _pendingUserInput.delete(chatid);
    if (!_autoContinueTimers.has(chatid)) {
      setTimeout(() => {
        triggerCharReply(chatid, charname, {
          userInitiated: true,
          singleInject: _pending.singleInject,
          onceInjectIds: _pending.onceInjectIds,
        }).catch(e => { console.warn("[generation] 自动续轮失败:", e?.message || e); });
      }, 0);
    }
  }
  // [0726 分身异步·002] 生成中到达的分身完成 → 本轮结束补唤醒。回合末分支③若已消费结果并排了
  //   续轮 timer（_autoContinueTimers 有本 chatid），notifyAsyncCloneDone 内的互斥判断天然跳过，不双触发。
  if (_pendingAsyncWake.has(chatid)) {
    const _awUser = _pendingAsyncWake.get(chatid);
    _pendingAsyncWake.delete(chatid);
    notifyAsyncCloneDone(chatid, charname, _awUser);
  }
}

/**
 * 触发角色回复（生成入口） — 加锁、创建 placeholder 气泡、构建请求、后台启动 executeGeneration。
 *
 * 链路：endpoints POST /message · trigger-reply · 自动续轮 setTimeout → 本函数
 *       → getChatRequest → StreamManager.create → executeGeneration（异步，不 await）
 * 影响：_generatingChats 加锁（per-chatid 互斥）/ 广播 message_added(placeholder) / 广播 typing_status /
 *       generationStats.total++·activeCount++ / _genPromises 记录在途 promise
 * 约束：同一 chatid 不可并发——已在生成时，userInitiated 排入 _pendingUserInput 待本轮结束补发，
 *       其他来源（auto-continue/系统）静默忽略。锁释放在 executeGeneration.finally 里。
 *
 * @param {string} chatid - 会话 ID
 * @param {string} [charname] - 角色目录名（省略取 LastTimeSlice 第一个角色）
 * @param {object} [options] - 选项
 * @param {string} [options.singleInject] - 单次注入文本（一次性不落盘）
 * @param {string[]} [options.onceInjectIds] - 单次注入·条目引用（本轮临时启用的 INJ 条目 id，一次性不落盘）
 * @param {boolean} [options.userInitiated] - 是否用户主动触发（影响中途输入排队逻辑）
 * @param {string} [options.sourceChannel] - 来源通道标识
 */
export async function triggerCharReply(chatid, charname, options = {}) {
  // 请求级去重：同一 chatid 正在生成时，忽略后续请求。
  // ★ A-竞态根修：check-then-add 必须在函数入口同步段（无 await 间隔）完成——原实现把去重
  //   检查放在下方 SEC-GC 的 `await import(v1_adapter)` 之后，两条并发 triggerCharReply(同 chatid)
  //   会各自在 await 处让出、恢复时都读到 has=false 而双双 add=重复生成同一轮。锁 = 唯一并发保护，
  //   不能被任何 await 从其 check-then-add 中劈开。SEC-GC 上限判断（依赖 await import）移到 add 之后，
  //   超限则回滚锁与计数再抛（见下）。
  if (_generatingChats.has(chatid)) {
    // ★ 中途输入：用户在生成中又发消息（addUserReply 已按序入 chatLog）→ 标记，待本轮结束补发。
    //   [0726] 连同本次的单次注入一起排队（见 _pendingUserInput 注释）：合并不覆盖。
    if (options.userInitiated) {
      const _prev = _pendingUserInput.get(chatid);
      const _mergedIds = [...new Set([...(_prev?.onceInjectIds ?? []), ...(options.onceInjectIds ?? [])])];
      const _mergedTxt = [...new Set([_prev?.singleInject, options.singleInject].filter(Boolean))].join("\n");
      _pendingUserInput.set(chatid, { singleInject: _mergedTxt, onceInjectIds: _mergedIds });
      console.log(`[chat] 中途输入排队: chatid=${chatid}（本轮结束后补发一轮，保序；携带单次注入 ${_mergedIds.length} 条+${_mergedTxt ? "临时文本" : "无文本"}）`);
    } else {
      console.warn(
        `[chat] triggerCharReply: chatid=${chatid} 正在生成中，忽略重复请求`,
      );
    }
    return;
  }
  _generatingChats.add(chatid);
  if (options.userInitiated) resetAutoContinueCounter(chatid);
  generationStats.total++;
  generationStats.activeCount++;

  // SEC-GC: 全局 AI 生成并发上限（可配开关，默认关闭——个人大型调查可能 40 并发）。
  //   移到锁 add 之后：先占锁（同步、防 A-竞态），再判全局并发；超限即回滚本次锁+计数再抛。
  //   activeCount 此处已含本次（+1 过），故判据从原 `>= _gcMax`（add 前）等价改为 `> _gcMax`（add 后）。
  const _gcCfg = config.genConcurrency || {};
  const _gcEnvMax = parseInt(globalThis.Deno?.env?.get?.("BEILU_GEN_CONCURRENCY_MAX") || process.env.BEILU_GEN_CONCURRENCY_MAX || "0");
  const _gcEnabled = _gcCfg.enabled === true || _gcEnvMax > 0;
  if (_gcEnabled) {
    const { V1_CONST: _v1c } = await import("../../../../../../server/web_server/v1_adapter.mjs");
    const _gcMax = _gcEnvMax > 0 ? _gcEnvMax : (_gcCfg.max || _v1c.GEN_CONCURRENCY_DEFAULT_MAX);
    if (generationStats.activeCount > _gcMax) {
      const _busy = generationStats.activeCount - 1; // 回滚前的在飞数（不含本次被拒的），用于消息展示
      _generatingChats.delete(chatid);
      generationStats.activeCount--;
      generationStats.total--; // 原上限检查在 total++ 前=被拒不计总；重排后 total 已+1，回滚保持"被拒不计"语义
      throw new Error(`AI 生成并发已达上限 (${_busy}/${_gcMax})，请稍后重试`);
    }
  }

  // #7（校准总表§一-7）：loadChat 抛出(I/O 失败/损坏 JSON)时也须释放锁——否则上方 add 后泄漏，
  //   该 chatid 永卡"正在生成中"直到重启。镜像下方 4 处 delete-on-error 范式。
  let chatMetadata;
  try {
    chatMetadata = await loadChat(chatid);
  } catch (e) {
    _generatingChats.delete(chatid);
    generationStats.activeCount--;
    throw e;
  }
  if (!chatMetadata) {
    _generatingChats.delete(chatid);
    generationStats.activeCount--;
    throw new Error("Chat not found");
  }

  // E 机制统一（凛倾 2026-07-09「技术债务补齐+注意压缩功能」）：生成前置把 file_op 结果池
  //   落 chat log 持久工具结果条（对齐 ideToolCall 结果条形态：用户可见折叠卡 + 持久 + 参与压缩），
  //   替代 GetPrompt 瞬注（不持久/用户不可见/AI 下下轮即忘）。
  //   为什么放生成前置而非生成末：一个点覆盖全部来源——审批后 trigger-reply / 续轮 / 用户新消息
  //   autoReply / stopContinue 滞留（下次任意生成前落 log，时序正确）。主进程前置 drain 后池空 →
  //   本次 GetPrompt drain 天然空=零双注入；worker 形态主池本就空=无害，worker 内旧路自洽。
  //   ALS 铺 username 桶（同 :458 peek 先例，Y1 双桶教训）。
  try {
    const _fmPre = await import("../../../../plugins/beilu-files/main.mjs");
    const _foResults = _fmPre._filesAls.run(
      { username: chatMetadata.username },
      () => _fmPre.drainPendingOpResultsForSession?.(chatid),
    ) || [];
    if (_foResults.length > 0) {
      const _foEntry = new chatLogEntry_t();
      _foEntry.role = "system";
      _foEntry.name = "文件操作结果";
      // 指令文案走 injectTexts 单源（files.op_result_instruction 键，与 beilu-files GetPrompt 注入点同源；
      // 0710 配置链专项：原 _fmPre.DEFAULT_OP_RESULT_INSTRUCTION export 已删）
      const { getInjectText: _giText } = await import("../../../../../../yonban/core/functions/injectTexts/main.mjs");
      _foEntry.content = `${_foResults.map((r) => r.text).join("\n\n")}\n\n${_giText("files.op_result_instruction")}`.trim();
      if (!_foEntry.extension) _foEntry.extension = {};
      _foEntry.extension._opType = "ide_tool_result"; // 复用前端折叠卡/压缩语义（messageList _opType 特判）
      _foEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
      _foEntry.time_stamp = new Date();
      _foEntry.is_generating = false;
      await addChatLogEntry(chatid, _foEntry);
      console.log(`[chat] ★ file_op 结果前置落 log: ${_foResults.length} 条（chatid=${chatid}）`);
      // 压缩适配（凛倾「注意压缩功能」）：代际隐藏——工具结果条只保留最近 TOOL_RESULT_KEEP 条喂 AI，
      //   更旧的 auto _hidden（用户仍可见折叠灰显、可恢复；requestBuilder 按 _hidden 滤出 AI 上下文）。
      //   落地了 chatOps:229 注释里许愿未做的「auto 工具结果刷新」——此前工具结果条永久滞留上下文。
      try {
        const _freshLog = (await loadChat(chatid))?.chatLog || [];
        const _toolIdx = [];
        for (let _i = 0; _i < _freshLog.length; _i++) {
          const _e = _freshLog[_i];
          if (_e?.extension?._opType === "ide_tool_result" && !_e.extension._hidden) _toolIdx.push(_i);
        }
        const TOOL_RESULT_KEEP = 6;
        const _stale = _toolIdx.slice(0, Math.max(0, _toolIdx.length - TOOL_RESULT_KEEP));
        if (_stale.length > 0) {
          await hideMessages(chatid, _stale, true, { meta: { by: "auto", reason: "tool_result_refresh" } });
          console.log(`[chat] ★ 压缩适配: 隐藏 ${_stale.length} 条旧工具结果条（保留最近 ${TOOL_RESULT_KEEP} 条）`);
        }
      } catch (_hsErr) {
        console.warn("[chat] 旧工具结果代际隐藏失败:", _hsErr?.message);
      }
    }
  } catch (_foPreErr) {
    // 前置 consume 失败不阻断生成：结果仍在池，GetPrompt 瞬注旧路兜底（降级零丢失）
    console.warn("[chat] file_op 结果前置落 log 失败:", _foPreErr?.message);
  }

  // 0715 断链修（审批续轮盲轮）：ideClient pendingResults 也前置落 log（对齐上方 file_op E 机制）。
  //   此前审批/拒绝完成 → _broadcastToolResultsReady → triggerCharReply 只触发生成，结果仍在池中——
  //   注入只发生在回合末 consumePendingResults，续轮那一轮 prompt 看不到审批结果（盲轮），要再多跑
  //   一轮才可见；盲轮空响应走 _isEmpty 停止分支时结果滞留池中直到用户再发言。前置落地后本轮 prompt
  //   即含结果。与回合末旧路无双通道：consume 破坏性取空——正常续轮时回合末已消费、此处天然空转，
  //   只有"两轮之间到达"的结果（审批/拒绝/stopContinue 滞留/空响应滞留）会被此处接住。
  {
    let _idePre = [];
    try { _idePre = ideClient.consumePendingResults(chatid) || []; } catch { _idePre = []; }
    if (_idePre.length > 0) {
      try {
        const _ideEntry = new chatLogEntry_t();
        _ideEntry.role = "system";
        _ideEntry.name = "IDE工具结果";
        _ideEntry.content = await _applySlashCommandRegex(formatToolResultsForInjection(_idePre), chatMetadata.username); // [0723 slash_command 补线]
        if (!_ideEntry.extension) _ideEntry.extension = {};
        _ideEntry.extension._opType = "ide_tool_result";
        _ideEntry.extension.ideToolEvents = _buildIdeToolEvents(_idePre);
        _ideEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
        _ideEntry.time_stamp = new Date();
        _ideEntry.is_generating = false;
        await addChatLogEntry(chatid, _ideEntry);
        // [0717 半修陷阱补] 前置落地路同为池消费点——userImage 不冲刷=图静默丢（文本落图不落）
        await _flushPendingUserImages(chatid, _idePre);
        console.log(`[chat] ★ IDE 工具结果前置落 log: ${_idePre.length} 条（chatid=${chatid}）`);
      } catch (_idePreErr) {
        // 落 log 失败 → 恢复池态让回合末旧路兜底（零丢失）。两类项恢复方式不同（F4 语义）：
        //   定向本会话项：consume 已从池摘除 → enqueuePendingResult 回灌；
        //   null 广播项：consume 后仍留池（linger 供其他会话拾取），回灌=重复——只撤回本会话 _deliveredTo 标记。
        for (const _r of _idePre) {
          try {
            if (_r.chatid) ideClient.enqueuePendingResult(_r);
            else _r._deliveredTo?.delete?.(chatid);
          } catch { /* 恢复失败仅日志 */ }
        }
        console.warn("[chat] IDE 结果前置落 log 失败（池态已恢复，回合末兜底）:", _idePreErr?.message);
      }
    }
  }

  // 如果没有指定角色，取第一个角色
  if (!charname) {
    const chars = Object.keys(chatMetadata.LastTimeSlice.chars);
    if (chars.length === 0) {
      _generatingChats.delete(chatid);
      generationStats.activeCount--;
      return;
    }
    charname = chars[0];
  }

  const char = chatMetadata.LastTimeSlice.chars[charname];
  if (!char) {
    _generatingChats.delete(chatid);
    generationStats.activeCount--;
    throw new Error("char not found");
  }

  // 创建 placeholder + request + stream（任何 await 失败都要释放锁）
  let placeholder, request, stream;
  try {
    placeholder = new chatLogEntry_t();
    placeholder.role = "char";
    placeholder.is_generating = true;
    placeholder.timeSlice = chatMetadata.LastTimeSlice.copy();
    placeholder.time_stamp = new Date();
    const { info } =
      (await getPartDetails(chatMetadata.username, `chars/${charname}`)) || {};
    placeholder.name = info?.name || charname;
    placeholder.avatar =
      info?.avatar || `/parts/chars:${encodeURIComponent(charname)}/image.png`;
    placeholder.timeSlice.charname = charname;
    placeholder.content = "";

    broadcastChatEvent(chatid, {
      type: "message_added",
      payload: await placeholder.toData(chatMetadata.username),
    });

    // windowMode（20260726）：用户发送时所在窗口的模式，随请求下传至 getChatRequest → result.mode
    //   → resolveGenerationMode 第一优先级命中，不再回退磁盘 active_modes_map 反查。
    request = await getChatRequest(chatid, charname, { singleInject: options.singleInject, onceInjectIds: options.onceInjectIds, sourceChannel: options.sourceChannel, windowMode: options.windowMode });
    stream = StreamManager.create(chatid, placeholder.id);
    stream._startTime = Date.now();
  } catch (e) {
    _generatingChats.delete(chatid);
    generationStats.activeCount--;
    throw e;
  }

  updateTypingStatus(chatid, charname, 1);

  // 后台执行，完成后释放锁
  const _genP = executeGeneration(chatid, request, stream, placeholder, chatMetadata).finally(
    () => _releaseGenerationLock(chatid, charname, _genP),
  );
  _genPromises.set(chatid, _genP);
}

// ============================================================
// modifyTimeLine — 时间线切换 / 重新生成
// ============================================================

/**
 * 时间线切换 / 重新生成（swipe 左右翻页 + regen）。
 *
 * 链路：endpoints PUT /:chatid/swipe · regen → 本函数
 *       → abortAll(在飞流) → await _genPromises(BUG-1: 等旧生成释放锁)
 *       → delta/absoluteIndex 寻址 → 已有时间线直接切换 / 越界则新建 placeholder 触发生成
 *       → greeting_type=single 走同步 GetGreeting / 普通回复走 executeGeneration 流式生成
 * 影响：saveChat / 广播 message_replaced · timeline_info / _generatingChats 状态变更
 * 约束：调用前端先收到 abortAll 中止在飞流；await _genPromises 确保旧生成锁已释放再判锁
 *
 * @param {string} chatid - 会话 ID
 * @param {number} delta - 时间线偏移量（+1/-1），与 absoluteIndex 二选一
 * @param {number} [absoluteIndex] - 绝对时间线索引（iframe switchSwipe 场景）
 * @returns {Promise<import('./models.mjs').chatLogEntry_t>} 切换/生成后的 entry
 */
export async function modifyTimeLine(chatid, delta, absoluteIndex) {
  StreamManager.abortAll(chatid);

  // BUG-1: abortAll 仅同步发出中止信号，旧生成的锁释放在其 .finally 微任务里，尚未执行。
  // 等旧生成真正结算(锁已释放)再继续，否则下方 _generatingChats.has 误判"正在生成中"跳过 regen。
  const _prevGen = _genPromises.get(chatid);
  if (_prevGen) { try { await _prevGen; } catch { /* 旧生成被中止而 reject 属预期，忽略 */ } }

  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");
  let newTimeLineIndex;
  if (absoluteIndex !== undefined && absoluteIndex !== null) {
    // 绝对索引模式（用于 iframe 内美化代码的 switchSwipe 调用）
    newTimeLineIndex = absoluteIndex;
    // [0727 凛倾「他们是按照1234,不是01234」实证] 绝对索引越界=客户端错误，直接 400：
    //   "右溢出=生成新时间线"是 delta 滑动的刻意语义，绝对模式借道它=1 基思维的卡点最后一项
    //   （发 4，合法 0-3）会**静默烧一次真实 AI 生成**（0727 日志实证：误触发 GetReply→代理返回
    //   ":ok" 解析炸→Char undefined 连环错）。绝对模式要新时间线应显式用 delta，不允许越界暗道。
    if (newTimeLineIndex < 0 || newTimeLineIndex >= chatMetadata.timeLines.length) {
      const _e = new Error(`时间线索引越界：${newTimeLineIndex}（合法 0-${chatMetadata.timeLines.length - 1}，共 ${chatMetadata.timeLines.length} 条；注意索引从 0 起算）`);
      _e.statusCode = 400;
      throw _e;
    }
  } else {
    newTimeLineIndex = chatMetadata.timeLineIndex + delta;
  }

  // 向左循环
  if (newTimeLineIndex < 0)
    newTimeLineIndex = chatMetadata.timeLines.length - 1;

  let entry;

  if (newTimeLineIndex >= chatMetadata.timeLines.length) {
    // 需要生成新消息
    if (!chatMetadata.chatLog.length) {
      // 客户端错误（对空 chat 切/生成时间线），标 statusCode 让 endpoint 映射为 400 而非 500
      const _e = new Error("无法生成新时间线：chatLog 为空，没有可参照的上一条消息");
      _e.statusCode = 400;
      throw _e;
    }
    let previousEntry = findLastActive(chatMetadata.chatLog) || chatMetadata.chatLog[chatMetadata.chatLog.length - 1];
    const { timeSlice } = previousEntry;
    const { greeting_type } = timeSlice;

    const newEntry = new chatLogEntry_t();
    newEntry.id = crypto.randomUUID();
    newEntry.timeSlice = timeSlice.copy();
    newEntry.timeSlice.greeting_type = greeting_type;
    newEntry.role = previousEntry.role;
    newEntry.name = previousEntry.name;
    newEntry.avatar = previousEntry.avatar;
    newEntry.is_generating = true;
    newEntry.content = "";
    newEntry.files = [];
    newEntry.time_stamp = new Date();

    chatMetadata.timeLines.push(newEntry);
    newTimeLineIndex = chatMetadata.timeLines.length - 1;
    chatMetadata.timeLineIndex = newTimeLineIndex;
    entry = newEntry;
    let _replaceIdx = findLastActiveIndex(chatMetadata.chatLog);
    if (_replaceIdx < 0) _replaceIdx = chatMetadata.chatLog.length - 1;
    chatMetadata.chatLog[_replaceIdx] = newEntry;

    // 广播 UI 更新
    broadcastChatEvent(chatid, {
      type: "message_replaced",
      payload: {
        index: _replaceIdx,
        entry: await newEntry.toData(chatMetadata.username),
      },
    });

    if (greeting_type === "single") {
      // 重新生成开场白（同步）。问题映射：跑在 ambient chatid 上下文，插件 GetPrompt 的 wbD 可映射前端。
      await runWithAmbientChatId(chatid, async () => {
      try {
        const { charname } = timeSlice;
        const request = await getChatRequest(chatid, charname || undefined);
        const char = charname ? timeSlice.chars[charname] : null;

        let result = null;
        if (char?.interfaces?.chat?.GetGreeting)
          result = await char.interfaces.chat.GetGreeting(
            request,
            newTimeLineIndex,
          );

        if (!result) throw new Error("No greeting result");

        const newTimeSlice = timeSlice.copy();
        newTimeSlice.greeting_type = greeting_type;

        const finalEntry = await BuildChatLogEntryFromCharReply(
          result,
          newTimeSlice,
          char,
          charname,
          chatMetadata.username,
        );
        Object.assign(newEntry, finalEntry);
        newEntry.is_generating = false;
        newEntry.id = entry.id;

        chatMetadata.timeLines[newTimeLineIndex] = newEntry;
        chatMetadata.chatLog[_replaceIdx] = newEntry;
        chatMetadata.LastTimeSlice = newEntry.timeSlice;

        await saveChat(chatid);

        broadcastChatEvent(chatid, {
          type: "message_replaced",
          payload: {
            index: _replaceIdx,
            entry: await newEntry.toData(chatMetadata.username),
          },
        });
      } catch (e) {
        console.error("Greeting generation failed:", e);
        newEntry.content = classifyApiError(e);
        newEntry.is_generating = false;
        newEntry.id = entry.id;
        newEntry.timeSlice = timeSlice;
        broadcastChatEvent(chatid, {
          type: "message_replaced",
          payload: {
            index: _replaceIdx,
            entry: await newEntry.toData(chatMetadata.username),
          },
        });
      }
      });
    } else {
      // 普通回复（流式）
      if (_generatingChats.has(chatid)) {
        console.warn(`[chat] modifyTimeLine: chatid=${chatid} 正在生成中，跳过regen`);
      } else {
        _generatingChats.add(chatid);
        generationStats.total++;
        generationStats.activeCount++;
        // [债#6 修 0726] SEC-GC 并发上限：本 regen 路径原来只计数不检查=绕过上限（主路径
        //   triggerCharReply:978 有检查）。多窗口下每窗都能 regen，绕过后并发无天花板。
        //   判据/回滚与主路径逐字同构（activeCount 已含本次故用 > ；被拒不计 total）。
        const _rgCfg = config.genConcurrency || {};
        const _rgEnvMax = parseInt(globalThis.Deno?.env?.get?.("BEILU_GEN_CONCURRENCY_MAX") || process.env.BEILU_GEN_CONCURRENCY_MAX || "0");
        if (_rgCfg.enabled === true || _rgEnvMax > 0) {
          const { V1_CONST: _rgV1c } = await import("../../../../../../server/web_server/v1_adapter.mjs");
          const _rgMax = _rgEnvMax > 0 ? _rgEnvMax : (_rgCfg.max || _rgV1c.GEN_CONCURRENCY_DEFAULT_MAX);
          if (generationStats.activeCount > _rgMax) {
            const _rgBusy = generationStats.activeCount - 1;
            _generatingChats.delete(chatid);
            generationStats.activeCount--;
            generationStats.total--;
            throw new Error(`AI 生成并发已达上限 (${_rgBusy}/${_rgMax})，请稍后重试`);
          }
        }
        const { charname } = timeSlice;
        // 对齐主路径 triggerCharReply :531-557：创建阶段 await/create 失败先释放锁再抛，
        //   否则 _generatingChats 泄漏 → 后续生成被 :711/:488 误判"正在生成中"跳过（regen 原裸 await 无兜底）。
        let request, stream;
        try {
          request = await getChatRequest(chatid, charname);
          stream = StreamManager.create(chatid, newEntry.id);
        } catch (e) {
          _generatingChats.delete(chatid);
          generationStats.activeCount--;
          throw e;
        }
        updateTypingStatus(chatid, charname, 1);
        const _regenP = executeGeneration(chatid, request, stream, newEntry, chatMetadata).finally(
          () => _releaseGenerationLock(chatid, charname, _regenP),
        );
        _genPromises.set(chatid, _regenP);
      }
    }
  } else {
    entry = chatMetadata.timeLines[newTimeLineIndex];
    chatMetadata.timeLineIndex = newTimeLineIndex;
    chatMetadata.LastTimeSlice = entry.timeSlice;
    let _swapIdx = findLastActiveIndex(chatMetadata.chatLog);
    if (_swapIdx < 0) _swapIdx = chatMetadata.chatLog.length - 1;
    chatMetadata.chatLog[_swapIdx] = entry;

    await saveChat(chatid);

    broadcastChatEvent(chatid, {
      type: "message_replaced",
      payload: {
        index: _swapIdx,
        entry: await entry.toData(chatMetadata.username),
      },
    });
  }

  // 广播当前 timeline 信息（用于前端 swipe 计数器显示）
  broadcastChatEvent(chatid, {
    type: "timeline_info",
    payload: {
      timeLineIndex: chatMetadata.timeLineIndex,
      timeLinesCount: chatMetadata.timeLines.length,
    },
  });

  return entry;
}
