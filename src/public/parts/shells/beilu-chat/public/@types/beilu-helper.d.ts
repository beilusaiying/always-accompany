/**
 * beilu 美化/脚本开发 — 注入 API 类型声明
 *
 * beilu 在消息渲染 iframe 中注入一套「酒馆兼容」(SillyTavern-compat) API。
 * 美化代码 / 角色卡脚本可直接调用这些全局函数。
 *
 * 用法：在你的美化项目顶部加一行引用即可获得自动补全：
 *   /// <reference path="https://你的beilu地址/parts/shells:chat/@types/beilu-helper.d.ts" />
 *
 * ⚠ 本文件只声明「已实现」的 API（与 stCompat 运行时一一对应）。
 *   设计中提到但运行时尚未提供的符号见 README.md「未实现」一节。
 *
 * 来源对照：stCompat/runtime/*.mjs（eventSystem / variableSystem / globalManager /
 *   utils / stContext / tavernHelper / lorebookAPI）+ iframeRenderer.mjs(earlyScript)。
 */

// ════════════════════════════════════════════════════════════
// 事件系统 (eventSystem.mjs)
// ════════════════════════════════════════════════════════════

/** 事件监听句柄，调用 .stop() 注销该监听 */
interface BeiluListenerHandle {
  stop(): void;
}

/** iframe 事件常量（6 键） */
interface IframeEvents {
  MESSAGE_RECEIVED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  [k: string]: string;
}

/**
 * SillyTavern 事件常量子集（含 MESSAGE_RECEIVED / CHAT_CHANGED 等）
 * + beilu 专属契约常量（EMOTION_CHANGED / MODE_CHANGED / CHARACTER_CHANGED）。
 *
 * ⚠ 常量存在 ≠ 父页面会广播。EMOTION_CHANGED 的 producer 取决于后端情感检测是否落地；
 *    MODE_CHANGED / CHARACTER_CHANGED 当前无 producer。详见 events.d.ts 分类注释。
 */
interface TavernEvents {
  MESSAGE_RECEIVED: string;
  MESSAGE_SENT: string;
  CHAT_CHANGED: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  /** beilu 专属：检测到情感标签时广播 { emotion, message_id }（producer 待后端落地） */
  EMOTION_CHANGED: string;
  /** beilu 专属：切换模式时广播 { mode }（当前无 producer） */
  MODE_CHANGED: string;
  /** beilu 专属：切换角色时广播 { charName }（当前无 producer） */
  CHARACTER_CHANGED: string;
  [k: string]: string;
}

/** 当前情感状态（getCurrentEmotion 返回值，无来源时为 null） */
interface BeiluEmotionState {
  /** 情感标签文本，如 "开心" */
  emotion: string;
  /** 关联消息楼层索引 */
  message_id: number;
  /** 检测到的时间戳（ms） */
  timestamp: number;
}

declare global {
  // —— 事件 ——
  /** 注册事件监听，返回可 .stop() 的句柄 */
  function eventOn(type: string, listener: (...args: any[]) => void): BeiluListenerHandle;
  /** 一次性监听 */
  function eventOnce(type: string, listener: (...args: any[]) => void): BeiluListenerHandle;
  /** 注册到监听队尾 */
  function eventMakeLast(type: string, listener: (...args: any[]) => void): BeiluListenerHandle;
  /** 注册到监听队首 */
  function eventMakeFirst(type: string, listener: (...args: any[]) => void): BeiluListenerHandle;
  /** 异步派发事件（await 每个监听） */
  function eventEmit(type: string, ...args: any[]): Promise<void>;
  /** 同步派发事件 */
  function eventEmitAndWait(type: string, ...args: any[]): void;
  /** 移除指定 type 上的单个监听 */
  function eventRemoveListener(type: string, listener: (...args: any[]) => void): void;
  /** 清空某事件的全部监听 */
  function eventClearEvent(type: string): void;
  /** 跨事件移除某个 listener */
  function eventClearListener(listener: (...args: any[]) => void): void;
  /** 清空本 iframe 注册的全部监听（pagehide 时自动调用） */
  function eventClearAll(): void;

  const iframe_events: IframeEvents;
  const tavern_events: TavernEvents;

  // —— 全局对象管理 (globalManager.mjs) ——
  /** 注册全局值到父页面并广播 global_<name>_initialized */
  function initializeGlobal(name: string, value: any): void;
  /** 等待某全局就绪（已就绪立即 resolve，否则监听/轮询，30s 超时） */
  function waitGlobalInitialized(name: string): Promise<any>;

  // —— 变量系统 (variableSystem.mjs) ——
  /** 变量作用域 */
  type BeiluVarType = "global" | "character" | "chat" | "preset" | "message" | "script" | "extension";
  interface BeiluVarOption {
    type?: BeiluVarType;
    message_id?: number;
    script_id?: string;
    extension_id?: string;
  }
  /** 读某作用域变量 */
  function getVariables(option?: BeiluVarOption): Record<string, any>;
  /** 整体替换某作用域变量（并持久化到父页面） */
  function replaceVariables(variables: Record<string, any>, option?: BeiluVarOption): void;
  /** 函数式更新变量 */
  function updateVariablesWith(updater: (vars: Record<string, any>) => Record<string, any>, option?: BeiluVarOption): Record<string, any>;
  /** 合并赋值（覆盖同名 key） */
  function insertOrAssignVariables(variables: Record<string, any>, option?: BeiluVarOption): Record<string, any>;
  /** 仅插入尚不存在的 key */
  function insertVariables(variables: Record<string, any>, option?: BeiluVarOption): Record<string, any>;
  /** 删除某路径变量 */
  function deleteVariable(path: string, option?: BeiluVarOption): { variables: Record<string, any>; delete_occurred: boolean };
  /** schema 占位（当前 no-op） */
  function registerVariableSchema(schema: any, option?: BeiluVarOption): void;
  /** 合并 global→character→chat→楼层 的全部变量 */
  function getAllVariables(): Record<string, any>;

  // —— 工具 (utils.mjs) ——
  /** try/catch 包装一个函数 */
  function errorCatched<T extends (...a: any[]) => any>(fn: T): T;
  /** 最后一条消息的 id（chat.length-1） */
  function getLastMessageId(): number;
  /** 当前消息 id（earlyScript 简版被 stContext 覆盖为真实值） */
  function getCurrentMessageId(): number;
  /** {{user}}/{{char}}/{{avatar}}/{{lastMessage}} 宏替换 */
  function substitudeMacros(str: string): string;
  /** 当前 iframe 的 frameElement.id */
  function getIframeName(): string;
  /** 生成 beilu-script-<ts> 形式的脚本 id */
  function getScriptId(): string;
  /** 重载当前 iframe */
  function reloadIframe(): void;

  // —— 楼层消息 (tavernHelper.mjs) ——
  /** 读取楼层消息 */
  function getChatMessages(range?: number | string, options?: Record<string, any>): any[];
  /** 写楼层内容/变量（同步父页面） */
  function setChatMessages(chat_messages: any[], options?: Record<string, any>): Promise<void>;
  /** 旧版单条转发 */
  function setChatMessage(field_values: Record<string, any>, message_id: number, options?: Record<string, any>): Promise<void>;
  /** 插入新消息 */
  function createChatMessages(chat_messages: any[], options?: Record<string, any>): Promise<void>;
  /** 删除消息 */
  function deleteChatMessages(message_ids: number[], options?: Record<string, any>): Promise<void>;
  /** 旋转消息顺序 */
  function rotateChatMessages(begin: number, middle: number, end: number, options?: Record<string, any>): Promise<void>;
  /** 把选项文本回传到聊天输入（autoSend 可直接发送） */
  function sendChoice(text: string, options?: { autoSend?: boolean }): void;
  /** 用户名（SillyTavern.name1） */
  function getUserName(): string;
  /** 当前角色名（SillyTavern.name2） */
  function getCurrentCharacterName(): string;
  /** 热重载美化（最近 limit 条） */
  function reloadMessages(limit?: number): void;

  // —— 情感系统契约 (tavernHelper.mjs) ——
  /**
   * 读取父页面最近一次检测到的情感状态。
   *
   * ⚠ 情感检测链路当前 0% 落地：父页面无情感来源时**返回 null**（绝不造假）。
   *   后端情感检测落地后即插即用——返回 { emotion, message_id, timestamp }。
   *   配合 eventOn(tavern_events.EMOTION_CHANGED, cb) 监听变化。
   */
  function getCurrentEmotion(): BeiluEmotionState | null;

  // —— 世界书 (lorebookAPI.mjs) ——
  function getCurrentCharPrimaryLorebook(): Promise<string | null>;
  function getLorebookEntries(name: string, options?: Record<string, any>): Promise<any[]>;
  function getCharWorldbookNames(type?: string): Promise<{ primary: string }>;
  function getLorebookSettings(): Record<string, any>;

  /** 聚合对象：TavernHelper.*（多数同名展开到 window，部分仅挂在此对象） */
  const TavernHelper: {
    injectPrompts(prompts: any[]): void;
    uninjectPrompts(ids: string[]): void;
    generate(config: Record<string, any>): Promise<string>;
    generateRaw(config: Record<string, any>): Promise<{ content: string; model?: string }>;
    getTavernRegexes(): Promise<any[]>;
    replaceTavernRegexes(newRules: any[]): Promise<any[]>;
    updateTavernRegexesWith(updater: (rules: any[]) => any[]): Promise<any[]>;
    isCharacterTavernRegexesEnabled(): Promise<boolean>;
    formatAsTavernRegexedString(text: string): Promise<string>;
    triggerSlash(cmd: string): void;
    triggerSlashWithResult(cmd: string): void;
    getCurrentCharacterName(): string;
    [k: string]: any;
  };

  /**
   * beilu 正式命名空间（设计 §4.4）。
   *
   * 归集 beilu 专属/增补 API 的【规范入口】。与 TavernHelper 并存：
   *   - TavernHelper.* + 其平铺到 window 的别名【保持不动】（向后兼容，现有脚本不破）。
   *   - BeiluHelper 是【新增】命名空间，内部引用同一批 window 函数，二者等价。
   * 用户可写 BeiluHelper.eventOn(...)（规范风格）或直接 eventOn(...)（平铺风格）。
   */
  const BeiluHelper: {
    /* 事件 */
    eventOn: typeof eventOn;
    eventOnce: typeof eventOnce;
    eventMakeLast: typeof eventMakeLast;
    eventMakeFirst: typeof eventMakeFirst;
    eventEmit: typeof eventEmit;
    eventEmitAndWait: typeof eventEmitAndWait;
    eventRemoveListener: typeof eventRemoveListener;
    eventClearEvent: typeof eventClearEvent;
    eventClearListener: typeof eventClearListener;
    eventClearAll: typeof eventClearAll;
    tavern_events: TavernEvents;
    iframe_events: IframeEvents;
    /* 交互 */
    sendChoice: typeof sendChoice;
    triggerSlash: typeof triggerSlash;
    /* 变量 */
    getVariables: typeof getVariables;
    replaceVariables: typeof replaceVariables;
    updateVariablesWith: typeof updateVariablesWith;
    insertOrAssignVariables: typeof insertOrAssignVariables;
    insertVariables: typeof insertVariables;
    deleteVariable: typeof deleteVariable;
    getAllVariables: typeof getAllVariables;
    /* 全局 / iframe 间通信 */
    initializeGlobal: typeof initializeGlobal;
    waitGlobalInitialized: typeof waitGlobalInitialized;
    /* 楼层 */
    getChatMessages: typeof getChatMessages;
    setChatMessages: typeof setChatMessages;
    createChatMessages: typeof createChatMessages;
    deleteChatMessages: typeof deleteChatMessages;
    getCurrentMessageId: typeof getCurrentMessageId;
    getLastMessageId: typeof getLastMessageId;
    /* 角色/用户 */
    getUserName: typeof getUserName;
    getCurrentCharacterName: typeof getCurrentCharacterName;
    /* 提示词注入 */
    injectPrompts(prompts: any[]): void;
    uninjectPrompts(ids: string[]): void;
    /* 音频桥 */
    audio: typeof beiluAudio;
    /* 情感系统契约（无来源时 getCurrentEmotion 返回 null） */
    getCurrentEmotion: typeof getCurrentEmotion;
    /* 开发体验 */
    reloadMessages: typeof reloadMessages;
    reloadIframe: typeof reloadIframe;
    /* 版本标识 */
    version: string;
    [k: string]: any;
  };

  /** SillyTavern 兼容对象（多为本地态 stub，见 README） */
  const SillyTavern: {
    name1: string;
    name2: string;
    chatId: string;
    characterId: string;
    chat: any[];
    getCurrentChatId(): string;
    setExtensionPrompt(id: string, content: string, ...rest: any[]): void;
    eventSource: {
      on(type: string, cb: (...a: any[]) => void): void;
      once(type: string, cb: (...a: any[]) => void): void;
      emit(type: string, ...args: any[]): void;
      removeListener(type: string, cb: (...a: any[]) => void): void;
    };
    callGenericPopup(content: string, type?: number): Promise<any>;
    [k: string]: any;
  };

  /** 触发斜杠命令（postMessage beilu-slash-command） */
  function triggerSlash(cmd: string): void;

  /** 音频桥（postMessage 父页面 beilu-audio-*） */
  const beiluAudio: {
    /** track 默认 "bgm"，合法值 "bgm" | "se" | "voice"（se 短音效可叠加，不受 suspend 限制） */
    play(src: string, options?: { track?: "bgm" | "se" | "voice"; loop?: boolean; volume?: number; force?: boolean }): void;
    pause(options?: { track?: "bgm" | "se" | "voice" }): void;
    stop(options?: { track?: "bgm" | "se" | "voice" }): void;
    setVolume(v: number, options?: { track?: "bgm" | "se" | "voice" }): void;
    isPlaying(track?: "bgm" | "se" | "voice"): boolean;
    getState(): Record<string, any>;
  };
}

export {};
