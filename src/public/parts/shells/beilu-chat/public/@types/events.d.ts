/**
 * beilu 事件名 + 事件数据类型声明
 *
 * 配合 beilu-helper.d.ts 使用：
 *   /// <reference path="https://你的beilu地址/parts/shells:chat/@types/events.d.ts" />
 *
 * ⚠ 重要：本文件区分「设计中的事件」与「父页面真正广播的事件」。
 *   美化代码只能收到「父页面真正广播」的那几个；其余常量虽存在于 tavern_events，
 *   但当前运行时没有 producer（无人 emit），监听它们不会触发。
 *
 * 来源对照：websocket.mjs _emitEventBus()（父页面唯一广播出口，:470/484/485/486/536/537）
 *   + 设计文档 渲染方案_设计.md §4.5 父页面事件源表。
 */

declare global {
  // ════════════════════════════════════════════════════════════
  // ① 父页面真正广播的事件（6 个，可被美化代码收到）
  // ════════════════════════════════════════════════════════════
  /**
   * 当前运行时父页面（websocket.mjs）实际 emit 的事件名。
   * 只有这 6 个监听后会真正触发；其余 tavern_events 常量是「设计占位」。
   */
  type BeiluLiveEventName =
    | "message_sent"          // 用户消息已发送（websocket.mjs:470）
    | "message_received"      // 收到新消息，arg0 = message index（:484）
    | "generation_started"    // AI 开始生成（:537）
    | "generation_ended"      // AI 生成结束，arg0 = message index（:485）
    | "js_generation_started" // 同上，js_ 前缀变体（:536）
    | "js_generation_ended";  // 同上，js_ 前缀变体（:486）

  /** message_received / generation_ended 携带的参数：消息楼层索引 */
  type BeiluMessageIndexArg = number;

  // ════════════════════════════════════════════════════════════
  // ② 设计中规划、但运行时尚未广播的事件（监听不会触发）
  // ════════════════════════════════════════════════════════════
  /**
   * 渲染方案_设计.md §4.5 规划但当前无 producer 的事件。
   * tavern_events 里有的（CHAT_CHANGED / EMOTION_CHANGED / MODE_CHANGED /
   * CHARACTER_CHANGED 等）现在都能拿到常量字符串（见 eventConstants.mjs），
   * 但父页面是否 emit 取决于对应检测/广播是否落地：
   *   - CHAT_CHANGED / MESSAGE_UPDATED / MESSAGE_DELETED / VARIABLE_UPDATED：
   *     常量在 tavern_events，但父页面缺 _emitEventBus 调用（无 producer）。
   *   - EMOTION_CHANGED：契约已就位（常量 + getCurrentEmotion 占位 + 事件分发管道），
   *     producer 待后端情感检测落地后调 window.emitEmotionChanged() 触发——即插即用。
   *   - MODE_CHANGED / CHARACTER_CHANGED：有常量，无 producer（模式/角色切换检测未广播）。
   *
   * 在对应 producer 未落地前，监听这些事件不会触发。
   */
  interface BeiluDesignedEventData {
    /** 消息被编辑/替换（常量在 tavern_events，父页面未广播） */
    MESSAGE_UPDATED: { message_id: number; content: string };
    /** 消息被删除（常量在 tavern_events，父页面未广播） */
    MESSAGE_DELETED: { message_id: number };
    /** 流式 token（未实现） */
    STREAM_TOKEN_RECEIVED: { message_id: number; token: string; full_content: string };
    /** 检测到情感标签（常量都不存在，链路 0% 落地） */
    EMOTION_CHANGED: { emotion: string; message_id: number };
    /** 切换聊天文件（常量在 tavern_events，父页面未广播） */
    CHAT_CHANGED: { chatId: string };
    /** 切换角色（常量都不存在） */
    CHARACTER_CHANGED: { charName: string };
    /** 切换模式（常量都不存在） */
    MODE_CHANGED: { mode: string };
    /** 变量被修改（常量在 tavern_events，父页面未广播） */
    VARIABLE_UPDATED: { type: string; message_id: number; variables: Record<string, any> };
  }
}

export {};
