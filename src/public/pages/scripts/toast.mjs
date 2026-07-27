import { geti18n, setLocalizeLogic } from './i18n.mjs'

/** 显式设置的 toast 容器；为 null 时使用默认的 #toast-container。 */
let toastContainer = null

/** 未传 duration 时使用的默认持续时间（毫秒）；0 表示不自动消失。页面可设为 0 以得到 showMessage 式常驻提示。 */
let defaultToastDuration = 4000

// T018 离线约束：图标原为 api.iconify.design 外链，断网时 toast 文字仍可用但 img 渲染为 broken image。
// 改内联 data URI（内容 = line-md/{alert-circle,confirm-circle,alert} 2026-07-05 快照，视觉不变，永不 broken）。
const svgDataUri = svg => `data:image/svg+xml,${encodeURIComponent(svg)}`
const alertCircleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path stroke-dasharray="60" d="M12 3c4.97 0 9 4.03 9 9c0 4.97 -4.03 9 -9 9c-4.97 0 -9 -4.03 -9 -9c0 -4.97 4.03 -9 9 -9Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="60;0"/></path><path stroke-dasharray="8" stroke-dashoffset="8" d="M12 7v6"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path><path stroke-dasharray="4" stroke-dashoffset="4" d="M12 17v0.01"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path></g></svg>'
const confirmCircleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path stroke-dasharray="60" d="M3 12c0 -4.97 4.03 -9 9 -9c4.97 0 9 4.03 9 9c0 4.97 -4.03 9 -9 9c-4.97 0 -9 -4.03 -9 -9Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="60;0"/></path><path stroke-dasharray="14" stroke-dashoffset="14" d="M8 12l3 3l5 -5"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.2s" to="0"/></path></g></svg>'
const alertSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path stroke-dasharray="60" d="M12 3l9 17h-18l9 -17Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="60;0"/></path><path stroke-dasharray="6" stroke-dashoffset="6" d="M12 10v4"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path><path stroke-dasharray="4" stroke-dashoffset="4" d="M12 17v0.01"><animate fill="freeze" attributeName="stroke-dashoffset" begin="0.7s" dur="0.2s" to="0"/></path></g></svg>'
const icons = {
	info: svgDataUri(alertCircleSvg),
	success: svgDataUri(confirmCircleSvg),
	warning: svgDataUri(alertSvg),
	error: svgDataUri(alertSvg),
}

/**
 * 确保 toast 容器存在。
 * 若已通过 setToastContainer 设置则返回该容器，否则使用或创建默认的 #toast-container。
 * @returns {HTMLElement} - toast 容器。
 */
function ensureToastContainer() {
	return (toastContainer ??= document.getElementById('toast-container')) || document.body.appendChild(toastContainer = Object.assign(document.createElement('div'), {
		id: 'toast-container',
		className: 'toast toast-bottom toast-end z-[100]'
	})) && toastContainer
}

/**
 * 设置 toast 使用的容器；toast 将追加到此元素内。
 * 传入 null 或省略则恢复使用默认容器。
 * @param {HTMLElement | null} [container] - 作为容器的元素。
 */
export function setToastContainer(container) {
	toastContainer = container ?? null
}

/**
 * 返回当前用于显示 toast 的容器（即 ensureToastContainer() 的结果）。
 * 可用于清空当前页的 toast 区域，例如 getToastContainer().innerHTML = ''。
 * @returns {HTMLElement} - 当前 toast 容器。
 */
export function getToastContainer() {
	return ensureToastContainer()
}

/**
 * 设置本页 toast 的默认持续时间；未传 duration 的 showToast/showToastI18n 将使用此值。
 * 传 0 可让该页所有 toast 不自动消失（常驻直到清空容器），等同于 showMessage 行为。
 * @param {number} ms - 默认持续时间（毫秒），0 表示不自动消失。
 */
export function setDefaultToastDuration(ms) {
	defaultToastDuration = ms
}

/**
 * 显示一个基本的 toast。
 * @param {string} type - toast 类型。
 * @param {string|HTMLElement} message - toast 消息。
 * @param {number} [duration] - toast 持续时间。
 * @returns {HTMLElement} - toast 元素。
 */
function base_showToast(type, message, duration = defaultToastDuration) {
	if (!(message instanceof HTMLElement) && !(Object(message) instanceof String)) {
		console.warn(`showToast() called with non-string/non-HTMLElement message: ${message}`)
		message = String(message)
	}
	const container = ensureToastContainer()
	// [去重 2026-07-27] 同型同文的 toast 在屏时不再叠一条：连发场景（0727 实证：对多条对话线连点关闭，
	//   满屏 11 条"这是主窗口，不能关闭"盖住整栏内容）改为原地计数 ×N + 重置倒计时。
	//   只对字符串消息去重：custom/HTMLElement 内容无法可靠等值比较，维持原行为。
	if (type !== 'custom' && !(message instanceof HTMLElement)) {
		const _key = `${type}|${message}`
		const _dup = [...container.children].find(el => el.dataset && el.dataset.beiluToastKey === _key)
		if (_dup) {
			const _n = (Number(_dup.dataset.beiluToastCount) || 1) + 1
			_dup.dataset.beiluToastCount = String(_n)
			const _badge = _dup.querySelector('[data-toast-count]')
			if (_badge) _badge.textContent = ` ×${_n}`
			_dup._beiluResetTimer?.()
			return _dup
		}
	}
	const alertId = `alert-${Date.now()}`
	const alertDiv = document.createElement('div')
	if (type == 'custom') {
		if (Object(message) instanceof HTMLElement)
			alertDiv.appendChild(message)
		else
			alertDiv.innerHTML = message
		alertDiv.id = alertId
	}
	else {
		alertDiv.id = alertId
		alertDiv.className = `alert alert-${type} shadow-lg`

		const iconUrl = icons[type] || icons.info
		const iconElement = document.createElement('img')
		iconElement.src = iconUrl
		iconElement.className = 'h-6 w-6 flex-shrink-0'

		const textElement = document.createElement('div')
		if (Object(message) instanceof HTMLElement)
			alertDiv.appendChild(message)
		else
			alertDiv.innerHTML = message.replace(/\n/g, '<br>')

		alertDiv.appendChild(iconElement)
		alertDiv.appendChild(textElement)
		// [去重 2026-07-27] 字符串消息挂等值键 + 计数位（重复时上方去重分支原地 ×N，不新增条目）
		if (!(message instanceof HTMLElement)) {
			alertDiv.dataset.beiluToastKey = `${type}|${message}`
			const countSpan = document.createElement('span')
			countSpan.setAttribute('data-toast-count', '')
			countSpan.style.cssText = 'font-weight:700;flex-shrink:0;'
			alertDiv.appendChild(countSpan)
		}
	}
	alertDiv.className += ' animate-fade-in-up'

	let hideTimeout

	/**
	 * 淡出并移除。移除不能只依赖 animationend：动画被主题/系统（prefers-reduced-motion 覆盖等）
	 * 禁用时事件永不触发 → toast 永驻挡住下方控件，故加定时兜底移除。
	 * @returns {void}
	 */
	const dismiss = () => {
		clearTimeout(hideTimeout)
		alertDiv.classList.add('animate-fade-out-down')
		alertDiv.addEventListener('animationend', () => {
			alertDiv.remove()
		})
		setTimeout(() => alertDiv.remove(), 400)
	}

	/**
	 * 启动计时器。
	 * @returns {void}
	 */
	const startTimer = () => {
		if (duration <= 0) return
		hideTimeout = setTimeout(dismiss, duration)
	}

	/**
	 * 重置计时器。
	 * @returns {void}
	 */
	const resetTimer = () => {
		if (duration <= 0) return
		clearTimeout(hideTimeout)
		startTimer()
	}

	alertDiv.addEventListener('mouseenter', () => clearTimeout(hideTimeout))
	alertDiv.addEventListener('mouseleave', resetTimer)
	// [去重 2026-07-27] 暴露给去重分支：重复触发=重置在屏那条的倒计时（复用本闭包，不另开计时器）
	alertDiv._beiluResetTimer = resetTimer
	// 点击即关：toast 固定在角落会盖住下方控件（如聊天发送键），且 mouseenter 暂停计时=
	// 光标停留其上时永不自动消失——必须给用户手动关闭出口。立即 remove 不走淡出，
	// 让下一次点击直达被盖住的控件。
	alertDiv.style.cursor = 'pointer'
	alertDiv.addEventListener('click', () => {
		clearTimeout(hideTimeout)
		alertDiv.remove()
	})

	container.appendChild(alertDiv)
	startTimer()
	return alertDiv
}

/**
 * 显示一个 toast。
 * @param {string} [type='info'] - toast 类型。
 * @param {string|HTMLElement} message - toast 消息。
 * @param {number} [duration] - 持续时间（毫秒）；不传则用 setDefaultToastDuration 设置的值，0 表示不自动消失。
 * @returns {void}
 */
export function showToast(type = 'info', message, duration) {
	base_showToast(type, message, duration)
}
/**
 * 显示一个 i18n toast。
 * @param {string} [type='info'] - toast 类型。
 * @param {string} key - i18n 键。
 * @param {object} [params={}] - i18n 参数。
 * @param {number} [duration] - 持续时间（毫秒）；不传则用 setDefaultToastDuration 设置的值，0 表示不自动消失。
 * @returns {void}
 */
export function showToastI18n(type = 'info', key, params = {}, duration) {
	const div = base_showToast(type, '', duration)
	if (Object.keys(params).length) setLocalizeLogic(div, () => {
		div.querySelector('div').innerHTML = geti18n(key, params).replace(/\n/g, '<br>')
	})
	else div.querySelector('div').dataset.i18n = key
}

const style = document.createElement('style')
style.textContent = `\
@keyframes animate-fade-in-up {
	from { opacity: 0; transform: translateY(20px); }
	to { opacity: 1; transform: translateY(0); }
}
.animate-fade-in-up {
	animation: animate-fade-in-up 0.3s ease-out forwards;
}
@keyframes animate-fade-out-down {
	from { opacity: 1; transform: translateY(0); }
	to { opacity: 0; transform: translateY(20px); }
}
.animate-fade-out-down {
	animation: animate-fade-out-down 0.3s ease-in forwards;
}
`
document.head.appendChild(style)
