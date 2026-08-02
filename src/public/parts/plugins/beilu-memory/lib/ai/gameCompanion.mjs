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
import path from "node:path";
import { pathToFileURL } from "node:url"; // 主链模块(chatOps/generation)按 __pluginDir 相对路径动态 import 用

import {
  __pluginDir,   // 解析 beilu-chat/src/lib 主链模块路径用 (= beilu-memory/)
  loadJsonFileIfExists,
  saveJsonFile,
  getEyeConfigPath,
  getGameCompanionConfigPath,
  getGcCaptureRequestPath,
} from "../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"; // T8·回切：壳已删改指 yonban 新位（删壳漏网:存活件对已删件的lib内互引盲区）

/** 活跃的游戏陪伴会话 Map<username, session>；同一用户只允许一个后台 runtime。 */
const _sessions = new Map();

/** 默认配置 */
const DEFAULT_CONFIG = {
  baseInterval: 5 * 60 * 1000,   // 5分钟
  maxInterval: 30 * 60 * 1000,   // 最大30分钟
  silenceMultiplier: 1.5,         // 用户忽略时频率倍增
  closeMultiplier: 2.0,           // 用户关闭时频率倍增
};

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
  const baseInterval = (Number.isFinite(_gcFreq) ? _gcFreq : 30) * 1000; // 秒→毫秒，默认30秒(与前端UI默认值一致;0=禁用)

  // captureFrequency=0 → baseInterval=0 → 用户意图是禁用自动截图
  if (baseInterval === 0 && !(options.interval > 0)) {
    console.log(`[gameCompanion] captureFrequency=0，自动截图已禁用，不启动: ${label}`);
    return { success: false, error: "自动截图已禁用 (captureFrequency=0)" };
  }

  // 陪伴轮一律走主对话链(P 系列已删,凛倾 2026-07-16):无承载对话=轮次无处落盘,诚实拒启不静默空转。
  if (!options.chatid) {
    return { success: false, error: "陪伴需要一个承载对话:请先打开一个对话,或在启动绑定里选择独立陪伴对话" };
  }

  // 加载用户的游戏陪伴配置（频率自适应/绑定）
  const gcConfigPath = getGameCompanionConfigPath(username);
  const gcConfig = loadJsonFileIfExists(gcConfigPath) || {};

  const _resolvedInterval = options.interval ?? baseInterval ?? DEFAULT_CONFIG.baseInterval;
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
    chatid: options.chatid,  // 承载对话(启动已强校验非空):陪伴轮的落盘/生成/前端显示全锚定这条对话
  };

  // 启动定时循环
  session.timer = setInterval(() => {
    if (!session.paused) {
      _executeRound(session).catch((e) => {
        console.error(`[gameCompanion] 执行轮次失败 (${label}):`, e.message);
      });
    }
  }, session.currentInterval);

  _sessions.set(key, session);
  console.log(`[gameCompanion] 已启动: ${label}, 间隔=${Math.round(session.currentInterval / 1000)}秒`);

  return { success: true, sessionId: session.id };
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
  console.log(`[gameCompanion] 已停止: ${session.username}/${session.charName}, 共${session.roundCount}轮`);

  return { success: true, rounds: session.roundCount };
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
  if (action !== "pause" && session.timer) {
    clearInterval(session.timer);
    session.timer = setInterval(() => {
      if (!session.paused) {
        _executeRound(session).catch((e) => {
          console.error(`[gameCompanion] 执行轮次失败 (${session.username}/${session.charName}):`, e.message);
        });
      }
    }, session.currentInterval);
  }

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
 * @returns {boolean} 是否已触发
 */
export function gameCompanionTouchMessage(username, text, extra = {}) {
  const t = typeof text === "string" ? text.trim() : "";
  const _exFiles = Array.isArray(extra.files) ? extra.files.filter(f => f && typeof f.dataBase64 === "string" && f.dataBase64) : [];
  if (!t && !_exFiles.length) return false;
  const session = _sessions.get(username);
  if (session && !session.paused) {
      session.lastUserReply = Date.now(); // 触碰=用户主动交互,复位降频语义(同 reply)
      _executeRound(session, {
        touchText: t,
        touchFiles: _exFiles,
        singleInject: typeof extra.singleInject === "string" ? extra.singleInject.trim() : "",
      }).catch(async (e) => {
        console.error(`[gameCompanion] 触碰消息轮失败 (${session.username}/${session.charName}):`, e.message);
        // 回执可见(2026-07-10 审计C修):reason 气泡只覆盖"陪伴未运行"前置检查,轮内失败(AI 出错等)
        // 此前只 console=用户以为发出去了。经既有 orb 槽→桌宠轮询→气泡,同显示链零新面。
        try {
          const _orbMod = await import("../../../../../../yonban/core/functions/screenshot/injection_state.mjs");
          if (_orbMod.setPendingOrbMessage) _orbMod.setPendingOrbMessage(username, `触碰消息发送失败: ${e.message}`);
        } catch { /* 回执失败不再级联 */ }
      });
      return true;
  }
  return false;
}

/**
 * 运行中对表 eye_config.captureFrequency(AI captureControl / 用户面板改频的运行时消费点):
 * 基频变了 → 更新 baseInterval、按原自适应倍率折算 currentInterval、重建定时器;
 * 改成 0 → 停止会话(与启动时 captureFrequency=0 不启动同语义)。
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
      console.log(`[gameCompanion] captureFrequency 运行中被改为 0,停止: ${session.username}/${session.charName}`);
      stopGameCompanion(session.username, session.charName);
      return true;
    }
    const _ratio = session.baseInterval > 0 ? session.currentInterval / session.baseInterval : 1; // 保留忽略/关闭累计的降频倍率
    session.baseInterval = _base;
    session.currentInterval = Math.min(_base * _ratio, session.maxInterval);
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = setInterval(() => {
        if (!session.paused) {
          _executeRound(session).catch((e) => {
            console.error(`[gameCompanion] 执行轮次失败 (${session.username}/${session.charName}):`, e.message);
          });
        }
      }, session.currentInterval);
    }
    console.log(`[gameCompanion] captureFrequency 运行中更新: 基频=${Math.round(_base / 1000)}秒, 当前=${Math.round(session.currentInterval / 1000)}秒`);
  } catch { /* 配置读失败保持现频 */ }
  return false;
}

async function _executeRound(session, opts = {}) {
  // 触碰轮判据=文本或附件任一存在(0725 对话台附件:纯附件消息也是用户主动交互,与 touchText 同轮语义——
  //   跳截图/不对表频率/必达;原 opts.touchText 真值判定会把纯附件轮误走定时轮路径→额外截图)
  const _isTouch = !!(opts.touchText || (Array.isArray(opts.touchFiles) && opts.touchFiles.length));
  // 重入闸(仅定时轮):单轮含等截图≤10s + 发起 AI 调用等多个 await,单轮耗时可能 > currentInterval;
  //   setInterval 到点仍会再触发 → 上一轮未完成时重入,并发交错读改写 session 计数/时刻字段,
  //   且 _syncFreqFromConfig/userAction 会 clear+重设 timer 引用。在途定时轮未结束时新定时轮直接跳过本次。
  //   触碰轮=用户主动交互,不受闸约束(必达,且跳过截图等待窗口极短),但仍以 inFlight 记账避免与定时轮叠算。
  if (!_isTouch) {
    if (session.inFlight) {
      console.log(`[gameCompanion] 上一轮未完成,跳过本次定时触发 (${session.username}/${session.charName})`);
      return;
    }
    session.inFlight = true;
  }
  try {
  // 触碰轮=用户主动说话,不对表频率;定时轮先对表 eye_config(AI/用户运行中改频的生效点),已停止则中止
  if (!_isTouch && _syncFreqFromConfig(session)) return;
  // 设计"不回复→降频(×1.5)"的真实 producer:上一轮发过消息(lastMessageAt)而用户至今未回复
  // → 视为一次忽略,复用 gameCompanionUserAction("ignore") 的规范降频+重排定时器逻辑(不另造)。
  // 用 lastIgnoredMessageAt 去重,确保同一条未回复消息只降频一次(不每轮重复降)。
  // (此前 consecutiveIgnores 只有 orb/桌面端 reply/ignore 能动,web 面板无 ignore producer → 自适应是死的。)
  if (
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
    // 1. 触发截图（通过beilu-eye的inject机制）
    //    这里直接调用eye的injection_state，假设Python eye进程在运行会自动截图
    //    如果eye没在运行，跳过本轮
    //    触碰消息轮(opts.touchText)=用户主动说话,跳过截图请求/等待/消费,纯文本进 AI。
    const { hasPendingInjection, consumePendingInjection } = await import("../../../../../../yonban/core/functions/screenshot/injection_state.mjs"); // T8·回切：改指 yonban 新位实现体
    if (_isTouch) {
      console.log("[gameCompanion] 触碰消息轮(跳过截图)");
    } else if (hasPendingInjection(username)) { // ★ J6：按 username 分区查本用户 pending
      console.log("[gameCompanion] eye已有pending截图");
    } else {
      // 通知前端触发一次截图（通过写一个标记文件，前端轮询）
      const gcFlagPath = getGcCaptureRequestPath(username); // T7 尾段收口：权威路径单点（写/删两用，与 endpoints 读方同源）
      saveJsonFile(gcFlagPath, {
        requestedAt: Date.now(),
        sessionId: session.id,
        round: session.roundCount,
      });
      console.log("[gameCompanion] 已请求截图");
      // 等待截图到达(窗口秒数可配,A2 去硬编码 2026-07-13:eye_config.gcShotWaitSec 默认10=原值;
      // 0=不等(本轮无图照常);等待步进 1s=检查粒度,非行为值不入配置)
      let _waitSec = 10;
      try {
        const _wv = Number((loadJsonFileIfExists(getEyeConfigPath(username)) || {}).gcShotWaitSec);
        if (Number.isFinite(_wv) && _wv >= 0 && _wv <= 120) _waitSec = _wv;
      } catch { /* 读失败=默认 */ }
      const waitStart = Date.now();
      while (Date.now() - waitStart < _waitSec * 1000) {
        if (hasPendingInjection(username)) break; // ★ J6：按 username 分区
        await new Promise(r => setTimeout(r, 1000));
      }
      // 清理请求标记
      try { fs.unlinkSync(gcFlagPath); } catch { /* ignore */ }
    }

    // 1b. 消费 pending 截图 → 附图给本轮 AI(2026-07-09 断链修:此前只 hasPending 判存在,从不消费、
    //     从不附图——AI 在陪伴轮次从未见过截图。consume=单次注入语义,与前端 active 轮询互斥(先到先得,
    //     injection_state 单槽,同一张图只进一路)。mime 按 base64 头判(同 eye.mjs:252 范式)。
    let _gcShot = null;
    if (!_isTouch) { try { _gcShot = consumePendingInjection(username); } catch { /* 无图:纯文本轮 */ } }

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
        if (_userText || _files.length) {
          // extension.gameCompanionShot=【截图轮】产者标记(T4 防膨胀):历史修剪只认此标记;
          //   用户对话台附件不打标=trimEntryFiles 永不剥它(用户数据零波及)
          await _chatOps.addUserReply(session.chatid, {
            content: _userText,
            files: _files,
            extension: _hasShotFile ? { gameCompanionShot: true } : {},
          });
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
        // 主链回复由 ReplyHandler 异步落盘,本函数拿不到完成回调;lastMessageAt 以触发时刻近似
        // (消费点=顶部"无回复→降频"判据,精度要求=分钟级间隔,触发≈回复时刻误差可忽略)。
        session.lastMessageAt = Date.now();
        // singleInject 透传(0725 对话台快速注入):与主聊天 POST_message→triggerCharReply 同消费点,一次性不落盘
        _gen.triggerCharReply(session.chatid, undefined, { userInitiated: _isTouch, sourceChannel: "gameCompanion", ...(opts.singleInject ? { singleInject: opts.singleInject } : {}) }).catch((e) => {
          console.warn(`[gameCompanion] 主链生成触发失败(第${session.roundCount}轮):`, e.message);
        });
        return; // 主链已接管本轮
      } catch (e) {
        // 主链模块不可达(部署形态异常):本轮跳过并留痕。aiRunner 临时轮降级已删
        // (P 系列/记忆预设不再搬进陪伴,凛倾 2026-07-16;临时轮不落对话文件=失忆,历史病灶不复活)。
        console.error(`[gameCompanion] 主链管线不可达,本轮跳过:`, e.message);
      }
    }

  } catch (e) {
    console.error(`[gameCompanion] 第${session.roundCount}轮执行失败:`, e.message);
  }
  } finally {
    // 释放重入闸(仅定时轮记账过);触碰轮不设闸,但统一清零无副作用(false→false)。
    // 判据与入口同源 _isTouch(0725:纯附件触碰轮若此处仍按 touchText 判会误清定时轮的闸——加锁/放锁必须同判据)
    if (!_isTouch) session.inFlight = false;
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
    console.log(`[gameCompanion] 进程退出，停止: ${key}`);
  }
  _sessions.clear();
}
