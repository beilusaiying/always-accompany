/**
 * timelineState.mjs — 时间线(swipe)状态单源（叶子模块，零依赖）
 *
 * 为什么存在：swipe(=后端 timeLines)的 {当前下标,总数} 此前是 virtualQueue.mjs 模块私有变量，
 *   而 ST 兼容层两个 chat 数组写点(scriptRunner 初始内联 / websocket _updateScriptIframeChat 活更新)
 *   也需要它来给最后一条消息真实 swipe_id(两端转移契约表§七#3 "message 变量定长1"断点)。
 *   三方直接互 import 会造 scriptRunner→virtualQueue→websocket 三角环，故状态下沉叶子：
 *   谁都能引，本文件不引任何人（与 svr_state.mjs 后端解环同款范式）。
 *
 * 写点：virtualQueue initializeVirtualQueue(bind 初始值) / handleTimelineInfo(WS timeline_info 广播)。
 * 读点：virtualQueue swipe 计数器(❮ N/M ❯) / scriptRunner._convertToSTChatFormat /
 *       websocket._updateScriptIframeChat。
 * 功能链：后端 generation.mjs modifyTimeLine 广播 timeline_info → websocket 路由 →
 *   virtualQueue.handleTimelineInfo → setTimelineInfo → 各读点。
 * 语义约束：时间线只挂最后一条活跃消息(modifyTimeLine 的 findLastActiveIndex replace 语义，
 *   与 swipe-nav 箭头只出现在末条 char 消息同判据)。
 */

let _timelineInfo = { timeLineIndex: 0, timeLinesCount: 1 };

/**
 * @returns {{timeLineIndex: number, timeLinesCount: number}} 当前时间线信息（浅拷贝，防调用方改单源）
 */
export function getTimelineInfo() {
  return { ..._timelineInfo };
}

/**
 * @param {{timeLineIndex?: number, timeLinesCount?: number}|null} info
 */
export function setTimelineInfo(info) {
  _timelineInfo = {
    timeLineIndex: info?.timeLineIndex ?? 0,
    timeLinesCount: info?.timeLinesCount ?? 1,
  };
}
