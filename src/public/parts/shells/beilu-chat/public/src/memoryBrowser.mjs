/**
 * memoryBrowser.mjs — 记忆文件浏览器（侧边栏文件树 + 文件内容查看）
 *
 * 职责：
 * - 动态加载记忆目录结构（hot/warm/cold）
 * - 文件树展开/折叠
 * - 点击文件显示内容（JSON 格式化）
 * - 文件内容编辑保存
 */

// ===== 状态 =====
let _username = ''
let _charId = ''
let _treeContainer = null
let _viewerContainer = null
let _expandedPaths = new Set()
let _selectedFilePath = ''

// ===== 图标映射 =====
const LAYER_ICONS = {
	hot: '🔥',
	warm: '🌤️',
	cold: '❄️',
}

const FILE_ICONS = {
	'tables.json': '📊',
	'_config.json': '⚙️',
	'_memory_presets.json': '🧩',
	'forever.json': '⭐',
	'appointments.json': '📅',
	'user_profile.json': '👤',
	'items_archive.json': '🎒',
	'warm_monthly_index.json': '📇',
	'cold_yearly_index.json': '📇',
}

/**
 * 判断文件是否应该在文件树中隐藏
 * 隐藏规则：以 _ 开头的配置文件、.bak 备份文件
 */
function shouldHideFile(name) {
	return name.startsWith('_') || name.endsWith('.bak')
}

function getFileIcon(name, isDir) {
	if (isDir) {
		if (LAYER_ICONS[name]) return LAYER_ICONS[name]
		return '📂'
	}
	if (FILE_ICONS[name]) return FILE_ICONS[name]
	if (name.endsWith('.json')) return '📄'
	if (name.endsWith('.bak')) return '💾'
	return '📝'
}

function getLayerBadge(dirPath) {
	if (dirPath === 'hot') return '<span class="mb-badge mb-badge-hot">热</span>'
	if (dirPath === 'warm') return '<span class="mb-badge mb-badge-warm">温</span>'
	if (dirPath === 'cold') return '<span class="mb-badge mb-badge-cold">冷</span>'
	return ''
}

// ===== API 调用 =====

async function listFiles(subPath = '') {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(_username)}&char_id=${encodeURIComponent(_charId)}`
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			_action: 'listMemoryFiles',
			username: _username,
			charName: _charId,
			subPath,
		}),
	})
	if (!res.ok) throw new Error(`列出文件失败: ${res.status}`)
	return res.json()
}

async function readFile(filePath) {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(_username)}&char_id=${encodeURIComponent(_charId)}`
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			_action: 'readMemoryFile',
			username: _username,
			charName: _charId,
			filePath,
		}),
	})
	if (!res.ok) throw new Error(`读取文件失败: ${res.status}`)
	return res.json()
}

async function writeFile(filePath, content) {
	const url = `/api/parts/plugins:beilu-memory/config/setdata?username=${encodeURIComponent(_username)}&char_id=${encodeURIComponent(_charId)}`
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			_action: 'writeMemoryFile',
			username: _username,
			charName: _charId,
			filePath,
			content,
		}),
	})
	if (!res.ok) throw new Error(`写入文件失败: ${res.status}`)
	return res.json()
}

// ===== 文件树渲染 =====

/**
 * 渲染文件树根节点
 */
async function renderFileTree() {
	if (!_treeContainer || !_charId) return

	_treeContainer.innerHTML = `
		<div class="mb-loading">
			<span class="mb-spinner"></span> 加载中...
		</div>
	`

	try {
		const data = await listFiles('')
		if (!data.success) throw new Error(data.error || '加载失败')

		_treeContainer.innerHTML = ''

		// 根节点
		const rootEl = document.createElement('div')
		rootEl.className = 'mb-tree-root'

		// 根目录标题
		const rootHeader = document.createElement('div')
		rootHeader.className = 'mb-tree-item mb-tree-root-header'
		rootHeader.innerHTML = `
			<span class="mb-tree-icon">🧠</span>
			<span class="mb-tree-label">${_charId}</span>
			<button class="mb-refresh-btn" title="刷新">🔄</button>
		`
		rootHeader.querySelector('.mb-refresh-btn').addEventListener('click', (e) => {
			e.stopPropagation()
			renderFileTree()
		})
		rootEl.appendChild(rootHeader)

		// 子目录 + 文件
		const childrenEl = document.createElement('div')
		childrenEl.className = 'mb-tree-children'

		// 先渲染目录（按 hot > warm > cold > 其他 排序）
		const sortedDirs = [...data.dirs].sort((a, b) => {
			const order = { hot: 0, warm: 1, cold: 2 }
			return (order[a.name] ?? 99) - (order[b.name] ?? 99)
		})

		for (const dir of sortedDirs) {
			const dirEl = await createDirNode(dir.name, dir.path)
			childrenEl.appendChild(dirEl)
		}

		// 渲染根目录文件（过滤掉配置文件和备份文件）
		for (const file of data.files) {
			if (shouldHideFile(file.name)) continue
			const fileEl = createFileNode(file.name, file.path, file.size)
			childrenEl.appendChild(fileEl)
		}

		rootEl.appendChild(childrenEl)
		_treeContainer.appendChild(rootEl)
	} catch (err) {
		console.error('[memoryBrowser] 加载文件树失败:', err)
		_treeContainer.innerHTML = `
			<div class="mb-error">
				<span>❌ ${err.message}</span>
				<button class="mb-retry-btn" onclick="this.closest('.mb-error').remove()">重试</button>
			</div>
		`
	}
}

/**
 * 创建目录节点
 */
async function createDirNode(name, dirPath) {
	const el = document.createElement('div')
	el.className = 'mb-tree-dir'

	const header = document.createElement('div')
	header.className = 'mb-tree-item mb-tree-dir-header'
	header.dataset.path = dirPath

	const isExpanded = _expandedPaths.has(dirPath)
	const icon = getFileIcon(name, true)
	const badge = getLayerBadge(name)

	header.innerHTML = `
		<span class="mb-tree-arrow ${isExpanded ? 'mb-expanded' : ''}">▶</span>
		<span class="mb-tree-icon">${icon}</span>
		<span class="mb-tree-label">${name}/</span>
		${badge}
	`

	const childrenEl = document.createElement('div')
	childrenEl.className = 'mb-tree-children'
	childrenEl.style.display = isExpanded ? '' : 'none'

	header.addEventListener('click', async () => {
		const wasExpanded = _expandedPaths.has(dirPath)
		if (wasExpanded) {
			_expandedPaths.delete(dirPath)
			childrenEl.style.display = 'none'
			header.querySelector('.mb-tree-arrow').classList.remove('mb-expanded')
		} else {
			_expandedPaths.add(dirPath)
			childrenEl.style.display = ''
			header.querySelector('.mb-tree-arrow').classList.add('mb-expanded')

			// 懒加载子目录内容
			if (childrenEl.children.length === 0) {
				childrenEl.innerHTML = '<div class="mb-loading-sm">加载中...</div>'
				try {
					const data = await listFiles(dirPath)
					childrenEl.innerHTML = ''

					if (data.dirs.length === 0 && data.files.length === 0) {
						childrenEl.innerHTML = '<div class="mb-empty-dir">(空目录)</div>'
						return
					}

					for (const subDir of data.dirs) {
							const subDirEl = await createDirNode(subDir.name, subDir.path)
							childrenEl.appendChild(subDirEl)
						}
						for (const file of data.files) {
							if (shouldHideFile(file.name)) continue
							const fileEl = createFileNode(file.name, file.path, file.size)
							childrenEl.appendChild(fileEl)
						}
				} catch (err) {
					childrenEl.innerHTML = `<div class="mb-error-sm">❌ ${err.message}</div>`
				}
			}
		}
	})

	el.appendChild(header)
	el.appendChild(childrenEl)

	// 如果已展开，立即加载内容
	if (isExpanded) {
		try {
			const data = await listFiles(dirPath)
			for (const subDir of data.dirs) {
				const subDirEl = await createDirNode(subDir.name, subDir.path)
				childrenEl.appendChild(subDirEl)
			}
			for (const file of data.files) {
				if (shouldHideFile(file.name)) continue
				const fileEl = createFileNode(file.name, file.path, file.size)
				childrenEl.appendChild(fileEl)
			}
		} catch { /* ignore */ }
	}

	return el
}

/**
 * 创建文件节点
 */
function createFileNode(name, filePath, size) {
	const el = document.createElement('div')
	el.className = 'mb-tree-item mb-tree-file'
	el.dataset.path = filePath

	const icon = getFileIcon(name, false)
	const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`

	el.innerHTML = `
		<span class="mb-tree-icon">${icon}</span>
		<span class="mb-tree-label">${name}</span>
		<span class="mb-tree-size">${sizeStr}</span>
	`

	if (_selectedFilePath === filePath) {
		el.classList.add('mb-tree-selected')
	}

	el.addEventListener('click', () => selectFile(filePath, el))

	return el
}

// ===== 文件内容查看 =====

/**
 * 选中文件并显示内容
 */
async function selectFile(filePath, treeEl) {
	_selectedFilePath = filePath

	// 更新文件树选中状态
	_treeContainer.querySelectorAll('.mb-tree-selected').forEach(el => {
		el.classList.remove('mb-tree-selected')
	})
	treeEl?.classList.add('mb-tree-selected')

	if (!_viewerContainer) return

	// 显示文件查看器，隐藏 dataTable 区域
	_viewerContainer.style.display = ''
	const datatableArea = document.getElementById('memory-datatable-area')
	if (datatableArea) datatableArea.style.display = 'none'

	_viewerContainer.innerHTML = `
		<div class="mb-viewer-loading">
			<span class="mb-spinner"></span> 读取中...
		</div>
	`

	try {
		const data = await readFile(filePath)
		if (!data.success) throw new Error(data.error || '读取失败')

		renderFileViewer(filePath, data)
	} catch (err) {
		_viewerContainer.innerHTML = `
			<div class="mb-viewer-error">
				<span>❌ 读取失败: ${err.message}</span>
			</div>
		`
	}
}

/**
 * 渲染文件内容查看器
 */
function renderFileViewer(filePath, data) {
	const fileName = filePath.split('/').pop()
	const sizeStr = data.size > 1024 ? `${(data.size / 1024).toFixed(1)}KB` : `${data.size}B`

	let contentHtml = ''
	if (data.isJson && data.parsed !== null) {
		// JSON 文件 — 格式化展示
		contentHtml = `<pre class="mb-json-content">${escapeHtml(JSON.stringify(data.parsed, null, 2))}</pre>`
	} else {
		// 纯文本
		contentHtml = `<pre class="mb-text-content">${escapeHtml(data.content)}</pre>`
	}

	_viewerContainer.innerHTML = `
		<div class="mb-viewer">
			<!-- 文件头 -->
			<div class="mb-viewer-header">
				<div class="mb-viewer-path">
					<span class="mb-viewer-icon">${getFileIcon(fileName, false)}</span>
					<span class="mb-viewer-filepath">${filePath}</span>
					<span class="mb-viewer-size">${sizeStr}</span>
				</div>
				<div class="mb-viewer-actions">
					<button class="dt-btn dt-btn-sm" id="mb-edit-btn">✏️ 编辑</button>
					<button class="dt-btn dt-btn-sm" id="mb-copy-btn">📋 复制</button>
				</div>
			</div>
			<!-- 文件内容 -->
			<div class="mb-viewer-body">
				${contentHtml}
			</div>
			<!-- 编辑区（默认隐藏） -->
			<div class="mb-editor-area" style="display:none;">
				<textarea class="mb-editor-textarea" id="mb-editor-textarea">${escapeHtml(data.isJson ? JSON.stringify(data.parsed, null, '\t') : data.content)}</textarea>
				<div class="mb-editor-footer">
					<button class="dt-btn dt-btn-sm dt-btn-primary" id="mb-save-btn">💾 保存</button>
					<button class="dt-btn dt-btn-sm" id="mb-cancel-btn">取消</button>
				</div>
			</div>
		</div>
	`

	// 绑定事件
	const editBtn = _viewerContainer.querySelector('#mb-edit-btn')
	const copyBtn = _viewerContainer.querySelector('#mb-copy-btn')
	const saveBtn = _viewerContainer.querySelector('#mb-save-btn')
	const cancelBtn = _viewerContainer.querySelector('#mb-cancel-btn')
	const editorArea = _viewerContainer.querySelector('.mb-editor-area')
	const viewerBody = _viewerContainer.querySelector('.mb-viewer-body')
	const textarea = _viewerContainer.querySelector('#mb-editor-textarea')

	editBtn?.addEventListener('click', () => {
		viewerBody.style.display = 'none'
		editorArea.style.display = ''
		editBtn.style.display = 'none'
		textarea.focus()
	})

	copyBtn?.addEventListener('click', () => {
		const text = data.isJson ? JSON.stringify(data.parsed, null, 2) : data.content
		navigator.clipboard?.writeText(text).then(() => {
			copyBtn.textContent = '✅ 已复制'
			setTimeout(() => { copyBtn.textContent = '📋 复制' }, 1500)
		}).catch(() => {
			copyBtn.textContent = '❌ 失败'
			setTimeout(() => { copyBtn.textContent = '📋 复制' }, 1500)
		})
	})

	cancelBtn?.addEventListener('click', () => {
		editorArea.style.display = 'none'
		viewerBody.style.display = ''
		editBtn.style.display = ''
		// 恢复原始内容
		textarea.value = data.isJson ? JSON.stringify(data.parsed, null, '\t') : data.content
	})

	saveBtn?.addEventListener('click', async () => {
		saveBtn.disabled = true
		saveBtn.textContent = '保存中...'

		try {
			let content = textarea.value
			// 尝试 JSON 解析（如果是 JSON 文件）
			if (data.isJson) {
				try {
					content = JSON.parse(content)
				} catch {
					// 不是合法 JSON，作为字符串保存
				}
			}

			const result = await writeFile(filePath, content)
			if (!result.success) throw new Error(result.error)

			// 重新加载文件内容
			await selectFile(filePath, _treeContainer.querySelector(`[data-path="${filePath}"]`))
		} catch (err) {
			saveBtn.textContent = `❌ ${err.message}`
			setTimeout(() => {
				saveBtn.disabled = false
				saveBtn.textContent = '💾 保存'
			}, 2000)
		}
	})
}

// ===== 工具函数 =====

function escapeHtml(str) {
	if (!str) return ''
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ===== 公开接口 =====

/**
 * 初始化记忆文件浏览器
 * @param {HTMLElement} treeContainer - 文件树渲染容器
 * @param {HTMLElement} viewerContainer - 文件内容查看器容器（可选，默认用 dataTable 区域）
 * @param {object} options - { charId, username }
 */
export async function initMemoryBrowser(treeContainer, viewerContainer, options = {}) {
	if (!treeContainer) return

	_treeContainer = treeContainer
	_viewerContainer = viewerContainer

	if (options.charId) {
		_charId = options.charId
		_username = options.username || ''
		await renderFileTree()
	} else {
		treeContainer.innerHTML = '<div class="mb-empty-dir" style="padding:1rem;">等待角色卡绑定...</div>'
	}

	console.log('[memoryBrowser] 初始化完成', options.charId ? `(${options.charId})` : '')
}

/**
 * 绑定到新角色卡并刷新文件树
 * @param {string} charId
 * @param {string} [username]
 */
export async function bindMemoryBrowserToChar(charId, username) {
	if (!_treeContainer) return
	if (charId === _charId) return // 同角色跳过

	_charId = charId
	_username = username || _username || ''
	_selectedFilePath = ''
	_expandedPaths.clear()

	// 默认展开 hot 目录
	_expandedPaths.add('hot')

	await renderFileTree()
}