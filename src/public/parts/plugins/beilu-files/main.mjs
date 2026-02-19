import info from './info.json' with { type: 'json' }

// ============================================================
// 文件操作安全策略
// ============================================================

/**
 * @typedef {Object} FileOperation
 * @property {string} id - 操作 ID
 * @property {string} type - 操作类型 ('read' | 'write' | 'create' | 'delete' | 'list' | 'move' | 'exec')
 * @property {string} path - 文件路径
 * @property {string} [content] - 文件内容 (write/create 时)
 * @property {string} [destPath] - 目标路径 (move 时)
 * @property {string} [command] - 命令 (exec 时)
 * @property {string} status - 状态 ('pending' | 'approved' | 'rejected' | 'completed' | 'failed')
 * @property {string} [result] - 操作结果
 * @property {string} [error] - 错误信息
 * @property {number} timestamp - 时间戳
 */

/**
 * 生成唯一 ID
 * @returns {string}
 */
function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

/**
 * 检查路径是否在允许列表中
 * @param {string} filePath - 待检查路径
 * @param {string[]} allowedPaths - 允许的路径前缀
 * @param {string[]} blockedPaths - 禁止的路径前缀
 * @returns {boolean}
 */
function isPathAllowed(filePath, allowedPaths, blockedPaths) {
	// 规范化路径
	const normalized = filePath.replace(/\\/g, '/').toLowerCase()

	// 检查禁止列表
	for (const blocked of blockedPaths) {
		if (normalized.startsWith(blocked.replace(/\\/g, '/').toLowerCase())) {
			return false
		}
	}

	// 如果允许列表为空，默认允许所有（除了被禁止的）
	if (allowedPaths.length === 0) return true

	// 检查允许列表
	for (const allowed of allowedPaths) {
		if (normalized.startsWith(allowed.replace(/\\/g, '/').toLowerCase())) {
			return true
		}
	}

	return false
}

/**
 * 解析 AI 回复中的文件操作指令
 * @param {string} content - AI 回复内容
 * @returns {FileOperation[]} 解析到的操作列表
 */
function parseFileOperations(content) {
	const operations = []

	// 解析 <file_op> 标签
	const fileOpRegex = /<file_op\s+type="(\w+)"(?:\s+path="([^"]*)")?(?:\s+dest="([^"]*)")?(?:\s+command="([^"]*)")?>([\s\S]*?)<\/file_op>/gi
	let match

	while ((match = fileOpRegex.exec(content)) !== null) {
		operations.push({
			id: generateId(),
			type: match[1],
			path: match[2] || '',
			destPath: match[3] || '',
			command: match[4] || '',
			content: match[5]?.trim() || '',
			status: 'pending',
			result: '',
			error: '',
			timestamp: Date.now(),
		})
	}

	// 也支持 tool_call 格式 (类 function calling)
	const toolCallRegex = /<tool_call>\s*\{\s*"name"\s*:\s*"file_(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}\s*<\/tool_call>/gi
	while ((match = toolCallRegex.exec(content)) !== null) {
		try {
			const args = JSON.parse(match[2])
			operations.push({
				id: generateId(),
				type: match[1],
				path: args.path || '',
				content: args.content || '',
				destPath: args.dest || args.destPath || '',
				command: args.command || '',
				status: 'pending',
				result: '',
				error: '',
				timestamp: Date.now(),
			})
		} catch {
			// JSON 解析失败，跳过
		}
	}

	return operations
}

// ============================================================
// 文件操作执行器 (Deno 环境)
// ============================================================

/**
 * 执行文件操作
 * @param {FileOperation} op - 操作对象
 * @returns {Promise<FileOperation>} 执行后的操作对象
 */
async function executeFileOperation(op) {
	if (typeof Deno === 'undefined') {
		op.status = 'failed'
		op.error = 'File operations require Deno runtime'
		return op
	}

	try {
		switch (op.type) {
			case 'read': {
				const content = await Deno.readTextFile(op.path)
				op.result = content
				op.status = 'completed'
				break
			}
			case 'write': {
				await Deno.writeTextFile(op.path, op.content)
				op.result = `Written ${op.content.length} chars to ${op.path}`
				op.status = 'completed'
				break
			}
			case 'create': {
				// 确保目录存在
				const dir = op.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
				if (dir) {
					try { await Deno.mkdir(dir, { recursive: true }) } catch { /* 目录已存在 */ }
				}
				await Deno.writeTextFile(op.path, op.content || '')
				op.result = `Created ${op.path}`
				op.status = 'completed'
				break
			}
			case 'delete': {
				await Deno.remove(op.path, { recursive: false })
				op.result = `Deleted ${op.path}`
				op.status = 'completed'
				break
			}
			case 'list': {
				const entries = []
				for await (const entry of Deno.readDir(op.path || '.')) {
					entries.push({
						name: entry.name,
						isFile: entry.isFile,
						isDirectory: entry.isDirectory,
					})
				}
				op.result = JSON.stringify(entries, null, 2)
				op.status = 'completed'
				break
			}
			case 'move': {
				await Deno.rename(op.path, op.destPath)
				op.result = `Moved ${op.path} → ${op.destPath}`
				op.status = 'completed'
				break
			}
			case 'exec': {
				const cmd = op.command || op.content
				if (!cmd) {
					op.status = 'failed'
					op.error = 'No command specified'
					break
				}
				const command = new Deno.Command(
					Deno.build.os === 'windows' ? 'cmd' : 'sh',
					{
						args: Deno.build.os === 'windows' ? ['/c', cmd] : ['-c', cmd],
						cwd: op.path || undefined,
						stdout: 'piped',
						stderr: 'piped',
					}
				)
				const output = await command.output()
				const stdout = new TextDecoder().decode(output.stdout)
				const stderr = new TextDecoder().decode(output.stderr)
				op.result = stdout + (stderr ? '\n[stderr] ' + stderr : '')
				op.status = output.code === 0 ? 'completed' : 'failed'
				if (output.code !== 0) op.error = `Exit code: ${output.code}`
				break
			}
			default:
				op.status = 'failed'
				op.error = `Unknown operation type: ${op.type}`
		}
	} catch (err) {
		op.status = 'failed'
		op.error = err.message || String(err)
	}

	return op
}

// ============================================================
// 插件数据
// ============================================================

/**
 * 检查路径是否指向系统盘 (C:)，禁止访问
 * @param {string} filePath - 待检查路径
 * @returns {string|null} 如果被禁止返回错误消息，否则返回 null
 */
function checkSystemDriveBlock(filePath) {
	if (!filePath) return null
	const normalized = filePath.replace(/\\/g, '/')
	if (/^[cC]:[\\/]/.test(normalized) || /^[cC]:$/.test(normalized)) {
		return '出于安全考虑，不允许访问系统盘 (C:)'
	}
	return null
}

let pluginData = {
	enabled: true,
	autoApprove: false,        // 自动批准操作 (危险！)
	autoApproveRead: true,     // 自动批准读取操作
	autoApproveList: true,     // 自动批准列出目录操作
	allowExec: false,          // 是否允许执行命令
	allowedPaths: [],          // 允许的路径前缀 (空 = 全部允许)
	blockedPaths: [],          // 禁止的路径前缀
	operationHistory: [],      // FileOperation[] 操作历史
	maxHistory: 100,           // 最大历史记录数
	pendingOperations: [],     // 待批准的操作
	// ---- 层级权限 ----
	activeMode: 'chat',        // 当前 UI 模式 ('chat' | 'file' | 'memory')
	customPrompt: '',          // 用户自定义提示词（文件操作场景）
	customPromptEnabled: false, // 是否启用自定义提示词
	// ---- 文件模式隔离 ----
	fileModeStartIndex: -1,    // 进入文件模式时的聊天消息数量
	fileModeChat: '',          // 进入文件模式时的 chatid
}

// ============================================================
// beilu-files 插件导出
// ============================================================

/**
 * beilu-files 插件 — 文件操作能力
 *
 * 职责：
 * - 解析 AI 回复中的 <file_op> 标签或 tool_call
 * - 安全策略检查 (路径白名单/黑名单)
 * - 自动/手动批准文件操作
 * - 执行文件读写/创建/删除/移动/命令执行
 * - GetPrompt: 注入文件操作能力说明
 * - ReplyHandler: 解析并执行文件操作
 */
const pluginExport = {
	info,
	Load: async ({ router }) => {
		if (!router) return

		router.get('/api/parts/plugins\\:beilu-files/config/getdata', async (req, res) => {
			try {
				const data = await pluginExport.interfaces.config.GetData()
				res.json(data)
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		router.post('/api/parts/plugins\\:beilu-files/config/setdata', async (req, res) => {
			try {
				const result = await pluginExport.interfaces.config.SetData(req.body)
				res.json(result || { success: true })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: async () => {},
	interfaces: {
		config: {
			GetData: async () => ({
					enabled: pluginData.enabled,
					autoApprove: pluginData.autoApprove,
					autoApproveRead: pluginData.autoApproveRead,
					autoApproveList: pluginData.autoApproveList,
					allowExec: pluginData.allowExec,
					allowedPaths: pluginData.allowedPaths,
					blockedPaths: pluginData.blockedPaths,
					maxHistory: pluginData.maxHistory,
					pendingOperations: pluginData.pendingOperations,
					operationHistory: pluginData.operationHistory.slice(-20), // 只返回最近20条
					activeMode: pluginData.activeMode,
					customPrompt: pluginData.customPrompt,
					customPromptEnabled: pluginData.customPromptEnabled,
					_stats: {
						totalOps: pluginData.operationHistory.length,
						pendingCount: pluginData.pendingOperations.length,
						completedCount: pluginData.operationHistory.filter(o => o.status === 'completed').length,
						failedCount: pluginData.operationHistory.filter(o => o.status === 'failed').length,
					},
				}),
			SetData: async (data) => {
				if (!data) return

				if (data._action) {
					switch (data._action) {
						// ======== 前端直接文件操作 ========
						case 'readFile': {
							const blockMsg = checkSystemDriveBlock(data.path)
							if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
							try {
								const content = await Deno.readTextFile(data.path)
								return { _result: { content, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						case 'writeFile': {
							const blockMsg = checkSystemDriveBlock(data.path)
							if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
							try {
								await Deno.writeTextFile(data.path, data.content || '')
								return { _result: { success: true, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						case 'listDir': {
							try {
								// 规范化路径：支持 Windows 绝对路径
								let dirPath = data.path || '.'
								// 将反斜杠统一为正斜杠
								dirPath = dirPath.replace(/\\/g, '/')
								// Windows 盘符根需要确保以 / 结尾 (D: → D:/)
								if (/^[a-zA-Z]:$/.test(dirPath)) dirPath += '/'
	
								// 安全策略：禁止访问系统盘 (C:)
								const blockMsg = checkSystemDriveBlock(dirPath)
								if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
	
								const entries = []
								for await (const entry of Deno.readDir(dirPath)) {
									const item = {
										name: entry.name,
										isFile: entry.isFile,
										isDirectory: entry.isDirectory,
									}
									// 尝试获取文件信息
									try {
										// 拼接完整路径：盘符根 (D:/) 不要去掉尾部斜杠
										const base = dirPath.replace(/\/+$/, '') || dirPath
										const fullPath = base + '/' + entry.name
										const stat = await Deno.stat(fullPath)
										item.size = stat.size
										item.modified = stat.mtime?.toISOString() || null
									} catch { /* 忽略 stat 失败 */ }
									entries.push(item)
								}
								// 排序：目录在前，文件在后，各自按名称排序
								entries.sort((a, b) => {
									if (a.isDirectory && !b.isDirectory) return -1
									if (!a.isDirectory && b.isDirectory) return 1
									return a.name.localeCompare(b.name)
								})
								return { _result: { entries, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						case 'createFile': {
							const blockMsg = checkSystemDriveBlock(data.path)
							if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
							try {
								const dir = data.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
								if (dir) {
									try { await Deno.mkdir(dir, { recursive: true }) } catch { /* 已存在 */ }
								}
								await Deno.writeTextFile(data.path, data.content || '')
								return { _result: { success: true, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						case 'deleteFile': {
							const blockMsg = checkSystemDriveBlock(data.path)
							if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
							try {
								await Deno.remove(data.path)
								return { _result: { success: true, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						case 'createDir': {
							const blockMsg = checkSystemDriveBlock(data.path)
							if (blockMsg) return { _result: { error: blockMsg, path: data.path } }
							try {
								await Deno.mkdir(data.path, { recursive: true })
								return { _result: { success: true, path: data.path } }
							} catch (err) {
								return { _result: { error: err.message, path: data.path } }
							}
						}
						// ======== AI 操作审批 ========
						case 'approveOp': {
							const op = pluginData.pendingOperations.find(o => o.id === data.opId)
							if (op) {
								op.status = 'approved'
								pluginData.pendingOperations = pluginData.pendingOperations.filter(o => o.id !== data.opId)
								const result = await executeFileOperation(op)
								pluginData.operationHistory.push(result)
								// 限制历史长度
								if (pluginData.operationHistory.length > pluginData.maxHistory) {
									pluginData.operationHistory = pluginData.operationHistory.slice(-pluginData.maxHistory)
								}
							}
							break
						}
						case 'rejectOp': {
							const op = pluginData.pendingOperations.find(o => o.id === data.opId)
							if (op) {
								op.status = 'rejected'
								pluginData.pendingOperations = pluginData.pendingOperations.filter(o => o.id !== data.opId)
								pluginData.operationHistory.push(op)
							}
							break
						}
						case 'approveAll': {
							for (const op of pluginData.pendingOperations) {
								op.status = 'approved'
								const result = await executeFileOperation(op)
								pluginData.operationHistory.push(result)
							}
							pluginData.pendingOperations = []
							break
						}
						case 'rejectAll': {
							for (const op of pluginData.pendingOperations) {
								op.status = 'rejected'
								pluginData.operationHistory.push(op)
							}
							pluginData.pendingOperations = []
							break
						}
						case 'clearHistory': {
							pluginData.operationHistory = []
							break
						}
						case 'addAllowedPath': {
							if (data.path && !pluginData.allowedPaths.includes(data.path)) {
								pluginData.allowedPaths.push(data.path)
							}
							break
						}
						case 'removeAllowedPath': {
							pluginData.allowedPaths = pluginData.allowedPaths.filter(p => p !== data.path)
							break
						}
						case 'addBlockedPath': {
							if (data.path && !pluginData.blockedPaths.includes(data.path)) {
								pluginData.blockedPaths.push(data.path)
							}
							break
						}
						case 'removeBlockedPath': {
							pluginData.blockedPaths = pluginData.blockedPaths.filter(p => p !== data.path)
							break
						}
						case 'setMode': {
							const validModes = ['chat', 'file', 'memory']
							if (validModes.includes(data.mode)) {
								const previousMode = pluginData.activeMode
								pluginData.activeMode = data.mode
	
								// 进入文件/记忆模式：记录起始点
								if ((data.mode === 'file' || data.mode === 'memory') && previousMode === 'chat') {
									pluginData.fileModeStartIndex = data.currentMessageCount ?? -1
									pluginData.fileModeChat = data.chatid || ''
									console.log(`[beilu-files] 进入${data.mode}模式, 起始索引=${pluginData.fileModeStartIndex}, chatid=${pluginData.fileModeChat}`)
								}
	
								// 退出文件/记忆模式：返回清理信息
								if (data.mode === 'chat' && (previousMode === 'file' || previousMode === 'memory')) {
									const cleanup = (pluginData.fileModeStartIndex >= 0 && pluginData.fileModeChat)
										? {
											_cleanup: {
												chatid: pluginData.fileModeChat,
												startIndex: pluginData.fileModeStartIndex,
											}
										}
										: null
	
									pluginData.fileModeStartIndex = -1
									pluginData.fileModeChat = ''
									console.log(`[beilu-files] 退出${previousMode}模式, 清理信息:`, cleanup)
	
									if (cleanup) return cleanup
								}
							}
							break
						}
						default:
							break
					}
					return
				}

				if (data.enabled !== undefined) pluginData.enabled = data.enabled
					if (data.autoApprove !== undefined) pluginData.autoApprove = data.autoApprove
					if (data.autoApproveRead !== undefined) pluginData.autoApproveRead = data.autoApproveRead
					if (data.autoApproveList !== undefined) pluginData.autoApproveList = data.autoApproveList
					if (data.allowExec !== undefined) pluginData.allowExec = data.allowExec
					if (data.allowedPaths !== undefined) pluginData.allowedPaths = data.allowedPaths
					if (data.blockedPaths !== undefined) pluginData.blockedPaths = data.blockedPaths
					if (data.maxHistory !== undefined) pluginData.maxHistory = data.maxHistory
					if (data.customPrompt !== undefined) pluginData.customPrompt = data.customPrompt
					if (data.customPromptEnabled !== undefined) pluginData.customPromptEnabled = data.customPromptEnabled
			},
		},
		chat: {
			/**
			 * GetPrompt: 注入文件操作能力说明
			 */
			GetPrompt: async (arg) => {
					if (!pluginData.enabled) return null
	
					// 层级权限：chat 模式下不注入文件操作能力
					if (pluginData.activeMode === 'chat') return null
	
					let text = '[File Operation Capabilities]\n'
					text += 'You can perform file operations using <file_op> tags:\n'
					text += '- <file_op type="read" path="..."></file_op> - Read file\n'
					text += '- <file_op type="write" path="...">content</file_op> - Write file\n'
					text += '- <file_op type="create" path="...">content</file_op> - Create file\n'
					text += '- <file_op type="delete" path="..."></file_op> - Delete file\n'
					text += '- <file_op type="list" path="..."></file_op> - List directory\n'
					text += '- <file_op type="move" path="..." dest="..."></file_op> - Move/rename file\n'
	
					if (pluginData.allowExec) {
						text += '- <file_op type="exec" command="..."></file_op> - Execute command\n'
					}
	
					// 显示待处理操作的结果
					const recentCompleted = pluginData.operationHistory.slice(-3).filter(o => o.status === 'completed')
					if (recentCompleted.length > 0) {
						text += '\n[Recent Operation Results]\n'
						for (const op of recentCompleted) {
							text += `- ${op.type} ${op.path}: ${op.result?.substring(0, 200) || 'OK'}\n`
						}
					}
	
					// 显示待批准操作
					if (pluginData.pendingOperations.length > 0) {
						text += `\n[${pluginData.pendingOperations.length} operations pending user approval]\n`
					}
	
					// 追加用户自定义提示词
					if (pluginData.customPromptEnabled && pluginData.customPrompt) {
						text += '\n[Custom Instructions]\n'
						text += pluginData.customPrompt + '\n'
					}
	
					return {
						text,
						role: 'system',
						name: 'beilu-files',
					}
				},

			/**
			 * ReplyHandler: 解析文件操作指令并执行
			 */
			ReplyHandler: async (reply, args) => {
				if (!pluginData.enabled) return false
				if (!reply || !reply.content) return false

				const operations = parseFileOperations(reply.content)
				if (operations.length === 0) return false

				for (const op of operations) {
					// 安全检查: exec 权限
					if (op.type === 'exec' && !pluginData.allowExec) {
						op.status = 'rejected'
						op.error = 'Command execution is disabled'
						pluginData.operationHistory.push(op)
						continue
					}

					// 安全检查: 路径权限
					if (op.path && !isPathAllowed(op.path, pluginData.allowedPaths, pluginData.blockedPaths)) {
						op.status = 'rejected'
						op.error = `Path not allowed: ${op.path}`
						pluginData.operationHistory.push(op)
						continue
					}

					// 判断是否自动批准
					const shouldAutoApprove =
						pluginData.autoApprove ||
						(pluginData.autoApproveRead && op.type === 'read') ||
						(pluginData.autoApproveList && op.type === 'list')

					if (shouldAutoApprove) {
						op.status = 'approved'
						const result = await executeFileOperation(op)
						pluginData.operationHistory.push(result)
					} else {
						// 加入待批准队列
						pluginData.pendingOperations.push(op)
					}
				}

				// 清除回复中的文件操作标签
				reply.content = reply.content
					.replace(/<file_op[\s\S]*?<\/file_op>/gi, '')
					.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
					.trim()

				// 限制历史长度
				if (pluginData.operationHistory.length > pluginData.maxHistory) {
					pluginData.operationHistory = pluginData.operationHistory.slice(-pluginData.maxHistory)
				}

				return false
			},
		},
	},
}

export default pluginExport