/**
 * stChatShape.mjs — 酒馆 SillyTavern.chat 单条消息形状 builder（叶子模块，零依赖）
 *
 * 为什么存在：此前该形状在 scriptRunner._convertToSTChatFormat(iframe 初始内联)与
 *   websocket._updateScriptIframeChat(message_replaced 活更新)两处逐字重复，且
 *   swipe_id/swipes/variables 恒定长1 —— 卡切一次 swipe 后读 variables[swipe_id] 即
 *   undefined（两端转移契约表§1.3/§七#3 确诊断点）。本文件收口单源 + 升 swipe 维度。
 *
 * 对标（酒馆助手 JS-Slash-Runner）：chat_message = {message_id, name, role, is_hidden,
 *   message, swipe_id, swipes[], variables[下标=swipe序号], swipe_info[]}；
 *   variables 是"下标=swipe 序号"的数组，getAllVariables/卡脚本按 variables[swipe_id] 读。
 *
 * beilu 映射：swipe = 后端 timeLines（generation.mjs modifyTimeLine，只挂最后一条活跃消息），
 *   每条 timeline entry 是完整 chatLogEntry、各自带 extension.mvu_variables ——
 *   数据层本来就每 swipe 一份，本 builder 只负责把"当前 swipe 的那份"放到真实下标。
 *   其它 swipe 的内容/变量在后端 chatMetadata.timeLines 里，前端不持有：
 *   诚实置 ""/null，不伪造；卡按 variables[swipe_id] 读当前份 = 酒馆主语义即可满足。
 */

/**
 * 构建单条酒馆格式 chat 消息。
 *
 * @param {object} msg - beilu 消息条目（{role, name, content, extension...}，后端 entry 或前端消息对象）
 * @param {number} index - chat 数组下标（= message_id）
 * @param {string} msgText - 显示文本。调用方决定传 content 还是 content_for_show
 *   （两写点历史口径不同：scriptRunner 传 content，websocket 传 content_for_show||content，各自保持）
 * @param {{timeLineIndex: number, timeLinesCount: number}|null} timelineInfo -
 *   仅时间线尾消息（最后一条非 user 消息）传，其余消息传 null
 * @param {string} fallbackUserName - msg.name 缺失时 user 角色的兜底名
 * @param {string} fallbackCharName - msg.name 缺失时 assistant 角色的兜底名
 * @returns {object} 酒馆格式 chat 消息
 */
export function buildStChatMessage(msg, index, msgText, timelineInfo, fallbackUserName, fallbackCharName) {
  const stRole = msg.role === "user" ? "user" : "assistant";
  const hidden = !!msg.extension?._hidden;
  const vars = msg.extension?.mvu_variables || {};

  let swipeId = 0;
  let swipes = [msgText];
  let variables = [vars];
  let swipeInfo = [{}];
  const count = timelineInfo?.timeLinesCount || 1;
  if (timelineInfo && count > 1) {
    swipeId = Math.min(Math.max(timelineInfo.timeLineIndex || 0, 0), count - 1);
    swipes = new Array(count).fill("");
    swipes[swipeId] = msgText;
    variables = new Array(count).fill(null);
    variables[swipeId] = vars;
    swipeInfo = Array.from({ length: count }, () => ({}));
  }

  return {
    // === 酒馆助手 API 字段 ===
    message_id: index,
    name: msg.name || (stRole === "user" ? fallbackUserName : fallbackCharName),
    role: stRole,
    is_hidden: hidden,
    is_user: stRole === "user",
    message: msgText,
    data: {},
    extra: {},
    // === 酒馆内部字段（setChatMessages / getVariables 依赖） ===
    // 隐藏态(extension._hidden)映射到 ST is_system，使 getChatMessages 的 hide_state 过滤 + is_hidden 输出正确
    // （websocket 旧写点曾硬编码 is_system:false，与 scriptRunner 口径不一致——收口后统一按隐藏态）
    is_system: hidden,
    mes: msgText,
    swipe_id: swipeId,
    swipes,
    variables,
    swipe_info: swipeInfo,
  };
}
