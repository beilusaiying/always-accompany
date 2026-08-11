/**
 * [beilu-st-host · 前端 runtime] st-ui —— 三个 DOM 容器 + 错误面板（extensionLoadErrors 对等物）。
 *
 * 【定位】酒馆插件把设置面板 append 到固定 id 的容器里：
 *   #extensions_settings / #extensions_settings2（转换表已证：纯视觉分栏，无语义差异，左右两栏）、
 *   #send_form（发送区表单，少量插件往这里挂按钮）。ST 里这些是主界面既有节点；beilu 无对等，
 *   故本文件创建它们（挂在 body 下一个默认收起的可折叠抽屉，样式极简，不打扰主界面）。
 *
 * 【错误面板（红线3）】ST 的 addExtension 门槛失败会记 extensionLoadErrors 并在 UI 标红；
 *   我们不学 ST 静默丢弃 —— host-loader 门槛判定失败时调 addExtensionError(name, reason)，
 *   在面板里可见可展开：哪个插件、缺哪个接入面/什么原因。console 只是附带，面板才是主出口。
 *
 * 【功能链】host-loader 启动 → initUi()（幂等建容器+抽屉）→ 门槛失败 addExtensionError() 落面板
 *   → 通过的插件把设置 append 进 #extensions_settings(2)。
 *
 * 【renderExtensionTemplateAsync】ST-P4 §2.2 证 Timelines/memory-enhancement 依赖它渲染 HTML 模板；
 *   一期无 ST 模板体系对等 → 抛错 stub（红线2，可见），二期接 fetch 模板→插入。由 extensions.js shim re-export。
 */

const DRAWER_ID = 'beilu-st-host-drawer'
const ERR_LIST_ID = 'beilu-st-host-error-list'

let _initialized = false

/** 极简内联样式（离线硬约束：不外链 CSS；不污染主界面全局样式，全部 scoped 到抽屉 id）。 */
const STYLE = `
#${DRAWER_ID}{position:fixed;right:0;bottom:0;z-index:9999;max-width:min(420px,90vw);
	font:13px/1.5 system-ui,sans-serif;color:#ddd;background:rgba(28,28,32,.96);
	border-top-left-radius:8px;box-shadow:0 -2px 12px rgba(0,0,0,.4);transform:translateY(calc(100% - 34px));
	transition:transform .2s ease}
#${DRAWER_ID}.open{transform:translateY(0)}
#${DRAWER_ID} > .bsh-head{height:34px;display:flex;align-items:center;gap:8px;padding:0 12px;
	cursor:pointer;user-select:none;font-weight:600}
#${DRAWER_ID} .bsh-dot{width:8px;height:8px;border-radius:50%;background:#4a4}
#${DRAWER_ID}.has-error .bsh-dot{background:#e55}
#${DRAWER_ID} > .bsh-body{max-height:min(60vh,480px);overflow:auto;padding:8px 12px 12px;
	border-top:1px solid rgba(255,255,255,.08)}
#${DRAWER_ID} .bsh-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;
	opacity:.6;margin:10px 0 4px}
#${ERR_LIST_ID}:empty::after{content:"（暂无加载错误）";opacity:.45}
#${ERR_LIST_ID} .bsh-err{border-left:3px solid #e55;background:rgba(229,85,85,.08);
	padding:6px 8px;margin:6px 0;border-radius:0 4px 4px 0}
#${ERR_LIST_ID} .bsh-err b{color:#f88}
#${ERR_LIST_ID} .bsh-err .bsh-reason{opacity:.85;white-space:pre-wrap;word-break:break-word}
#${DRAWER_ID} .bsh-cols{display:flex;gap:8px}
#${DRAWER_ID} #extensions_settings,#${DRAWER_ID} #extensions_settings2{flex:1;min-width:0}
`

/** 注入一次内联样式表。 */
function _injectStyle() {
	if (document.getElementById('beilu-st-host-style')) return
	const el = document.createElement('style')
	el.id = 'beilu-st-host-style'
	el.textContent = STYLE
	document.head.appendChild(el)
}

/**
 * 初始化 UI：幂等创建抽屉 + 三容器 + 错误列表。必须在注入插件 js 之前调用
 * （插件 js 顶层可能立即 querySelector('#extensions_settings') 往里 append）。
 */
export function initUi() {
	if (_initialized) return
	if (typeof document === 'undefined') return
	_injectStyle()

	// [0807 凛倾"按照酒馆,插件那些前端和关联放到 st 兼容那里"] 抽屉 → 召唤式浮层：
	//   DOM 仍常驻 body（放进会重渲染的面板 innerHTML 会把插件已 append 的设置内容清掉——框架约束），
	//   但不再右下角常驻可见；入口=「额外插件→酒馆插件」面板的按钮（extensionsPanel 调
	//   window.__beiluStHostOpenPanel）。加载错误仍自动弹出（红线3：失败可见，不因收纳而静默）。
	const drawer = document.createElement('div')
	drawer.id = DRAWER_ID
	drawer.style.display = 'none' // 默认完全隐藏；入口按钮/错误自动弹出时显示
	drawer.innerHTML = `
		<div class="bsh-head"><span class="bsh-dot"></span><span>酒馆插件（beilu 宿主）</span><span style="margin-left:auto;opacity:.6">✕ 收起</span></div>
		<div class="bsh-body">
			<div class="bsh-section-title">加载错误</div>
			<div id="${ERR_LIST_ID}"></div>
			<div class="bsh-section-title">插件设置</div>
			<div class="bsh-cols">
				<div id="extensions_settings"></div>
				<div id="extensions_settings2"></div>
			</div>
		</div>`
	// 浮层头点击=收起（隐藏）；打开动作走 __beiluStHostOpenPanel。
	drawer.querySelector('.bsh-head').addEventListener('click', () => { drawer.style.display = 'none' })
	document.body.appendChild(drawer)
	// 运行时桥：ST 兼容面板（extensionsPanel 酒馆插件区）的入口按钮调它打开浮层——
	// 两侧零构建期依赖（与 __beiluUpsertExtensionPrompt 同款桥范式）。
	window.__beiluStHostOpenPanel = () => { drawer.style.display = 'block'; drawer.classList.add('open') }

	// #send_form：酒馆发送区表单容器（插件在内自建 #qr--bar 注工具按钮，st-input-helper 官方模板形态）。
	// [0807 凛倾"按照酒馆"] 优先挂输入区静态 dock（index.html #st-host-sendform-dock，位于输入框
	// 上方=对齐 ST 的 qr--bar 位置，工具栏用户可见可点）；dock 不存在（独立页面/测试环境）→
	// 原隐藏 body 兜底（插件 append 不落空，功能可用不可见）。
	if (!document.getElementById('send_form')) {
		const sf = document.createElement('form')
		sf.id = 'send_form'
		// [0807 E2E 抓获断点F] 插件按钮多为裸 <button>（无 type）＝form 内默认 type=submit →
		// 点击触发表单提交=页面导航（真浏览器实录 "Execution context was destroyed"）。
		// ST 的 #send_form 同为 form 但自家 submit 链拦截不导航——对齐：容器层统一 preventDefault。
		sf.addEventListener('submit', (e) => e.preventDefault())
		const dock = document.getElementById('st-host-sendform-dock')
		if (dock) { dock.appendChild(sf) }
		else { sf.style.display = 'none'; document.body.appendChild(sf) }
	}

	_initialized = true
}

/**
 * 记一条插件加载错误到面板（红线3：失败可见，不只 console.warn）。
 * @param {string} pluginName 插件目录名/显示名
 * @param {string} reason 缺哪个接入面 / 什么原因（面向用户可读）
 */
export function addExtensionError(pluginName, reason) {
	// 兜底 console，便于日志排查；但主出口是面板。
	console.warn(`[beilu-st-host] 插件 "${pluginName}" 未加载：${reason}`)
	if (typeof document === 'undefined') return
	initUi()
	const list = document.getElementById(ERR_LIST_ID)
	if (!list) return
	const item = document.createElement('div')
	item.className = 'bsh-err'
	const b = document.createElement('b')
	b.textContent = String(pluginName || '(未知插件)')
	const r = document.createElement('div')
	r.className = 'bsh-reason'
	r.textContent = String(reason || '(未说明原因)')
	item.appendChild(b)
	item.appendChild(r)
	list.appendChild(item)

	// 有错误 → 浮层标红并自动弹出，确保用户看得到（红线3、红线4——收纳进 ST 兼容面板后仍不静默）。
	const drawer = document.getElementById(DRAWER_ID)
	if (drawer) { drawer.classList.add('has-error'); drawer.classList.add('open'); drawer.style.display = 'block' }
}

/**
 * renderExtensionTemplateAsync：ST-P4 §2.2 依赖符号，一期抛错 stub（红线2 可见），二期接模板体系。
 * ST 签名：(extensionName, templateId, templateData?, sanitize?, localize?) => Promise<string> HTML。
 */
export async function renderExtensionTemplateAsync(extensionName, templateId) {
	throw new Error(`[beilu宿主] renderExtensionTemplateAsync 尚未实现（一期）。` +
		`插件 "${extensionName}" 请求模板 "${templateId}"；ST 模板渲染体系属二期接入项。`)
}
