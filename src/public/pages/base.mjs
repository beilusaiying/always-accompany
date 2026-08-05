// beilu-always-accompany: 精简后的前端基础模块
// 移除了 Sentry / Service Worker / 自动更新 / 愚人节彩蛋

import { onServerEvent } from './scripts/server_events.mjs'
import { showToast } from './scripts/toast.mjs'
import { notifyDesktop } from './scripts/desktopNotify.mjs'

// ── 前端错误自动上报到后端 monitor ──
;(() => {
	const REPORT_URL = '/api/v1/monitor/errors/report';
	const reported = new Set();

	window._reportError = (message, stack, extra = {}) => {
		const key = `${message}|${(stack || '').split('\n')[0] || ''}`;
		if (reported.has(key)) return;
		reported.add(key);
		if (reported.size > 200) reported.clear();

		fetch(REPORT_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message,
				stack: stack || null,
				url: extra.url || location.href,
				line: extra.line || null,
				col: extra.col || null,
				userAgent: navigator.userAgent,
				// [多线归属 0726] 报错来自哪条线：多线并行时错误追踪面板要能分清是哪条线出的错。
				//   chatid 取 hash（endpoints 的权威源；本文件是无依赖的基础层故直读 location.hash，不 import）。
				chatid: (() => { try { const h = location.hash.replace(/^#/, ''); return /^[a-z0-9]{7,15}$/.test(h) ? h : null; } catch { return null; } })(),
			}),
		}).catch(() => {});
	};

	addEventListener('error', (e) => {
		window._reportError(
			e.message || 'Unknown error',
			e.error?.stack || null,
			{ url: e.filename, line: e.lineno, col: e.colno }
		);
	});

	addEventListener('unhandledrejection', (e) => {
		const r = e.reason;
		window._reportError(
			r instanceof Error ? r.message : String(r),
			r instanceof Error ? r.stack : null
		);
	});

	// ── console.error → 上报桥接（可开关，默认关）──
	// 默认只上报「未捕获异常 + 手动 _reportError」。开启后，每次 console.error 也镜像上报，
	// 把那些被 try/catch 吞掉、只打了 console.error 的错误也送进权威缓冲（前端可见性缺口的补法）。
	// 护栏：
	//   1. 始终保留并调用本桥接安装时刻的原始 console.error（不破坏 IDE 壳 backendMonitor.mjs 的拦截链——
	//      谁后装谁在外层，二者都只是「调原始 + 副作用」，无环）。
	//   2. _inBridge 再入锁：上报路径内若再次触发 console.error（理论上不会，fetch().catch 不打 console），
	//      也直接跳过镜像，杜绝递归洪泛；叠加 _reportError 自带去重 Set，二次保险。
	//   3. 开关幂等：重复开/关只换 console.error 指向，不叠加包装层。
	let _bridgeOrigError = null; // 安装桥接时捕获的「当时的」console.error
	let _bridgedError = null;    // 桥接版函数引用（用于卸载时判断当前是否仍是我们装的）
	let _inBridge = false;
	window._setConsoleErrorBridge = (on) => {
		if (on) {
			if (_bridgedError && console.error === _bridgedError) return; // 已装且未被他人覆盖
			_bridgeOrigError = console.error;
			_bridgedError = function (...args) {
				_bridgeOrigError.apply(console, args);
				if (_inBridge) return;
				_inBridge = true;
				try {
					const errArg = args.find((a) => a instanceof Error);
					const message = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))).join(' ');
					window._reportError(message || 'console.error', errArg ? errArg.stack : null, { via: 'console.error' });
				} catch { /* 上报失败不影响原始 console.error */ }
				finally { _inBridge = false; }
			};
			console.error = _bridgedError;
		} else {
			// 仅当当前 console.error 确实是我们装的那一层时才还原，避免踩掉他人后装的包装
			if (_bridgedError && console.error === _bridgedError && _bridgeOrigError) {
				console.error = _bridgeOrigError;
			}
			_bridgedError = null;
			_bridgeOrigError = null;
		}
	};
	// 启动时按持久化偏好恢复（设置弹窗写 localStorage['beilu-console-error-bridge']='1'）
	try {
		if (localStorage.getItem('beilu-console-error-bridge') === '1') window._setConsoleErrorBridge(true);
	} catch { /* localStorage 不可用则忽略 */ }
})();

// polyfill（本地化副本，避免运行时 jsdelivr CDN 依赖；内部 esm.sh 子依赖走 /esm-cache 缓存代理）
await import('/vendor/js-polyfill/index.mjs').catch(console.error)

// Service Worker 已禁用 — 不再缓存旧版前端代码
// 如需重新启用，取消下方注释：
// if ('serviceWorker' in navigator)
// 	navigator.serviceWorker.register('/service_worker.mjs', { scope: '/', module: true })

// 注销已有的 Service Worker 并清除遗留的 Cache Storage
if ('serviceWorker' in navigator)
	navigator.serviceWorker.getRegistrations().then(async regs => {
		for (const reg of regs) await reg.unregister()
		const keys = await caches.keys()
		for (const key of keys) await caches.delete(key)
	})

// T017-2.4：已删除 document 级 Escape 全局拦截。
//   原逻辑(Escape → history.back()/window.close())与 dialog/select 的原生 Escape 冲突：
//   dialog.cancel/select 收起先触发,随后冒泡到 document 又触发页面后退 → 关浮窗同时页面误后退(login/protocolhandler 的 confirmation dialog bug 根因)。
//   质检已穷举：beilu-chat 18 个组件全部自行局部监听 Escape,零依赖此全局拦截 → 直接删,浮窗关闭功能无回归。


// 桌面 OS 通知（通道B）——服务端 event_dispatcher.sendNotification 经此到达 OS 通知，
// 替代已禁用 SW 里的 showNotification（旧消费端死在 service_worker.mjs）。窗口失焦时弹。
onServerEvent('notification', ({ title, options, targetUrl } = {}) => {
	notifyDesktop(title, options?.body || '', { icon: options?.icon, tag: options?.tag, targetUrl })
})

// 账户删除（通道B）——后端 event_dispatcher.mjs AfterUserDeleted 经 /ws/notify 直发本事件；
// chat WS 侧 websocket.mjs handleBroadcastEvent 的同名分支在错误通道上从未收到过（断链榜A2，20260703）。
// 接收对齐到真实通道：清 beilu-* 本地存储并回登录页。
// 20260706 删号传导链修：终点直写 /login/ 不绕 '/'——账户已删=确定无会话，去 '/' 再解析默认壳
// 无意义且历史上因 resolveDefaultShell 吞 401 直接撞 /parts/shells:* 死路（截图裸 401 JSON 根因链一环）。
onServerEvent('account_deleted', () => {
	// 前缀清除契约锚：与壳门面 beilu-chat/src/shared/state/storage.mjs clearAll() 同语义副本——
	// pages 层不 import 壳模块（层级隔离）故保留本地实现；改前缀/语义须两处同步。
	try { for (const k of Object.keys(localStorage)) if (k.startsWith('beilu-')) localStorage.removeItem(k) } catch { }
	// 窗口局部镜像同域清理（与壳门面 clearAll 0715 同步：窗口局部键类别在 sessionStorage 有 per-tab 镜像）
	try { for (const k of Object.keys(sessionStorage)) if (k.startsWith('beilu-')) sessionStorage.removeItem(k) } catch { }
	window.location.href = '/login/'
})

// 服务端版本比对（通道B）——补前端消费：后端 event_dispatcher.register 在每次 /ws/notify 连接建立时
// 回送 server-reconnected {commitId}（commitId = 服务端当前 git commit）。功能链：
//   server_events.mjs _notifyWs.onmessage → dispatchMessage → 本 onServerEvent 回调。
// 断线重连（server_events.mjs onclose → 3s 后 _connectNotify 重连）时后端会再次回送本事件；
// 若此时 commitId 与上次记录的不同 ⇒ 服务端进程重启过且部署了新代码 ⇒ 提示用户刷新页面拿新版前端。
// 语义：诊断/恢复面（用户应看见"服务端已更新"这件事），非装饰，也不碰断线重连的 conn-dot 指示灯链
// （那是 chat WS 自驱动的另一通道 websocket.mjs _updateConnIndicator，与本事件正交）。
// 设计取舍（对齐硬约束）：
//   1. 用页面级模块内存变量 _lastServerCommit 记基线，不落 localStorage——刷新即重新基线；
//      若存 localStorage，跨会话比对会在"重启后首次登录"就弹陈旧提示（用户本就是新会话，无需提醒）。
//   2. 首次连接（_lastServerCommit 尚未记录）只记录基线不提示——首连不代表服务端刚更新。
//   3. commitId 为空/undefined（后端 git 不可用，currentGitCommit 拿不到值）⇒ 静默不记录不提示：
//      无有效基线可比，记了空值反而会在下次拿到真实值时误判为"变化"而误弹。
//   4. 不自动刷新、不打断输入——只弹一条可自动消失的 toast，是否刷新交给用户。
let _lastServerCommit = null
let _expectedUpdateCommit = (() => { try { return sessionStorage.getItem('beilu-update-expected-commit') } catch { return null } })()
onServerEvent('server-reconnected', ({ commitId } = {}) => {
	if (!commitId) return // 无有效 commitId：静默（见上取舍 3）
	if (_expectedUpdateCommit && commitId === _expectedUpdateCommit) {
		_renderUpdateStatus({ phase: 'completed', progress: 100, message: '更新完成，服务已恢复连接', currentCommit: commitId })
		showToast('success', '更新完成，服务已恢复连接', 8000)
		_expectedUpdateCommit = null
		try { sessionStorage.removeItem('beilu-update-expected-commit') } catch { }
	}
	if (_lastServerCommit === null) { _lastServerCommit = commitId; return } // 首连只记基线（取舍 2）
	if (commitId !== _lastServerCommit) {
		_lastServerCommit = commitId
		showToast('warning', '服务端已更新，建议刷新页面以获取最新版本', 8000)
	}
	// 同 commitId 的普通重连：不打扰（取舍 4）
})

// 更新 UI 只消费 autoupdate.mjs 的唯一状态。检测不会自动 pull；owner 明确点击后才应用。
let _updatePanel = null
let _canApplyUpdate = false
let _updatePollTimer = null
function _getUpdatePanel() {
	if (_updatePanel) return _updatePanel
	const panel = document.createElement('section')
	panel.setAttribute('role', 'status')
	panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:10020;width:min(390px,calc(100vw - 36px));padding:14px;border:1px solid #66809b;border-radius:10px;background:#26384a;color:#eef6ff;box-shadow:0 8px 28px #0007;font:14px/1.5 system-ui;display:none'
	const title = document.createElement('strong')
	title.textContent = '版本更新'
	const text = document.createElement('div')
	text.dataset.updateText = '1'
	text.style.margin = '8px 0'
	const progress = document.createElement('progress')
	progress.dataset.updateProgress = '1'
	progress.max = 100
	progress.style.cssText = 'width:100%;height:12px'
	const actions = document.createElement('div')
	actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px'
	const later = document.createElement('button')
	later.type = 'button'
	later.dataset.updateLater = '1'
	later.textContent = '稍后'
	later.addEventListener('click', () => { panel.style.display = 'none' })
	const apply = document.createElement('button')
	apply.type = 'button'
	apply.dataset.updateApply = '1'
	apply.textContent = '更新到新版本'
	apply.addEventListener('click', async () => {
		if (!_expectedUpdateCommit) return
		try { sessionStorage.setItem('beilu-update-expected-commit', _expectedUpdateCommit) } catch { }
		apply.disabled = true
		_renderUpdateStatus({ phase: 'preflight', progress: 25, message: '正在提交更新确认…' })
		try {
			const response = await fetch('/api/update/apply', {
				method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expectedCommit: _expectedUpdateCommit }),
			})
			const result = await response.json().catch(() => ({}))
			if (!response.ok || !result.accepted) throw new Error(result.message || `更新请求失败 (${response.status})`)
			_renderUpdateStatus(result.status || { phase: 'preflight', progress: 30, message: result.message })
		} catch (e) {
			_renderUpdateStatus({ phase: 'failed', progress: 0, message: `${e.message}；可稍后重新检查` })
		}
	})
	actions.append(later, apply)
	panel.append(title, text, progress, actions)
	document.body.append(panel)
	_updatePanel = panel
	return panel
}

const _busyUpdatePhases = new Set(['checking', 'preflight', 'marker-written', 'pulling', 'verified', 'restart-scheduled'])
function _renderUpdateStatus(status = {}) {
	const panel = _getUpdatePanel()
	let phase = status.phase || 'idle'
	if (_expectedUpdateCommit && status.currentCommit === _expectedUpdateCommit && ['idle', 'up-to-date'].includes(phase)) {
		phase = 'completed'
		status = { ...status, phase, progress: 100, message: '更新完成，服务已恢复连接' }
		_expectedUpdateCommit = null
		try { sessionStorage.removeItem('beilu-update-expected-commit') } catch { }
	}
	if (typeof status.canApply === 'boolean') _canApplyUpdate = status.canApply
	if (status.availableCommit) {
		_expectedUpdateCommit = status.availableCommit
		try { sessionStorage.setItem('beilu-update-expected-commit', _expectedUpdateCommit) } catch { }
	}
	const text = panel.querySelector('[data-update-text]')
	const progress = panel.querySelector('[data-update-progress]')
	const apply = panel.querySelector('[data-update-apply]')
	const later = panel.querySelector('[data-update-later]')
	text.textContent = `${status.message || '正在处理更新'}${phase === 'available' && !_canApplyUpdate ? '（仅实例管理员可执行更新）' : ''}`
	progress.value = Number.isFinite(Number(status.progress)) ? Number(status.progress) : 0
	apply.disabled = phase !== 'available'
	apply.style.display = phase === 'available' && _canApplyUpdate ? '' : 'none'
	later.style.display = _busyUpdatePhases.has(phase) ? 'none' : ''
	panel.style.display = ['idle', 'up-to-date', 'disabled'].includes(phase) ? 'none' : 'block'
	if (_busyUpdatePhases.has(phase)) _scheduleUpdatePoll()
}

function _scheduleUpdatePoll() {
	if (_updatePollTimer) return
	_updatePollTimer = setTimeout(async () => {
		_updatePollTimer = null
		try {
			const response = await fetch('/api/update/status', { credentials: 'same-origin' })
			if (response.ok) _renderUpdateStatus(await response.json())
			else _scheduleUpdatePoll()
		} catch { _scheduleUpdatePoll() }
	}, 2000)
}

onServerEvent('update-available', _renderUpdateStatus)
onServerEvent('update-progress', _renderUpdateStatus)
onServerEvent('update-result', _renderUpdateStatus)

// 事件可能在页面连接前发送，认证完成后从服务端唯一状态读回；401 仅表示尚未登录，不弹假错误。
setTimeout(async () => {
	try {
		const response = await fetch('/api/update/status', { credentials: 'same-origin' })
		if (response.ok) _renderUpdateStatus(await response.json())
	} catch { /* WebSocket 事件或下次页面加载会恢复状态 */ }
}, 1500)
console.log('[beilu] 前端基础模块已加载（SW禁用/Sentry禁用/更新需用户确认）')

/**
 * 基础目录。
 * @type {string}
 */
export const base_dir = '/'
