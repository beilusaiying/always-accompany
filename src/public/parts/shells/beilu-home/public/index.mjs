/**
 * beilu-home 首页入口
 *
 * 职责：
 * - 选项卡切换（使用 / 系统设置 / 用户设置）
 * - 子头部动态标题和描述更新
 * - 各选项卡内的子导航切换
 * - 初始化各选项卡内容模块
 */

import { getCurrentLang, initI18n, switchLang, t } from './src/i18n.mjs'
import { init as initAiDiag } from './src/tabs/aiDiag.mjs'
import { init as initDebug } from './src/tabs/debug.mjs'
import { init as initFakeSend } from './src/tabs/fakeSend.mjs'
import { init as initLogger } from './src/tabs/logger.mjs'
import { init as initMemoryManage } from './src/tabs/memoryManage.mjs'
import { init as initMemoryPreset } from './src/tabs/memoryPreset.mjs'
import { init as initPersona } from './src/tabs/persona.mjs'
import { init as initPluginConfig } from './src/tabs/pluginConfig.mjs'
import { init as initPreset } from './src/tabs/preset.mjs'
import { init as initSystem } from './src/tabs/system.mjs'
import { init as initSysViewer } from './src/tabs/sysViewer.mjs'
import { init as initUsage } from './src/tabs/usage.mjs'
import { init as initWorldbook } from './src/tabs/worldbook.mjs'

// ===== 选项卡配置（使用 i18n key） =====
const TAB_CONFIG = {
	usage: {
		titleKey: 'nav.usage.chars',
		descKey: 'desc.usage',
	},
	system: {
		titleKey: 'nav.system.api',
		descKey: 'desc.system',
	},
	user: {
		titleKey: 'nav.user.theme',
		descKey: 'desc.user',
	},
}

// ===== DOM 引用 =====
const tabButtons = document.querySelectorAll('.beilu-tab')
const tabContents = document.querySelectorAll('.beilu-tab-content')
const dynamicTitle = document.getElementById('dynamic-title')
const dynamicDescription = document.getElementById('dynamic-description')

// ===== 选项卡切换 =====
function switchTab(tabId) {
	// 更新选项卡按钮状态
	tabButtons.forEach(btn => {
		btn.classList.toggle('active', btn.dataset.tab === tabId)
	})

	// 更新选项卡内容显示
	tabContents.forEach(content => {
		content.classList.toggle('active', content.id === `tab-${tabId}`)
	})

	// 更新子头部
	const config = TAB_CONFIG[tabId]
	if (config) {
		dynamicTitle.textContent = t(config.titleKey)
		dynamicDescription.textContent = t(config.descKey)
	}
}

// ===== 事件绑定 =====
tabButtons.forEach(btn => {
	btn.addEventListener('click', () => {
		switchTab(btn.dataset.tab)
	})
})

// ===== Service Worker 通知 =====
// 通知 Service Worker 退出冷启动缓存模式（Fount 机制）
if (navigator.serviceWorker?.controller) {
	const channel = new MessageChannel()
	navigator.serviceWorker.controller.postMessage({ type: 'EXIT_COLD_BOOT' }, [channel.port2])
}

// ===== "使用"选项卡导航切换 =====
const usageNavItems = document.querySelectorAll('.beilu-usage-nav-item')
const usageSectionTitleKeys = {
	chars: 'nav.usage.chars',
	worlds: 'nav.usage.worlds',
	personas: 'nav.usage.personas',
	presets: 'nav.usage.presets',
	memoryPresets: 'nav.usage.memoryPresets',
	memoryManage: 'nav.usage.memoryManage',
	sysViewer: 'nav.usage.sysViewer',
	aiDiag: 'nav.usage.aiDiag',
}

usageNavItems.forEach(btn => {
	btn.addEventListener('click', () => {
		if (btn.disabled) return
		const sectionId = btn.dataset.section
		// 切换导航高亮
		usageNavItems.forEach(n => n.classList.toggle('active', n === btn))
		// 切换内容区
		document.querySelectorAll('.beilu-usage-section').forEach(s => {
			s.classList.toggle('active', s.id === `section-${sectionId}`)
		})
		// 更新子头部标题
		dynamicTitle.textContent = t(usageSectionTitleKeys[sectionId]) || sectionId

		// 懒加载：首次切换到预设管理时初始化
		if (sectionId === 'presets' && !presetInitialized) {
			presetInitialized = true
			initPreset().catch(err => {
				console.error('[beilu-home] 初始化预设管理失败:', err)
			})
		}

		// 懒加载：首次切换到世界书时初始化
		if (sectionId === 'worlds' && !worldbookInitialized) {
			worldbookInitialized = true
			initWorldbook().catch(err => {
				console.error('[beilu-home] 初始化世界书管理失败:', err)
			})
		}

		// 懒加载：首次切换到用户人设时初始化
		if (sectionId === 'personas' && !personaInitialized) {
			personaInitialized = true
			initPersona().catch(err => {
				console.error('[beilu-home] 初始化人设管理失败:', err)
			})
		}

		// 懒加载：首次切换到记忆预设时初始化
		if (sectionId === 'memoryPresets' && !memoryPresetInitialized) {
			memoryPresetInitialized = true
			initMemoryPreset().catch(err => {
				console.error('[beilu-home] 初始化记忆预设管理失败:', err)
			})
		}

		// 懒加载：首次切换到记忆管理时初始化
		if (sectionId === 'memoryManage' && !memoryManageInitialized) {
			memoryManageInitialized = true
			initMemoryManage().catch(err => {
				console.error('[beilu-home] 初始化记忆管理失败:', err)
			})
		}

		// 懒加载：首次切换到系统查看器时初始化
		if (sectionId === 'sysViewer' && !sysViewerInitialized) {
			sysViewerInitialized = true
			initSysViewer().catch(err => {
				console.error('[beilu-home] 初始化系统查看器失败:', err)
			})
		}

		// 懒加载：首次切换到AI诊断时初始化
		if (sectionId === 'aiDiag' && !aiDiagInitialized) {
			aiDiagInitialized = true
			initAiDiag().catch(err => {
				console.error('[beilu-home] 初始化AI诊断面板失败:', err)
			})
		}
	})
})

// ===== "系统设置"选项卡导航切换 =====
const systemNavItems = document.querySelectorAll('.beilu-system-nav-item')
const systemSectionTitleKeys = {
	api: 'nav.system.api',
	search: 'nav.system.search',
	translate: 'nav.system.translate',
	import: 'nav.system.import',
	plugins: 'nav.system.plugins',
	generators: 'nav.system.generators',
	shells: 'nav.system.shells',
}

systemNavItems.forEach(btn => {
	btn.addEventListener('click', () => {
		if (btn.disabled) return
		const sectionId = btn.dataset.sysSection
		// 切换导航高亮
		systemNavItems.forEach(n => n.classList.toggle('active', n === btn))
		// 切换内容区
		document.querySelectorAll('.beilu-system-section').forEach(s => {
			s.classList.toggle('active', s.id === `sys-section-${sectionId}`)
		})
		// 更新子头部标题
		dynamicTitle.textContent = t(systemSectionTitleKeys[sectionId]) || sectionId
	})
})

// ===== "用户设置"选项卡导航切换 =====
const userNavItems = document.querySelectorAll('.beilu-user-nav-item')
const userSectionTitleKeys = {
	theme: 'nav.user.theme',
	language: 'nav.user.language',
	remote: 'nav.user.remote',
	browser: 'nav.user.browser',
	debug: 'nav.user.debug',
	about: 'nav.user.about',
}

userNavItems.forEach(btn => {
	btn.addEventListener('click', () => {
		if (btn.disabled) return
		const sectionId = btn.dataset.userSection
		// 切换导航高亮
		userNavItems.forEach(n => n.classList.toggle('active', n === btn))
		// 切换内容区
		document.querySelectorAll('.beilu-user-section').forEach(s => {
			s.classList.toggle('active', s.id === `user-section-${sectionId}`)
		})
		// 更新子头部标题
		dynamicTitle.textContent = t(userSectionTitleKeys[sectionId]) || sectionId
	})
})

// ===== 初始化各模块 =====
let presetInitialized = false
let worldbookInitialized = false
let personaInitialized = false
let memoryManageInitialized = false
let memoryPresetInitialized = false
let sysViewerInitialized = false
let aiDiagInitialized = false
let systemInitialized = false
let pluginConfigInitialized = false
let loggerInitialized = false
let debugInitialized = false
let fakeSendInitialized = false

console.log('[beilu-home] 首页已加载')

// 初始化"使用"选项卡（角色卡列表）
initUsage().catch(err => {
	console.error('[beilu-home] 初始化"使用"选项卡失败:', err)
})

// 监听顶级选项卡切换，懒加载系统设置
tabButtons.forEach(btn => {
	btn.addEventListener('click', () => {
		if (btn.dataset.tab === 'system' && !systemInitialized) {
			systemInitialized = true
			initSystem().catch(err => {
				console.error('[beilu-home] 初始化系统设置失败:', err)
			})
		}
		if (btn.dataset.tab === 'system' && !pluginConfigInitialized) {
			pluginConfigInitialized = true
			initPluginConfig().catch(err => {
				console.error('[beilu-home] 初始化插件配置面板失败:', err)
			})
			// 初始化 beilu-eye 面板
			initBeiluEyePanel()
		}
		if (btn.dataset.tab === 'user' && !loggerInitialized) {
			loggerInitialized = true
			initLogger().catch(err => {
				console.error('[beilu-home] 初始化日志面板失败:', err)
			})
		}
		if (btn.dataset.tab === 'user' && !debugInitialized) {
			debugInitialized = true
			initDebug().catch(err => {
				console.error('[beilu-home] 初始化调试面板失败:', err)
			})
		}
		if (btn.dataset.tab === 'user' && !fakeSendInitialized) {
			fakeSendInitialized = true
			initFakeSend().catch(err => {
				console.error('[beilu-home] 初始化伪发送面板失败:', err)
			})
		}
	})
})

// ===== beilu-eye 面板交互 =====
const BE_API = '/api/parts/plugins:beilu-eye/config'

function initBeiluEyePanel() {
	const expandable = document.getElementById('plugin-beilu-eye')
	const header = expandable?.querySelector('.beilu-part-item-header')
	const configPanel = document.getElementById('beilu-eye-config')
	const statusBadge = document.getElementById('be-electron-status')
	const startBtn = document.getElementById('be-start-btn')
	const stopBtn = document.getElementById('be-stop-btn')
	const restartBtn = document.getElementById('be-restart-btn')

	if (!expandable || !header) return

	// 展开/折叠
	header.addEventListener('click', (e) => {
		if (e.target.closest('.toggle')) return
		const isExpanded = expandable.classList.toggle('expanded')
		if (configPanel) {
			configPanel.style.display = isExpanded ? 'block' : 'none'
		}
		if (isExpanded) refreshEyeStatus()
	})

	// 刷新状态
	async function refreshEyeStatus() {
		try {
			const res = await fetch(`${BE_API}/getdata`)
			if (!res.ok) {
				if (statusBadge) statusBadge.textContent = t('sys.plugins.eye.notLoaded')
						return
			}
			const data = await res.json()
			if (statusBadge) {
				const labelKeys = { stopped: 'sys.plugins.eye.stopped', installing: 'sys.plugins.eye.installing', starting: 'sys.plugins.eye.starting', running: 'sys.plugins.eye.running', error: 'sys.plugins.eye.error' }
						statusBadge.textContent = labelKeys[data.electronStatus] ? t(labelKeys[data.electronStatus]) : data.electronStatus
				statusBadge.className = 'badge badge-sm badge-outline'
				if (data.electronStatus === 'running') statusBadge.classList.add('badge-success')
				else if (data.electronStatus === 'error') statusBadge.classList.add('badge-error')
				else statusBadge.classList.add('badge-warning')
			}
		} catch {
			if (statusBadge) statusBadge.textContent = t('sys.plugins.eye.notLoaded')
		}
	}

	// 按钮事件
	async function sendEyeAction(action) {
		try {
			await fetch(`${BE_API}/setdata`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ _action: action }),
			})
			setTimeout(refreshEyeStatus, 1500)
		} catch (err) {
			console.error('[beilu-eye] action failed:', err)
		}
	}

	startBtn?.addEventListener('click', () => sendEyeAction('restart-electron'))
	stopBtn?.addEventListener('click', () => sendEyeAction('stop-electron'))
	restartBtn?.addEventListener('click', () => sendEyeAction('restart-electron'))
}

// ===== 深色/浅色主题切换 =====
function initDarkMode() {
	const toggle = document.getElementById('user-dark-mode')
	if (!toggle) return

	// preload.mjs 已设置 data-theme，从当前状态同步 toggle
	const currentTheme = document.documentElement.dataset.theme
	const isDark = currentTheme !== 'light'
	toggle.checked = isDark

	// 更新描述文字
	const desc = toggle.closest('.beilu-settings-item')?.querySelector('.text-xs')
	if (desc) desc.textContent = isDark ? t('user.theme.darkMode.on') : t('user.theme.darkMode.off')

	toggle.addEventListener('change', () => {
		const theme = toggle.checked ? 'dark' : 'light'
		localStorage.setItem('theme', theme)
		document.documentElement.setAttribute('data-theme', theme)
		if (desc) desc.textContent = toggle.checked ? t('user.theme.darkMode.on') : t('user.theme.darkMode.off')
	})
}

initDarkMode()

// ===== 字体大小控制 =====
function initFontSize() {
	const fontSizeSelect = document.getElementById('user-font-size')
	if (!fontSizeSelect) return

	// 从 localStorage 恢复
	const saved = localStorage.getItem('beilu-font-size') || 'medium'
	fontSizeSelect.value = saved
	applyFontSize(saved)

	fontSizeSelect.addEventListener('change', () => {
		const size = fontSizeSelect.value
		localStorage.setItem('beilu-font-size', size)
		applyFontSize(size)
	})
}

function applyFontSize(size) {
	// 移除所有字体大小 class（设在 <html> 上，rem 才能生效）
	document.documentElement.classList.remove('font-size-small', 'font-size-medium', 'font-size-large')
	document.documentElement.classList.add(`font-size-${size}`)
}

initFontSize()

// ===== 远程访问 URL 显示 =====
async function initRemoteAccess() {
	const urlEl = document.getElementById('user-local-url')
	const copyBtn = document.getElementById('user-copy-url')
	if (!urlEl) return

	try {
		const res = await fetch('/api/parts/shells:beilu-home/network-info')
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const data = await res.json()
		const port = data.port || 1314
		const ips = data.ips || []

		if (ips.length === 0) {
				urlEl.textContent = `http://localhost:${port}` + t('user.remote.noLan')
		} else {
			// 显示所有局域网地址（后端返回 [{name, address}]）
			const urls = ips.map(ip => `http://${ip.address}:${port}`)
			urlEl.innerHTML = urls.map(u => `<div>${u}</div>`).join('')
		}

		// 复制按钮
		if (copyBtn) {
			copyBtn.addEventListener('click', () => {
				const firstUrl = ips.length > 0 ? `http://${ips[0].address}:${port}` : `http://localhost:${port}`
				navigator.clipboard.writeText(firstUrl).then(() => {
					copyBtn.textContent = t('user.remote.copied')
					setTimeout(() => { copyBtn.textContent = t('user.remote.copy') }, 2000)
				}).catch(() => {
					// fallback
					const ta = document.createElement('textarea')
					ta.value = firstUrl
					document.body.appendChild(ta)
					ta.select()
					document.execCommand('copy')
					document.body.removeChild(ta)
					copyBtn.textContent = t('user.remote.copied')
					setTimeout(() => { copyBtn.textContent = t('user.remote.copy') }, 2000)
				})
			})
		}
	} catch (err) {
		console.warn('[beilu-home] 获取网络信息失败:', err)
		urlEl.textContent = `http://localhost:1314` + t('user.remote.failed')
	}
}

initRemoteAccess()

// ===== 手机适配（小屏单面板模式） =====
function initMobileAdaptation() {
	const MOBILE_BREAKPOINT = 768

	// 为每个 usage-content 区域创建返回按钮
	const contentAreas = document.querySelectorAll('.beilu-usage-content')
	contentAreas.forEach(area => {
		const backBtn = document.createElement('button')
		backBtn.className = 'beilu-mobile-back-btn'
		backBtn.innerHTML = t('mobile.back')
		backBtn.dataset.i18n = 'mobile.back'
		backBtn.addEventListener('click', () => showMobileNav())
		area.prepend(backBtn)
	})

	// 获取所有 layout 容器
	const layouts = document.querySelectorAll('.beilu-usage-layout')

	// 监听导航项点击 → 小屏时切换到内容模式
	const allNavItems = document.querySelectorAll('.beilu-usage-nav-item, .beilu-system-nav-item, .beilu-user-nav-item')
	allNavItems.forEach(btn => {
		btn.addEventListener('click', () => {
			if (window.innerWidth <= MOBILE_BREAKPOINT) {
				showMobileContent()
			}
		})
	})

	function showMobileContent() {
		layouts.forEach(l => {
			l.classList.remove('mobile-nav-active')
			l.classList.add('mobile-content-active')
		})
	}

	function showMobileNav() {
		layouts.forEach(l => {
			l.classList.remove('mobile-content-active')
			l.classList.add('mobile-nav-active')
		})
	}

	// 响应窗口大小变化
	function handleResize() {
		if (window.innerWidth > MOBILE_BREAKPOINT) {
			// 桌面：移除所有手机模式 class
			layouts.forEach(l => {
				l.classList.remove('mobile-content-active', 'mobile-nav-active')
			})
		} else {
			// 手机：默认显示导航
			const hasActive = [...layouts].some(l =>
				l.classList.contains('mobile-content-active') || l.classList.contains('mobile-nav-active')
			)
			if (!hasActive) {
				layouts.forEach(l => l.classList.add('mobile-nav-active'))
			}
		}
	}

	window.addEventListener('resize', handleResize)
	handleResize()
}

initMobileAdaptation()

// ===== 语言切换 =====
function initLanguageSwitch() {
	const langSelect = document.getElementById('user-language')
	if (!langSelect) return

	// 从 localStorage 恢复
	const saved = localStorage.getItem('beiluHomeLang') || 'zh-CN'
	langSelect.value = saved

	langSelect.addEventListener('change', () => {
		switchLang(langSelect.value)
	})

	// 语言切换事件 → 更新动态标题
	window.addEventListener('beilu-lang-change', () => {
		// 找到当前激活的顶级 tab
		const activeTab = document.querySelector('.beilu-tab.active')
		if (activeTab) {
			switchTab(activeTab.dataset.tab)
		}
	})
}

// ===== 初始化 i18n =====
initI18n().then(() => {
	initLanguageSwitch()

	// 如果不是中文，需要重新设置动态标题
	if (getCurrentLang() !== 'zh-CN') {
		const activeTab = document.querySelector('.beilu-tab.active')
		if (activeTab) {
			switchTab(activeTab.dataset.tab)
		}
	}
}).catch(err => {
	console.warn('[beilu-home] i18n 初始化失败:', err)
	initLanguageSwitch()
})