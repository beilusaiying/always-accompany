/**
 * beilu-chat 文件浏览器/编辑器模块
 *
 * 功能：
 * - 文件树浏览（左栏）— 可配置根路径
 * - 文件编辑器（中栏文件选项卡）
 * - 打开文件夹 / 打开文件 弹窗
 * - 路径输入框手动导航
 * - 新建文件/目录
 * - 保存 / Ctrl+S
 * - AI 操作审批
 */

import { showFilePicker, showFolderPicker } from './ui/filePicker.mjs'

const FILES_API_GET = '/api/parts/plugins:beilu-files/config/getdata'
const FILES_API_SET = '/api/parts/plugins:beilu-files/config/setdata'

// ============================================================
// API 通信
// ============================================================

async function getFilesData() {
	const res = await fetch(FILES_API_GET)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

async function setFilesData(data) {
	const res = await fetch(FILES_API_SET, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data),
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res.json()
}

// ============================================================
// 状态
// ============================================================

/** @type {HTMLElement|null} */
let treeContainer = null
/** @type {HTMLElement|null} */
let editorContainer = null

/** 默认安全根路径 */
const DEFAULT_SAFE_ROOT = 'ai玩耍空间'

/** 文件树根路径（可通过打开文件夹或路径输入框更改） */
let rootPath = DEFAULT_SAFE_ROOT
/** 当前展开的目录路径 */
let currentPath = '.'
let expandedDirs = new Set(['.'])

// ============================================================
// 多标签状态
// ============================================================

/**
 * @typedef {Object} TabState
 * @property {string} path - 文件路径
 * @property {string} content - 文件内容
 * @property {boolean} isDirty - 是否有未保存修改
 * @property {number} scrollTop - textarea 滚动位置
 * @property {number} scrollLeft - textarea 水平滚动位置
 * @property {number} selectionStart - 光标起始位置
 * @property {number} selectionEnd - 光标结束位置
 */

/** @type {TabState[]} */
let openTabs = []

/** @type {string|null} 当前活动标签的文件路径 */
let activeTabPath = null

/** 标签栏 DOM 容器 */
let tabBarContainer = null

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化文件浏览器
 * @param {HTMLElement} treeEl - 左栏文件树容器
 * @param {HTMLElement} editorEl - 中栏编辑器容器
 */
export async function initFileExplorer(treeEl, editorEl) {
	treeContainer = treeEl
	editorContainer = editorEl
	if (!treeContainer || !editorContainer) return

	// 获取标签栏容器
	tabBarContainer = document.getElementById('ide-editor-tabs')

	// 始终以安全默认路径启动，不恢复上次的浏览位置
	rootPath = DEFAULT_SAFE_ROOT

	// 渲染文件树
	renderTreeLoading()
	await loadFileTree(rootPath)

	// 绑定编辑器事件
	bindEditorEvents()

	// 渲染初始标签栏（空）
	renderTabs()
}

/**
 * 外部调用：设置文件树根路径并刷新
 * @param {string} path
 */
export async function setFileExplorerRoot(path) {
	rootPath = path || '.'
	expandedDirs = new Set([rootPath])
	currentPath = rootPath

	try {
		localStorage.setItem('beilu-file-root', rootPath)
	} catch { /* ignore */ }

	await loadFileTree(rootPath)
}

// ============================================================
// 文件树
// ============================================================

function renderTreeLoading() {
	if (!treeContainer) return
	treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<h3 class="font-bold text-amber-700 text-sm flex items-center gap-2 mb-2">
				<img src="https://api.iconify.design/mdi/folder-outline.svg" class="w-4 h-4 icon" />
				文件浏览
			</h3>
			<p class="text-xs text-base-content/40 text-center py-4">加载中...</p>
		</div>
	`
}

async function loadFileTree(path) {
	try {
		const result = await setFilesData({ _action: 'listDir', path })
		if (result?._result?.entries) {
			renderFileTree(path, result._result.entries)
		} else if (result?._result?.error) {
			renderTreeError(result._result.error)
		}
	} catch (err) {
		renderTreeError(err.message)
	}
}

function renderTreeError(message) {
	if (!treeContainer) return
	treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<h3 class="font-bold text-amber-700 text-sm flex items-center gap-2 mb-2">
				<img src="https://api.iconify.design/mdi/folder-outline.svg" class="w-4 h-4 icon" />
				文件浏览
			</h3>
			<p class="text-xs text-error text-center py-4">${escapeHtml(message)}</p>
			<button class="btn btn-xs btn-block btn-outline" id="file-tree-retry">🔄 重试</button>
		</div>
	`
	treeContainer.querySelector('#file-tree-retry')?.addEventListener('click', () => loadFileTree(rootPath))
}

function renderFileTree(treePath, entries) {
	if (!treeContainer) return

	const displayPath = treePath === '.' ? '项目根目录' : treePath.replace(/\\/g, '/')

	treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="font-bold text-amber-700 text-sm flex items-center gap-2">
					<img src="https://api.iconify.design/mdi/folder-outline.svg" class="w-4 h-4 icon" />
					文件浏览
				</h3>
				<div class="flex items-center gap-0.5">
					<button id="file-tree-open-folder" class="btn btn-xs btn-ghost btn-square" title="打开文件夹">📂</button>
					<button id="file-tree-open-file" class="btn btn-xs btn-ghost btn-square" title="打开文件">📄</button>
					<button id="file-tree-refresh" class="btn btn-xs btn-ghost btn-square" title="刷新">🔄</button>
				</div>
			</div>

			<!-- 路径输入栏 -->
			<div class="flex items-center gap-1 mb-1">
				<input type="text" id="file-root-input"
					class="input input-xs input-bordered flex-1 font-mono text-xs"
					value="${escapeAttr(rootPath)}"
					placeholder="输入路径..." spellcheck="false" />
				<button id="file-root-go" class="btn btn-xs btn-ghost btn-square" title="前往">→</button>
			</div>

			<div class="text-xs text-base-content/40 mb-1 font-mono truncate" title="${escapeHtml(treePath)}">
				📂 ${escapeHtml(displayPath)}
			</div>

			<!-- 操作按钮 -->
			<div class="flex items-center gap-0.5 mb-1">
				<button id="file-tree-new-file" class="btn btn-xs btn-ghost" title="新建文件">📄+ 新文件</button>
				<button id="file-tree-new-dir" class="btn btn-xs btn-ghost" title="新建目录">📂+ 新目录</button>
			</div>

			<div id="file-tree-entries" class="file-tree text-xs space-y-0.5">
				${renderEntries(entries, treePath)}
			</div>
			<div class="divider my-1 opacity-30"></div>
			<div id="file-pending-ops" class="text-xs"></div>
		</div>
	`

	// 绑定树事件
	bindTreeEvents()

	// 加载待审批操作
	loadPendingOps()
}

/** 拼接路径：正确处理 Windows 盘符根 (D:/) */
function joinPath(base, name) {
	// 去掉尾部斜杠，但盘符根 D:/ 保留
	const trimmed = base.replace(/\/+$/, '')
	// 如果去掉后变成盘符 (D:)，保留一个 /
	if (/^[a-zA-Z]:$/.test(trimmed)) return trimmed + '/' + name
	return (trimmed || '.') + '/' + name
}

function renderEntries(entries, parentPath) {
	if (!entries || entries.length === 0) {
		return '<p class="text-base-content/30 text-center py-2 text-[10px]">(空目录)</p>'
	}

	// 排序：目录在前，文件在后
	entries.sort((a, b) => {
		if (a.isDirectory && !b.isDirectory) return -1
		if (!a.isDirectory && b.isDirectory) return 1
		return (a.name || '').localeCompare(b.name || '')
	})

	let html = ''
	for (const entry of entries) {
		const fullPath = joinPath(parentPath, entry.name)
		const icon = entry.isDirectory ? '📂' : getFileIcon(entry.name)
		const isOpen = entry.isDirectory && expandedDirs.has(fullPath)
		const isSelected = activeTabPath === fullPath

		html += `
		<div class="file-tree-item ${entry.isDirectory ? 'folder' : 'file'} ${isSelected ? 'active' : ''}"
			data-path="${escapeAttr(fullPath)}" data-is-dir="${entry.isDirectory}">
			<span class="tree-toggle ${entry.isDirectory ? 'cursor-pointer' : 'invisible'}">${entry.isDirectory ? (isOpen ? '▾' : '▸') : ''}</span>
			<span class="tree-icon">${icon}</span>
			<span class="tree-label flex-1 truncate">${escapeHtml(entry.name)}</span>
			${entry.size != null && !entry.isDirectory ? `<span class="text-[10px] text-base-content/30 ml-1">${formatSize(entry.size)}</span>` : ''}
		</div>
		`

		// 如果目录已展开，显示子内容占位
		if (entry.isDirectory && isOpen) {
			html += `<div class="file-tree-children pl-4" data-parent="${escapeAttr(fullPath)}">
				<p class="text-[10px] text-base-content/30 py-1">加载中...</p>
			</div>`
		}
	}

	return html
}

function getFileIcon(name) {
	const ext = name.split('.').pop()?.toLowerCase()
	const icons = {
		js: '📜', mjs: '📜', ts: '📘', json: '📋', css: '🎨', html: '🌐',
		md: '📝', txt: '📄', py: '🐍', sh: '⚡', bat: '⚡',
		png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
	}
	return icons[ext] || '📄'
}

function formatSize(bytes) {
	if (bytes < 1024) return bytes + 'B'
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K'
	return (bytes / (1024 * 1024)).toFixed(1) + 'M'
}

function bindTreeEvents() {
	if (!treeContainer) return

	// 打开文件夹 — 弹窗浏览
	treeContainer.querySelector('#file-tree-open-folder')?.addEventListener('click', async () => {
		const selected = await showFolderPicker(rootPath)
		if (selected) {
			await setFileExplorerRoot(selected)
			showToast(`已切换到: ${selected}`, 'success')
		}
	})

	// 打开文件 — 弹窗浏览
	treeContainer.querySelector('#file-tree-open-file')?.addEventListener('click', async () => {
		const selected = await showFilePicker(rootPath)
		if (selected) {
			openFileInEditor(selected)
		}
	})

	// 路径输入框 — 手动导航（支持文件路径直接打开）
	const rootInput = treeContainer.querySelector('#file-root-input')
	const rootGoBtn = treeContainer.querySelector('#file-root-go')

	async function handleGoToPath(target) {
		if (!target) return
		// 先尝试当作目录加载
		try {
			const result = await setFilesData({ _action: 'listDir', path: target })
			if (result?._result?.entries) {
				// 成功作为目录 → 设为根
				await setFileExplorerRoot(target)
				return
			}
		} catch { /* 不是目录 */ }
		// 尝试当作文件打开
		try {
			const result = await setFilesData({ _action: 'readFile', path: target })
			if (result?._result?.content !== undefined) {
				openFileInEditor(target)
				return
			}
		} catch { /* 也不是文件 */ }
		showToast('路径无效: ' + target, 'error')
	}

	rootGoBtn?.addEventListener('click', () => {
		const target = rootInput?.value?.trim()
		if (target) handleGoToPath(target)
	})

	rootInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			const target = rootInput.value.trim()
			if (target) handleGoToPath(target)
		}
	})

	// 刷新
	treeContainer.querySelector('#file-tree-refresh')?.addEventListener('click', () => loadFileTree(rootPath))

	// 新建文件
	treeContainer.querySelector('#file-tree-new-file')?.addEventListener('click', async () => {
		const name = prompt('新文件名:')
		if (!name?.trim()) return
		const path = joinPath(currentPath, name.trim())
		try {
			await setFilesData({ _action: 'createFile', path, content: '' })
			showToast(`文件 ${name} 已创建`, 'success')
			await loadFileTree(rootPath)
			openFileInEditor(path)
		} catch (err) {
			showToast('创建失败: ' + err.message, 'error')
		}
	})

	// 新建目录
	treeContainer.querySelector('#file-tree-new-dir')?.addEventListener('click', async () => {
		const name = prompt('新目录名:')
		if (!name?.trim()) return
		const path = joinPath(currentPath, name.trim())
		try {
			await setFilesData({ _action: 'createDir', path })
			showToast(`目录 ${name} 已创建`, 'success')
			await loadFileTree(rootPath)
		} catch (err) {
			showToast('创建失败: ' + err.message, 'error')
		}
	})

	// 文件/目录点击
	treeContainer.querySelectorAll('.file-tree-item').forEach(item => {
		item.addEventListener('click', async () => {
			const path = item.dataset.path
			const isDir = item.dataset.isDir === 'true'

			if (isDir) {
				// 切换目录展开
				if (expandedDirs.has(path)) {
					expandedDirs.delete(path)
					// 移除子元素
					const children = treeContainer.querySelector(`.file-tree-children[data-parent="${CSS.escape(path)}"]`)
					if (children) children.remove()
					// 更新图标
					const toggle = item.querySelector('.tree-toggle')
					if (toggle) toggle.textContent = '▸'
				} else {
					expandedDirs.add(path)
					currentPath = path
					// 加载子目录
					try {
						const result = await setFilesData({ _action: 'listDir', path })
						if (result?._result?.entries) {
							// 插入子节点
							const childHtml = `<div class="file-tree-children pl-4" data-parent="${escapeAttr(path)}">
								${renderEntries(result._result.entries, path)}
							</div>`
							item.insertAdjacentHTML('afterend', childHtml)
							// 为新节点绑定事件
							const newChildren = item.nextElementSibling
							if (newChildren) {
								newChildren.querySelectorAll('.file-tree-item').forEach(child => {
									child.addEventListener('click', function handler() {
										const p = child.dataset.path
										const d = child.dataset.isDir === 'true'
										if (d) {
											// 简化：重新渲染整棵树
											if (expandedDirs.has(p)) expandedDirs.delete(p)
											else expandedDirs.add(p)
											loadFileTree(rootPath)
										} else {
											openFileInEditor(p)
										}
									})
								})
							}
							// 更新图标
							const toggle = item.querySelector('.tree-toggle')
							if (toggle) toggle.textContent = '▾'
						}
					} catch (err) {
						showToast('加载目录失败: ' + err.message, 'error')
					}
				}
			} else {
				// 打开文件
				openFileInEditor(path)
			}
		})

		// 右键菜单
		item.addEventListener('contextmenu', (e) => {
			e.preventDefault()
			showFileContextMenu(item.dataset.path, item.dataset.isDir === 'true', e)
		})
	})
}

// ============================================================
// 多标签管理
// ============================================================

/**
 * 获取指定路径的标签
 * @param {string} path
 * @returns {TabState|undefined}
 */
function getTab(path) {
	return openTabs.find(t => t.path === path)
}

/**
 * 获取当前活动标签
 * @returns {TabState|undefined}
 */
function getActiveTab() {
	return activeTabPath ? getTab(activeTabPath) : undefined
}

/**
 * 在保存当前标签的编辑状态（滚动、光标、内容）后切换
 */
function saveActiveTabState() {
	if (!activeTabPath) return
	const tab = getTab(activeTabPath)
	if (!tab) return

	const textarea = editorContainer?.querySelector('#file-editor-textarea')
	if (textarea) {
		tab.content = textarea.value
		tab.scrollTop = textarea.scrollTop
		tab.scrollLeft = textarea.scrollLeft
		tab.selectionStart = textarea.selectionStart
		tab.selectionEnd = textarea.selectionEnd
	}
}

/**
 * 渲染标签栏
 */
function renderTabs() {
	if (!tabBarContainer) return

	if (openTabs.length === 0) {
		tabBarContainer.innerHTML = '<span class="ide-tabs-placeholder text-xs text-base-content/30 px-3">未打开文件</span>'
		return
	}

	let html = ''
	for (const tab of openTabs) {
		const fileName = tab.path.split('/').pop()
		const isActive = tab.path === activeTabPath
		const icon = getFileIcon(fileName)

		html += `<div class="ide-editor-tab ${isActive ? 'ide-tab-active' : ''}" data-tab-path="${escapeAttr(tab.path)}" title="${escapeAttr(tab.path)}">
			<span class="ide-tab-icon text-[0.7rem]">${icon}</span>
			<span class="ide-tab-name">${escapeHtml(fileName)}</span>
			${tab.isDirty ? '<span class="ide-tab-dirty">●</span>' : ''}
			<button class="ide-tab-close" data-close-path="${escapeAttr(tab.path)}" title="关闭">×</button>
		</div>`
	}

	tabBarContainer.innerHTML = html

	// 绑定标签点击事件
	tabBarContainer.querySelectorAll('.ide-editor-tab').forEach(el => {
		el.addEventListener('click', (e) => {
			// 排除关闭按钮点击
			if (e.target.classList.contains('ide-tab-close')) return
			const path = el.dataset.tabPath
			if (path && path !== activeTabPath) {
				switchToTab(path)
			}
		})

		// 中键关闭
		el.addEventListener('auxclick', (e) => {
			if (e.button === 1) {
				e.preventDefault()
				const path = el.dataset.tabPath
				if (path) closeTab(path)
			}
		})
	})

	// 绑定关闭按钮
	tabBarContainer.querySelectorAll('.ide-tab-close').forEach(btn => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation()
			const path = btn.dataset.closePath
			if (path) closeTab(path)
		})
	})

	// 确保活动标签可见（滚动到视野内）
	requestAnimationFrame(() => {
		const activeEl = tabBarContainer.querySelector('.ide-tab-active')
		if (activeEl) activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' })
	})
}

/**
 * 切换到指定标签
 * @param {string} path
 */
function switchToTab(path) {
	const tab = getTab(path)
	if (!tab) return

	// 保存当前标签状态
	saveActiveTabState()

	// 切换
	activeTabPath = path

	// 渲染标签栏
	renderTabs()

	// 渲染编辑器内容
	renderEditor()

	// 恢复滚动和光标位置
	requestAnimationFrame(() => {
		const textarea = editorContainer?.querySelector('#file-editor-textarea')
		if (textarea) {
			textarea.scrollTop = tab.scrollTop || 0
			textarea.scrollLeft = tab.scrollLeft || 0
			textarea.selectionStart = tab.selectionStart || 0
			textarea.selectionEnd = tab.selectionEnd || 0
		}
	})

	// 更新文件树选中状态
	treeContainer?.querySelectorAll('.file-tree-item').forEach(item => {
		item.classList.toggle('active', item.dataset.path === path)
	})

	// 更新状态栏文件信息
	updateStatusBar(tab)
}

/**
 * 关闭标签
 * @param {string} path
 */
function closeTab(path) {
	const tab = getTab(path)
	if (!tab) return

	// 检查未保存
	if (tab.isDirty) {
		if (!confirm(`文件 "${path.split('/').pop()}" 有未保存的更改，是否关闭？`)) return
	}

	const idx = openTabs.indexOf(tab)
	openTabs.splice(idx, 1)

	// 如果关闭的是当前活动标签，需要切换
	if (path === activeTabPath) {
		if (openTabs.length === 0) {
			activeTabPath = null
			renderTabs()
			renderEmptyEditor()
		} else {
			// 优先选择右侧邻居，无则左侧
			const nextIdx = Math.min(idx, openTabs.length - 1)
			activeTabPath = openTabs[nextIdx].path
			renderTabs()
			renderEditor()
			// 恢复新活动标签的滚动位置
			const newTab = openTabs[nextIdx]
			requestAnimationFrame(() => {
				const textarea = editorContainer?.querySelector('#file-editor-textarea')
				if (textarea) {
					textarea.scrollTop = newTab.scrollTop || 0
					textarea.scrollLeft = newTab.scrollLeft || 0
				}
			})
			// 更新文件树选中
			treeContainer?.querySelectorAll('.file-tree-item').forEach(item => {
				item.classList.toggle('active', item.dataset.path === activeTabPath)
			})
			updateStatusBar(newTab)
		}
	} else {
		// 关闭的不是当前标签，只需重新渲染标签栏
		renderTabs()
	}
}

/**
 * 更新 IDE 状态栏
 * @param {TabState} tab
 */
function updateStatusBar(tab) {
	const statusFile = document.getElementById('ide-status-file')
	const statusLang = document.getElementById('ide-status-lang')
	if (statusFile) statusFile.textContent = tab ? tab.path : '就绪'
	if (statusLang && tab) {
		const ext = tab.path.split('.').pop()?.toUpperCase() || ''
		statusLang.textContent = ext
	}
}

// ============================================================
// 文件编辑器
// ============================================================

async function openFileInEditor(path) {
	// 如果已有此标签，直接切换
	if (getTab(path)) {
		switchToTab(path)
		return
	}

	try {
		const result = await setFilesData({ _action: 'readFile', path })
		if (result?._result?.error) {
			showToast('读取失败: ' + result._result.error, 'error')
			return
		}

		// 保存当前标签状态
		saveActiveTabState()

		// 创建新标签
		const newTab = {
			path,
			content: result._result.content || '',
			isDirty: false,
			scrollTop: 0,
			scrollLeft: 0,
			selectionStart: 0,
			selectionEnd: 0,
		}
		openTabs.push(newTab)
		activeTabPath = path

		// 渲染
		renderTabs()
		renderEditor()

		// 更新文件树选中状态
		treeContainer?.querySelectorAll('.file-tree-item').forEach(item => {
			item.classList.toggle('active', item.dataset.path === path)
		})

		updateStatusBar(newTab)
	} catch (err) {
		showToast('打开文件失败: ' + err.message, 'error')
	}
}

function renderEditor() {
	if (!editorContainer) return
	const tab = getActiveTab()
	if (!tab) {
		renderEmptyEditor()
		return
	}

	const fileName = tab.path.split('/').pop() || ''
	const ext = fileName.split('.').pop()?.toLowerCase() || ''
	const isEditable = ['js', 'mjs', 'ts', 'json', 'css', 'html', 'md', 'txt', 'py', 'sh', 'bat', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'xml', 'svg'].includes(ext)

	editorContainer.innerHTML = `
		<div class="flex flex-col h-full">
			<!-- 编辑器内容 -->
			<div class="flex-1 overflow-auto relative">
				${isEditable ? `
				<div class="flex h-full">
					<!-- 行号 -->
					<div id="editor-line-numbers" class="text-right pr-2 pl-2 py-2 text-[11px] font-mono text-base-content/25 bg-base-300/20 select-none shrink-0 overflow-hidden"></div>
					<!-- 编辑区 -->
					<textarea id="file-editor-textarea"
						class="flex-1 p-2 font-mono text-xs bg-transparent border-none resize-none focus:outline-none leading-[1.4em]"
						spellcheck="false"
						wrap="off">${escapeHtml(tab.content)}</textarea>
				</div>
				` : `
				<div class="flex items-center justify-center h-full text-base-content/30">
					<div class="text-center">
						<div class="text-4xl mb-3">${getFileIcon(fileName)}</div>
						<p class="text-sm">二进制或不可编辑文件</p>
						<p class="text-xs mt-1">${escapeHtml(fileName)}</p>
					</div>
				</div>
				`}
			</div>
			<!-- 状态栏 -->
			<div class="flex items-center justify-between px-3 py-1 bg-base-300/30 text-[10px] text-base-content/50 border-t border-base-300/50 shrink-0">
				<div class="flex items-center gap-2">
					<span id="editor-dirty-indicator" class="${tab.isDirty ? 'text-warning' : ''}">${tab.isDirty ? '● 未保存' : '✓ 已保存'}</span>
					<span id="editor-cursor-pos">行 1, 列 1</span>
				</div>
				<div class="flex items-center gap-2">
					<span>${ext.toUpperCase() || 'TEXT'}</span>
					<span id="editor-char-count">${tab.content.length} 字符</span>
				</div>
			</div>
		</div>
	`

	// 绑定编辑器交互
	const textarea = editorContainer.querySelector('#file-editor-textarea')
	const lineNumbers = editorContainer.querySelector('#editor-line-numbers')
	const cursorPos = editorContainer.querySelector('#editor-cursor-pos')
	const dirtyIndicator = editorContainer.querySelector('#editor-dirty-indicator')
	const charCount = editorContainer.querySelector('#editor-char-count')

	if (textarea && lineNumbers) {
		updateLineNumbers(textarea, lineNumbers)

		textarea.addEventListener('input', () => {
			const currentTab = getActiveTab()
			if (currentTab) {
				currentTab.isDirty = true
				currentTab.content = textarea.value
			}
			if (dirtyIndicator) {
				dirtyIndicator.textContent = '● 未保存'
				dirtyIndicator.className = 'text-warning'
			}
			if (charCount) charCount.textContent = textarea.value.length + ' 字符'
			updateLineNumbers(textarea, lineNumbers)
			// 更新标签栏 dirty 指示
			renderTabs()
		})

		textarea.addEventListener('scroll', () => {
			if (lineNumbers) lineNumbers.scrollTop = textarea.scrollTop
		})

		textarea.addEventListener('click', () => updateCursorPos(textarea, cursorPos))
		textarea.addEventListener('keyup', () => updateCursorPos(textarea, cursorPos))

		// Ctrl+S 保存
		textarea.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault()
				saveCurrentFile()
			}
			// Tab 键插入制表符
			if (e.key === 'Tab') {
				e.preventDefault()
				const start = textarea.selectionStart
				const end = textarea.selectionEnd
				textarea.value = textarea.value.substring(0, start) + '\t' + textarea.value.substring(end)
				textarea.selectionStart = textarea.selectionEnd = start + 1
				textarea.dispatchEvent(new Event('input'))
			}
		})
	}

	// 启用顶部工具栏按钮
	const saveBtn = document.getElementById('file-save-btn')
	const reloadBtn = document.getElementById('file-reload-btn')
	if (saveBtn) saveBtn.disabled = false
	if (reloadBtn) reloadBtn.disabled = false
}

function updateLineNumbers(textarea, lineNumbers) {
	if (!textarea || !lineNumbers) return
	const lines = textarea.value.split('\n').length
	let html = ''
	for (let i = 1; i <= lines; i++) {
		html += i + '\n'
	}
	lineNumbers.textContent = html
}

function updateCursorPos(textarea, cursorPos) {
	if (!textarea || !cursorPos) return
	const value = textarea.value.substring(0, textarea.selectionStart)
	const line = value.split('\n').length
	const col = value.split('\n').pop().length + 1
	cursorPos.textContent = `行 ${line}, 列 ${col}`
}

function bindEditorEvents() {
	// 顶部工具栏按钮
	const saveBtn = document.getElementById('file-save-btn')
	const reloadBtn = document.getElementById('file-reload-btn')

	saveBtn?.addEventListener('click', saveCurrentFile)
	reloadBtn?.addEventListener('click', async () => {
		const tab = getActiveTab()
		if (tab) {
			if (tab.isDirty && !confirm('有未保存的更改，确定刷新吗？')) return
			// 强制重新加载：删除标签后重新打开
			const path = tab.path
			const idx = openTabs.indexOf(tab)
			openTabs.splice(idx, 1)
			activeTabPath = null
			// 重新打开（会走网络请求）
			await openFileInEditor(path)
			showToast('文件已重新加载', 'info')
		}
	})

	// 全局 Ctrl+S 拦截（当焦点不在 textarea 时也能保存）
	document.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			if (activeTabPath && getActiveTab()) {
				e.preventDefault()
				saveCurrentFile()
			}
		}
	})
}

async function saveCurrentFile() {
	const tab = getActiveTab()
	if (!tab) return

	// 先同步 textarea 内容到 tab
	const textarea = editorContainer?.querySelector('#file-editor-textarea')
	if (textarea) {
		tab.content = textarea.value
	}

	try {
		await setFilesData({ _action: 'writeFile', path: tab.path, content: tab.content })
		tab.isDirty = false

		const dirtyIndicator = editorContainer?.querySelector('#editor-dirty-indicator')
		if (dirtyIndicator) {
			dirtyIndicator.textContent = '✓ 已保存'
			dirtyIndicator.className = ''
		}
		// 更新标签栏（移除 dirty 指示）
		renderTabs()
		showToast('文件已保存', 'success')
	} catch (err) {
		showToast('保存失败: ' + err.message, 'error')
	}
}

// ============================================================
// 右键菜单
// ============================================================

function showFileContextMenu(path, isDir, event) {
	// 移除已有菜单
	document.querySelectorAll('.file-context-menu').forEach(m => m.remove())

	const menu = document.createElement('div')
	menu.className = 'file-context-menu fixed bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1 text-xs min-w-[140px]'
	menu.style.left = event.clientX + 'px'
	menu.style.top = event.clientY + 'px'

	const fileName = path.split('/').pop()
	const items = []

	if (!isDir) {
		items.push({ label: '📄 打开', action: 'open' })
	}
	if (isDir) {
		items.push({ label: '📂 在此打开', action: 'setRoot' })
		items.push({ label: '📄 新建文件', action: 'newFile' })
		items.push({ label: '📂 新建子目录', action: 'newDir' })
	}
	items.push({ label: '—', action: 'divider' })
	items.push({ label: '📋 复制路径', action: 'copyPath' })
	items.push({ label: '✏️ 重命名', action: 'rename' })
	items.push({ label: '—', action: 'divider' })
	items.push({ label: '🗑️ 删除', action: 'delete', danger: true })

	for (const item of items) {
		if (item.action === 'divider') {
			menu.innerHTML += '<div class="divider my-0.5 mx-2"></div>'
			continue
		}
		const btn = document.createElement('button')
		btn.className = `block w-full text-left px-3 py-1 hover:bg-base-300/50 ${item.danger ? 'text-error' : ''}`
		btn.textContent = item.label
		btn.addEventListener('click', async () => {
			menu.remove()
			switch (item.action) {
				case 'open':
					await openFileInEditor(path)
					break
				case 'setRoot':
					await setFileExplorerRoot(path)
					showToast(`已切换到: ${path}`, 'success')
					break
				case 'newFile': {
					const name = prompt('新文件名:')
					if (!name?.trim()) return
					const newPath = path.replace(/\/$/, '') + '/' + name.trim()
					try {
						await setFilesData({ _action: 'createFile', path: newPath, content: '' })
						showToast('文件已创建', 'success')
						await loadFileTree(rootPath)
					} catch (err) {
						showToast('创建失败: ' + err.message, 'error')
					}
					break
				}
				case 'newDir': {
					const name = prompt('新目录名:')
					if (!name?.trim()) return
					const newPath = path.replace(/\/$/, '') + '/' + name.trim()
					try {
						await setFilesData({ _action: 'createDir', path: newPath })
						showToast('目录已创建', 'success')
						await loadFileTree(rootPath)
					} catch (err) {
						showToast('创建失败: ' + err.message, 'error')
					}
					break
				}
				case 'copyPath':
					navigator.clipboard?.writeText(path).then(() => showToast('路径已复制', 'success'))
					break
				case 'rename': {
					const newName = prompt('新名称:', fileName)
					if (!newName?.trim() || newName === fileName) return
					showToast('重命名功能待实现', 'warning')
					break
				}
				case 'delete':
					if (!confirm(`确定删除 "${fileName}" 吗？此操作不可撤销。`)) return
					try {
						await setFilesData({ _action: 'deleteFile', path })
						showToast(`${fileName} 已删除`, 'success')
						// 如果该文件有标签，关闭它（不提示保存）
						const delTab = getTab(path)
						if (delTab) {
							delTab.isDirty = false // 文件已删除，无需提示保存
							closeTab(path)
						}
						await loadFileTree(rootPath)
					} catch (err) {
						showToast('删除失败: ' + err.message, 'error')
					}
					break
			}
		})
		menu.appendChild(btn)
	}

	document.body.appendChild(menu)
	const closeMenu = (e) => {
		if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu) }
	}
	setTimeout(() => document.addEventListener('click', closeMenu), 0)
}

// ============================================================
// 待审批操作
// ============================================================

async function loadPendingOps() {
	const container = treeContainer?.querySelector('#file-pending-ops')
	if (!container) return

	try {
		const data = await getFilesData()
		const pending = data?.pendingOperations || []

		if (pending.length === 0) {
			container.innerHTML = ''
			return
		}

		container.innerHTML = `
			<div class="bg-warning/10 border border-warning/30 rounded-lg p-2 space-y-1">
				<div class="flex items-center justify-between">
					<span class="text-xs font-bold text-warning">⚠️ ${pending.length} 个操作待审批</span>
					<div class="flex gap-0.5">
						<button class="btn btn-xs btn-success" id="file-approve-all">✓ 全部批准</button>
						<button class="btn btn-xs btn-error btn-outline" id="file-reject-all">✗ 全拒</button>
					</div>
				</div>
				${pending.map(op => `
					<div class="flex items-center gap-1 text-[10px]">
						<span class="badge badge-xs">${op.type}</span>
						<span class="flex-1 truncate font-mono">${escapeHtml(op.path || op.command || '')}</span>
						<button class="btn btn-xs btn-ghost text-success approve-op" data-id="${op.id}">✓</button>
						<button class="btn btn-xs btn-ghost text-error reject-op" data-id="${op.id}">✗</button>
					</div>
				`).join('')}
			</div>
		`

		container.querySelector('#file-approve-all')?.addEventListener('click', async () => {
			await setFilesData({ _action: 'approveAll' })
			showToast('所有操作已批准', 'success')
			await loadPendingOps()
		})

		container.querySelector('#file-reject-all')?.addEventListener('click', async () => {
			await setFilesData({ _action: 'rejectAll' })
			showToast('所有操作已拒绝', 'info')
			await loadPendingOps()
		})

		container.querySelectorAll('.approve-op').forEach(btn => {
			btn.addEventListener('click', async () => {
				await setFilesData({ _action: 'approveOp', opId: btn.dataset.id })
				await loadPendingOps()
			})
		})

		container.querySelectorAll('.reject-op').forEach(btn => {
			btn.addEventListener('click', async () => {
				await setFilesData({ _action: 'rejectOp', opId: btn.dataset.id })
				await loadPendingOps()
			})
		})
	} catch (err) {
		container.innerHTML = ''
	}
}

function renderEmptyEditor() {
	if (!editorContainer) return

	activeTabPath = null

	// 禁用顶部工具栏按钮
	const saveBtn = document.getElementById('file-save-btn')
	const reloadBtn = document.getElementById('file-reload-btn')
	if (saveBtn) saveBtn.disabled = true
	if (reloadBtn) reloadBtn.disabled = true

	// 更新状态栏
	updateStatusBar(null)

	editorContainer.innerHTML = `
		<div class="flex items-center justify-center h-full text-base-content/30">
			<div class="text-center">
				<img src="https://api.iconify.design/mdi/folder-open-outline.svg" class="w-16 h-16 mx-auto mb-4 opacity-20 icon" />
				<p class="text-sm">从左侧文件树选择文件</p>
				<p class="text-xs mt-1 text-base-content/20">或使用 📂 打开文件夹 / 📄 打开文件</p>
			</div>
		</div>
	`

	// 更新标签栏
	renderTabs()
}

// ============================================================
// 工具函数
// ============================================================

function escapeHtml(str) {
	const div = document.createElement('div')
	div.textContent = str || ''
	return div.innerHTML
}

function escapeAttr(str) {
	return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function showToast(message, type = 'info') {
	const toast = document.createElement('div')
	const alertType = type === 'success' ? 'alert-success' : type === 'error' ? 'alert-error' : type === 'warning' ? 'alert-warning' : 'alert-info'
	toast.className = `alert ${alertType} fixed top-4 right-4 z-[100] max-w-sm shadow-lg text-sm`
	toast.innerHTML = `<span>${escapeHtml(message)}</span>`
	document.body.appendChild(toast)
	setTimeout(() => {
		toast.style.opacity = '0'
		toast.style.transition = 'opacity 0.3s'
		setTimeout(() => toast.remove(), 300)
	}, 3000)
}