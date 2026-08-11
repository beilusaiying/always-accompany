/**
 * filePicker.mjs — 模态文件/文件夹选择器
 *
 * 功能链：
 *   showFolderPicker(initialPath?, ownerChatId?, safeRoot?) / showFilePicker(initialPath?, ownerChatId?, safeRoot?)
 *     → 打开时冻结发起窗口 ownerChatId → 弹出模态对话框
 *     → 渲染当前目录条目（listDir + 同一 scope.chatId → POST beilu-files setdata）
 *     → 点目录 → 进入子目录刷新列表；点「↑ 上级」→ parentPath 计算上级路径
 *     → 文件夹选择器：点「选择此文件夹」→ resolve(currentPath)
 *     → 文件选择器：点文件 → resolve(filePath)
 *     → 取消/关闭 → resolve(null)
 *   Windows 驱动器列表：当路径退到盘符根时显示 __drives__ 特殊视图（A:-Z: 枚举）
 *
 * why：
 *   服务端文件系统不能用浏览器原生 <input type="file">，需要通过 beilu-files 后端 API 遍历；
 *   弹窗期间即使切换窗口，所有目录浏览仍沿用打开弹窗时冻结的 ownerChatId，避免跨窗串线；
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
 *   调用方 await showFolderPicker() → 冻结窗口归属 → 用户浏览服务端目录 → 返回绝对路径字符串；
 *   取消或关闭返回 null；用户首次使用会弹免责确认框。
 */

import { escapeHtml } from '../../shared/state/utils.mjs'
import { sendAction } from '../../shared/transport/sendAction.mjs' // T6b：出向统一门面（verb=真动作 listDir → beilu-files 通配路由）
import { currentChatId } from '../../shared/transport/endpoints.mjs'
import { getFileType, getFileTypeIconMarkup } from './fileTypeRegistry.mjs'

// ============================================================
// API
// ============================================================

function freezePickerOwnerChatId(ownerChatId = null) {
	let owner = ownerChatId
	if (!owner) {
		try { owner = window._beiluCurWinChatId?.() || null } catch { owner = null }
	}
	if (!owner) owner = currentChatId || null
	if (typeof owner !== 'string' || !owner.trim()) {
		throw new Error('当前窗口没有有效对话归属，无法浏览窗口隔离文件')
	}
	return owner.trim()
}

// [D6 §3 2026-08-04] 整机浏览授权（browse grant）：后端 listDir 不再以"沙箱闸失败"自动旁路，
//   工作区外列举必须显式携带 requestBrowseGrant 签发的短期 owner-bound grantId（typed E_BROWSE_* 拒绝）。
//   本模块持会话级 grant（TTL 后端定，前端留 5s 提前量续期）；免责协议照旧在前。
let _browseGrant = null // { id, expiresAt }

async function ensureBrowseGrant(ownerChatId) {
	if (_browseGrant && Date.now() < _browseGrant.expiresAt - 5000) return _browseGrant.id
	const data = await sendAction({
		verb: 'requestBrowseGrant', target: 'plugins:beilu-files', source: 'web',
		scope: { chatId: ownerChatId }, payload: {},
	})
	const r = data?._result
	if (!r?.success) {
		_browseGrant = null
		throw new Error(r?.error || '整机浏览授权失败')
	}
	_browseGrant = { id: r.grantId, expiresAt: r.expiresAt }
	return r.grantId
}

async function listDir(path, ownerChatId) {
	// verb=listDir → beilu-files 通配路由组装 {_action:"listDir", path}。逻辑失败走 _result.error（HTTP 200）。
	// 持有未过期 grant 时随请求附带（根内列举后端不消费该字段，零影响；根外列举据此过 grant 闸）。
	const payload = { path }
	if (_browseGrant && Date.now() < _browseGrant.expiresAt) payload.browseGrantId = _browseGrant.id
	const data = await sendAction({
		verb: 'listDir', target: 'plugins:beilu-files', source: 'web',
		scope: { chatId: ownerChatId }, payload,
	})
	if (data?._result?.error) throw new Error(data._result.error)
	return data?._result?.entries || []
}

// ============================================================
// 工具函数
// ============================================================

function normalizePath(path) {
	// 统一斜杠方向，合并重复斜杠
	let result = path.replace(/\\/g, '/').replace(/\/+/g, '/')
	// 去掉尾部斜杠，但保留 POSIX 根与 Windows 盘符根（如 /、D:/）。
	if (result === '/') return result
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

/**
 * Build path segments once for the picker and the explorer root breadcrumb.
 * Each segment carries the exact navigable path; labels never become path data.
 */
export function getPathBreadcrumbSegments(path) {
	const normalized = normalizePath(path || '.')
	if (normalized === '__drives__') {
		return [{ label: '计算机', path: '__drives__', isComputer: true }]
	}

	const segments = []
	if (/^[a-zA-Z]:\//.test(normalized)) {
		segments.push({ label: '计算机', path: '__drives__', isComputer: true })
		const drive = normalized.slice(0, 2)
		let accumulated = drive + '/'
		segments.push({ label: drive, path: accumulated })
		for (const part of normalized.slice(3).split('/').filter(Boolean)) {
			accumulated = accumulated.replace(/\/$/, '') + '/' + part
			segments.push({ label: part, path: accumulated })
		}
		return segments
	}

	if (normalized.startsWith('/')) {
		segments.push({ label: '计算机', path: '__drives__', isComputer: true })
		segments.push({ label: '/', path: '/' })
		let accumulated = ''
		for (const part of normalized.split('/').filter(Boolean)) {
			accumulated += '/' + part
			segments.push({ label: part, path: accumulated })
		}
		return segments
	}

	let accumulated = ''
	for (const part of normalized.split('/').filter(Boolean)) {
		accumulated = accumulated ? accumulated + '/' + part : part
		segments.push({ label: part === '.' ? '项目目录' : part, path: accumulated })
	}
	return segments.length ? segments : [{ label: '项目目录', path: '.' }]
}

/** 安全区兜底：调用方未给根时只把项目目录当安全区。 */
const DEFAULT_SAFE_ROOT = '.'

/** 是否已确认过免责协议（会话级别） */
let disclaimerAccepted = false

function isOutsideSafeZone(path, frozenSafeRoot = DEFAULT_SAFE_ROOT) {
	const safeRoot = normalizePath(frozenSafeRoot || DEFAULT_SAFE_ROOT)
	const normalized = normalizePath(path)
	if (normalized === '__drives__') return true
	if (isAbsolutePath(safeRoot)) {
		if (!isAbsolutePath(normalized)) return true
		const sl = safeRoot.toLowerCase(), nl = normalized.toLowerCase()
		return nl !== sl && !nl.startsWith(sl + '/')
	}
	if (isAbsolutePath(normalized)) return true
	if (normalized.startsWith('..')) return true
	if (safeRoot === '.') return false
	return normalized !== safeRoot && !normalized.startsWith(safeRoot + '/')
}

/** Windows C 盘路径：最终选作文件夹时必须逐次独立确认，不记忆本次同意。 */
function isCDrivePath(path) {
	return /^c:(?:[\\/]|$)/i.test(String(path || ''))
}

/**
 * C 盘目录最终选择的独立二次确认。
 * 与首次免责协议分离：免责同意不能替代这一步，取消只留在 picker 内且不 resolve 路径。
 */
function showCDriveSelectionConfirmation(path) {
	return new Promise((resolve) => {
		const overlay = document.createElement('div')
		overlay.className = 'fp-overlay fp-disclaimer-overlay'

		const dialog = document.createElement('div')
		dialog.className = 'fp-modal fp-modal-disclaimer'
		dialog.setAttribute('role', 'alertdialog')
		dialog.setAttribute('aria-modal', 'true')
		dialog.setAttribute('aria-labelledby', 'fp-c-drive-confirm-title')
		dialog.innerHTML = `
			<div class="fp-header">
				<span class="fp-title" id="fp-c-drive-confirm-title"><i data-ic="warning"></i> 再次确认 C 盘工作区</span>
			</div>
			<div class="fp-disclaimer-body">
				<p>您正在把 C 盘下的目录设为 AI 工作区：</p>
				<p><strong>${escapeHtml(path)}</strong></p>
				<p class="fp-disclaimer-warning"><i data-ic="warning" aria-hidden="true"></i> 工作区内的文件可能被读取、修改或删除。请确认这不是系统、应用数据或密钥目录。</p>
				<div class="fp-disclaimer-actions">
					<button class="fp-cancel-btn" id="c-drive-confirm-cancel">取消</button>
					<button class="fp-confirm-btn fp-disclaimer-accept" id="c-drive-confirm-accept">确认选择此目录</button>
				</div>
			</div>
		`

		overlay.appendChild(dialog)
		document.body.appendChild(overlay)

		let settled = false
		const onConfirmKeyDown = (event) => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			event.stopImmediatePropagation()
			finish(false)
		}
		const finish = (accepted) => {
			if (settled) return
			settled = true
			document.removeEventListener('keydown', onConfirmKeyDown, true)
			overlay.remove()
			resolve(accepted)
		}
		document.addEventListener('keydown', onConfirmKeyDown, true)
		dialog.querySelector('#c-drive-confirm-accept').addEventListener('click', () => finish(true))
		dialog.querySelector('#c-drive-confirm-cancel').addEventListener('click', () => finish(false))
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) finish(false)
		})
	})
}

/**
 * 显示免责协议对话框
 * @returns {Promise<boolean>} 用户是否同意
 */
function showDisclaimerDialog() {
	return new Promise((resolve) => {
		const overlay = document.createElement('div')
		overlay.className = 'fp-overlay fp-disclaimer-overlay'

		const dialog = document.createElement('div')
		dialog.className = 'fp-modal fp-modal-disclaimer'
		dialog.setAttribute('role', 'alertdialog')
		dialog.setAttribute('aria-modal', 'true')
		dialog.setAttribute('aria-labelledby', 'fp-disclaimer-title')
		dialog.innerHTML = `
			<div class="fp-header">
				<span class="fp-title" id="fp-disclaimer-title"><i data-ic="warning"></i> 安全提示</span>
			</div>
			<div class="fp-disclaimer-body">
				<p>首次使用 <strong>beilu-always accompany</strong> 时，建议将 AI 的文件操作范围保持在默认工作区 <strong>「AI 玩耍空间」</strong> 内，不要指向其他目录。</p>
				<p class="fp-disclaimer-warning"><i data-ic="warning" aria-hidden="true"></i> 如果因为您自行导航到系统或其他重要目录而造成的文件损失，您必须自行负责。我们不会对因您自身不当操作造成的损失负责。</p>
				<div class="fp-disclaimer-actions">
					<button class="fp-cancel-btn" id="disclaimer-reject">不同意</button>
					<button class="fp-confirm-btn fp-disclaimer-accept" id="disclaimer-accept">同意该协议</button>
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
function createPicker(mode, initialPath, requestedOwnerChatId = null, requestedSafeRoot = null) {
	const ownerChatId = freezePickerOwnerChatId(requestedOwnerChatId)
	// 安全根与 owner 一起在弹窗打开时冻结；不能读跨窗口共享的 localStorage 最后值。
	const safeRoot = normalizePath(requestedSafeRoot || initialPath || DEFAULT_SAFE_ROOT)
	return new Promise((resolve) => {
		let currentDir = normalizePath(initialPath || '.')
		let selectedItem = null // { name, path, isDirectory }
		let isLoading = false
		let isFinalConfirming = false

		// 创建模态
		const overlay = document.createElement('div')
		overlay.className = 'fp-overlay'

		const modal = document.createElement('div')
		modal.className = 'fp-modal'
		modal.setAttribute('role', 'dialog')
		modal.setAttribute('aria-modal', 'true')
		modal.setAttribute('aria-labelledby', 'fp-picker-title')

		const title = mode === 'folder' ? '<i data-ic="folder-open"></i> 打开文件夹' : '<i data-ic="file"></i> 打开文件'
		const confirmText = mode === 'folder' ? '选择此目录' : '打开'

		modal.innerHTML = `
			<div class="fp-header">
				<span class="fp-title" id="fp-picker-title">${title}</span>
				<button class="fp-close-btn" title="关闭">×</button>
			</div>
			<div class="fp-path-bar">
				<button class="fp-up-btn" title="上级目录" aria-label="上级目录"><i data-ic="folder-open" aria-hidden="true"></i></button>
				<input type="text" class="fp-path-input" value="${escapeHtml(currentDir)}" spellcheck="false" />
				<button class="fp-go-btn" title="前往输入的路径" aria-label="前往输入的路径"><i data-ic="external-link" aria-hidden="true"></i></button>
			</div>
			<div class="fp-breadcrumb" aria-label="当前路径"></div>
			<div class="fp-list-container">
				<div class="fp-list" role="listbox" aria-label="文件与文件夹"></div>
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
			document.removeEventListener('keydown', onKeyDown)
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
		confirmBtn.addEventListener('click', async () => {
			if (mode === 'folder') {
				// 文件夹模式：选当前目录 或 选中的子目录
				const selectedPath = selectedItem?.isDirectory ? selectedItem.path : currentDir
				// C 盘最终选根每次都独立确认；取消不 resolve 路径，调用方不会进入 setWorkspaceRoot。
				if (isCDrivePath(selectedPath)) {
					if (isFinalConfirming) return
					isFinalConfirming = true
					let accepted = false
					try {
						accepted = await showCDriveSelectionConfirmation(selectedPath)
					} finally {
						isFinalConfirming = false
					}
					if (!accepted) return
				}
				close(selectedPath)
			} else {
				// 文件模式：必须选中文件
				if (selectedItem && !selectedItem.isDirectory) {
					close(selectedItem.path)
				}
			}
		})

		// ---- 安全导航：检查是否需要免责确认 + [D6 §3] 工作区外先取 browse 授权 ----
		async function safeNavigate(target) {
			if (isOutsideSafeZone(target, safeRoot)) {
				if (!disclaimerAccepted) {
					const accepted = await showDisclaimerDialog()
					if (!accepted) return // 用户拒绝，不导航
				}
				try {
					await ensureBrowseGrant(ownerChatId)
				} catch (err) {
					listContainer.innerHTML = `<div class="fp-error">整机浏览未授权: ${escapeHtml(err.message)}</div>`
					return
				}
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
			const segments = getPathBreadcrumbSegments(currentDir)
			const html = segments.map((segment, index) => {
				const isLast = index === segments.length - 1
				const icon = segment.isComputer ? '<i data-ic="code" aria-hidden="true"></i> ' : ''
				const crumb = `<button type="button" class="fp-crumb${isLast ? ' fp-crumb-active' : ''}" data-path="${escapeHtml(segment.path)}" title="${escapeHtml(segment.path)}" ${isLast ? 'aria-current="location"' : ''}>${icon}${escapeHtml(segment.label)}</button>`
				return isLast ? crumb : crumb + '<span class="fp-crumb-sep" aria-hidden="true">/</span>'
			}).join('')
			breadcrumb.innerHTML = html

			breadcrumb.querySelectorAll('.fp-crumb:not(.fp-crumb-active)').forEach(el => {
				el.addEventListener('click', () => safeNavigate(el.dataset.path))
			})
		}

		// ---- 加载并渲染目录 ----
		async function navigateTo(path) {
			if (isLoading) return
			isLoading = true
			modal.setAttribute('aria-busy', 'true')
			listContainer.setAttribute('aria-busy', 'true')
			currentDir = normalizePath(path)
			pathInput.value = currentDir
			selectedItem = null
			updateSelection()

			listContainer.innerHTML = '<div class="fp-loading">加载中...</div>'

			try {
				const entries = await listDir(currentDir, ownerChatId)

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
						const fullPath = currentDir === '.' ? entry.name : normalizePath(currentDir + '/' + entry.name)
						const fileType = getFileType(entry.name, { isDirectory: entry.isDirectory, isOpen: false })
						const icon = getFileTypeIconMarkup(entry.name, { isDirectory: entry.isDirectory, isOpen: false })
						const sizeStr = (!entry.isDirectory && entry.size != null) ? formatSize(entry.size) : ''
						const itemDescription = [fileType.languageLabel, sizeStr].filter(Boolean).join(', ')

						html += `
							<div class="fp-item${entry.isDirectory ? ' fp-item-dir' : ' fp-item-file'}"
								data-path="${escapeHtml(fullPath)}"
								data-name="${escapeHtml(entry.name)}"
								data-is-dir="${entry.isDirectory}"
								data-file-kind="${fileType.kind}"
								role="option" tabindex="0" aria-selected="false"
								title="${escapeHtml(fullPath)}"
								aria-label="${escapeHtml(entry.name + (itemDescription ? ', ' + itemDescription : ''))}">
								<span class="fp-item-icon">${icon}</span>
								<span class="fp-item-name">${escapeHtml(entry.name)}</span>
								<span class="fp-item-kind">${escapeHtml(fileType.languageLabel)}</span>
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

						const selectItem = () => {
							listContainer.querySelectorAll('.fp-item').forEach(e => {
								e.setAttribute('aria-selected', 'false')
							})
							el.setAttribute('aria-selected', 'true')
							selectedItem = { name: itemName, path: itemPath, isDirectory: isDir }
							updateSelection()
						}

						// 单击在 release/click 阶段选中；pressed 只由 CSS :active 表达。
						el.addEventListener('click', selectItem)

						// 双击：目录进入，文件确认
						el.addEventListener('dblclick', () => {
							if (isDir) {
								navigateTo(itemPath)
							} else if (mode === 'file') {
								close(itemPath)
							}
						})
						el.addEventListener('keydown', (event) => {
							if (event.key === ' ') {
								event.preventDefault()
								selectItem()
							} else if (event.key === 'Enter') {
								event.preventDefault()
								if (isDir) navigateTo(itemPath)
								else if (mode === 'file') close(itemPath)
								else selectItem()
							}
						})
					})
				}
			} catch (err) {
				listContainer.innerHTML = `<div class="fp-error">加载失败: ${escapeHtml(err.message)}</div>`
			}

			isLoading = false
			modal.setAttribute('aria-busy', 'false')
			listContainer.setAttribute('aria-busy', 'false')
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
			modal.setAttribute('aria-busy', 'true')
			listContainer.setAttribute('aria-busy', 'true')
			currentDir = '__drives__'
			pathInput.value = ''
			selectedItem = null
			updateSelection()

			breadcrumb.innerHTML = '<span class="fp-crumb fp-crumb-active"><i data-ic="code"></i> 计算机</span>'
			listContainer.innerHTML = '<div class="fp-loading">正在扫描驱动器...</div>'

			// [D6 §3] 盘符探测=工作区外列举，先确保 browse 授权（未授权直接可见报错，不再静默"未找到驱动器"）
			try {
				await ensureBrowseGrant(ownerChatId)
			} catch (err) {
				listContainer.innerHTML = `<div class="fp-error">整机浏览未授权: ${escapeHtml(err.message)}</div>`
				isLoading = false
				modal.setAttribute('aria-busy', 'false')
				listContainer.setAttribute('aria-busy', 'false')
				return
			}

			// 探测盘符：C 盘也进入现有 browse policy；后端仍会拒绝系统/应用敏感目录。
			const drives = []
			const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('')
			for (const letter of letters) {
				try {
					const testPath = letter + ':/'
					const entries = await listDir(testPath, ownerChatId)
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
					await listDir('/', ownerChatId)
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
							data-is-dir="true"
							data-file-kind="folder"
							role="option" tabindex="0" aria-selected="false" title="${escapeHtml(drive.path)}">
							<span class="fp-item-icon">${getFileTypeIconMarkup(drive.name, { isDirectory: true, isOpen: false })}</span>
							<span class="fp-item-name">${escapeHtml(drive.isPosixRoot ? '/' : drive.name + '/')}</span>
							<span class="fp-item-kind">文件夹</span>
							<span class="fp-item-size">${drive.isPosixRoot ? '根目录' : '本地磁盘'}</span>
						</div>
					`
				}
				listContainer.innerHTML = html

				listContainer.querySelectorAll('.fp-item').forEach(el => {
					const selectDrive = () => {
						listContainer.querySelectorAll('.fp-item').forEach(e => {
							e.setAttribute('aria-selected', 'false')
						})
						el.setAttribute('aria-selected', 'true')
						selectedItem = { name: el.dataset.name, path: el.dataset.path, isDirectory: true }
						updateSelection()
					}
					el.addEventListener('click', selectDrive)
					el.addEventListener('dblclick', () => navigateTo(el.dataset.path))
					el.addEventListener('keydown', (event) => {
						if (event.key === ' ') {
							event.preventDefault()
							selectDrive()
						} else if (event.key === 'Enter') {
							event.preventDefault()
							navigateTo(el.dataset.path)
						}
					})
				})
			}
			isLoading = false
			modal.setAttribute('aria-busy', 'false')
			listContainer.setAttribute('aria-busy', 'false')
		}

		// 初始加载
		if (currentDir === '__drives__') showDrivesList()
		else navigateTo(currentDir)

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
 * @param {string|null} [ownerChatId=null] 打开弹窗时冻结的发起窗口归属
 * @param {string} [safeRoot=initialPath] 同 owner 一起冻结的免责安全根
 * @returns {Promise<string|null>} 选中的目录路径，取消返回 null
 */
export function showFolderPicker(initialPath = '.', ownerChatId = null, safeRoot = initialPath) {
	return createPicker('folder', initialPath, ownerChatId, safeRoot)
}

/**
 * 显示文件选择器
 * @param {string} [initialPath='.'] 初始路径
 * @param {string|null} [ownerChatId=null] 打开弹窗时冻结的发起窗口归属
 * @param {string} [safeRoot=initialPath] 同 owner 一起冻结的免责安全根
 * @returns {Promise<string|null>} 选中的文件路径，取消返回 null
 */
export function showFilePicker(initialPath = '.', ownerChatId = null, safeRoot = initialPath) {
	return createPicker('file', initialPath, ownerChatId, safeRoot)
}
