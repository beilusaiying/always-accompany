/**
 * [utils.mjs] — 前端通用工具函数库（无副作用的纯函数 + 少量 UI 常量）。
 *
 * 功能链：各前端模块 → import 具体函数 → 本地计算/转换 → 返回结果（无网络请求、无 DOM 副作用；
 *   例外为右键菜单/内联编辑机制件：positionContextMenu / bindClickOutsideClose / copyWithFeedback /
 *   mountInlineEdit——操作调用方传入的元素，本模块不持有 DOM）。
 *   escapeHtml：用户输入/AI 输出文本 → 转义 5 个危险字符 → 安全插入 innerHTML。
 *   resolveAvatar：avatar 原始值（文件名/URL/空串/宏字符串）→ 解析为可直接用于 <img src> 的 URL。
 *   processTimeStampForId：时间戳字符串 → 合法 HTML id（替换空格/点/斜线/冒号为下划线）。
 *   arrayBufferToBase64：二进制 ArrayBuffer → Base64 字符串（用于图片/文件上传前编码）。
 *   positionContextMenu：右键菜单 DOM 元素 + 鼠标坐标 → 计算视口边界 → 写入 style.left/top 防溢出。
 *
 * why：escapeHtml / resolveAvatar 等工具函数历史上各处手写，实现不一致（有的漏转义单引号，
 *   有的对空 avatar 用 falsy 静默跳过留破图）。集中到本文件可让全前端共用经过验证的唯一实现，
 *   bug 修一处即全局生效（C7 头像 404 契约、W72 XSS 防护均依赖本文件）。
 *
 * 关联链：
 *   被 import → chat.mjs / messageList.mjs / sidebar.mjs / 各 UI 组件 / 几乎所有前端模块
 *   无外部 import（本文件是纯工具层，不依赖其他 shared/state/ 模块，防循环依赖）
 *
 * 影响范围：
 *   - 改动 escapeHtml() → 影响全前端所有 innerHTML 插入点的 XSS 防护
 *   - 改动 resolveAvatar() → 影响所有角色卡/人设/世界书头像显示（含 fallback 逻辑）
 *   - 改动 DEFAULT_AVATAR → 影响所有无头像时显示的默认占位图
 *   - 改动 SWIPE_THRESHOLD / TRANSITION_DURATION → 影响滑动手势触发灵敏度和动画时长
 *   - 改动 positionContextMenu() → 影响所有右键菜单的屏幕边界防溢出行为
 *
 * 使用效果：
 *   - 用户发送消息时：escapeHtml() 确保 AI 回复中的 HTML 特殊字符被安全渲染，不执行为脚本
 *   - 用户看角色头像时：resolveAvatar() 确保文件名/相对路径/空值都能正确解析为图片 URL
 *   - 用户右键菜单在屏幕边缘时：positionContextMenu() 自动收回避免超出视口
 */

/**
 * HTML 转义（项目唯一权威实现，全前端复用）。
 * 转义 & < > " ' 五字符——属性上下文(含单/双引号)与文本上下文均安全。
 * null/undefined/数字一律 String() 兜底，等价于各旧实现的 if(!str) 守卫。
 * @param {*} s - 任意输入。
 * @returns {string} - 转义后的字符串。
 */
export function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * 处理时间戳以用作ID。
 * @param {string} time_stamp - 时间戳。
 * @returns {string} - 处理后的ID。
 */
export function processTimeStampForId(time_stamp) {
	return time_stamp?.replaceAll?.(/[\s./:]/g, '_')
}

/**
 * 将ArrayBuffer转换为Base64。
 * @param {ArrayBuffer} buffer - ArrayBuffer。
 * @returns {string} - Base64字符串。
 */
export function arrayBufferToBase64(buffer) {
	let binary = ''
	const bytes = new Uint8Array(buffer)
	for (let i = 0; i < bytes.byteLength; i++)
		binary += String.fromCharCode(bytes[i])
	return window.btoa(binary)
}

/**
 * 滑动阈值。
 * @type {number}
 */
export const SWIPE_THRESHOLD = 50
/**
 * 过渡持续时间。
 * @type {number}
 */
export const TRANSITION_DURATION = 500
/**
 * 默认头像。
 * @type {string}
 */
export const DEFAULT_AVATAR = '/parts/shells:beilu-chat/icons/line-md__person.svg'

/**
 * 统一解析头像 URL（C7 头像 404 契约单一权威）。
 *
 * 收敛三种情况到同一可预期行为，避免 `avatar:""` 被 falsy 静默跳过留破图/裸 alt：
 *  - avatar 为非空字符串 → 解析为可访问 URL（data:/http/绝对路径原样，相对文件名拼 /parts/{kind}:{name}/{file}）
 *  - avatar === ""（后端契约：明确无头像）→ 返回 fallback（默认显式占位，非必败 404）
 *  - avatar 缺失/undefined（details 未加载等）→ 返回 fallback
 * 未替换的宏字符串（如 "{{avatar}}"）视为无效，走 fallback。
 *
 * @param {Object} opts
 * @param {string} [opts.avatar] 原始 avatar 值（文件名/URL/data:/空串/undefined）
 * @param {string} [opts.kind]   parts 命名空间（如 'chars' / 'personas' / 'worlds' / 'plugins'）
 * @param {string} [opts.name]   part 名称，用于拼相对路径
 * @param {string} [opts.fallback=DEFAULT_AVATAR] 兜底 URL
 * @returns {string} 始终返回非空可用 URL
 */
export function resolveAvatar({ avatar, kind, name, fallback = DEFAULT_AVATAR } = {}) {
	let raw = avatar
	// 未替换的宏（{{avatar}} 等）视为无效
	if (typeof raw === 'string' && /\{\{.*\}\}/.test(raw)) raw = ''
	// 空串 / undefined / null → 显式 fallback（核心：不再 falsy 静默跳过）
	if (!raw || typeof raw !== 'string') return fallback
	// 已是可访问 URL，原样返回
	if (raw.startsWith('data:') || raw.startsWith('http') || raw.startsWith('/')) return raw
	// 相对文件名 → /parts/{kind}:{name}/{file}；缺 kind/name 无法拼，退回 fallback
	if (kind && name) return `/parts/${kind}:${encodeURIComponent(name)}/${raw}`
	return fallback
}

export function positionContextMenu(menuEl, clientX, clientY) {
	const rect = menuEl.getBoundingClientRect();
	let left = clientX, top = clientY;
	if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
	if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
	menuEl.style.left = Math.max(4, left) + "px";
	menuEl.style.top = Math.max(4, top) + "px";
}

/**
 * bot 对话线标记符号——前端单源（0715 收口:近期diff审计,此前 utils/chat/conversationManager/
 * companion/discordBotPanel 五处 "🤖" 字面量散写零守卫,改一处漏一处=bot 线在普通列表泄露或消失）。
 * 权威=后端 chatOps.mjs BOT_CHAT_SYMBOL(浏览器无法 import 服务端模块,跨 runtime 镜像,
 * 改必同步两处——此前是"改必同步五处")。
 */
export const BOT_CHAT_SYMBOL = "🤖";

/**
 * 「对话是否属于某角色」过滤单一权威。[D7 迁移 0713] 本体原住 chat-core/chat.mjs——/new 等轻入口页
 * import 会拉起整条 chat 重链,于是各自手抄(public/new/index.mjs 曾漏 primaryCharName 判断+bot 排除,
 * 跨角色误命中已有对话)。纯函数无依赖,迁本文件;chat.mjs re-export 保持既有消费者路径不变。
 * 规则:BOT_CHAT_SYMBOL 前缀 customName=bot 线一律排除;primaryCharName 优先,chars 数组兜底。
 * @param {object} chat - getchatlist 返回的聊天摘要
 * @param {string} charName - 角色名
 * @returns {boolean}
 */
export function chatBelongsToChar(chat, charName) {
	if (!chat || !charName) return false;
	if ((chat.customName || "").startsWith(BOT_CHAT_SYMBOL)) return false;
	if (chat.primaryCharName === charName) return true;
	if (Array.isArray(chat.chars) && chat.chars.includes(charName)) return true;
	return false;
}

/**
 * 「获取模型列表」端点 URL 规整单一权威（OpenAI 惯例渠道；ollama 走 apiChannels.modelsRequestFor 分发）。
 * [合并批 0714] 原三副本收口：preset.mjs normalizeUrl（本逻辑源）/ layout.mjs onboarding 内联 /
 * subModePanel._normalizeModelUrl（第四份，0713 已删）；apiChannels.modelsRequestFor 原弱版
 * （只换 chat/completions 不补 /v1/models）同批接入本函数。
 * 规则：协议缺省补 https→http；`.../chat/completions*` → `.../models`；已 `/models` 结尾原样
 * （防二次拼接）；`.../v1` → 补 `/models`；其余 → 补 `/v1/models`。
 * @param {string} url 用户填写的 API 地址（完整端点或 base）
 * @returns {string|null} 规整后的 models 端点；无法解析返回 null
 */
export function normalizeModelsUrl(url) {
	let urlObj;
	try {
		urlObj = new URL(url);
	} catch {
		if (!url || url.startsWith("http")) return null;
		try { urlObj = new URL("https://" + url); }
		catch {
			try { urlObj = new URL("http://" + url); } catch { return null; }
		}
	}
	if (urlObj.pathname.includes("/chat/completions")) {
		urlObj.pathname = urlObj.pathname.replace(/\/chat\/completions.*$/, "/models");
	} else {
		let path = urlObj.pathname.replace(/\/+$/, "");
		if (path.endsWith("/models")) urlObj.pathname = path; // 已是端点，原样（三副本共有的二次拼接边界，收口时一并堵）
		else if (path.endsWith("/v1")) urlObj.pathname = path + "/models";
		else urlObj.pathname = path + "/v1/models";
	}
	return urlObj.toString();
}

/**
 * [0716 竞态收口原语] latestOnly —— 「最后发起者生效」单源实现。
 * 病：异步加载函数（切角色/切源/切tab 触发的面板填充）被快速连续调用时，先发慢至的旧响应
 *     覆盖新状态。既有防护是各文件手抄 reqId 序号+比对（普查实测 13 份手工副本），
 *     凛倾 0716「别打补丁」定案：机制收口为单源原语，消费方只声明语义。
 * 用法：`const load = latestOnly(async (isStale, ...args) => { await ...; if (isStale()) return; 写状态 })`
 *   —— 包装层维护序号（每次调用使前序全部过期）；fn 首参 isStale() 供长函数在各写入点自查
 *   （JS 无法外部中断已运行函数，写点自查是该问题的本质形状，与 AbortSignal 检查同构）。
 * @template {(isStale: () => boolean, ...args: any[]) => Promise<any>} F
 * @param {F} fn
 * @returns {(...args: any[]) => Promise<any>}
 */
export function latestOnly(fn) {
	let _seq = 0;
	return function (...args) {
		const _my = ++_seq;
		return fn(() => _my !== _seq, ...args);
	};
}

/**
 * 相对时间显示单一权威（"刚刚/N分钟前/N小时前/N天前"）。
 * [合并批 0714] 原 conversationManager.formatRelativeTime 与 subModePanel._relTime 逐行同构双实现，收口本处。
 * 边界：语义不同的时间格式不并入——importExport._fmtTime（绝对时间 YYYY-MM-DD HH:mm）、
 * settingsSlots.timeSince（时长无"前"缀）、fmtUptime（uptime 秒）各留原地。
 * @param {number} timestamp - 毫秒时间戳
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
	const diff = Date.now() - timestamp;
	if (diff < 60000) return "刚刚";
	if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
	if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前";
	return Math.floor(diff / 86400000) + "天前";
}

/**
 * 「点菜单外关闭」绑定单一权威（与 positionContextMenu 配对的右键菜单机制件）。
 * [合并批 0714·二] 原 6 处同构手写（fileExplorer/regexEditor/panels/conversationManager×2/skillPicker）：
 * setTimeout(0) 延迟绑定（跳过触发菜单的那次点击）→ 点菜单外即 onClose+自解绑。
 * 顺带收口两处旧漏：①点菜单项后菜单已 remove 但 document listener 残留（contains 对 detached
 * 节点仍 true）——本实现以 isConnected 判活，菜单已亡即清 listener；②conversationManager 原版
 * 无 contains 判断（点菜单内 4px padding 空隙也关），统一为标准「点外才关」。
 * @param {HTMLElement} el 菜单元素
 * @param {() => void} onClose 关闭回调（通常 el.remove()）
 * @returns {() => void} 手动解绑函数（菜单由其它路径关闭时调用，防 listener 挂到下次点击）
 */
export function bindClickOutsideClose(el, onClose) {
	const handler = (e) => {
		if (el.isConnected && el.contains(e.target)) return;
		document.removeEventListener("click", handler);
		onClose();
	};
	setTimeout(() => document.addEventListener("click", handler), 0);
	return () => document.removeEventListener("click", handler);
}

/**
 * 「复制到剪贴板 + 按钮 ✅ 反馈」单一权威。
 * [合并批 0714·二] 原 5 处按钮形态同构副本收口（promptViewer/memoryPresetChat/settingsSlots×3：
 * 均为 写剪贴板→按钮换✅文案→1500ms 还原）。边界：toast 形态（companion/settings 复制即弹 toast）、
 * messageList 成功静默/i18n 形态语义不同，不并入。
 * 失败统一 toast 可见（原 settingsSlots 三处 .then 无 catch=静默 unhandled rejection；
 * LAN http 非安全上下文 navigator.clipboard undefined 的同步 TypeError 也由 async 包内 catch 接住）。
 * @param {string} text 要复制的内容
 * @param {HTMLElement|null} btn 反馈按钮（null=只复制不反馈）
 * @param {string} [doneLabel] 成功期间按钮内容（innerHTML；1500ms 后还原原内容）
 */
export async function copyWithFeedback(text, btn, doneLabel = "✅ 已复制") {
	try {
		await navigator.clipboard.writeText(text);
		if (btn && btn.isConnected) {
			const orig = btn.innerHTML;
			btn.innerHTML = doneLabel;
			setTimeout(() => { btn.innerHTML = orig; }, 1500);
		}
	} catch (err) {
		window._beiluToast?.("复制失败: " + (err?.message || err), "error");
	}
}

/**
 * 内联改名输入框 DOM 编排单一权威。
 * [合并批 0714·二] 原 4 处同构副本收口（conversationManager.renameConversation / chatmgmt /
 * smart._renameSmartRecent / workPanel._renameHistoryConv：均为 label 清空→塞 input→focus+select→
 * Enter/blur 提交去重→Escape 恢复原文）。数据提交层已由 commitChatRename 单源（D2 0713），
 * 本函数只管 UI 编排；提交后动作由调用方 onCommit 回调承载（各面板重渲染方式不同）。
 * 统一形态顺带收口两处旧漏：①workPanel 版 blur 无 contains 守卫——Escape 恢复原文移除 input
 * 触发 blur 仍会提交改名；②chatmgmt 版无 click stopPropagation——点输入框冒泡触发行级切换。
 * 边界：taskCard/taskItemPanel 的任务编辑（replaceWith 结构+失败整卡重渲染恢复）形态不同，不并入。
 * @param {HTMLElement} labelEl 显示名容器（textContent 被替换为 input）
 * @param {Object} opts
 * @param {string} [opts.value] 输入框初值
 * @param {string} [opts.placeholder]
 * @param {string} [opts.className] input class（与 cssText 二选一，按调用方原样式）
 * @param {string} [opts.cssText] input 内联样式
 * @param {(name: string) => Promise<void>|void} opts.onCommit 提交回调（收 trim 后的值）
 * @returns {HTMLInputElement|null} 已在编辑中返回 null
 */
export function mountInlineEdit(labelEl, { value = "", placeholder = "", className = "", cssText = "", onCommit } = {}) {
	if (!labelEl || labelEl.querySelector("input")) return null;
	const original = labelEl.textContent;
	const input = document.createElement("input");
	input.type = "text";
	input.value = value;
	if (placeholder) input.placeholder = placeholder;
	if (className) input.className = className;
	if (cssText) input.style.cssText = cssText;
	labelEl.textContent = "";
	labelEl.appendChild(input);
	input.focus();
	input.select();
	let _committing = false; // Enter 与 blur 双触发去重
	const commit = async () => {
		if (_committing) return;
		_committing = true;
		await onCommit?.(input.value.trim());
	};
	input.addEventListener("keydown", (ke) => {
		ke.stopPropagation();
		if (ke.key === "Enter") { ke.preventDefault(); commit(); }
		else if (ke.key === "Escape") { ke.preventDefault(); labelEl.textContent = original; }
	});
	input.addEventListener("blur", () => {
		// 延迟+contains 守卫：Escape/提交已移除 input 时不再触发提交
		setTimeout(() => { if (labelEl.contains(input)) commit(); }, 50);
	});
	input.addEventListener("click", (e) => e.stopPropagation());
	// dblclick 是独立事件不被 click stopPropagation 挡——双击输入框选词会冒泡触发行级
	// dblclick（chatmgmt 弹窗行 dblclick=switchToChat 切走对话，全文走读发现的原版旧漏）
	input.addEventListener("dblclick", (e) => e.stopPropagation());
	return input;
}

/**
 * 0716 轮子收口：浏览器下载基元单源。原全壳 4 个命名函数（regexEditor.downloadJson /
 * memoryBrowser.downloadBase64 / importExport._downloadBlob / fileHandling.downloadFile）
 * + 多处内联 <a download> 各自手写同一形状——收口为两基元，变体保留各自签名薄转调。
 * @param {string} href - 可下载 URL（objectURL / data: / 服务端路径）
 * @param {string} filename - 落盘文件名
 */
export function downloadUrl(href, filename) {
	const a = document.createElement("a");
	a.href = href;
	a.download = filename || "download";
	document.body.appendChild(a); // 挂 DOM 后 click：兼容 Firefox 未挂载 <a> 不触发下载
	a.click();
	a.remove();
}

/**
 * 下载 Blob（objectURL 生命周期收口：用完即 revoke，防泄漏）。
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	try { downloadUrl(url, filename); } finally { URL.revokeObjectURL(url); }
}

/**
 * 可见性门控事件处理器包装：面板不可见时跳过 handler（不发 HTTP），可见时正常执行。
 * 用法：window.addEventListener("beilu:char-changed", whenVisible("#my-panel", () => fetchData()));
 * @param {string} panelSelector - 面板 CSS 选择器
 * @param {Function} handler - 原始事件处理器
 * @returns {Function} 包装后的处理器
 */
export function whenVisible(panelSelector, handler) {
	return function(e) {
		const el = document.querySelector(panelSelector);
		if (el && el.offsetParent !== null) return handler.call(this, e);
	};
}
