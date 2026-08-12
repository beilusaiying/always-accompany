/**
 * [endpoints.mjs] — 聊天会话的所有后端 API 封装层。不管 WS 通信（那是 websocket.mjs 的事），
 *   不管消息渲染（那是 virtualQueue/messageList 的事）。
 *
 * 职责：
 *   1. callApi()：以 currentChatId 为路由前缀，统一向后端 /api/parts/shells:chat/:chatid/* 发请求
 *   2. 聊天生命周期：createNewChat / getInitialData / getChatLog / getChatLogLength
 *   3. 角色/插件/人设/世界：addCharacter / removeCharacter / addPlugin / setPersona / setWorld
 *   4. 消息操作：addUserReply / deleteMessage / deleteMessagesRange / editMessage / modifyTimeLine
 *   5. currentChatId 单源：setCurrentChatId / currentChatId 导出，供各模块读写当前会话
 *
 * 链路：chat.mjs → getInitialData() → POST /api/parts/shells:chat/:chatid/get_initial_data
 *       messageInput.mjs → addUserReply() → POST /api/parts/shells:chat/:chatid/addreply
 *       messageList.mjs → deleteMessage / editMessage / modifyTimeLine
 *       conversationManager.mjs → createNewChat / fetchChatList（直接走 apiFetch）
 * 影响：不写 DOM；不写 localStorage；仅发 HTTP 请求并返回响应数据
 * 相交：← chat.mjs / messageInput.mjs / messageList.mjs / virtualQueue.mjs / conversationManager.mjs
 *       → api-client.mjs（apiFetch：timeout+401 统一处理）
 *       → whitebox.mjs（wbTrace/wbDetect：链路追踪）
 *
 * 点击后发生什么：
 *   发送消息按钮 → messageInput.mjs sendMessage() → addUserReply() → POST addreply → WS 推流回来
 *   新建对话 → conversationManager.mjs createNewChat() → POST /new → 返回新 chatId
 *   加载聊天 → chat.mjs getInitialData() → POST get_initial_data → 全量初始状态下发
 */
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { apiFetch } from "./api-client.mjs";
import { sendAction } from "./sendAction.mjs"; // T6b批7：具名 REST 出向（createNewChat/deleteMessagesRange）收口到门面；callApi 通用 per-chatId 传输核不收（见其注释）
import { isValidChatId } from "../state/sharedState.mjs";
import { DEFAULTS } from "../../config/defaults.mjs"; // T2 config 收口：超时值单源

/**
 * 当前聊天ID。
 * @type {string|null}
 */
export let currentChatId = null

/**
 * 设置当前聊天ID（W59: 供chat.mjs自动获取聊天时调用）
 * @param {string} id
 */
export function setCurrentChatId(id) {
  currentChatId = id;
}

/** 用户切换成功后同步当前对话；初连/重连不得调用。 */
export function announceActiveChat(chatId) {
  if (!chatId) return Promise.resolve(null);
  return apiFetch("/api/parts/shells:chat/switch-active", {
    method: "POST",
    body: { chatid: chatId },
  });
}

/**
 * 调用API。
 * @param {string} endpoint - 端点。
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [method='POST'] - 方法。
 * @param {object} [body] - 正文。
 * @returns {Promise<any>} - 响应数据。
 */
// T6b批7 不收口理由：callApi 是通用 per-chatId 传输核（endpoint/method 动态，服务
//   char/message/log?query/timeline/plugin/:x/trigger-reply/initial-data/chars/plugins 等 ~13 类端点，
//   本身即「所有后端 API 封装层」= sendAction 的同层 peer）。走门面需为每端点注册 verb 或用通用透传，
//   前者=一次架构级重写、后者=破坏门面 fail-loud 精确路由契约（双层传输）。故本核保留 apiFetch，
//   仅收口本文件内两个「具名离散 REST 出向」createNewChat / deleteMessagesRange（与 conversationManager 同类）。
async function callChatApi(chatId, endpoint, method = 'POST', body) {
	if (!chatId) {
		const err = new Error(`[callChatApi] chatId 为空，无法调用 ${method} ${endpoint}`)
		console.warn(err.message)
		throw err
	}
	const url = `/api/parts/shells:chat/${chatId}/${endpoint}`
	console.log(`[callApi] ${method} ${url}`, body ? '(有body)' : '')
	wbTrace("endpoint", "callApi", { method, endpoint })

	let response
	try {
		response = await apiFetch(url, { method, body, timeout: DEFAULTS.request.timeoutMs, raw: true })
	} catch (fetchErr) {
		wbDetect("endpoint", "callApi:network", false, fetchErr.message, { method, endpoint })
		window._reportError?.(`[API] ${method} ${url}: ${fetchErr.message}`, fetchErr.stack);
		throw fetchErr
	}

	if (!response.ok) {
		let errorBody = {}
		try {
			errorBody = await response.json()
		} catch (_) { /* response 可能不是 JSON */ }
		if (response.status !== 404) {
			wbDetect("endpoint", "callApi:http", false, `${method} ${endpoint} → ${response.status}`, { status: response.status })
			console.error(`[callApi] ★ 请求失败: ${method} ${url} → ${response.status}`, errorBody)
			window._reportError?.(`[API] ${method} ${url} → ${response.status}`, null, { url });
		}
		throw Object.assign(new Error(`API request failed with status ${response.status}`), errorBody, { response })
	}

	try {
		return await response.json();
	} catch (parseErr) {
		console.error('[callApi] Response not JSON:', parseErr);
		window._reportError?.(`[callApi] JSON parse failed: ${response.url}`, parseErr.stack);
		return {};
	}
}

async function callApi(endpoint, method = 'POST', body) {
	return callChatApi(currentChatId, endpoint, method, body)
}

/**
 * 创建新聊天。
 * @returns {Promise<string>} - 新聊天的ID。
 */
export async function createNewChat(charName) {
	try {
		// T6b批7：POST /new（body {charName}）→ sendAction shells:chat#createChat（带 body 变体）。
		//   !ok 由门面统一抛错走 catch（原 `if(!response.ok) throw` 等价）。
		const data = await sendAction({ verb: "createChat", target: "shells:chat", source: "web", payload: { charName } });
		return data;
	} catch (err) {
		console.error('[endpoints] createNewChat failed:', err);
		window._reportError?.(`[endpoints] createNewChat: ${err.message}`, err.stack);
		throw err;
	}
}

/**
 * 添加角色。
 * @param {string} charname - 角色名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function addCharacter(charname) {
	return callApi('char', 'POST', { charname })
}

/**
 * 移除角色。
 * @param {string} charname - 角色名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function removeCharacter(charname) {
	return callApi(`char/${charname}`, 'DELETE')
}

/**
 * 添加插件。
 * @param {string} pluginname - 插件名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function addPlugin(pluginname) {
	return callApi('plugin', 'POST', { pluginname })
}

/**
 * 移除插件。
 * @param {string} pluginname - 插件名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function removePlugin(pluginname) {
	return callApi(`plugin/${pluginname}`, 'DELETE')
}

/**
 * 设置世界。
 * @param {string} worldname - 世界名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function setWorld(worldname) {
	return callApi('world', 'PUT', { worldname })
}

/**
 * 设置角色。
 * @param {string} personaname - 角色名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function setPersona(personaname) {
	return callApi('persona', 'PUT', { personaname })
}

/**
 * 触发角色回复。
 * @param {string} charname - 角色名称。
 * @returns {Promise<any>} - 响应数据。
 */
export function triggerCharacterReply(charname) {
	return callApi('trigger-reply', 'POST', { charname })
}

/**
 * 添加用户回复。
 * @param {string} reply - 回复内容。
 * @param {string} [singleInject] - 单次注入·文本：仅对本次生成生效的临时 system 指令（不存条目）。
 * @param {string[]} [onceInjectIds] - 单次注入·条目引用（0726 注入坞）：本轮临时启用的 INJ 条目 id。
 *   与 singleInject 并存不互斥——前者引用条目走 INJ 正线（保留各自 role/depth/order/宏），
 *   后者是「这次就说一句、不想存成条目」。两者都仅本轮生效，均不落盘。
 * @returns {Promise<any>} - 响应数据。
 */
export function addUserReply(reply, singleInject, onceInjectIds, windowMode) {
	// [0719 幂等契约] client_msg_id=本次逻辑发送的幂等键：传输层重放（超时重试等）携带同一 id，
	// 后端窗内命中不重写不重触发（chatOps 幂等窗）。用户再次点击=新调用=新 id（新意图不去重）。
	// [20260726 窗口模式随请求] window_mode=本次发送时用户所在窗口的模式（TAB_TO_MODE[activeTab]）。
	//   why：模式是**窗口的运行时事实**，此前从不随请求上送，后端只能回退去磁盘查
	//   `active_modes_map[chatid]`（把窗口身份存到对话身上）——两个窗口同时跑就互相覆盖那张表。
	//   后端 resolveGenerationMode 的第一优先级本就是 `arg.mode`（通道早在，无人喂），此处补上生产者。
	//   空值=不带（后台链/异常路径维持原磁盘兜底，零回归）。
	return callApi('message', 'POST', {
		reply,
		single_inject: singleInject || '',
		single_inject_ids: Array.isArray(onceInjectIds) ? onceInjectIds : [],
		...(windowMode ? { window_mode: windowMode } : {}),
		client_msg_id: crypto.randomUUID(),
	})
}

/**
 * 删除消息。
 * @param {string} chatId - 点击/批删启动时冻结的对话 ID；执行时不读 currentChatId。
 * @param {number} indexHint - 消息索引提示；后端以 messageId 为准。
 * @param {string} messageId - 消息稳定 ID。
 * @returns {Promise<any>} - 响应数据。
 */
export function deleteMessage(chatId, indexHint, messageId) {
	if (!Number.isInteger(indexHint) || indexHint < 0) {
		throw new TypeError("[deleteMessage] indexHint 必须是非负整数")
	}
	if (typeof messageId !== "string" || !messageId) {
		throw new TypeError("[deleteMessage] messageId 必须是非空字符串")
	}
	return callChatApi(
		chatId,
		`message/${indexHint}?messageId=${encodeURIComponent(messageId)}`,
		'DELETE',
	)
}

/**
 * 编辑消息。
 * @param {string} chatId - 渲染时冻结的对话 ID。
 * @param {number} indexHint - 原始 chatLog 索引提示。
 * @param {string} messageId - 消息稳定 ID，后端唯一身份。
 * @param {object} content - 编辑补丁；未显式提供 files/extension 时后端保留旧值。
 * @param {string} editOperationId - 一次编辑意图的稳定幂等键；网络未知结果重试必须复用。
 * @returns {Promise<any>} - 响应数据。
 */
export async function editMessage(chatId, indexHint, messageId, content, editOperationId) {
	if (!Number.isInteger(indexHint) || indexHint < 0) {
		throw new TypeError("[editMessage] indexHint 必须是非负整数")
	}
	if (typeof messageId !== "string" || !messageId.trim()) {
		throw new TypeError("[editMessage] messageId 必须是非空字符串")
	}
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		throw new TypeError("[editMessage] content 必须是对象")
	}
	if (typeof editOperationId !== "string" || !editOperationId.trim()) {
		throw new TypeError("[editMessage] editOperationId 必须是非空字符串")
	}
	const normalizedMessageId = messageId.trim()
	const normalizedOperationId = editOperationId.trim()
	const editBody = {
		messageId: normalizedMessageId,
		content,
		editOperationId: normalizedOperationId,
	}
	try {
		return await callChatApi(chatId, "message/" + indexHint, 'PUT', editBody)
	} catch (error) {
		const status = error?.response?.status
		const unknownCommit = !error?.response || status >= 500 || error?.chatCommitted === true
		if (!unknownCommit) throw error
		try {
			return await callChatApi(
				chatId,
				"message/" + indexHint + "/edit-operation/" + encodeURIComponent(normalizedOperationId) + "/reconcile",
				'POST',
				{ messageId: normalizedMessageId, content },
			)
		} catch (reconcileError) {
			if (reconcileError?.response?.status !== 404) {
				error.reconciliationError = reconcileError
				throw error
			}
		}
		// 对账明确未命中后只重放同一个 operationId；服务端 owner 串行化使并发首请求
		// 即使稍后提交，也只会命中同一回执，不会形成第二次编辑。
		return callChatApi(chatId, "message/" + indexHint, 'PUT', editBody)
	}
}

/**
 * 获取角色列表。
 * @returns {Promise<any>} - 角色列表。
 */
export function getCharList() {
	return callApi('chars', 'GET')
}

/**
 * 获取插件列表。
 * @returns {Promise<any>} - 插件列表。
 */
export function getPluginList() {
	return callApi('plugins', 'GET')
}

/**
 * 获取聊天记录。
 * @param {number} start - 开始索引。
 * @param {number} end - 结束索引。
 * @returns {Promise<any>} - 聊天记录。
 */
export function getChatLog(start, end) {
	return callApi(`log?start=${start}&end=${end}`, 'GET')
}

/**
 * 获取聊天记录长度。
 * @returns {Promise<any>} - 聊天记录长度。
 */
export function getChatLogLength() {
	return callApi('log/length', 'GET')
}

/**
 * 修改时间线。
 * @param {number} delta - 时间增量。
 * @returns {Promise<any>} - 响应数据。
 */
export function modifyTimeLine(delta) {
	return callApi('timeline', 'PUT', { delta })
}

/**
 * 设置时间线绝对索引（用于 iframe 内 switchSwipe 切换到指定开场白）。
 * @param {number} absoluteIndex - 目标时间线索引。
 * @returns {Promise<any>} - 响应数据。
 */
export function setTimeLineAbsolute(absoluteIndex) {
	return callApi('timeline', 'PUT', { absoluteIndex })
}

/**
 * 获取初始数据。
 * @returns {Promise<any>} - 初始数据。
 */
export function getInitialData() {
	return callApi('initial-data', 'GET')
}

/**
 * 批量删除消息范围（文件模式隔离用）
 * @param {string} chatid - 聊天 ID
 * @param {number} startIndex - 起始索引（含）
 * @param {number} [endIndex] - 结束索引（不含），默认到末尾
 * @param {{anchorMessageId: string}} options - 稳定范围锚点；后端按 ID 重新定位起点。
 * @returns {Promise<{success: boolean, applied: boolean, deleted: number}>}
 */
export async function deleteMessagesRange(chatid, startIndex, endIndex, options = {}) {
	const anchorMessageId = typeof options.anchorMessageId === "string" ? options.anchorMessageId.trim() : "";
	if (!anchorMessageId) throw new Error("deleteMessagesRange requires anchorMessageId");
	// T6b批7：POST /:chatId/messages/delete-range → sendAction shells:chat#deleteMessagesRange
	//   （chatId 进 URL，{startIndex,endIndex} 进 body）。!ok 由门面统一抛错（原 `if(!response.ok) throw` 等价）。
	return sendAction({
		verb: "deleteMessagesRange",
		target: "shells:chat",
		source: "web",
		scope: { chatId: chatid },
		payload: {
			startIndex,
			endIndex,
			anchorMessageId,
		},
	})
}

if (window.location.hash) {
	const _initHash = window.location.hash.substring(1);
	if (isValidChatId(_initHash)) currentChatId = _initHash;
}

window.addEventListener("hashchange", () => {
	const newId = window.location.hash.substring(1)
	if (!isValidChatId(newId)) return;
	if (newId && newId !== currentChatId)
		import("../chat-core/chat.mjs")
			.then((m) => m.switchCharacterScope?.(newId))
			.then(() => window.emitBeiluEvent?.("chat_id_changed", { chatid: newId }))
			.catch((e) => { console.warn("[hashchange] 后退/前进切换失败:", e?.message); setCurrentChatId(newId) }) // T6-D1：降级兜底也走唯一 setter，消灭第二写点（行为等价）
})
