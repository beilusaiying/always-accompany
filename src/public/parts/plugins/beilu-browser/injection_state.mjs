/**
 * beilu-browser 共享注入状态
 *
 * 这个模块是 beilu-browser 插件和 beilu-chat 前端之间的桥梁。
 * ES 模块在同一进程中是单例的，所以两边 import 同一个模块实例。
 *
 * 流程（双通道模式：用户消息 + GetPrompt 内容注入）：
 * 1. 油猴脚本 POST pushPage（带 message + content）→ setPendingBrowserInjection()
 * 2. beilu-chat 前端轮询 GetData → hasPending: true
 * 3. 前端调用 consumeBrowser → 后端消费此处 pending 数据 + 存入 main.mjs 的一次性 GetPrompt 注入缓存
 * 4. 前端调用 addUserReply("[beilu-browser-page] 我正在浏览: ...")
 *    - 用户消息让 {{lastUserMessage}} 宏能捕获
 *    - 消息默认在聊天界面隐藏（messageList.mjs 过滤 [beilu-browser-page] 前缀）
 * 5. AI 回复时 GetPrompt → 从一次性缓存读取完整页面内容并注入 → 用后即清
 *
 * 关键特性：
 * - 用户消息：简短标记（标题+URL），前端视觉隐藏，可通过"显示感知消息"开关显示
 * - 页面内容：通过 GetPrompt 一次性注入（20000字符级别），不出现在聊天界面
 * - {{lastUserMessage}} 宏能捕获浏览器感知消息
 * - 自动注入缓存中的快照作为补充上下文
 */

/** @type {{ url: string, title: string, content: string, selectedText: string, message: string, timestamp: number } | null} */
let _pendingInjection = null;

/** 注入数据 TTL（毫秒）：超过此时间自动视为过期并丢弃 */
const INJECTION_TTL_MS = 60_000;

/**
 * 检查 pending 数据是否已过期，过期则自动清理
 * @returns {boolean} true = 有效数据存在
 */
function checkAndExpire() {
  if (!_pendingInjection) return false;
  const age = Date.now() - _pendingInjection.timestamp;
  if (age > INJECTION_TTL_MS) {
    console.log(
      "[beilu-browser] pending 注入已过期，自动清理",
      "| age:",
      Math.round(age / 1000),
      "秒",
      "| title:",
      _pendingInjection.title,
      "| TTL:",
      INJECTION_TTL_MS / 1000,
      "秒",
    );
    _pendingInjection = null;
    return false;
  }
  return true;
}

/**
 * 设置待注入的浏览器页面数据
 * @param {{ url: string, title: string, content?: string, selectedText?: string, message?: string }} data
 */
export function setPendingBrowserInjection(data) {
  _pendingInjection = {
    url: data.url || "",
    title: data.title || "",
    content: data.content || "",
    selectedText: data.selectedText || "",
    message: data.message || "",
    timestamp: Date.now(),
  };
  console.log(
    "[beilu-browser] 收到页面注入:",
    _pendingInjection.title,
    "| message:",
    _pendingInjection.message
      ? _pendingInjection.message.substring(0, 50)
      : "(无)",
  );
}

/**
 * 消费（取出并清除）待注入数据
 * 调用后 pendingInjection 变为 null，实现一次性注入
 * 增加 TTL 过期检查 + 原子消费日志
 * @returns {{ url: string, title: string, content: string, selectedText: string, message: string, timestamp: number } | null}
 */
export function consumePendingBrowserInjection() {
  if (!checkAndExpire()) return null;
  const data = _pendingInjection;
  _pendingInjection = null;
  if (data) {
    console.log(
      "[beilu-browser] pending 已消费",
      "| age:",
      Math.round((Date.now() - data.timestamp) / 1000),
      "秒",
      "| title:",
      data.title,
      "| contentLen:",
      data.content?.length || 0,
    );
  }
  return data;
}

/**
 * 检查是否有待注入数据（不消费）
 * 含 TTL 过期检查
 * @returns {boolean}
 */
export function hasPendingBrowserInjection() {
  return checkAndExpire();
}

/**
 * 获取待注入数据的状态（不消费）
 * 含 TTL 过期检查
 * @returns {{ hasPending: boolean, message: string|null, title: string|null, url: string|null }}
 */
export function getPendingBrowserStatus() {
  if (!checkAndExpire())
    return { hasPending: false, message: null, title: null, url: null };
  return {
    hasPending: true,
    message: _pendingInjection.message,
    title: _pendingInjection.title,
    url: _pendingInjection.url,
  };
}
