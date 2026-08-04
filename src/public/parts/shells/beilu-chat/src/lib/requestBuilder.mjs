/**
 * beilu-chat 请求构建层 — 管「请求对象组装」和「fake-send token 预览构建」。
 * 不管生成调度（那是 generation.mjs 的事）、不管提示词组装（那是 beilu-preset 的事）、不管 AI 调用（那是 proxy 的事）。
 *
 * 链路：triggerCharReply / modifyTimeLine → getChatRequest → 返回 chatReplyRequest_t → executeGeneration 消费
 *       buildFakeSendRequest → getChatRequest(isFakeSend) → buildPromptStruct(触发全插件 GetPrompt/TweakPrompt) → 组装预览
 * 影响：无持久化副作用 — getChatRequest 的 chat_log 是 getVisibleChatLog 产生的新数组副本，singleInject push 不污染持久态
 * 相交：← generation.triggerCharReply·modifyTimeLine·endpoints.buildFakeSendRequest（调用方）
 *       → chatOps.getVisibleChatLog·chatStorage.loadChat·parts_loader.loadPart·prompt_struct.buildPromptStruct
 */

import { getPartInfo } from "../../../../../../scripts/locale.mjs";
import { getUserByUsername } from "../../../../../../yonban/core/functions/security/auth.mjs";
import {
  getAllDefaultParts,
  getPartDetails,
  getPartList,
  loadPart,
} from "../../../../../../server/parts_loader.mjs";
import {
  buildPromptStruct,
  margeStructPromptChatLog,
  structPromptToSingleNoChatLog,
} from "../prompt_struct.mjs";

import { addChatLogEntry, getVisibleChatLog } from "./chatOps.mjs";
import { countTokens } from "../../../../../../yonban/core/functions/memory/nlp/tokenizer.mjs"; // T8·回切：改指 yonban 新位实现体；逐条 _tokens 后 estimated_tokens 改累加（Σ(4+_tokens) 与 countMessagesTokens 同式）
import { chatMetadatas, loadChat } from "./chatStorage.mjs";
import { chatLogEntry_t } from "./models.mjs";
import { BuildChatLogEntryFromCharReply } from "./messageBuilder.mjs";
import { wbTrace, wbSpan, wbDetect, runQuiet } from "../../../../../../server/whitebox.mjs";

// runtimeParamsSnapshot 惰性桥接（同 storage.getUserDataDir userDir 桥范式）：
// 静态 import preset main 会把其装载序提前（模块级 loadRuntimeParams/engine 副作用）=装载序炸弹，
// 故首用时动态 import 取 snapshotRuntimeParams，失败置 null 不重试（消费端回退活全局=原行为）。
let _snapRtParams;
// [T1 激活层] 激活备料惰性桥（同 _snapRtParams 范式）：{resolveGenerationMode, buildPresetContext}，
// 首用动态 import，失败置 null 不重试（消费端回退原解析链）。
let _activationDeps;

// ============================================================
// getChatRequest — 构建角色回复请求对象
// ============================================================

/**
 * 构建角色回复请求对象 — 加载会话元数据、合并默认插件、组装 chatReplyRequest_t。
 *
 * 链路：triggerCharReply / modifyTimeLine → 本函数 → 返回 chatReplyRequest_t → executeGeneration / GetReply 消费
 * 影响：无持久化副作用 — chat_log 是 getVisibleChatLog 产生的新数组，singleInject push 不污染 chatMetadata.chatLog
 * 约束：singleInject 仅对非 fakeSend 生效（fakeSend 是 token 预览，不注入）；
 *       Update() 递归调用 getChatRequest 重建（不携带 singleInject → 仅本轮生效）
 *
 * @param {string} chatid - 会话 ID
 * @param {string} charname - 角色目录名
 * @param {object} [options] - 选项
 * @param {string} [options.singleInject] - 单次注入文本（一次性追加到 chat_log 末尾，不落盘）
 * @param {string[]} [options.onceInjectIds] - 单次注入·条目引用（本轮临时启用的 INJ 条目 id，不落盘）
 * @param {boolean} [options.isFakeSend] - 是否 fake-send（token 预览模式，插件据此跳过耗时操作）
 * @param {string} [options.sourceChannel] - 来源通道标识
 * @returns {Promise<import('../../chat/decl/chatLog.ts').chatReplyRequest_t>} 构建好的请求对象
 */
export async function getChatRequest(chatid, charname, options = {}) {
  wbTrace(chatid, "requestBuilder", "getChatRequest:enter", { charname, isFakeSend: !!options.isFakeSend });
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  const { username, LastTimeSlice: timeSlice } = chatMetadata;
  const { locales } = getUserByUsername(username);
  const userinfo = (await getPartInfo(timeSlice.player, locales)) || {};
  let charinfo = (await getPartInfo(timeSlice.chars[charname], locales)) || {};
  // ★ 兜底：getPartInfo 可能因 chardata.json 缺失返回空，用 getPartDetails 补充角色显示名
  if (!charinfo.name) {
    const details = await getPartDetails(username, `chars/${charname}`).catch(
      () => null,
    );
    if (details?.info?.name) {
      charinfo = { ...charinfo, name: details.info.name };
    }
  }
  const UserCharname = userinfo.name || timeSlice.player_id || username;

  const other_chars = { ...timeSlice.chars };
  delete other_chars[charname];

  // ★ 自动合并默认插件：确保 getAllDefaultParts 中的插件即使不在旧聊天的 timeSlice 中也能参与 GetPrompt
  const mergedPlugins = { ...timeSlice.plugins };
  const defaultPluginNames = getAllDefaultParts(username, "plugins");
  // ★ 只加载「真实存在的插件」：用户 defaultParts.plugins 可能误列 shell（如 beilu-home），
  //   它在 plugins/ 下不存在 → 每次 GetPrompt 都 loadFail 刷噪声。先按 getPartList 过滤，不存在的静默跳过。
  let _existingPlugins = null;
  try { _existingPlugins = new Set(getPartList(username, "plugins") || []); } catch { _existingPlugins = null; }
  for (const pluginName of defaultPluginNames) {
    if (!mergedPlugins[pluginName]) {
      if (_existingPlugins && !_existingPlugins.has(pluginName)) {
        // 配置里列了但 plugins/ 下没有（多为 shell 误列），静默跳过，不刷 loadFail
        continue;
      }
      try {
        mergedPlugins[pluginName] = await loadPart(
          username,
          "plugins/" + pluginName,
        );
      } catch (e) {
        // 插件加载失败不影响其他流程
        wbDetect(chatid, "requestBuilder", "defaultPlugin:loadFail", false, e?.message || String(e), { plugin: pluginName });
      }
    }
  }

  for (const k of Object.keys(other_chars)) {
    if (other_chars[k] == null) delete other_chars[k];
  }
  for (const k of Object.keys(mergedPlugins)) {
    if (mergedPlugins[k] == null) delete mergedPlugins[k];
  }

  /** @type {import('../../../chat/decl/chatLog.ts').chatReplyRequest_t} */
  const result = {
    isFakeSend: !!options.isFakeSend,
    supported_functions: {
      markdown: true,
      mathjax: true,
      html: true,
      unsafe_html: true,
      files: true,
      add_message: true,
      beilu_assets: true,
      beilu_i18nkeys: true,
    },
    chat_name: "common_chat_" + chatid,
    // [T1 激活层 2026-07-19] chatid 显式上激活载体：此前只有 chat_name 前缀埋 cid，
    //   带回退的读点（preset _resolveCid 等）能还原，但 shadowBuild 四处直读 args.chatid
    //   （ModeDef 选择 resolveGenerationMode / dispatch scope.chatId / loadMemoryData）恒拿
    //   null → per-chatId 模式绑定链（N38 active_modes_map）在生成主链从不生效，
    //   每条对话线的 ModeDef 都随 char 级 active_mode（切 tab 联动）漂移 = 管线互相污染的后端根源。
    chatid,
    // [20260726 窗口即模式] mode=发送时用户所在窗口的模式（前端 TAB_TO_MODE[activeTab] → HTTP
    //   window_mode → triggerCharReply options.windowMode → 此处）。
    //   resolveGenerationMode 的优先级本就是 `arg.mode` > 磁盘 active_modes_map[chatid]，
    //   但生产者一直缺位，导致模式这个**窗口的运行时事实**被落盘成"对话的属性"再读回来——
    //   两个窗口（如 airp + code）同时跑就互相覆盖那张表（无锁整份写回）。补上生产者后：
    //   有窗口上下文=请求说了算、零磁盘依赖；无窗口的后台链（定时任务/归档/P2）仍走磁盘兜底。
    //   非法/空值不落此字段（isValidModeId 由 resolveGenerationMode 内部把关），行为零回归。
    ...(options.windowMode ? { mode: options.windowMode } : {}),
    char_id: charname,
    username,
    UserCharname,
    Charname: charinfo.name || charname,
    locales,
    chat_log: _applyContentFilter(await getVisibleChatLog(chatid, chatMetadata), username),
    Update: () => getChatRequest(chatid, charname),
    AddChatLogEntry: async (entry) => {
      if (!chatMetadata.LastTimeSlice.chars[charname])
        throw new Error("Char not in this chat");
      const built = await BuildChatLogEntryFromCharReply(
        entry, chatMetadata.LastTimeSlice.copy(),
        chatMetadata.LastTimeSlice.chars[charname], charname, chatMetadata.username,
      );
      chatMetadata.timeLines = [built];
      chatMetadata.timeLineIndex = 0;
      chatMetadata.LastTimeSlice = built.timeSlice;
      return addChatLogEntry(chatid, built);
    },
    world: timeSlice.world,
    char:
      timeSlice.chars[charname] ??
      (() => {
        throw new Error(
          `Char "${charname}" failed to load or not found in timeSlice`,
        );
      })(),
    user: timeSlice.player,
    other_chars,
    chat_scoped_char_memory: (timeSlice.chars_memories[charname] ??= {}),
    plugins: mergedPlugins,
    user_description: userinfo.description || "",
    extension: {},
    sourceChannel: options.sourceChannel || "",
  };

  // runtimeParamsSnapshot 两步装配·第 1 步（设计②§3.4，凛倾 07-03"4个模式做好隔离"）：
  // 本函数是全部生成路径的单一咽喉（generation 主链 / groupReplyRunner worker / fakeSend 预览同源），
  // 在此拍冻结快照挂激活载体 → 在途生成对并发窗口 POST runtime-params 的全局单例改动免疫
  // （T4 靶点② temp=1.7 跨窗污染族根修）。第 2 步=preset TweakPrompt Round2 mergeRuntimeParams 纯函数消费。
  try {
    if (_snapRtParams === undefined)
      _snapRtParams = (await import("../../../../../../yonban/core/functions/prompt/preset/main.mjs")).snapshotRuntimeParams ?? null;
    if (_snapRtParams) result.extension.runtime_params_snapshot = _snapRtParams(username); // [T065] runtime 参数 per-user，快照按本请求 username 取桶
  } catch { _snapRtParams = null; }

  // [T1 激活层·两步创建第 1 步] 激活入参备料（三层激活架构_设计 01：激活线冒出时把选择键一次备齐冻结）：
  // 本函数是全部生成路径的单一咽喉（generation 主链 / groupReplyRunner worker / fakeSend 预览同源），
  // 在此解析本条激活线的 mode（resolveGenerationMode 单源，bot 派生→契约槽→N38 per-chat 绑定链）
  // 与 preset_name（buildPresetContext 门面 → resolveActivePresetName 单源）。
  // why 冻结在入口：GetPrompt/TweakPrompt 三轮此前各自重复解析，另一窗口在组装中途切预设/切模式
  //   会让三轮读到不同预设 = 撕裂组装；激活语义 = 本次激活用备料时刻的值，跑完蒸发。
  // 不经本咽喉的入口（bot 壳 generateChatReplyRequest 等）无 activation → 消费端回退原解析链
  //   （与 runtime_params_snapshot 同款多入口诚实回退，非吞错）。
  try {
    if (_activationDeps === undefined) {
      try {
        const [_stor, _preset, _smAct] = await Promise.all([
          import("../../../../../../yonban/core/functions/memory/storage_mod/storage.mjs"),
          import("../../../../../../yonban/core/functions/prompt/preset/main.mjs"),
          import("../../../../../../yonban/core/functions/memory/storage_mod/subModeActivation.mjs"),
        ]);
        _activationDeps = {
          resolveGenerationMode: _stor.resolveGenerationMode ?? null,
          buildPresetContext: _preset.buildPresetContext ?? null,
          ensureWindowModePresetBindings: _preset.ensureWindowModePresetBindings ?? null,
          getActivationSnapshot: _smAct.getActivationSnapshot ?? null, // D3 0804：子模式激活快照（revision/provenance/requestProfile）
        };
      } catch { _activationDeps = null; }
    }
    if (_activationDeps?.resolveGenerationMode) {
      const _actMode = _activationDeps.resolveGenerationMode(result, username, result.char_id || "_global", chatid);
      if (_activationDeps.ensureWindowModePresetBindings && chatid) {
        await _activationDeps.ensureWindowModePresetBindings(username, chatid);
      }
      const _actPreset = _activationDeps.buildPresetContext
        ? (_activationDeps.buildPresetContext(username, chatid, _actMode)?.presetName || null)
        : null;
      // [D3 0804] sub_mode 快照同批冻结：切换期在飞请求用备料时刻的 revision/requestProfile/provenance，
      //   不随中途 activateSubMode 漂移（与 mode/preset_name 同一激活语义：备料时刻的值，跑完蒸发）。
      //   快照失败=null（消费端回退每轮解析链，与 activation 缺位同款诚实回退，非吞错）。
      let _actSubMode = null;
      if (_activationDeps.getActivationSnapshot) {
        try {
          _actSubMode = Object.freeze(_activationDeps.getActivationSnapshot(username, result.char_id || "", chatid, _actMode));
        } catch (e) {
          console.warn("[requestBuilder] sub_mode 快照失败(消费端回退每轮解析):", e?.message);
        }
      }
      result.extension.activation = Object.freeze({ chatid, mode: _actMode, preset_name: _actPreset, sub_mode: _actSubMode });
    }
  } catch (e) {
    console.warn("[requestBuilder] activation 备料失败(消费端回退原解析链):", e?.message);
  }

  // 单次注入·条目引用（0726 注入坞）：本轮临时启用的 INJ 条目 id 列表，挂 extension 透传给
  // beilu-memory getPromptHandler —— 命中的条目由 INJ 正线注入（injectionSystem.resolveEffectiveInjections
  // 认 ctx.onceIds），各自的 role/depth/order/宏 全部照常生效，注入的永远是条目当前内容。
  // 与下方 singleInject（纯文本 push chat_log）是两条不同语义的通道：这条是「引用已有条目」，
  // 那条是「这次就说一句、不想存」（companionChat/gameCompanion 也在用），两者可同时携带。
  // 仅本轮：Update() 递归调用 getChatRequest 不传 options → extension 天然不再携带，无需清理动作。
  {
    const _onceIds = Array.isArray(options.onceInjectIds)
      ? options.onceInjectIds.filter((s) => typeof s === "string" && s)
      : [];
    if (_onceIds.length && !result.isFakeSend) {
      result.extension.once_inject_ids = _onceIds;
      wbTrace(chatid, "requestBuilder", "getChatRequest:onceInject", { ids: _onceIds });
    }
  }

  // 单次注入：把临时 system 指令追加到本次请求的 chat_log 末尾（一次性，不落盘）。
  // chat_log 是 filter 产生的新数组，push 不会污染持久化的 chatMetadata.chatLog；
  // 经 triggerCharReply 线程传入而非 stash，Update() 重建天然不携带 → 仅本轮生效。
  const _singleInject = (options.singleInject || "").trim();
  if (_singleInject && !result.isFakeSend) {
    const injectEntry = new chatLogEntry_t();
    injectEntry.role = "system";
    injectEntry.name = "单次注入";
    injectEntry.content = _singleInject;
    injectEntry.timeSlice = chatMetadata.LastTimeSlice.copy();
    injectEntry.time_stamp = new Date();
    injectEntry.is_generating = false;
    result.chat_log.push(injectEntry);
    wbTrace(chatid, "requestBuilder", "getChatRequest:singleInject", { len: _singleInject.length });
  }

  wbTrace(chatid, "requestBuilder", "getChatRequest:exit", { charname, chatLogLen: result.chat_log.length, plugins: Object.keys(mergedPlugins).length });
  return result;
}

// ============================================================
// buildFakeSendRequest — 构建完整的 Chat Completion request 预览
// ============================================================

/**
 * 构建完整的 Chat Completion request 预览 — token 预览（promptViewer）专用。
 *
 * 链路：endpoints GET /:chatid/fake-send（每 15s 轮询 + 多面板）→ 本函数
 *       → getChatRequest(isFakeSend=true) → buildPromptStruct(触发全插件 GetPrompt/TweakPrompt)
 *       → 司令员模式? 五段式组装 : 标准 XML 格式 → 返回 {messages, model, _meta}
 * 影响：无持久化副作用；整段套 runQuiet 静默白盒（trace 不刷屏/不广播）
 * 约束：isFakeSend=true 使插件跳过 P1 检索等耗时操作；
 *       _meta.model_params 为 N8 修（此前缺失导致 promptViewer 参数 Tab 永不生效）
 *
 * @param {string} chatid - 会话 ID
 * @param {string} [charname] - 角色目录名（省略取 LastTimeSlice 第一个角色，chars 空时回退 primaryCharName）
 * @returns {Promise<{messages: Array, model: string, _meta: object}>} 预览用请求对象
 */
export async function buildFakeSendRequest(chatid, charname) {
  // fake-send = token 预览（每 15s 轮询 + 多面板），整段套 runQuiet：白盒不记/不打印/不广播，
  // 杜绝 getChatRequest+全插件 GetPrompt 的 trace 每 15s 刷屏。真实回合的问题映射不受影响。
  return runQuiet(async () => {
  wbTrace(chatid, "requestBuilder", "buildFakeSendRequest:enter", { charname });
  const chatMetadata = await loadChat(chatid);
  if (!chatMetadata) throw new Error("Chat not found");

  const { LastTimeSlice: timeSlice } = chatMetadata;

  if (!timeSlice || !timeSlice.chars) {
    throw new Error(`Chat data invalid: LastTimeSlice or chars is missing (chatid: ${chatid})`);
  }

  if (!charname) {
    const chars = Object.keys(timeSlice.chars);
    if (chars.length === 0) {
      // 容错：LastTimeSlice.chars 为空时，尝试从 chatMetadatas 的 primaryCharName 回退
      const chatData = chatMetadatas.get(chatid);
      const fallbackChar = chatData?.primaryCharName;
      if (fallbackChar) {
        try {
          timeSlice.chars[fallbackChar] = await loadPart(
            chatMetadata.username,
            "chars/" + fallbackChar,
          );
          charname = fallbackChar;
          console.warn(
            `[chat/fake-send] chars was empty, recovered from primaryCharName "${fallbackChar}"`,
          );
        } catch (e) {
          throw new Error(
            `No characters in this chat (primaryCharName "${fallbackChar}" load failed: ${e.message})`,
          );
        }
      } else {
        throw new Error(
          "No characters in this chat and no primaryCharName available",
        );
      }
    } else {
      charname = chars[0];
    }
  }

  // 步骤 1：构建 chatReplyRequest_t（传入 isFakeSend 标记，插件据此跳过耗时操作如 P1 检索）
  const request = await getChatRequest(chatid, charname, { isFakeSend: true });

  // 步骤 2：构建 prompt_struct（fake-send 全程 runQuiet 静默，插件 GetPrompt trace 不刷屏/不广播）
  const prompt_struct = await buildPromptStruct(request);

  // [0716 附件传导链修·凛倾定案] 预览与真发送同源：文本附件全文只给最近一条带附件的 user 消息，
  //   历史轮名字占位（hide 默认；AI 源 config 若改 attachment_history=inline/block，预览按默认 hide
  //   估算会有偏差——预览层不感知具体源 config，如实标注）。动态 import 防壳↔yonban 装载时序耦合（同 roleReminding 范式）。
  const { buildEntryAttachmentText, findLastUserFilesIndex } = await import(
    "../../../../../../yonban/core/functions/api/_shared/textAttachment.mjs"
  );
  const _pvLuFilesIdx = findLastUserFilesIndex(prompt_struct.chat_log || []);
  const _inlineTextFiles = (e, baseContent, isLast) => {
    if (!e.files?.length) return baseContent;
    const _at = buildEntryAttachmentText(e, { isLastUser: !!isLast, username: chatMetadata.username, historyMode: "hide" });
    return _at ? (baseContent || "") + _at : baseContent;
  };

  // 步骤 2.5：检测司令员模式
  const presetExt = prompt_struct.plugin_prompts?.["beilu-preset"]?.extension;
  const commanderMode =
    presetExt?.commander_mode &&
    (presetExt?.beilu_preset_before || presetExt?.beilu_preset_messages);

  let messages;
  let modelParams = {};

  if (commanderMode) {
    // 读取 5 段式数据
    const beforeChat =
      presetExt.beilu_preset_before || presetExt.beilu_preset_messages || [];
    const afterChat = presetExt.beilu_preset_after || [];
    const injectionAbove = presetExt.beilu_injection_above || [];
    const injectionBelow = presetExt.beilu_injection_below || [];
    modelParams = presetExt.beilu_model_params || {};

    const toMsg = (m, section, source = "preset") => ({
      role:
        m.role === "user"
          ? "user"
          : m.role === "assistant"
            ? "assistant"
            : "system",
      content: m.content || "",
      _identifier: m.identifier,
      _name: m.name,
      _is_marker: !!m.is_marker,
      _source: source,
      _section: section,
    });

    // 1. 头部预设（beforeChat）
    const beforeSection = beforeChat.map((m) => toMsg(m, "beforeChat"));

    // 2. 注入上方（injectionAbove, @D>=1）
    const aboveSection = injectionAbove.map((m) =>
      toMsg(m, "injectionAbove", "injection"),
    );

    // 3. 聊天记录
    const chatLogMsgs = (prompt_struct.chat_log || []).map((e, _i) => ({
      role:
        e.role === "user"
          ? "user"
          : e.role === "system"
            ? "system"
            : "assistant",
      content: _inlineTextFiles(e, e.content || "", _i === _pvLuFilesIdx), // [0716] 文本附件处理（与真发送同源）
      _name: e.name,
      _source: "chat_log",
      _section: "chatHistory",
      _files: e.files?.length
        ? e.files.map((f) => ({
            name: f.name,
            mime_type: f.mime_type,
            size: f.buffer?.length || 0,
          }))
        : undefined,
    }));

    // 4. 注入下方（injectionBelow, @D=0）
    const belowSection = injectionBelow.map((m) =>
      toMsg(m, "injectionBelow", "injection"),
    );

    // 5. 尾部预设（afterChat）
    const afterSection = afterChat.map((m) => toMsg(m, "afterChat"));

    messages = [
      ...beforeSection,
      ...aboveSection,
      ...chatLogMsgs,
      ...belowSection,
      ...afterSection,
    ];
  } else {
    const chatLogEntries = margeStructPromptChatLog(prompt_struct);
    // compat 分支数组与 chat_log 不同（marge 合并），锚点按本数组另算
    const _pvCompatLuIdx = findLastUserFilesIndex(chatLogEntries);
    messages = chatLogEntries.map((chatLogEntry, _i) => {
      // uid 稳定化（0720 token 缓存归位配套）：原 Math.random() 每次构建都变 → 同一消息两次
      //   预览拼出的 content 字符串永不相等 → tokenizer 内容寻址缓存永 miss=每次全量重编码。
      //   预览专用包裹标记无随机性需求（不发给 AI），改 entry.id 前 8 位（无 id 回退索引）。
      const uid = String(chatLogEntry.id || _i).slice(0, 8);
      const textContent = `<message "${uid}">\n<sender>${chatLogEntry.name}</sender>\n<content>\n${_inlineTextFiles(chatLogEntry, chatLogEntry.content, _i === _pvCompatLuIdx && _pvCompatLuIdx >= 0)}\n</content>\n</message "${uid}">\n`;

      const message = {
        role:
          chatLogEntry.role === "user"
            ? "user"
            : chatLogEntry.role === "system"
              ? "system"
              : "assistant",
        content: textContent,
      };

      if (chatLogEntry.files?.length)
        message._files = chatLogEntry.files.map((f) => ({
          name: f.name,
          mime_type: f.mime_type,
          size: f.buffer?.length || 0,
        }));

      return message;
    });

    const system_prompt = structPromptToSingleNoChatLog(prompt_struct);
    messages.unshift({
      role: "system",
      content: system_prompt,
    });

    // 多角色提醒（fake-send token 预览路径）：检测与文案收敛到 yonban 共享层单源
    // （_shared/roleReminding.mjs isMultiChar + DEFAULT_ROLE_REMINDING_TEXT），
    // 原本文件手写第四份检测+写死文案（与 proxy/grok/ollama 三家不同源，改单源后预览计数与真发送一致）。
    // 动态 import 防壳↔yonban 加载时序耦合（同 prompt_struct.mjs buildPromptStruct 范式）。
    {
      const { isMultiChar, DEFAULT_ROLE_REMINDING_TEXT } = await import(
        "../../../../../../yonban/core/functions/api/_shared/roleReminding.mjs"
      );
      if (isMultiChar(prompt_struct.chat_log)) {
        messages.push({
          role: "system",
          content: DEFAULT_ROLE_REMINDING_TEXT.replace("{charname}", prompt_struct.Charname || ""),
        });
      }
    }

    try {
      const presetPlugin = timeSlice.plugins["beilu-preset"];
      if (presetPlugin?.interfaces?.config?.GetData) {
        // [T065] 预设 per-user：预览按本聊天 username 取该用户激活预设的 model_params（不传=读 _default 桶=错值）
        const presetData = await presetPlugin.interfaces.config.GetData(undefined, chatMetadata.username);
        modelParams = presetData.model_params || {};
      }
    } catch (e) {
      console.warn("[fake-send] 获取模型参数失败:", e.message);
      wbDetect(chatid, "requestBuilder", "buildFakeSendRequest:modelParamsFail", false, e?.message || String(e), null);
    }
  }

  const totalChars = messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );

  // 逐条 _tokens：预设编辑器 Inspect（panels.mjs 条目实际注入列表）按条显示 token 用，
  // ST message.getTokens() 同款语义（内容 token 算好缓存）。缓存实现收口在 tokenizer.mjs
  // 内容寻址 LRU 单源（0720 根修）：同内容重复构建命中缓存零编码,配套 uid 稳定化（:397）。
  // estimated_tokens 改为 Σ(4+_tokens)——与原 countMessagesTokens(messages) 完全同式，避免整体二次编码。
  let estimatedTokens = 0;
  for (const m of messages) {
    const _c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    m._tokens = await countTokens(_c);
    estimatedTokens += 4 + m._tokens;
  }

  // 提取各系统组件的原始内容（用于上下文总览视图）
  const context_parts = {
    char: {
      name: prompt_struct.Charname || charname,
      texts: (prompt_struct.char_prompt?.text || []).map((t) => ({
        content: t.content || "",
        important: t.important,
      })),
    },
    user: {
      name: prompt_struct.UserCharname || chatMetadata.username,
      texts: (prompt_struct.user_prompt?.text || []).map((t) => ({
        content: t.content || "",
        important: t.important,
      })),
    },
    world: {
      texts: (() => {
        // 优先从 world_prompt 获取
        const worldTexts = (prompt_struct.world_prompt?.text || []).map(
          (t) => ({
            content: t.content || "",
            important: t.important,
          }),
        );
        if (worldTexts.length > 0) return worldTexts;

        // 回退：从 beilu-worldbook 插件的 extension 中提取世界书内容
        const wbExt =
          prompt_struct.plugin_prompts?.["beilu-worldbook"]?.extension;
        if (wbExt) {
          const wbTexts = [];
          // before/after 位置的条目
          const charInj = wbExt.worldbook_char_injections;
          if (Array.isArray(charInj)) {
            for (const inj of charInj) {
              if (inj.content) {
                wbTexts.push({
                  content: inj.content,
                  important: 0,
                  _position: inj.position === 0 ? "before" : "after",
                });
              }
            }
          }
          // @depth 位置的条目
          const depthInj = wbExt.worldbook_injections;
          if (Array.isArray(depthInj)) {
            for (const inj of depthInj) {
              if (inj.content) {
                wbTexts.push({
                  content: inj.content,
                  important: 0,
                  _position: `@depth=${inj.depth ?? 4}`,
                });
              }
            }
          }
          if (wbTexts.length > 0) return wbTexts;
        }
        return worldTexts;
      })(),
    },
    other_chars: Object.fromEntries(
      Object.entries(prompt_struct.other_chars_prompt || {})
        .filter(([, v]) => v?.text?.length)
        .map(([k, v]) => [
          k,
          {
            texts: v.text.map((t) => ({
              content: t.content || "",
              important: t.important,
            })),
          },
        ]),
    ),
    plugins: Object.fromEntries(
      Object.entries(prompt_struct.plugin_prompts || {})
        .filter(([, v]) => v?.text?.length)
        .map(([k, v]) => [
          k,
          {
            texts: v.text.map((t) => ({
              content: t.content || "",
              important: t.important,
            })),
          },
        ]),
    ),
  };

  return {
    messages,
    model: modelParams.model || "(未配置)",
    temperature: modelParams.temperature,
    max_tokens: modelParams.max_tokens,
    stream: modelParams.stream ?? true,
    presence_penalty: modelParams.presence_penalty,
    frequency_penalty: modelParams.frequency_penalty,
    top_p: modelParams.top_p,
    top_k: modelParams.top_k,
    stop: modelParams.stop,

    _meta: {
      timestamp: new Date().toISOString(),
      chatid,
      charname,
      char_display_name: prompt_struct.Charname,
      user_display_name: prompt_struct.UserCharname,
      message_count: messages.length,
      total_chars: totalChars,
      estimated_tokens: estimatedTokens,
      // 上下文窗口(total)：供 token 条算占比。fake-send 顶层只有 max_tokens(输出上限)，
      // 这里显式带 max_context(上下文上限)，YonBan token 条 total 用它(本体亦可用)。
      // 单源收口（2026-07-13）：优先 code_token_status.limit（resolveEffectiveMaxContextLive 三层
      // per-chat 权威）——fake-send 路径的 modelParams 来自 GetData().model_params=预设 base 单层
      // 静态值（无 runtime/子模式覆盖），曾使 YonBan 分母与本体口径漂移；原 _effective_max_context
      // 分支为死键（mergeRuntimeParams/GetData 产物均无此键）已删。
      max_context: prompt_struct.plugin_prompts?.["beilu-memory"]?.extension?.code_token_status?.limit || modelParams.max_context || 0,
      commander_mode: !!commanderMode,
      // N8：补 model_params producer。promptViewer.mjs:586 读 _meta.model_params 渲染司令员模式预设参数(8项)，
      //   此前 _meta 从不含该字段 → 条件恒假 → 该 UI 永不生效。modelParams 同函数已提取(见 :448-450)。
      model_params: modelParams,
      context_parts,
      // 编程记忆 token 状态（后端 getPromptHandler 算的）透传给前端 token 条，闭合 beilu:code-token-status 链路
      code_token_status: prompt_struct.plugin_prompts?.["beilu-memory"]?.extension?.code_token_status || null,
    },
  };
  });
}

/**
 * 内容过滤：mode=both 时从 chat_log 中移除匹配黑名单关键词/用户名的条目。
 * 读 user.contentFilter（前端 settings.mjs 通过 setusersetting 同步）。
 */
function _applyContentFilter(chatLog, username) {
  const user = getUserByUsername(username);
  const cf = user?.contentFilter;
  if (!cf || cf.mode !== "both") return chatLog;
  const msgKw = Array.isArray(cf.msgKeywords) ? cf.msgKeywords.filter(Boolean) : [];
  const userBl = Array.isArray(cf.userNames) ? cf.userNames.filter(Boolean) : [];
  if (!msgKw.length && !userBl.length) return chatLog;
  return chatLog.filter(entry => {
    if (userBl.length && entry.name && userBl.some(u => String(entry.name).includes(u))) return false;
    if (msgKw.length) {
      const text = String(entry.content || "");
      if (msgKw.some(kw => text.includes(kw))) return false;
    }
    return true;
  });
}
