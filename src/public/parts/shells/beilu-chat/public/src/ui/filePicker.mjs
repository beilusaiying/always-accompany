/**
 * filePicker.mjs — 模态文件/文件夹选择器
 *
 * 提供两个主要入口：
 * - showFolderPicker(initialPath?) → Promise<string|null>
 * - showFilePicker(initialPath?) → Promise<string|null>
 *
 * 通过 beilu-files 插件 API 浏览服务器文件系统。
 */

const FILES_API_SET = '/api/parts/plugins:beilu-files/config/setdata'

// ============================================================
// API
// ============================================================

async function listDir(path) {
	const res = await fetch(FILES_API_SET, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ _action: 'listDir', path }),
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const data = await res.json()
	if (data?._result?.error) throw new Error(data._result.error)
	return data?._result?.entries || []
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str || ''
	return div.innerHTML
}

function getFileIcon(name, isDir) {
	if (isDir) return '📂'
	const ext = name.split('.').pop()?.toLowerCase()
	const icons = {
		js: '📜', mjs: '📜', ts: '📘', json: '📋', css: '🎨', html: '🌐',
		md: '📝', txt: '📄', py: '🐍', sh: '⚡', bat: '⚡',
		png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
	}
	return icons[ext] || '📄'
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
	// Windows 盘符根 (D:/) 的上级 → 显示驱动器列表
	if (/^[a-zA-Z]:\/?$/.test(normalized)) return '__drives__'
	const parts = normalized.split('/')
	parts.pop()
	if (parts.length === 0) return '.'
	// 如果剩下的是盘符 (如 D:)，补上 /
	const result = parts.join('/')
	if (/^[a-zA-Z]:$/.test(result)) return result + '/'
	return result
}

/** 检测是否为 Windows 绝对路径 */
function isAbsolutePath(path) {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')
}

/** 默认安全根路径 */
const DEFAULT_SAFE_ROOT = 'ai玩耍空间'

/** 是否已确认过免责协议（会话级别） */
let disclaimerAccepted = false

/** 默认安全区域的根 */
const SAFE_ZONE_PREFIX = 'ai玩耍空间'

/**
 * 检测路径是否离开了安全区域 (ai玩耍空间)
 * 不以 ai玩耍空间 开头的任何路径都视为"外部"
 */
function isOutsideSafeZone(path) {
	const normalized = normalizePath(path)
	// __drives__ 是驱动器列表虚拟路径，也是外部
	if (normalized === '__drives__') return true
	// 绝对路径肯定在外部
	if (isAbsolutePath(normalized)) return true
	// ../ 开头也是外部
	if (normalized.startsWith('..')) return true
	// 不以安全区域前缀开头的相对路径也是外部（包括 '.' 项目根）
	if (!normalized.startsWith(SAFE_ZONE_PREFIX)) return true
	return false
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
		overlay.style.zIndex = '10000'

		const dialog = document.createElement('div')
		dialog.className = 'fp-modal'
		dialog.style.maxWidth = '480px'
		dialog.innerHTML = `
			<div class="fp-header">
				<span class="fp-title">⚠️ 安全提示</span>
			</div>
			<div style="padding: 16px; font-size: 13px; line-height: 1.6; color: var(--base-content, #e0d0b0);">
				<p style="margin-bottom: 12px;">如果您是第一次使用 <strong>beilu-always accompany</strong>，还请让 AI 在默认的 <strong>「AI 玩耍空间」</strong> 中活动，而不是前往其他位置。</p>
				<p style="margin-bottom: 12px; color: #f59e0b;">⚠️ 如果因为您自行导航到系统或其他重要目录而造成的文件损失，您必须自行负责。我们不会对因您自身不当操作造成的损失负责。</p>
				<div style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px; display: flex; justify-content: flex-end; gap: 8px;">
					<button class="fp-cancel-btn" id="disclaimer-reject" style="padding: 6px 16px;">不同意</button>
					<button class="fp-confirm-btn" id="disclaimer-accept" style="padding: 6px 16px; background: #d4a017; color: #1a1a2e; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">同意该协议</button>
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

		const title = mode === 'folder' ? '📂 打开文件夹' : '📄 打开文件'
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
				html += `<span class="fp-crumb" data-action="drives">💻 计算机</span><span class="fp-crumb-sep">/</span>`
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

			breadcrumb.innerHTML = '<span class="fp-crumb fp-crumb-active">💻 计算机</span>'
			listContainer.innerHTML = '<div class="fp-loading">正在扫描驱动器...</div>'

			// 尝试常见盘符 A-Z（跳过系统盘）
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
							<span class="fp-item-icon">💾</span>
							<span class="fp-item-name">${escapeHtml(drive.name + '/')}</span>
							<span class="fp-item-size">本地磁盘</span>
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