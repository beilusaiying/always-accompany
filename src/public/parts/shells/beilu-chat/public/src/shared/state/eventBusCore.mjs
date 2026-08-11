/**
 * eventBusCore.mjs — __beiluEventBus 单源叶子（创建 + emit + 订阅收口）
 *
 * 【why · 2026-08-07 转接二期#6】酒馆助手/ST 的事件总线是"await + 可变引用 + 回读"的一等公民模式
 *   （ST 本体 `await eventSource.emit(type, data)`：串行 await 每个监听器，监听器改 args 对象/数组，
 *   emit 返回后宿主回读改后的值继续走——ST-P7 核实 91 事件中 14+ 个是这种可变管道：
 *   CHAT_COMPLETION_PROMPT_READY / GENERATE_BEFORE_COMBINE_PROMPTS / WORLDINFO_SCAN_DONE / 4 个 *_READY 等）。
 *   beilu 宿主侧此前 emit 实现散拼两处（websocket._emitEventBus / virtualQueue._emitStreamTokenReceived）
 *   且都是同步 fire-and-forget 不 await——async 监听器还没改完，宿主已经拿旧值继续走=可变管道语义断裂。
 *   bus 创建也散在三处（stCompat/index、iframeRenderer、chat.mjs 兜底）——形状漂移风险。
 *   本叶子把创建/emit/订阅收口成单源；iframe 内 eventSystem.mjs 的 eventEmit 已是 async 串行 await
 *   （与本实现同语义），iframe 无法 import 模块故其内联实现保留，两端操作同一个 _listeners Map。
 *
 * 【解环】零依赖叶子（timelineState/stChatShape 同款范式）：websocket/virtualQueue/panels 各方
 *   只 import 本叶子，不互相 import。
 *
 * 【功能链】
 *   producer（websocket 后端事件桥 / virtualQueue 流式 token / 未来生成链可变管道）
 *     → emitEventBus(name, ...args)（需要回读时 await）或 emitEventBusDetached（通知类，不阻塞调用链）
 *     → 串行 await 该事件全部监听器（卡内脚本经 iframe eventOn 注册的原样回调 / 宿主模块经 onEventBus 注册）
 *     → args 原引用透传：监听器改对象/数组，await emitEventBus 返回后 producer 回读生效值
 *
 * 【影响范围】window.__beiluEventBus 全部读写方；行为差异=async 监听器现在被等待（原先被丢弃时序）。
 */

/**
 * bus 单源创建/获取。形状恒 { _listeners: Map<string, Function[]> }（iframe eventSystem 同形）。
 * @returns {{_listeners: Map<string, Function[]>}}
 */
export function getEventBus() {
  if (typeof window === "undefined") return { _listeners: new Map() };
  if (!window.__beiluEventBus) window.__beiluEventBus = { _listeners: new Map() };
  const bus = window.__beiluEventBus;
  if (!bus._listeners) bus._listeners = new Map(); // 兜底修形（历史散点可能造过无 Map 的壳）
  return bus;
}

/**
 * ST await 语义 emit：串行 await 每个监听器；args 按原引用透传（可变管道）；
 * 单监听器抛错隔离（console.error 后继续下一个，与 ST catch 同语义）。
 * 需要回读的 producer：`await emitEventBus("xxx_ready", data); 用改后的 data 继续`。
 * @param {string} eventName
 * @param {...any} args - 原引用透传，监听器可改
 * @returns {Promise<any[]>} args（回读便利：await 后直接解构）
 */
export async function emitEventBus(eventName, ...args) {
  const bus = getEventBus();
  const listeners = bus._listeners.get(eventName);
  if (!listeners || listeners.length === 0) return args;
  const copy = listeners.slice(); // emit 期间增删监听器不影响本轮（ST 同语义）
  for (const cb of copy) {
    try {
      await cb(...args);
    } catch (e) {
      console.error("[eventBusCore]", eventName, e);
    }
  }
  return args;
}

/**
 * 通知类 producer 出口：不阻塞调用链（fire-and-detach），内部仍串行 await=监听器之间时序保持。
 * 适用：message_sent/generation_ended 等纯通知事件（producer 不消费监听器的改动）。
 * @param {string} eventName
 * @param {...any} args
 */
export function emitEventBusDetached(eventName, ...args) {
  emitEventBus(eventName, ...args).catch((e) => {
    // emitEventBus 内部已 per-listener 隔离，此处只兜极端（理论不可达），保诊断不吞
    console.error("[eventBusCore detached]", eventName, e);
  });
}

/**
 * 宿主模块订阅收口（替代各处手拼 `if(!map.has(name)) map.set(name,[]); map.get(name).push(cb)`）。
 * @param {string} eventName
 * @param {Function} cb
 * @returns {() => void} 退订函数
 */
export function onEventBus(eventName, cb) {
  const bus = getEventBus();
  if (!bus._listeners.has(eventName)) bus._listeners.set(eventName, []);
  const arr = bus._listeners.get(eventName);
  if (arr.indexOf(cb) === -1) arr.push(cb);
  return () => {
    const cur = bus._listeners.get(eventName);
    if (!cur) return;
    const idx = cur.indexOf(cb);
    if (idx !== -1) cur.splice(idx, 1);
  };
}
