/**
 * gameCompanion.mjs — 游戏陪伴模式（W15+W18 Q2）：定时截图→AI分析→WS弹窗的独立轻量服务。
 *
 * 【功能链】
 *   用户启动游戏陪伴后，按配置的频率（默认30秒）循环：
 *     1. 触发截图（eyeCapture / captureScreen）
 *     2. 截图/触碰文本经 addUserReply 落进承载对话 chats/{chatid}.json（先落盘后广播）
 *     3. triggerCharReply 走主对话链全量管线——预设/API/后处理全用该对话自身的 AIRP 配置
 *        （P 系列/记忆预设已删,凛倾 2026-07-16"不要把记忆系统搬运到这里":陪伴零独立提示词配置）
 *     4. AI 回复由 ReplyHandler 落盘+广播 message_added/orbMessage/emotion（桌宠气泡走既有 orb 链;
 *        前端陪伴面板按 chatid 轮询 getLog 显示,不依赖 WS——WS 按 currentChatId 门控收不到后台对话）
 *   支持频率自适应：用户忽略消息时按 silenceMultiplier 降频，关闭弹窗时按 closeMultiplier 降频，
 *   有效降低无需互动时的打扰频率（上限 maxInterval）。
 *   不走 scheduler.mjs（scheduler 是基于 cron/interval/once 的工作模式任务调度器，
 *   gameCompanion 是聊天模式下的感知反馈闭环，两者职责不同）。
 *
 * 【why】
 *   游戏陪伴需要感知屏幕内容主动发起 AI 调用（非被动等用户消息），
 *   独立于主对话流水线（generation.mjs）以避免干扰正常对话节奏；
 *   频率自适应是因为用户游戏时可能不希望频繁被打断，但遇到关键画面（如 BOSS 战）又希望及时提醒，
 *   简单固定频率无法平衡——忽略/关闭行为驱动的自适应降频能逼近用户真实偏好。
 *
 * 【前端调用方式】
 *   前端调用 SetData("startGameCompanion", { chatid }) → setDataActions → startGameCompanion()
 *   前端调用 SetData("stopGameCompanion") → setDataActions → stopGameCompanion()
 *   前端调用 SetData("gameCompanionFeedback", { type: "ignore"|"close" }) → recordFeedback()
 *   AI 回复在承载对话文件里,前端 companionChat.mjs 按 getGameCompanionStatus().chatid 轮询 getLog 显示。
 *
 * 【关联链】
 *   ← setDataActions.mjs（startGameCompanion / stopGameCompanion / recordFeedback）
 *   → chatOps.mjs（addUserReply / trimEntryFiles — 用户侧消息落盘+截图附件修剪）
 *   → generation.mjs（triggerCharReply — 主对话链全量拼装,与 AIRP 同一条链）
 *   → storage.mjs（loadJsonFileIfExists / saveJsonFile / 各权威路径）
 *   读配置：eye_config.json（captureFrequency 截图频率）、game_companion_config.json（频率自适应参数/绑定）
 *
 * 【影响范围】
 *   - 内存：_sessions Map（每个 username 一个后台 runtime；角色卡/对话在 session 内固定）
 *   - 承载对话文件：每轮写入用户侧消息(截图/触碰)+AI 回复（主链 ReplyHandler 落盘）
 *   - 不写记忆表格，不写 tables.json（陪伴消息不归档到记忆体系）
 *   - 定时器：每个 session 一个 setInterval（间隔=currentInterval，自适应频率变化时 clear 后按新频率重建）；
 *     单轮耗时可能 > 间隔，由 session.inFlight 重入闸串行化定时轮（在途轮未结束时新触发跳过本次）
 *
 * 【使用效果】
 *   用户打开游戏时启动，AI 主动观察屏幕并在适当时机给出陪伴提示（技巧/情绪/提醒），
 *   用户互动少时自动降低打扰频率，停止时立即清理定时器不留后台负担。
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url"; // 主链模块(chatOps/generation)按 __pluginDir 相对路径动态 import 用

import {
  __pluginDir,   // 解析 beilu-chat/src/lib 主链模块路径用 (= beilu-memory/)
  __projectRoot,
  loadJsonFileIfExists,
  saveJsonFile,
  getEyeConfigPath,
  getGameCompanionConfigPath,
  getGcCaptureRequestPath,
} from "../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"; // T8·回切：壳已删改指 yonban 新位（删壳漏网:存活件对已删件的lib内互引盲区）
import { acquireInteractionLease, loadPetSettingsStore, releaseInteractionLease } from "../../../../../../yonban/core/functions/screenshot/injection_state.mjs";
import { bindCompanionOutput, unbindCompanionOutput } from "../../../../../../yonban/core/functions/render/companionOutput.mjs";

/** 活跃的游戏陪伴会话 Map<username, session>；同一用户只允许一个后台 runtime。 */
const _sessions = new Map();

/** 默认配置 */
const DEFAULT_CONFIG = {
  baseInterval: 5 * 60 * 1000,   // 5分钟
  maxInterval: 30 * 60 * 1000,   // 最大30分钟
  silenceMultiplier: 1.5,         // 用户忽略时频率倍增
  closeMultiplier: 2.0,           // 用户关闭时频率倍增
};

/** 定时截图只是陪伴 session 的可选能力；0 表示不建 timer，不表示文字/语音陪伴不存在。 */
function _armSessionTimer(session) {
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
  if (!(session.currentInterval > 0)) return;
  session.timer = setInterval(() => {
    if (!session.paused) {
      _executeRound(session).catch((e) => {
        console.error(`[gameCompanion] 执行定时轮失败 (${session.username}/${session.charName}):`, e.message);
      });
    }
  }, session.currentInterval);
}

/**
 * 启动游戏陪伴
 * @param {string} username
 * @param {string} charName
 * @param {object} [options]
 * @returns {{ success: boolean, sessionId?: string, error?: string }}
 */
export function startGameCompanion(username, charName, options = {}) {
  const key = username;
  const label = `${username}/${charName}`;
  if (_sessions.has(key)) {
    return { success: false, error: "游戏陪伴已在运行" };
  }

  // 加载用户的eye_config（截图频率等）
  const eyeConfigPath = getEyeConfigPath(username);
  const eyeConfig = loadJsonFileIfExists(eyeConfigPath) || {};
  const _gcFreq = Number(eyeConfig.captureFrequency);
  // 缺键与 DEFAULT_EYE_CONFIG 同语义=0。旧代码在 raw 文件缺键时另造 30 秒默认，造成
  // 设置页显示“关闭”而 runtime 实际会截；现在 0 仅关闭定时截图，文字/语音 session 仍可启动。
  const baseInterval = (Number.isFinite(_gcFreq) ? Math.max(0, _gcFreq) : 0) * 1000;

  // 陪伴轮一律走主对话链(P 系列已删,凛倾 2026-07-16):无承载对话=轮次无处落盘,诚实拒启不静默空转。
  if (!options.chatid) {
    return { success: false, error: "陪伴需要一个承载对话:请先打开一个对话,或在启动绑定里选择独立陪伴对话" };
  }

  // 加载用户的游戏陪伴配置（频率自适应/绑定）
  const gcConfigPath = getGameCompanionConfigPath(username);
  const gcConfig = loadJsonFileIfExists(gcConfigPath) || {};

  const _resolvedInterval = options.interval > 0 ? options.interval : baseInterval;
  const session = {
    id: `gc_${Date.now().toString(36)}`,
    username,
    charName,
    startedAt: Date.now(),
    baseInterval: _resolvedInterval,
    currentInterval: _resolvedInterval,
    // 频率自适应:原 DEFAULT_CONFIG 硬编码常量暴露为 game_companion_config 可调字段,缺省=原值(零行为变化)。
    maxInterval: (Number(gcConfig.maxIntervalMin) > 0 ? Number(gcConfig.maxIntervalMin) * 60 * 1000 : DEFAULT_CONFIG.maxInterval),
    silenceMultiplier: (Number(gcConfig.silenceMultiplier) > 0 ? Number(gcConfig.silenceMultiplier) : DEFAULT_CONFIG.silenceMultiplier),
    closeMultiplier: (Number(gcConfig.closeMultiplier) > 0 ? Number(gcConfig.closeMultiplier) : DEFAULT_CONFIG.closeMultiplier),
    lastRoundAt: Date.now(),  // 上一轮(截图→AI)起始时刻;前端据此 + currentInterval 算"下次截图"倒计时
    // 频率来源标记:基频取自 eye_config(而非 options.interval 显式覆盖)时,运行中每轮对表 eye_config.captureFrequency
    // ——AI captureControl/用户面板改频"运行中生效"的消费点(此前只 start 读一次="始终生效"是假的,2026-07-09 半接线修)
    freqFromConfig: !(options.interval > 0),
    roundCount: 0,
    lastUserReply: null,
    lastMessageAt: null,        // 上一轮真正发出消息的时刻(onComplete 非空回复时设);供"无回复→降频"检测
    lastIgnoredMessageAt: null, // 已按"无回复"计过忽略的那条消息时刻;去重,同一条未回复消息只降频一次
    consecutiveIgnores: 0,
    paused: false,
    inFlight: false,  // 重入闸:_executeRound 有多个 await(等截图≤10s + AI 调用),单轮耗时可能 > currentInterval;
                      // setInterval 到点仍会再触发 → 上一轮未完成时重入,并发交错读改写 session(roundCount/
                      // lastRoundAt/lastMessageAt)且 _syncFreqFromConfig/userAction 会 clear 并重设 timer 引用。
                      // 闸门收口在 _executeRound 入口(单点),在途轮未结束时新触发直接跳过本次(串行化,不叠轮)。
    timer: null,
    captureChain: Promise.resolve(), // 每用户截图请求串行化：标记文件只有一个权威槽，禁止定时轮与语音轮互相覆盖 requestId
    chatid: options.chatid,  // 承载对话(启动已强校验非空):陪伴轮的落盘/生成/前端显示全锚定这条对话
    petLeaseId: null, // 互动桌宠租约(D5 §2.1/§2.2):随 session 同寿命,不落盘;stop/Unload release
  };

  _sessions.set(key, session);
  const _pet = loadPetSettingsStore(__projectRoot);
  bindCompanionOutput(username, session.chatid, charName, [_pet.emotionTag, _pet.motionTag, _pet.orbMessageTag]);
  // 互动对桌宠的临时要求=运行时 lease(替代 0804 iter6 的 petAutoEnabledByInteraction 持久化标记):
  //   acquire 触发 PetLifecycle owner(screenshot/main.mjs)按 effectiveDesired=explicit||lease 拉起;
  //   显式 petEnabled 不被改写——停止互动只 release 本 lease,原开的桌宠仍在、原关的会停,重启无 lease 不遗留。
  //   options.petLease===false = 用户选「只互动」(D5 §2.2 可选偏好),session 照常,不申请桌宠。
  if (options.petLease !== false) {
    try { session.petLeaseId = acquireInteractionLease(username, session.chatid); }
    catch (e) { console.warn(`[gameCompanion] 互动桌宠租约申请失败(session 不受影响): ${e.message}`); }
  }
  _armSessionTimer(session);
  console.log(`[gameCompanion] 已启动: ${label}, 定时截图=${session.currentInterval > 0 ? Math.round(session.currentInterval / 1000) + "秒" : "关闭"}, 桌宠租约=${session.petLeaseId || "(未申请)"}`);

  return { success: true, sessionId: session.id, chatid: session.chatid, autoCapture: session.currentInterval > 0, petLeaseId: session.petLeaseId };
}

/**
 * 停止游戏陪伴
 * @param {string} username
 * @param {string} charName
 * @returns {{ success: boolean }}
 */
export function stopGameCompanion(username, _charName) {
  const key = username;
  const session = _sessions.get(key);
  if (!session) {
    return { success: false, error: "没有运行中的游戏陪伴" };
  }

  if (session.timer) clearInterval(session.timer);
  _sessions.delete(key);
  unbindCompanionOutput(username, session.chatid);
  // 只撤回本次互动的临时桌宠要求(release 幂等:显式关闭接管已 revoke 时返回 false 无害);
  // 用户显式开启的桌宠不经此路——effectiveDesired 仍为 true,owner 不会停它。
  let _leaseReleased = false;
  if (session.petLeaseId) {
    try { _leaseReleased = releaseInteractionLease(session.petLeaseId); }
    catch (e) { console.warn(`[gameCompanion] 互动桌宠租约释放异常: ${e.message}`); }
  }
  console.log(`[gameCompanion] 已停止: ${session.username}/${session.charName}, 共${session.roundCount}轮, 租约释放=${_leaseReleased}`);

  return { success: true, rounds: session.roundCount, petLeaseReleased: _leaseReleased };
}

/**
 * 获取游戏陪伴状态
 * @param {string} username
 * @param {string} charName
 * @returns {object}
 */
export function getGameCompanionStatus(username, _charName) {
  const key = username;
  const session = _sessions.get(key);
  if (!session) {
    return { running: false };
  }
  return {
    running: true,
    sessionId: session.id,
    charName: session.charName,
    chatid: session.chatid, // 承载对话:前端陪伴面板(companionChat.mjs)据此拉历史,producer↔consumer 全接线
    startedAt: session.startedAt,
    roundCount: session.roundCount,
    currentInterval: Math.round(session.currentInterval / 1000),
    baseInterval: Math.round(session.baseInterval / 1000),
    maxInterval: Math.round(session.maxInterval / 1000),
    lastRoundAt: session.lastRoundAt,
    consecutiveIgnores: session.consecutiveIgnores,
    paused: session.paused,
    petLeaseId: session.petLeaseId, // 互动桌宠租约(null=只互动/已被显式关闭接管吊销)
  };
}

/**
 * 用户对弹窗做出了反应（回复/忽略/关闭）
 * @param {string} username
 * @param {string} charName
 * @param {"reply"|"ignore"|"close"|"pause"} action
 */
export function gameCompanionUserAction(username, _charName, action) {
  const key = username;
  const session = _sessions.get(key);
  if (!session) return;

  switch (action) {
    case "reply":
      // 用户回复 → 重置频率
      session.currentInterval = session.baseInterval;
      session.consecutiveIgnores = 0;
      session.lastUserReply = Date.now();
      break;
    case "ignore":
      // 用户忽略 → 降频
      session.consecutiveIgnores++;
      session.currentInterval = Math.min(
        session.currentInterval * (session.silenceMultiplier || DEFAULT_CONFIG.silenceMultiplier),
        session.maxInterval,
      );
      break;
    case "close":
      // 用户关闭 → 大幅降频
      session.currentInterval = Math.min(
        session.currentInterval * (session.closeMultiplier || DEFAULT_CONFIG.closeMultiplier),
        session.maxInterval,
      );
      break;
    case "pause":
      // 安静模式
      session.paused = !session.paused;
      break;
  }

  // 重建定时器（新频率）
  if (action !== "pause") _armSessionTimer(session);

  console.log(
    `[gameCompanion] 用户动作: ${action}, 新间隔=${Math.round(session.currentInterval / 1000)}秒, 忽略次数=${session.consecutiveIgnores}`,
  );
}

/**
 * 执行一轮游戏陪伴（截图→AI→广播）
 * @param {object} session
 */
/**
 * 触碰发送(凛倾 2026-07-09 触碰设计②):把【用户自己设定的内容】作为用户消息发进陪伴轮,
 * 经主对话链落盘生成;回应由 ReplyHandler 广播+orb 链(桌宠气泡可见),前端陪伴面板轮询显示。
 * 文本=用户配置数据,代码不产生。需陪伴运行中(session 持有承载对话);未运行=false,调用方诚实提示。
 * 0725 对话台对齐主输入条:extra.files=附件([{name,mime_type,dataBase64}],随本轮 addUserReply.files
 * 进承载对话,消费与截图附件同链);extra.singleInject=单次注入(透传 triggerCharReply.singleInject,
 * 与主聊天 POST_message 同消费点,一次性不落盘)。纯附件无文本也可发(与主输入条语义一致)。
 * @returns {Promise<{success:boolean, accepted?:boolean, queued?:boolean, error?:string}>} 主链是否真实受理/排队
 */
export async function gameCompanionTouchMessage(username, text, extra = {}) {
  const t = typeof text === "string" ? text.trim() : "";
  const _exFiles = Array.isArray(extra.files) ? extra.files.filter(f => f && typeof f.dataBase64 === "string" && f.dataBase64) : [];
  if (!t && !_exFiles.length) return { success: false, code: "E_COMPANION_EMPTY_MESSAGE", error: "空消息" };
  const session = _sessions.get(username);
  if (session && !session.paused) {
      try {
        session.lastUserReply = Date.now(); // 触碰=用户主动交互,复位降频语义(同 reply)
        const result = await _executeRound(session, {
        touchText: t,
        touchFiles: _exFiles,
        singleInject: typeof extra.singleInject === "string" ? extra.singleInject.trim() : "",
        captureNow: extra.captureNow === true,
        });
        return { success: true, accepted: result?.accepted === true, queued: result?.queued === true, screenshot: result?.screenshot || "none" };
      } catch (e) {
        console.error(`[gameCompanion] 触碰消息轮失败 (${session.username}/${session.charName}):`, e.message);
        // 回执可见(2026-07-10 审计C修):reason 气泡只覆盖"陪伴未运行"前置检查,轮内失败(AI 出错等)
        // 此前只 console=用户以为发出去了。经既有 orb 槽→桌宠轮询→气泡,同显示链零新面。
        try {
          const _orbMod = await import("../../../../../../yonban/core/functions/screenshot/injection_state.mjs");
          if (_orbMod.setPendingOrbMessage) _orbMod.setPendingOrbMessage(username, `触碰消息发送失败: ${e.message}`);
        } catch { /* 回执失败不再级联 */ }
        return { success: false, error: e.message };
      }
  }
  return session
    ? { success: false, code: "E_COMPANION_PAUSED", error: "陪伴已暂停" }
    : { success: false, code: "E_COMPANION_NOT_RUNNING", error: "陪伴未运行" };
}

/** 用户显式“立即截图并让伙伴评论”：复用同一轮 requestId 截图链，不再把 reply 动作冒充截图。 */
export async function gameCompanionCaptureNow(username) {
  const session = _sessions.get(username);
  if (!session) return { success: false, error: "陪伴未运行" };
  if (session.paused) return { success: false, error: "陪伴已暂停" };
  try {
    const result = await _executeRound(session, { captureNow: true, userInitiated: true });
    return { success: true, accepted: result?.accepted === true, queued: result?.queued === true, screenshot: result?.screenshot || "none" };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 运行中对表 eye_config.captureFrequency(AI captureControl / 用户面板改频的运行时消费点):
 * 基频变了 → 更新 baseInterval、按原自适应倍率折算 currentInterval、重建定时器;
 * 改成 0 → 只停止定时截图，保留文字/语音陪伴 session。
 * 只对 freqFromConfig 会话生效(options.interval 显式覆盖的会话不被 eye_config 抢写)。
 * @returns {boolean} true=会话已被停止(调用方应中止本轮)
 */
function _syncFreqFromConfig(session) {
  if (!session.freqFromConfig) return false;
  try {
    const _cfg = loadJsonFileIfExists(getEyeConfigPath(session.username)) || {};
    const _freq = Number(_cfg.captureFrequency);
    if (!Number.isFinite(_freq)) return false;
    const _base = _freq * 1000;
    if (_base === session.baseInterval) return false;
    if (_base === 0) {
      session.baseInterval = 0;
      session.currentInterval = 0;
      _armSessionTimer(session);
      console.log(`[gameCompanion] captureFrequency 运行中被改为 0,仅停止定时截图: ${session.username}/${session.charName}`);
      return false;
    }
    const _ratio = session.baseInterval > 0 ? session.currentInterval / session.baseInterval : 1; // 保留忽略/关闭累计的降频倍率
    session.baseInterval = _base;
    session.currentInterval = Math.min(_base * _ratio, session.maxInterval);
    _armSessionTimer(session);
    console.log(`[gameCompanion] captureFrequency 运行中更新: 基频=${Math.round(_base / 1000)}秒, 当前=${Math.round(session.currentInterval / 1000)}秒`);
  } catch { /* 配置读失败保持现频 */ }
  return false;
}

/**
 * 请求并只消费属于本轮 requestId 的截图。session.captureChain 将单文件请求槽串行化，
 * 既不抢普通主动感知截图，也不让并发的语音/定时轮覆盖彼此的请求。
 */
async function _captureForRound(session) {
  const previous = session.captureChain || Promise.resolve();
  let release;
  session.captureChain = new Promise((resolve) => { release = resolve; });
  await previous;
  const requestId = crypto.randomUUID();
  const gcFlagPath = getGcCaptureRequestPath(session.username);
  try {
    const eye = await import("../../../../../../yonban/core/functions/screenshot/injection_state.mjs");
    saveJsonFile(gcFlagPath, {
      requestId,
      requestedAt: Date.now(),
      sessionId: session.id,
      round: session.roundCount,
    });
    console.log(`[gameCompanion] 已请求截图 requestId=${requestId}`);

    const rawEye = loadJsonFileIfExists(getEyeConfigPath(session.username)) || {};
    let waitSec = Number(rawEye.gcShotWaitSec);
    if (!Number.isFinite(waitSec)) waitSec = Number(eye.DEFAULT_EYE_CONFIG?.gcShotWaitSec) || 10;
    waitSec = Math.max(0, Math.min(120, waitSec));
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitSec * 1000) {
      if (eye.hasPendingInjection(session.username, requestId)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const shot = eye.consumePendingInjection(session.username, requestId);
    return { shot, status: shot ? "attached" : "timeout_or_blocked", requestId };
  } finally {
    // 只删除仍属于本请求的标记；若外部恢复/替换了文件，不误删新所有者的数据。
    try {
      const current = loadJsonFileIfExists(gcFlagPath);
      if (current?.requestId === requestId) fs.unlinkSync(gcFlagPath);
    } catch { /* 标记已被移除 */ }
    release();
  }
}

async function _executeRound(session, opts = {}) {
  // 触碰轮判据=文本或附件任一存在(0725 对话台附件:纯附件消息也是用户主动交互,与 touchText 同轮语义——
  //   跳截图/不对表频率/必达;原 opts.touchText 真值判定会把纯附件轮误走定时轮路径→额外截图)
  const _isTouch = !!(opts.touchText || (Array.isArray(opts.touchFiles) && opts.touchFiles.length));
  const _isInteractive = _isTouch || opts.userInitiated === true;
  const _wantCapture = !_isTouch || opts.captureNow === true;
  // 重入闸(仅定时轮):单轮含等截图≤10s + 发起 AI 调用等多个 await,单轮耗时可能 > currentInterval;
  //   setInterval 到点仍会再触发 → 上一轮未完成时重入,并发交错读改写 session 计数/时刻字段,
  //   且 _syncFreqFromConfig/userAction 会 clear+重设 timer 引用。在途定时轮未结束时新定时轮直接跳过本次。
  //   触碰轮=用户主动交互,不受闸约束(必达,且跳过截图等待窗口极短),但仍以 inFlight 记账避免与定时轮叠算。
  if (!_isInteractive) {
    if (session.inFlight) {
      console.log(`[gameCompanion] 上一轮未完成,跳过本次定时触发 (${session.username}/${session.charName})`);
      return;
    }
    session.inFlight = true;
  }
  try {
  // 触碰轮=用户主动说话,不对表频率;定时轮先对表 eye_config(AI/用户运行中改频的生效点),已停止则中止
  if (!_isInteractive && _syncFreqFromConfig(session)) return;
  // 设计"不回复→降频(×1.5)"的真实 producer:上一轮发过消息(lastMessageAt)而用户至今未回复
  // → 视为一次忽略,复用 gameCompanionUserAction("ignore") 的规范降频+重排定时器逻辑(不另造)。
  // 用 lastIgnoredMessageAt 去重,确保同一条未回复消息只降频一次(不每轮重复降)。
  // (此前 consecutiveIgnores 只有 orb/桌面端 reply/ignore 能动,web 面板无 ignore producer → 自适应是死的。)
  if (!_isInteractive &&
    session.lastMessageAt &&
    session.lastMessageAt !== session.lastIgnoredMessageAt &&
    (!session.lastUserReply || session.lastUserReply < session.lastMessageAt)
  ) {
    session.lastIgnoredMessageAt = session.lastMessageAt;
    gameCompanionUserAction(session.username, session.charName, "ignore");
  }
  session.roundCount++;
  session.lastRoundAt = Date.now();  // 本轮起始 → 前端"下次截图"倒计时基准
  const { username, charName } = session;
  console.log(`[gameCompanion] 执行第${session.roundCount}轮 (${username}/${charName})`);

  try {
    // 1. 定时轮默认取图；文字/语音轮仅在 captureNow=true 时取图。截图必须带 requestId，
    //    只由本轮精确消费；安全门拒绝/桌宠离线/超时均诚实降级为纯文字。
    let _gcShot = null;
    let _screenshotStatus = "not_requested";
    if (_wantCapture) {
      const captured = await _captureForRound(session);
      _gcShot = captured.shot;
      _screenshotStatus = captured.status;
    }

    // ── T1 对话锁定(凛倾 2026-06-16"对话锁定到一个对话文件……角色卡选择,对话选择-对话"):
    //    陪伴轮走主对话链全量管线【唯一路径】(P 系列/aiRunner 临时轮已删,凛倾 2026-07-16
    //    "不要把记忆系统搬运到这里";chatid 在 startGameCompanion 强校验非空):
    //    用户侧消息(触碰文本/截图+描述)经 addUserReply 落 chats/{chatid}.json(先落盘后广播 RT-4),
    //    triggerCharReply 全量拼装——该对话自身的预设/记忆/表格经 getPromptHandler 注入,
    //    与 AIRP 同一条链零重复建设;AI 回复由 ReplyHandler 落盘+广播 message_added+orbMessage/emotion
    //    提取(桌宠气泡走既有 orb 链,表情走既有广播)。重roll=对话时间线(modifyTimeLine)原生可用。
    {
      try {
        const _libDir = path.join(__pluginDir, "..", "..", "shells", "beilu-chat", "src", "lib");
        const _chatOps = await import(pathToFileURL(path.join(_libDir, "chatOps.mjs")).href);
        const _gen = await import(pathToFileURL(path.join(_libDir, "generation.mjs")).href);
        let _userText = opts.touchText || (_gcShot && _gcShot.message) || "";
        const _files = [];
        let _hasShotFile = false; // 截图产者标记的真实判据(0725:附件也进 _files 后,不能再拿 _files.length 当"是截图")
        if (_gcShot && _gcShot.image) {
          const { Buffer: _Buf } = await import("node:buffer");
          const _isJpg = _gcShot.image.startsWith("/9j/");
          _files.push({
            name: "screenshot." + (_isJpg ? "jpg" : "png"),
            mime_type: _isJpg ? "image/jpeg" : "image/png",
            buffer: _Buf.from(_gcShot.image, "base64"),
          });
          _hasShotFile = true;
          if (!_userText) {
            // 截图轮无描述时占位走 injectTexts 单源(铁律:进 messages 的文本用户可配置,代码只递数据)
            const { getInjectText: _giT } = await import("../../../../../../yonban/core/functions/injectTexts/main.mjs");
            _userText = _giT("memory.screenshot_placeholder");
          }
        }
        // 0725 对话台附件(触碰轮):base64→buffer,形状与截图附件一致({name,mime_type,buffer}),
        //   同 addUserReply.files 消费链;坏 base64 单个跳过不废整轮
        if (Array.isArray(opts.touchFiles) && opts.touchFiles.length) {
          const { Buffer: _Buf2 } = await import("node:buffer");
          for (const f of opts.touchFiles) {
            if (!f || typeof f.dataBase64 !== "string" || !f.dataBase64) continue;
            try {
              _files.push({
                name: String(f.name || "attachment"),
                mime_type: String(f.mime_type || "application/octet-stream"),
                buffer: _Buf2.from(f.dataBase64, "base64"),
              });
            } catch (e2) { console.warn("[gameCompanion] 触碰附件解码失败,已跳过:", f && f.name, e2.message); }
          }
        }
        let _addedUserEntry = false;
        if (_userText || _files.length) {
          // extension.gameCompanionShot=【截图轮】产者标记(T4 防膨胀):历史修剪只认此标记;
          //   用户对话台附件不打标=trimEntryFiles 永不剥它(用户数据零波及)
          await _chatOps.addUserReply(session.chatid, {
            content: _userText,
            files: _files,
            extension: _hasShotFile ? { gameCompanionShot: true } : {},
          });
          _addedUserEntry = true;
          // T4 防膨胀(凛倾 tasks#12):截图 files 随陪伴轮在绑定对话累积(chat json 存 file:hash 引用+
          // files 库 blob)。保最近 N 条截图轮的附件,更旧剥引用(条目文字仍在=占位);blob 回收=
          // beilu-chat files.mjs cleanFiles 既有每小时孤儿 GC。N 单源=eye_config.gcShotKeepN,
          // 0=关;读失败/缺键=10(与 DEFAULT_EYE_CONFIG 同值离线兜底,gcShotWaitSec 同范式)。
          if (_hasShotFile) { // 0725:只有截图轮才触发修剪(附件轮不产 gameCompanionShot 条目,跑修剪=空转)
            try {
              let _keepN = 10;
              const _kv = Number((loadJsonFileIfExists(getEyeConfigPath(username)) || {}).gcShotKeepN);
              if (Number.isFinite(_kv) && _kv >= 0 && _kv <= 100) _keepN = Math.floor(_kv);
              if (_keepN > 0) await _chatOps.trimEntryFiles(session.chatid, { keep: _keepN, marker: "gameCompanionShot" });
            } catch (e) { console.warn("[gameCompanion] 截图历史修剪失败(不影响本轮):", e.message); }
          }
        }
        // 纯截图轮若截图被安全门拒绝/桌宠离线/超时，没有任何新用户内容，不得对旧上下文空触发一轮。
        if (!_addedUserEntry) return { accepted: false, queued: false, screenshot: _screenshotStatus, reason: "no_user_content" };
        // singleInject 透传(0725 对话台快速注入):与主聊天 POST_message→triggerCharReply 同消费点,一次性不落盘
        // 所有陪伴轮都已经 addUserReply 落盘，故在主生成锁语义里都是“用户输入”；忙时必须排队而非静默忽略。
        // session.charName 是启动时由 bindChar + 承载对话契约解析出的权威角色。陪伴调用方已经知道
        // 要由谁回复，就不能再丢成 undefined 让主生成器从对话第一角色猜；多角色对话会猜错，
        // 历史空壳对话则直接 no_character。对话自身仍必须真实挂载该角色，generation 会继续
        // 以 char not found 诚实拒绝，角色修复职责由 ensureBotChat 的绑定不变量承担。
        const trigger = await _gen.triggerCharReply(session.chatid, session.charName, { userInitiated: true, sourceChannel: "gameCompanion", ...(opts.singleInject ? { singleInject: opts.singleInject } : {}) });
        if (!trigger?.accepted && !trigger?.queued) throw new Error(`主生成器未接受陪伴轮: ${trigger?.reason || "unknown"}`);
        session.lastMessageAt = Date.now();
        // 定时轮的 inFlight 与真实生成同寿命；用户文字/语音入口只等“已接收”，不把 HTTP/IPC 卡几十秒。
        if (!_isInteractive && trigger.accepted && trigger.completion) await trigger.completion;
        return { ...trigger, screenshot: _screenshotStatus };
      } catch (e) {
        // 主链模块不可达(部署形态异常):本轮跳过并留痕。aiRunner 临时轮降级已删
        // (P 系列/记忆预设不再搬进陪伴,凛倾 2026-07-16;临时轮不落对话文件=失忆,历史病灶不复活)。
        console.error(`[gameCompanion] 主链管线不可达,本轮跳过:`, e.message);
        throw e;
      }
    }

  } catch (e) {
    console.error(`[gameCompanion] 第${session.roundCount}轮执行失败:`, e.message);
    throw e;
  }
  } finally {
    // 释放重入闸(仅定时轮记账过);触碰轮不设闸,但统一清零无副作用(false→false)。
    // 判据与入口同源 _isTouch(0725:纯附件触碰轮若此处仍按 touchText 判会误清定时轮的闸——加锁/放锁必须同判据)
    if (!_isInteractive) session.inFlight = false;
  }
}

/**
 * 构建游戏陪伴的提示词
 * @param {object} session
 * @returns {string}
 */
// (_buildGameCompanionPrompt 已删 2026-07-09:其产物 customSystemPrompt 从未被 aiRunner 消费=死码;
//  且内容是代码硬编码进对话的提示词=违铁律【代码禁产生进入 messages 的文本】。
//  陪伴行为指令归所绑预设(凛倾 2026-06-18:提示词全继承预设);预设可用宏 {{petExpressions}} 等取数据。)

/**
 * 停止所有活跃会话（进程退出时调用）
 */
export function stopAllSessions() {
  for (const [key, session] of _sessions) {
    if (session.timer) clearInterval(session.timer);
    unbindCompanionOutput(session.username, session.chatid);
    // Unload 路径同样撤回互动租约(D5 §2.1:lease 随 start/stop/Unload 变化),防插件退场后遗留意愿
    if (session.petLeaseId) { try { releaseInteractionLease(session.petLeaseId); } catch { /* ignore */ } }
    console.log(`[gameCompanion] 进程退出，停止: ${key}`);
  }
  _sessions.clear();
}
