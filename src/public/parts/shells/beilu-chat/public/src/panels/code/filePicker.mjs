/**
 * filePicker.mjs — 模态文件/文件夹选择器
 *
 * 功能链：
 *   showFolderPicker(initialPath?) / showFilePicker(initialPath?)
 *     → 弹出模态对话框 → 渲染当前目录条目（listDir → POST beilu-files setdata {_action:"listDir", path}）
 *     → 点目录 → 进入子目录刷新列表；点「↑ 上级」→ parentPath 计算上级路径
 *     → 文件夹选择器：点「选择此文件夹」→ resolve(currentPath)
 *     → 文件选择器：点文件 → resolve(filePath)
 *     → 取消/关闭 → resolve(null)
 *   Windows 驱动器列表：当路径退到盘符根时显示 __drives__ 特殊视图（A:-Z: 枚举）
 *
 * why：
 *   服务端文件系统不能用浏览器原生 <input type="file">，需要通过 beilu-files 后端 API 遍历；
 *   免责协议（disclaimerAccepted 会话级）防止用户误选系统目录后大量文件操作。
 *   normalizePath 统一斜杠方向，兼容 Windows 盘符（D:/ D:\ 均处理正确）。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（listDir 调用：POST beilu-files setdata）
 *   → shared/state/utils.mjs escapeHtml（文件名 XSS 安全转义）
 *   ← fileExplorer.mjs（打开文件夹/打开文件按钮调用本模块两个入口函数）
 *
 * 影响范围：
 *   动态创建/复用 #beilu-folder-picker-modal / #beilu-file-picker-modal 模态 DOM；
 *   不持久化任何状态（disclaimerAccepted 为会话内存，关闭页面重置）。
 *
 * 使用效果：
 *   调用方 await showFolderPicker() → 用户在弹窗浏览服务端目录 → 选定后返回绝对路径字符串；
 *   取消或关闭返回 null；用户首次使用会弹免责确认框。
 */

import { escapeHtml } from '../../shared/state/utils.mjs'
import { storage, KEYS } from '../../shared/state/storage.mjs' // R2: localStorage 集中（安全根路径读取）
import { sendAction } from '../../shared/transport/sendAction.mjs' // T6b：出向统一门面（verb=真动作 listDir → beilu-files 通配路由）

// ============================================================
// API
// ============================================================

async function listDir(path) {
	// verb=listDir → beilu-files 通配路由组装 {_action:"listDir", path}。逻辑失败走 _result.error（HTTP 200）。
	const data = await sendAction({ verb: 'listDir', target: 'plugins:beilu-files', source: 'web', payload: { path } })
	if (data?._result?.error) throw new Error(data._result.error)
	return data?._result?.entries || []
}

// ============================================================
// 工具函数
// ============================================================

function getFileIcon(name, isDir) {
	if (isDir) return '<i data-ic="folder-open"></i>'
	const ext = name.split('.').pop()?.toLowerCase()
	const icons = {
		js: '<i data-ic="script"></i>', mjs: '<i data-ic="script"></i>', ts: '<i data-ic="book"></i>', json: '<i data-ic="clipboard"></i>', css: '<i data-ic="palette"></i>', html: '<i data-ic="earth"></i>',
		md: '<i data-ic="edit"></i>', txt: '<i data-ic="file"></i>', py: '<i data-ic="python"></i>', sh: '<i data-ic="zap"></i>', bat: '<i data-ic="zap"></i>',
		png: '<i data-ic="image"></i>', jpg: '<i data-ic="image"></i>', jpeg: '<i data-ic="image"></i>', gif: '<i data-ic="image"></i>', svg: '<i data-ic="image"></i>',
	}
	return icons[ext] || '<i data-ic="file"></i>'
}

function normalizePath(path) {
	// 统一斜杠方向，合并重复斜杠
	let result = path.replace(/\\/g, '/').replace(/\/+/g, '/')
	// 去掉尾部斜杠，但保留 Windows 盘符根 (如 D:/)
	if (/^[a-zA-Z]:\/$/.test(result)) {
		return result // D:/ 保持原样
	}
	result = result.replace(/\/$/, '') || '.'
	// 单独的盘符 D: 补上 /
	if (/^[a-zA-Z]:$/.test(result)) {
		return result + '/'
	}
	return result
}

function parentPath(path) {
	const normalized = normalizePath(path)
	// 项目根目录 '.' 的上级 → 显示驱动器列表
	if (normalized === '.' || normalized === '') return '__drives__'
	// [0719 适配必修1] POSIX 根 '/' 的顶层 → 与盘符根同语义回到"计算机"视图
	if (normalized === '/') return '__drives__'
	// Windows 盘符根 (D:/) 的上级 → 显示驱动器列表
	if (/^[a-zA-Z]:\/?$/.test(normalized)) return '__drives__'
	const parts = normalized.split('/')
	parts.pop()
	if (parts.length === 0) return '.'
	// 如果剩下的是盘符 (如 D:)，补上 /
	const result = parts.join('/')
	if (/^[a-zA-Z]:$/.test(result)) return result + '/'
	// [0719 适配必修1] POSIX 一级目录 (/home) 的上级：split 后剩 [''] join 成空串——归位到根 '/'
	if (result === '' && normalized.startsWith('/')) return '/'
	return result
}

/** 检测是否为 Windows 绝对路径 */
function isAbsolutePath(path) {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')
}

/** 安全区兜底（正常触达不到）：fileExplorer init 保证 localStorage BEILU_FILE_ROOT 必有值
 *  （首次=后端 ensureDefaultWorkspace 的「ai玩耍空间」，之后=用户上次工作区）；本值仅
 *  localStorage 被禁用/异常时兜底。"." 比默认工作区略宽（app 根内不弹免责），绝对路径仍全弹。 */
const DEFAULT_SAFE_ROOT = '.'

/** 是否已确认过免责协议（会话级别） */
let disclaimerAccepted = false

function _getCurrentSafeRoot() {
	try { return storage.get(KEYS.BEILU_FILE_ROOT) || DEFAULT_SAFE_ROOT } catch { return DEFAULT_SAFE_ROOT }
}

function isOutsideSafeZone(path) {
	const safeRoot = normalizePath(_getCurrentSafeRoot())
	const normalized = normalizePath(path)
	if (normalized === '__drives__') return true
	if (isAbsolutePath(safeRoot)) {
		if (!isAbsolutePath(normalized)) return true
		const sl = safeRoot.toLowerCase(), nl = normalized.toLowerCase()
		return nl !== sl && !nl.startsWith(sl + '/')
	}
	if (isAbsolutePath(normalized)) return true
	if (normalized.startsWith('..')) return true
	return !normalized.startsWith(safeRoot)
}

/** 系统盘符（隐藏） */
const HIDDEN_DRIVES = ['C']

/**
 * 显示免责协议对话框
 * @returns {Promise<boolean>} 用户是否同意
 */
function showDisclaimerDialog() {
	return new Promise((resolve) => {
		const overlay = document.createElement('div')
		overlay.className = 'fp-overlay'
		overlay.style.zIndex = 'var(--z-overlay)'

		const dialog = document.createElement('div')
		dialog.className = 'fp-modal'
		dialog.style.maxWidth = '480px'
		dialog.innerHTML = `
			<div class="fp-header">
				<span class="fp-title"><i data-ic="warning"></i> 安全提示</span>
			</div>
			<div style="padding: 16px; font-size: 13px; line-height: 1.6; color: var(--color-base-content);">
				<p style="margin-bottom: 12px;">首次使用 <strong>beilu-always accompany</strong> 时，建议将 AI 的文件操作范围保持在默认工作区 <strong>「AI 玩耍空间」</strong> 内，不要指向其他目录。</p>
				<p style="margin-bottom: 12px; color: var(--beilu-warning);">⚠️ 如果因为您自行导航到系统或其他重要目录而造成的文件损失，您必须自行负责。我们不会对因您自身不当操作造成的损失负责。</p>
				<div style="border-top: 1px solid var(--beilu-border); padding-top: 12px; display: flex; justify-content: flex-end; gap: 8px;">
					<button class="fp-cancel-btn" id="disclaimer-reject" style="padding: 6px 16px;">不同意</button>
					<button class="fp-confirm-btn" id="disclaimer-accept" style="padding: 6px 16px; background: var(--beilu-amber); color: var(--beilu-bg-dark); border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">同意该协议</button>
				</div>
			</div>
		`

		overlay.appendChild(dialog)
		document.body.appendChild(overlay)

		dialog.querySelector('#disclaimer-accept').addEventListener('click', () => {
			disclaimerAccepted = true
			overlay.remove()
			resolve(true)
		})

		dialog.querySelector('#disclaimer-reject').addEventListener('click', () => {
			overlay.remove()
			resolve(false)
		})

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				overlay.remove()
				resolve(false)
			}
		})
	})
}

function formatSize(bytes) {
	if (bytes == null) return ''
	if (bytes < 1024) return bytes + 'B'
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K'
	return (bytes / (1024 * 1024)).toFixed(1) + 'M'
}

// ============================================================
// 模态对话框
// ============================================================

/**
 * 创建并显示文件/文件夹选择器
 * @param {'folder'|'file'} mode - 选择模式
 * @param {string} initialPath - 初始路径
 * @returns {Promise<string|null>} 选中的路径，取消返回 null
 */
function createPicker(mode, initialPath) {
	return new Promise((resolve) => {
		let currentDir = normalizePath(initialPath || '.')
		let selectedItem = null // { name, path, isDirectory }
		let isLoading = false

		// 创建模态
		const overlay = document.createElement('div')
		overlay.className = 'fp-overlay'

		const modal = document.createElement('div')
		modal.className = 'fp-modal'

		const title = mode === 'folder' ? '<i data-ic="folder-open"></i> 打开文件夹' : '<i data-ic="file"></i> 打开文件'
		const confirmText = mode === 'folder' ? '选择此目录' : '打开'

		modal.innerHTML = `
			<div class="fp-header">
				<span class="fp-title">${title}</span>
				<button class="fp-close-btn" title="关闭">×</button>
			</div>
			<div class="fp-path-bar">
				<button class="fp-up-btn" title="上级目录">⬆️</button>
				<input type="text" class="fp-path-input" value="${escapeHtml(currentDir)}" spellcheck="false" />
				<button class="fp-go-btn" title="前往">→</button>
			</div>
			<div class="fp-breadcrumb"></div>
			<div class="fp-list-container">
				<div class="fp-list"></div>
			</div>
			<div class="fp-footer">
				<span class="fp-selected-label"></span>
				<div class="fp-footer-buttons">
					<button class="fp-cancel-btn">取消</button>
					<button class="fp-confirm-btn" disabled>${confirmText}</button>
				</div>
			</div>
		`

		overlay.appendChild(modal)
		document.body.appendChild(overlay)

		// DOM 引用
		const closeBtn = modal.querySelector('.fp-close-btn')
		const upBtn = modal.querySelector('.fp-up-btn')
		const pathInput = modal.querySelector('.fp-path-input')
		const goBtn = modal.querySelector('.fp-go-btn')
		const breadcrumb = modal.querySelector('.fp-breadcrumb')
		const listContainer = modal.querySelector('.fp-list')
		const selectedLabel = modal.querySelector('.fp-selected-label')
		const cancelBtn = modal.querySelector('.fp-cancel-btn')
		const confirmBtn = modal.querySelector('.fp-confirm-btn')

		// ---- 关闭 ----
		function close(result) {
			overlay.remove()
			resolve(result)
		}

		closeBtn.addEventListener('click', () => close(null))
		cancelBtn.addEventListener('click', () => close(null))
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close(null)
		})

		// ESC 关闭
		function onKeyDown(e) {
			if (e.key === 'Escape') {
				close(null)
				document.removeEventListener('keydown', onKeyDown)
			}
		}
		document.addEventListener('keydown', onKeyDown)

		// ---- 确认 ----
		confirmBtn.addEventListener('click', () => {
			if (mode === 'folder') {
				// 文件夹模式：选当前目录 或 选中的子目录
				close(selectedItem?.isDirectory ? selectedItem.path : currentDir)
			} else {
				// 文件模式：必须选中文件
				if (selectedItem && !selectedItem.isDirectory) {
					close(selectedItem.path)
				}
			}
		})

		// ---- 安全导航：检查是否需要免责确认 ----
		async function safeNavigate(target) {
			if (isOutsideSafeZone(target) && !disclaimerAccepted) {
				const accepted = await showDisclaimerDialog()
				if (!accepted) return // 用户拒绝，不导航
			}
			if (target === '__drives__') {
				showDrivesList()
			} else {
				navigateTo(target)
			}
		}

		// ---- 导航 ----
		upBtn.addEventListener('click', () => {
			const parent = parentPath(currentDir)
			safeNavigate(parent)
		})

		goBtn.addEventListener('click', () => {
			const target = normalizePath(pathInput.value.trim())
			if (target) safeNavigate(target)
		})

		pathInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				const target = normalizePath(pathInput.value.trim())
				if (target) safeNavigate(target)
			}
		})

		// ---- 渲染面包屑 ----
		function renderBreadcrumb() {
			const parts = currentDir === '.' ? ['.'] : currentDir.split('/').filter(p => p !== '')
			let html = ''
			// 如果是绝对路径，添加"计算机"作为最前面的面包屑
			if (isAbsolutePath(currentDir)) {
				html += `<span class="fp-crumb" data-action="drives"><i data-ic="code"></i> 计算机</span><span class="fp-crumb-sep">/</span>`
			}
			let accumulated = ''
			for (let i = 0; i < parts.length; i++) {
				if (i === 0) {
					accumulated = parts[0]
					// 盘符需要补 /
					if (/^[a-zA-Z]:$/.test(accumulated)) accumulated += '/'
				} else {
					accumulated = accumulated.replace(/\/$/, '') + '/' + parts[i]
				}
				const display = parts[i] === '.' ? '项目目录' : parts[i]
				const isLast = i === parts.length - 1
				html += `<span class="fp-crumb${isLast ? ' fp-crumb-active' : ''}" data-path="${escapeHtml(accumulated)}">${escapeHtml(display)}</span>`
				if (!isLast) html += '<span class="fp-crumb-sep">/</span>'
			}
			breadcrumb.innerHTML = html

			breadcrumb.querySelectorAll('.fp-crumb:not(.fp-crumb-active)').forEach(el => {
				if (el.dataset.action === 'drives') {
					el.addEventListener('click', () => showDrivesList())
				} else {
					el.addEventListener('click', () => navigateTo(el.dataset.path))
				}
			})
		}

		// ---- 加载并渲染目录 ----
		async function navigateTo(path) {
			if (isLoading) return
			isLoading = true
			currentDir = normalizePath(path)
			pathInput.value = currentDir
			selectedItem = null
			updateSelection()

			listContainer.innerHTML = '<div class="fp-loading">加载中...</div>'

			try {
				const entries = await listDir(currentDir)

				// 排序：目录在前，文件在后，各自按名称排序
				entries.sort((a, b) => {
					if (a.isDirectory && !b.isDirectory) return -1
					if (!a.isDirectory && b.isDirectory) return 1
					return (a.name || '').localeCompare(b.name || '')
				})

				renderBreadcrumb()

				if (entries.length === 0) {
					listContainer.innerHTML = '<div class="fp-empty">（空目录）</div>'
				} else {
					let html = ''
					for (const entry of entries) {
						const fullPath = currentDir === '.' ? entry.name : currentDir + '/' + entry.name
						const icon = getFileIcon(entry.name, entry.isDirectory)
						const sizeStr = (!entry.isDirectory && entry.size != null) ? formatSize(entry.size) : ''
						const isSelectable = mode === 'folder' ? entry.isDirectory : !entry.isDirectory

						html += `
							<div class="fp-item${entry.isDirectory ? ' fp-item-dir' : ' fp-item-file'}"
								data-path="${escapeHtml(fullPath)}"
								data-name="${escapeHtml(entry.name)}"
								data-is-dir="${entry.isDirectory}">
								<span class="fp-item-icon">${icon}</span>
								<span class="fp-item-name">${escapeHtml(entry.name)}</span>
								<span class="fp-item-size">${sizeStr}</span>
							</div>
						`
					}
					listContainer.innerHTML = html

					// 绑定事件
					listContainer.querySelectorAll('.fp-item').forEach(el => {
						const itemPath = el.dataset.path
						const itemName = el.dataset.name
						const isDir = el.dataset.isDir === 'true'

						// 单击选中
						el.addEventListener('click', () => {
							listContainer.querySelectorAll('.fp-item').forEach(e => e.classList.remove('fp-item-selected'))
							el.classList.add('fp-item-selected')
							selectedItem = { name: itemName, path: itemPath, isDirectory: isDir }
							updateSelection()
						})

						// 双击：目录进入，文件确认
						el.addEventListener('dblclick', () => {
							if (isDir) {
								navigateTo(itemPath)
							} else if (mode === 'file') {
								close(itemPath)
							}
						})
					})
				}
			} catch (err) {
				listContainer.innerHTML = `<div class="fp-error">加载失败: ${escapeHtml(err.message)}</div>`
			}

			isLoading = false
		}

		// ---- 更新选中状态 ----
		function updateSelection() {
			if (mode === 'folder') {
				if (selectedItem?.isDirectory) {
					selectedLabel.textContent = `已选: ${selectedItem.name}/`
					confirmBtn.disabled = false
				} else {
					selectedLabel.textContent = `当前目录: ${currentDir === '.' ? '根目录' : currentDir}`
					// 文件夹模式始终可确认（选当前目录）
					confirmBtn.disabled = false
				}
			} else {
				if (selectedItem && !selectedItem.isDirectory) {
					selectedLabel.textContent = `已选: ${selectedItem.name}`
					confirmBtn.disabled = false
				} else {
					selectedLabel.textContent = ''
					confirmBtn.disabled = true
				}
			}
		}

		// ---- 显示驱动器列表 (Windows) ----
		async function showDrivesList() {
			isLoading = true
			currentDir = '__drives__'
			pathInput.value = ''
			selectedItem = null
			updateSelection()

			breadcrumb.innerHTML = '<span class="fp-crumb fp-crumb-active"><i data-ic="code"></i> 计算机</span>'
			listContainer.innerHTML = '<div class="fp-loading">正在扫描驱动器...</div>'

			// 探测盘符：先 D-Z 再 A/B（跳过系统盘 C），listDir 不抛错即视为存在
			const drives = []
			const letters = 'DEFGHIJKLMNOPQRSTUVWXYZAB'.split('')
			for (const letter of letters) {
				try {
					const testPath = letter + ':/'
					const entries = await listDir(testPath)
					// 如果没抛错说明盘符存在
					drives.push({ name: letter + ':', path: testPath, isDirectory: true })
				} catch {
					// 盘符不存在，跳过
				}
			}

			// [0719 适配必修1] 非 Windows 后端（mac/linux）无盘符 → 探测 POSIX 根 '/'（探测式，
			//   不猜平台：Windows 有盘符时不会走到这，POSIX 后端 listDir('/') 通过即给根入口，
			//   否则原「未找到可用驱动器」死路让非 Windows 用户永远选不了工作区）
			if (drives.length === 0) {
				try {
					await listDir('/')
					drives.push({ name: '/', path: '/', isDirectory: true, isPosixRoot: true })
				} catch {
					// 连 '/' 都不可列：维持空态提示
				}
			}

			if (drives.length === 0) {
				listContainer.innerHTML = '<div class="fp-empty">未找到可用驱动器</div>'
			} else {
				let html = ''
				for (const drive of drives) {
					html += `
						<div class="fp-item fp-item-dir"
							data-path="${escapeHtml(drive.path)}"
							data-name="${escapeHtml(drive.name)}"
							data-is-dir="true">
							<span class="fp-item-icon"><i data-ic="save"></i></span>
							<span class="fp-item-name">${escapeHtml(drive.isPosixRoot ? '/' : drive.name + '/')}</span>
							<span class="fp-item-size">${drive.isPosixRoot ? '根目录' : '本地磁盘'}</span>
						</div>
					`
				}
				listContainer.innerHTML = html

				listContainer.querySelectorAll('.fp-item').forEach(el => {
					el.addEventListener('click', () => {
						listContainer.querySelectorAll('.fp-item').forEach(e => e.classList.remove('fp-item-selected'))
						el.classList.add('fp-item-selected')
						selectedItem = { name: el.dataset.name, path: el.dataset.path, isDirectory: true }
						updateSelection()
					})
					el.addEventListener('dblclick', () => navigateTo(el.dataset.path))
				})
			}
			isLoading = false
		}

		// 初始加载
		navigateTo(currentDir)

		// 文件夹模式下确认按钮默认可用（选当前目录）
		if (mode === 'folder') {
			confirmBtn.disabled = false
		}
	})
}

// ============================================================
// 导出
// ============================================================

/**
 * 显示文件夹选择器
 * @param {string} [initialPath='.'] 初始路径
 * @returns {Promise<string|null>} 选中的目录路径，取消返回 null
 */
export function showFolderPicker(initialPath = '.') {
	return createPicker('folder', initialPath)
}

/**
 * 显示文件选择器
 * @param {string} [initialPath='.'] 初始路径
 * @returns {Promise<string|null>} 选中的文件路径，取消返回 null
 */
export function showFilePicker(initialPath = '.') {
	return createPicker('file', initialPath)
}