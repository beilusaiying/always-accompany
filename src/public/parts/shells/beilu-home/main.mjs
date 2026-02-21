import info from './info.json' with { type: 'json' }

/**
 * beilu-home Shell — 贝露首页
 *
 * 职责：
 * - 提供选项卡式首页界面（使用 / 系统设置 / 用户设置）
 * - 角色卡列表展示和进入聊天
 * - 预设管理和 API 配置入口
 *
 * 后端 API：
 * - GET /api/parts/shells:beilu-home/chat-summaries — 获取聊天摘要缓存
 */
export default {
	info,
	/**
	 * 加载 Shell，注册后端路由
	 * @param {Object} param0 - 参数对象
	 * @param {Object} param0.router - Express 路由器
	 */
	Load: async ({ router }) => {
		const { authenticate, getUserByReq, getUserDictionary } = await import('../../../../server/auth.mjs')
		const { notifyPartInstall, uninstallPartBase, parts_set } = await import('../../../../server/parts_loader.mjs')
		const { loadData, saveData } = await import('../../../../server/setting_loader.mjs')
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')

		// ============================================================
		// GET /api/parts/shells:beilu-home/network-info
		// 返回局域网 IP 地址列表和端口
		// ============================================================
		router.get('/api/parts/shells\\:beilu-home/network-info', async (_req, res) => {
			try {
				const interfaces = os.networkInterfaces()
				const ips = []
				for (const name of Object.keys(interfaces)) {
					for (const iface of interfaces[name]) {
						if (iface.family === 'IPv4' && !iface.internal) {
							ips.push({ name, address: iface.address })
						}
					}
				}
				// 从配置或环境变量读取端口
				const port = process.env.FOUNT_PORT || 1314
				res.json({ ips, port })
			} catch (err) {
				console.error('[beilu-home] network-info error:', err)
				res.status(500).json({ error: err.message })
			}
		})
		// beilu 角色卡模板目录
		const CHAR_TEMPLATE_DIR = path.join(import.meta.dirname, 'beilu-char-template')
			const PERSONA_TEMPLATE_DIR = path.join(import.meta.dirname, 'beilu-persona-template')

		// PNG 角色卡解析器（复用 Fount 的 data_reader）
		const dataReader = await import('../../ImportHandlers/SillyTavern/data_reader.mjs')

		// POST /api/parts/shells:beilu-home/create-char
		// 创建空白角色卡
		router.post('/api/parts/shells\\:beilu-home/create-char', authenticate, async (req, res) => {
			try {
				const { username } = await getUserByReq(req)
				const { name } = req.body || {}

				if (!name || typeof name !== 'string' || !name.trim()) {
					return res.status(400).json({ message: '角色名称不能为空' })
				}

				const charName = name.trim()
				// 安全检查：禁止路径穿越字符
				if (/[\/\\:*?"<>|]/.test(charName)) {
					return res.status(400).json({ message: '角色名称包含非法字符' })
				}

				const userDir = getUserDictionary(username)
				const charDir = path.join(userDir, 'chars', charName)

				if (fs.existsSync(charDir)) {
					return res.status(409).json({ message: `角色 "${charName}" 已存在` })
				}

				// 创建目录
				fs.mkdirSync(charDir, { recursive: true })
	
				// 复制 beilu 角色卡模板 main.mjs（保持与导入角色卡结构一致）
				const templateMain = path.join(CHAR_TEMPLATE_DIR, 'main.mjs')
				if (fs.existsSync(templateMain)) {
					fs.copyFileSync(templateMain, path.join(charDir, 'main.mjs'))
				} else {
					console.warn('[beilu-home] 角色卡模板 main.mjs 不存在，空白角色卡可能缺少 main.mjs')
				}
	
				// 写入 fount.json
				fs.writeFileSync(
					path.join(charDir, 'fount.json'),
					JSON.stringify({ type: 'chars', dirname: charName }, null, '\t'),
					'utf-8'
				)

				// 写入 info.json（最小的多语言信息）
				const infoData = {
					'zh-CN': {
						name: charName,
						avatar: '',
						description: '',
						version: '0.1.0',
						author: username,
						tags: []
					},
					'en-UK': {
						name: charName,
						avatar: '',
						description: '',
						version: '0.1.0',
						author: username,
						tags: []
					}
				}
				fs.writeFileSync(
					path.join(charDir, 'info.json'),
					JSON.stringify(infoData, null, '\t'),
					'utf-8'
				)

				// 通知 Fount 刷新 parts 缓存
				try {
					notifyPartInstall(username, `chars/${charName}`)
				} catch (e) {
					console.warn('[beilu-home] notifyPartInstall 失败:', e.message)
				}

				console.log(`[beilu-home] 角色卡已创建: "${charName}" (user: ${username})`)
				res.status(201).json({ success: true, name: charName })
			} catch (error) {
				console.error('[beilu-home] Error creating char:', error)
				res.status(500).json({ message: error.message })
			}
		})

		// GET /api/parts/shells:beilu-home/chat-summaries
		// 读取 chat_summaries_cache.json，过滤 null 值后返回
		router.get('/api/parts/shells\\:beilu-home/chat-summaries', authenticate, async (req, res) => {
			try {
				const { username } = await getUserByReq(req)
				const userDir = getUserDictionary(username)
				const cachePath = path.join(userDir, 'shells', 'chat', 'chat_summaries_cache.json')

				if (!fs.existsSync(cachePath)) {
					return res.status(200).json({})
				}

				const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
				const filtered = {}
				for (const [key, value] of Object.entries(raw)) {
					if (value !== null) filtered[key] = value
				}

				res.status(200).json(filtered)
			} catch (error) {
				console.error('[beilu-home] Error reading chat summaries:', error)
				res.status(500).json({ message: error.message })
			}
		})
		// ============================================================
		// POST /api/parts/shells:beilu-home/import-char
		// 自定义角色卡导入（不使用 Fount 的 ST ImportHandler）
		// 接收 multipart 文件上传（支持 JSON / PNG）
		// ============================================================
		router.post('/api/parts/shells\\:beilu-home/import-char', authenticate, async (req, res) => {
			try {
				const { username } = await getUserByReq(req)

				// express-fileupload 解析后的文件
				const uploadedFile = req.files?.file
				if (!uploadedFile) {
					return res.status(400).json({ message: '未上传文件' })
				}

				const fileName = uploadedFile.name || ''
				const fileBuffer = uploadedFile.data
				const ext = fileName.toLowerCase().split('.').pop()

				let charDataRaw = null  // 解析后的角色卡 JSON 对象
				let imageBuffer = null  // PNG 图片 Buffer（仅 PNG 导入时有）

				// --- 根据文件类型解析 ---
				if (ext === 'json') {
					// JSON 角色卡：直接解析
					const text = fileBuffer.toString('utf-8')
					charDataRaw = JSON.parse(text)
				} else if (ext === 'png') {
					// PNG 角色卡：从 tEXt chunk 提取 chara 数据
					try {
						const charaJson = dataReader.read(fileBuffer)
						charDataRaw = JSON.parse(charaJson)
						imageBuffer = fileBuffer  // 原始 PNG 作为头像
					} catch (pngErr) {
						return res.status(400).json({ message: 'PNG 中未找到角色卡数据: ' + pngErr.message })
					}
				} else {
					return res.status(400).json({ message: `不支持的文件格式: .${ext}（支持 .json / .png）` })
				}

				if (!charDataRaw || typeof charDataRaw !== 'object') {
					return res.status(400).json({ message: '角色卡数据解析失败' })
				}

				// 解析 ST chara_card_v2/v3 格式
				const data = charDataRaw.data || charDataRaw
				const charName = (data.name || 'unknown').trim()

				if (!charName) {
					return res.status(400).json({ message: '角色名称为空' })
				}

				// 安全检查：替换非法字符
				const safeName = charName.replace(/[\/\\:*?"<>|]/g, '_')
				const userDir = getUserDictionary(username)
				let charDir = path.join(userDir, 'chars', safeName)

				// 处理重名：加数字后缀
				let finalName = safeName
				let counter = 1
				while (fs.existsSync(charDir)) {
					finalName = `${safeName}_${counter}`
					charDir = path.join(userDir, 'chars', finalName)
					counter++
				}

				// 创建角色卡目录
				fs.mkdirSync(charDir, { recursive: true })

				// 1. 复制 beilu 角色卡模板 main.mjs
				const templateMain = path.join(CHAR_TEMPLATE_DIR, 'main.mjs')
				if (fs.existsSync(templateMain)) {
					fs.copyFileSync(templateMain, path.join(charDir, 'main.mjs'))
				} else {
					// 模板缺失时清理已创建的目录
					fs.rmSync(charDir, { recursive: true, force: true })
					console.warn('[beilu-home] 角色卡模板 main.mjs 不存在:', templateMain)
					return res.status(500).json({ message: '角色卡模板缺失' })
				}

				// 2. 写入 chardata.json（完整保留原始 ST 数据，不篡改）
				fs.writeFileSync(
					path.join(charDir, 'chardata.json'),
					JSON.stringify(data, null, '\t'),
					'utf-8'
				)

				// 3. 写入 fount.json
				fs.writeFileSync(
					path.join(charDir, 'fount.json'),
					JSON.stringify({ type: 'chars', dirname: finalName }, null, '\t'),
					'utf-8'
				)

				// 4. 保存头像图片
				if (imageBuffer) {
					const publicDir = path.join(charDir, 'public')
					fs.mkdirSync(publicDir, { recursive: true })
					fs.writeFileSync(path.join(publicDir, 'image.png'), imageBuffer)
				}

				// 5. 为新角色写入默认 AIsource 配置（在 notifyPartInstall 之前，确保 Fount 加载时能读到）
				try {
					const parts_config = loadData(username, 'parts_config')
	
					// 策略1: 复用已有角色卡的 AIsource
					let defaultAIsource = ''
					for (const [key, val] of Object.entries(parts_config)) {
						if (key.startsWith('chars/') && val?.AIsource) {
							defaultAIsource = val.AIsource
							break
						}
					}
	
					// 策略2: 找 generator === "proxy" 的第一个 AI 源
					if (!defaultAIsource) {
						for (const [key, val] of Object.entries(parts_config)) {
							if (key.startsWith('serviceSources/AI/') && val?.generator === 'proxy') {
								defaultAIsource = key.replace('serviceSources/AI/', '')
								break
							}
						}
					}
	
					if (defaultAIsource) {
						parts_config[`chars/${finalName}`] = {
							AIsource: defaultAIsource,
							plugins: [],
						}
						saveData(username, 'parts_config')
						console.log(`[beilu-home] 自动配置 AIsource: "${defaultAIsource}" → chars/${finalName}`)
					} else {
						console.warn('[beilu-home] 未找到可用的 AIsource，新角色卡需要手动配置')
					}
				} catch (e) {
					console.warn('[beilu-home] 自动配置 AIsource 失败:', e.message)
				}
	
				// 6. 通知 Fount 刷新 parts 缓存
				try {
					notifyPartInstall(username, `chars/${finalName}`)
				} catch (e) {
					console.warn('[beilu-home] notifyPartInstall 失败:', e.message)
				}

				console.log(`[beilu-home] 角色卡已导入: "${finalName}" (原名: "${charName}", user: ${username})`)
				res.status(201).json({
					success: true,
					name: finalName,
					original_name: charName,
					// 返回角色卡数据供前端提取附属资源（正则 + 世界书）
					chardata: data,
				})
			} catch (error) {
				console.error('[beilu-home] Error importing char:', error)
				res.status(500).json({ message: error.message })
			}
		})

		// ============================================================
		// DELETE /api/parts/shells:beilu-home/delete-char/:charName
		// 删除角色卡（移动到回收站）
		// Body 可选参数:
		//   deleteChats: boolean — 是否同时删除该角色的聊天记录
		//   deleteMemory: boolean — 是否同时删除该角色的记忆数据
		//   deleteWorldbook: boolean — 是否同时删除绑定的世界书
		// 正则规则始终自动删除（无需询问）
		// ============================================================
		router.delete('/api/parts/shells\\:beilu-home/delete-char/:charName', authenticate, async (req, res) => {
			try {
				const { username } = await getUserByReq(req)
				const { charName } = req.params
				const options = req.body || {}

				if (!charName) {
					return res.status(400).json({ message: '缺少角色名称' })
				}

				const userDir = getUserDictionary(username)
				const charDir = path.join(userDir, 'chars', charName)

				if (!fs.existsSync(charDir)) {
					return res.status(404).json({ message: `角色 "${charName}" 不存在` })
				}

				const partpath = `chars/${charName}`
					const cleanupResults = { regex: false, worldbook: false, chats: 0, memory: false }
	
					// 插件配置文件的固定路径（不依赖 parts_set 运行时加载状态）
					const pluginsDir = path.join(import.meta.dirname, '../../plugins')
	
					// 1. 正则规则 — 始终自动删除（直接操作磁盘文件）
					try {
						const regexConfigPath = path.join(pluginsDir, 'beilu-regex', 'config_data.json')
						if (fs.existsSync(regexConfigPath)) {
							const regexData = JSON.parse(fs.readFileSync(regexConfigPath, 'utf-8'))
							if (Array.isArray(regexData.rules)) {
								const before = regexData.rules.length
								regexData.rules = regexData.rules.filter(r => r.boundCharName !== charName)
								const removed = before - regexData.rules.length
								if (removed > 0) {
									fs.writeFileSync(regexConfigPath, JSON.stringify(regexData, null, 2), 'utf-8')
									console.log(`[beilu-home] 已清理角色 "${charName}" 绑定的 ${removed} 条正则规则`)
								}
								cleanupResults.regex = true
							}
						}
						// 如果插件已加载到 parts_set，同步内存状态
						try {
							const regexPlugin = parts_set[username]?.['plugins/beilu-regex']
							if (regexPlugin?.interfaces?.config?.SetData) {
								await regexPlugin.interfaces.config.SetData({ _action: 'removeByChar', charName })
							}
						} catch (_) { /* 插件未加载时忽略 */ }
					} catch (e) {
						console.warn('[beilu-home] 清理绑定正则失败:', e.message)
					}
	
					// 2. 世界书 — 根据用户选择（直接操作磁盘文件）
					if (options.deleteWorldbook) {
						try {
							const wbConfigPath = path.join(pluginsDir, 'beilu-worldbook', 'config_data.json')
							if (fs.existsSync(wbConfigPath)) {
								const wbData = JSON.parse(fs.readFileSync(wbConfigPath, 'utf-8'))
								if (Array.isArray(wbData.worldbooks)) {
									const before = wbData.worldbooks.length
									wbData.worldbooks = wbData.worldbooks.filter(wb => wb.boundCharName !== charName)
									const removed = before - wbData.worldbooks.length
									if (removed > 0) {
										fs.writeFileSync(wbConfigPath, JSON.stringify(wbData, null, 2), 'utf-8')
										console.log(`[beilu-home] 已清理角色 "${charName}" 绑定的 ${removed} 个世界书`)
									}
									cleanupResults.worldbook = true
								}
							}
							// 如果插件已加载到 parts_set，同步内存状态
							try {
								const worldbookPlugin = parts_set[username]?.['plugins/beilu-worldbook']
								if (worldbookPlugin?.interfaces?.config?.SetData) {
									await worldbookPlugin.interfaces.config.SetData({ removeByChar: { charName } })
								}
							} catch (_) { /* 插件未加载时忽略 */ }
						} catch (e) {
							console.warn('[beilu-home] 清理绑定世界书失败:', e.message)
						}
					}
	
					// 3. 聊天记录 — 根据用户选择（直接操作文件系统）
					if (options.deleteChats) {
						try {
							// 直接删除 chars/{charName}/chats/ 目录下的所有聊天文件
							const chatsDir = path.join(charDir, 'chats')
							if (fs.existsSync(chatsDir)) {
								const chatFiles = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'))
								for (const file of chatFiles) {
									try {
										fs.unlinkSync(path.join(chatsDir, file))
										cleanupResults.chats++
									} catch (e) {
										console.warn(`[beilu-home] 删除聊天文件 ${file} 失败:`, e.message)
									}
								}
							}
							// 同时清理 summaries cache 中该角色的聊天
							try {
								const cachePath = path.join(userDir, 'shells', 'chat', 'chat_summaries_cache.json')
								if (fs.existsSync(cachePath)) {
									const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
									let changed = false
									for (const [chatid, summary] of Object.entries(cache)) {
										// 通过 chars 字段判断是否属于该角色
										if (summary?.chars?.includes?.(charName)) {
											delete cache[chatid]
											changed = true
										}
									}
									if (changed) {
										fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
									}
								}
							} catch (_) { /* 缓存清理失败不影响主流程 */ }
						} catch (e) {
							console.warn('[beilu-home] 清理聊天记录失败:', e.message)
						}
					}

				// 4. 记忆数据 — 根据用户选择（在 uninstallPartBase 之前主动处理）
				if (options.deleteMemory) {
					// 主动删除新路径 chars/{charName}/memory/（不依赖 uninstallPartBase 的 trash）
					const memoryDir = path.join(charDir, 'memory')
					if (fs.existsSync(memoryDir)) {
						try {
							fs.rmSync(memoryDir, { recursive: true, force: true })
							console.log(`[beilu-home] 已删除记忆目录: ${memoryDir}`)
						} catch (e) {
							console.warn('[beilu-home] 删除记忆目录失败:', e.message)
						}
					}
					// 同时清理旧路径残留 memory/{charName}/
					const oldMemoryDir = path.join(userDir, 'memory', charName)
					if (fs.existsSync(oldMemoryDir)) {
						try {
							fs.rmSync(oldMemoryDir, { recursive: true, force: true })
							console.log(`[beilu-home] 已删除旧记忆目录: ${oldMemoryDir}`)
						} catch (e) {
							console.warn('[beilu-home] 删除旧记忆目录失败:', e.message)
						}
					}
					cleanupResults.memory = true
				} else {
					// 用户选择保留记忆 → 备份 memory 目录到临时位置
					const memoryDir = path.join(charDir, 'memory')
					const tempMemoryDir = path.join(userDir, '_temp_memory_backup_' + charName)
					if (fs.existsSync(memoryDir)) {
						try {
							fs.cpSync(memoryDir, tempMemoryDir, { recursive: true })
						} catch (e) {
							console.warn('[beilu-home] 备份记忆数据失败:', e.message)
						}
					}
					// 标记需要恢复
					options._restoreMemoryFrom = tempMemoryDir
				}
	
				// 5. 使用 Fount 的 uninstallPartBase 进行完整卸载
				// 清理 5 层缓存：parts_set / parts_init / parts_config / parts_details_cache / parts_branch_cache
				// 加 try-catch 保护：trash 对中文路径可能失败，回退为 rmSync
				try {
						await uninstallPartBase(username, partpath, undefined, undefined, {
							pathGetter: () => charDir,
						})
					} catch (uninstallErr) {
					console.warn(`[beilu-home] uninstallPartBase 失败(${uninstallErr.message})，手动删除目录...`)
					if (fs.existsSync(charDir)) {
						try {
							fs.rmSync(charDir, { recursive: true, force: true })
						} catch (rmErr) {
							console.error('[beilu-home] 手动删除角色卡目录也失败:', rmErr.message)
						}
					}
				}
	
				// 6. 如果需要恢复记忆数据（用户选择保留时）
				if (options._restoreMemoryFrom && fs.existsSync(options._restoreMemoryFrom)) {
					try {
						// 恢复到独立的 memory/{charName}/ 目录（角色卡已删除，chars/ 不再存在）
						const restoredDir = path.join(userDir, 'memory', charName)
						fs.cpSync(options._restoreMemoryFrom, restoredDir, { recursive: true })
						fs.rmSync(options._restoreMemoryFrom, { recursive: true, force: true })
						console.log(`[beilu-home] 记忆数据已保留到: ${restoredDir}`)
					} catch (e) {
						console.warn('[beilu-home] 恢复记忆数据失败:', e.message)
					}
				}
	
				// 7. 通知 beilu-memory 清理内存缓存
				try {
					const memPlugin = parts_set[username]?.['plugins/beilu-memory']
					if (memPlugin?.interfaces?.config?.SetData) {
						await memPlugin.interfaces.config.SetData({ _action: 'clearCache', charName, username })
					}
				} catch (_) { /* 插件未加载时忽略 */ }
	
				// 8. 保险：确保角色卡目录被彻底删除（防止 trash/rmSync 因路径或占用问题遗漏）
				if (fs.existsSync(charDir)) {
					try {
						fs.rmSync(charDir, { recursive: true, force: true })
						console.log(`[beilu-home] 保险清理：角色卡目录已删除: ${charDir}`)
					} catch (e) {
						console.error('[beilu-home] 保险清理失败:', e.message)
					}
				}
	
	console.log(`[beilu-home] 角色卡已删除（含缓存清理）: "${charName}" (user: ${username})`, cleanupResults)
res.status(200).json({ success: true, name: charName, cleanup: cleanupResults })
} catch (error) {
console.error('[beilu-home] Error deleting char:', error)
res.status(500).json({ message: error.message })
}
})

// ============================================================
// PUT /api/parts/shells:beilu-home/update-char/:charName
// 更新角色卡数据（chardata.json 字段 + 可选头像上传）
// Body JSON: { first_mes?, description?, personality?, scenario? }
// 或 multipart: avatar 文件 + JSON 字段
// ============================================================
router.put('/api/parts/shells\\:beilu-home/update-char/:charName', authenticate, async (req, res) => {
	try {
		const { username } = await getUserByReq(req)
		const { charName } = req.params

		if (!charName) {
			return res.status(400).json({ message: '缺少角色名称' })
		}

		const userDir = getUserDictionary(username)
		const charDir = path.join(userDir, 'chars', charName)

		if (!fs.existsSync(charDir)) {
			return res.status(404).json({ message: `角色 "${charName}" 不存在` })
		}

		const chardataPath = path.join(charDir, 'chardata.json')
		let chardata = {}
		if (fs.existsSync(chardataPath)) {
			chardata = JSON.parse(fs.readFileSync(chardataPath, 'utf-8'))
		}

		// 更新文本字段
		const updates = req.body || {}
		const allowedFields = ['name', 'first_mes', 'description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes']
		let changed = false
		for (const field of allowedFields) {
			if (updates[field] !== undefined) {
				chardata[field] = updates[field]
				changed = true
			}
		}
		// alternate_greetings 数组（兼容 FormData 字符串传输）
		let altGreetings = updates.alternate_greetings
		if (typeof altGreetings === 'string') {
			try { altGreetings = JSON.parse(altGreetings) } catch (_) { altGreetings = null }
		}
		if (Array.isArray(altGreetings)) {
			chardata.alternate_greetings = altGreetings
			changed = true
		}

		if (changed) {
			fs.writeFileSync(chardataPath, JSON.stringify(chardata, null, '\t'), 'utf-8')
		}

		// 如果 name 字段变更，同步更新 info.json
		if (updates.name !== undefined) {
			const infoPath = path.join(charDir, 'info.json')
			if (fs.existsSync(infoPath)) {
				const infoData = JSON.parse(fs.readFileSync(infoPath, 'utf-8'))
				for (const lang of Object.keys(infoData)) {
					if (typeof infoData[lang] === 'object') {
						infoData[lang].name = updates.name
					}
				}
				fs.writeFileSync(infoPath, JSON.stringify(infoData, null, '\t'), 'utf-8')
			}
		}

		// 处理头像上传
		const avatarFile = req.files?.avatar
		if (avatarFile) {
			const publicDir = path.join(charDir, 'public')
			fs.mkdirSync(publicDir, { recursive: true })
			fs.writeFileSync(path.join(publicDir, 'image.png'), avatarFile.data)
		}

		// 清除 parts_details_cache 以刷新
		try {
			const cache = loadData(username, 'parts_details_cache')
			delete cache[`chars/${charName}`]
			saveData(username, 'parts_details_cache')
		} catch (_) { /* 静默 */ }

		console.log(`[beilu-home] 角色卡已更新: "${charName}" (user: ${username})`)
		res.status(200).json({ success: true, name: charName, chardata })
	} catch (error) {
		console.error('[beilu-home] Error updating char:', error)
		res.status(500).json({ message: error.message })
	}
})

// ============================================================
// GET /api/parts/shells:beilu-home/char-data/:charName
// 获取角色卡完整数据
// ============================================================
router.get('/api/parts/shells\\:beilu-home/char-data/:charName', authenticate, async (req, res) => {
	try {
		const { username } = await getUserByReq(req)
		const { charName } = req.params
		const userDir = getUserDictionary(username)
		const chardataPath = path.join(userDir, 'chars', charName, 'chardata.json')

		if (!fs.existsSync(chardataPath)) {
			return res.status(404).json({ message: `角色 "${charName}" 数据不存在` })
		}

		const chardata = JSON.parse(fs.readFileSync(chardataPath, 'utf-8'))
		res.status(200).json(chardata)
	} catch (error) {
		console.error('[beilu-home] Error reading char data:', error)
		res.status(500).json({ message: error.message })
	}
})

// ============================================================
// POST /api/parts/shells:beilu-home/create-persona
// 创建新用户人设
// ============================================================
router.post('/api/parts/shells\\:beilu-home/create-persona', authenticate, async (req, res) => {
try {
	const { username } = await getUserByReq(req)
	const { name, description } = req.body || {}

	if (!name || typeof name !== 'string' || !name.trim()) {
		return res.status(400).json({ message: '人设名称不能为空' })
	}

	const personaName = name.trim()
	if (/[\/\\:*?"<>|]/.test(personaName)) {
		return res.status(400).json({ message: '人设名称包含非法字符' })
	}

	const userDir = getUserDictionary(username)
	const personaDir = path.join(userDir, 'personas', personaName)

	if (fs.existsSync(personaDir)) {
		return res.status(409).json({ message: `人设 "${personaName}" 已存在` })
	}

	// 创建目录
	fs.mkdirSync(personaDir, { recursive: true })

	// 复制模板 main.mjs
	const templateMain = path.join(PERSONA_TEMPLATE_DIR, 'main.mjs')
	if (fs.existsSync(templateMain)) {
		fs.copyFileSync(templateMain, path.join(personaDir, 'main.mjs'))
	} else {
		fs.rmSync(personaDir, { recursive: true, force: true })
		return res.status(500).json({ message: '人设模板缺失' })
	}

	// 写入 fount.json
	fs.writeFileSync(
		path.join(personaDir, 'fount.json'),
		JSON.stringify({ type: 'personas', dirname: personaName }, null, '\t'),
		'utf-8'
	)

	// 写入 info.json
	const infoData = {
		'zh-CN': {
			name: personaName,
			avatar: '',
			description: description || '',
			version: '0.1.0',
			author: username,
		},
		'en-UK': {
			name: personaName,
			avatar: '',
			description: description || '',
			version: '0.1.0',
			author: username,
		}
	}
	fs.writeFileSync(
		path.join(personaDir, 'info.json'),
		JSON.stringify(infoData, null, '\t'),
		'utf-8'
	)

	// 通知 Fount 刷新
	try {
		notifyPartInstall(username, `personas/${personaName}`)
	} catch (e) {
		console.warn('[beilu-home] notifyPartInstall(persona) 失败:', e.message)
	}

	console.log(`[beilu-home] 人设已创建: "${personaName}" (user: ${username})`)
	res.status(201).json({ success: true, name: personaName })
} catch (error) {
	console.error('[beilu-home] Error creating persona:', error)
	res.status(500).json({ message: error.message })
}
})

// ============================================================
// PUT /api/parts/shells:beilu-home/update-persona/:name
// 更新用户人设（名称 / 描述）
// ============================================================
router.put('/api/parts/shells\\:beilu-home/update-persona/:name', authenticate, async (req, res) => {
try {
	const { username } = await getUserByReq(req)
	const { name: personaName } = req.params
	const { description } = req.body || {}

	if (!personaName) {
		return res.status(400).json({ message: '缺少人设名称' })
	}

	const userDir = getUserDictionary(username)
	const personaDir = path.join(userDir, 'personas', personaName)

	if (!fs.existsSync(personaDir)) {
		return res.status(404).json({ message: `人设 "${personaName}" 不存在` })
	}

	// 读取并更新 info.json
	const infoPath = path.join(personaDir, 'info.json')
	let infoData = {}
	if (fs.existsSync(infoPath)) {
		infoData = JSON.parse(fs.readFileSync(infoPath, 'utf-8'))
	}

	// 更新所有语言的 description
	for (const lang of Object.keys(infoData)) {
		if (typeof infoData[lang] === 'object') {
			if (description !== undefined) infoData[lang].description = description
		}
	}
	// 如果 info.json 为空或没有语言键，创建默认结构
	if (Object.keys(infoData).length === 0) {
		infoData = {
			'zh-CN': { name: personaName, description: description || '', avatar: '' },
			'en-UK': { name: personaName, description: description || '', avatar: '' },
		}
	}

	fs.writeFileSync(infoPath, JSON.stringify(infoData, null, '\t'), 'utf-8')

	// 清除 parts_details_cache 以刷新
	try {
		const cache = loadData(username, 'parts_details_cache')
		delete cache[`personas/${personaName}`]
		saveData(username, 'parts_details_cache')
	} catch (_) { /* 静默 */ }

	console.log(`[beilu-home] 人设已更新: "${personaName}" (user: ${username})`)
	res.status(200).json({ success: true, name: personaName })
} catch (error) {
	console.error('[beilu-home] Error updating persona:', error)
	res.status(500).json({ message: error.message })
}
})

// ============================================================
// DELETE /api/parts/shells:beilu-home/delete-persona/:name
// 删除用户人设
// ============================================================
router.delete('/api/parts/shells\\:beilu-home/delete-persona/:name', authenticate, async (req, res) => {
try {
	const { username } = await getUserByReq(req)
	const { name: personaName } = req.params

	if (!personaName) {
		return res.status(400).json({ message: '缺少人设名称' })
	}

	const partpath = `personas/${personaName}`

	// 使用 Fount 的 uninstallPartBase 完整卸载
	// 加 try-catch 保护：trash 对中文路径可能失败，回退为 rmSync
	try {
		await uninstallPartBase(username, partpath)
	} catch (uninstallErr) {
		console.warn(`[beilu-home] uninstallPartBase(persona) 失败(${uninstallErr.message})，手动删除目录...`)
		const userDir = getUserDictionary(username)
		const personaDir = path.join(userDir, 'personas', personaName)
		if (fs.existsSync(personaDir)) {
			try {
				fs.rmSync(personaDir, { recursive: true, force: true })
			} catch (rmErr) {
				console.error('[beilu-home] 手动删除人设目录也失败:', rmErr.message)
			}
		}
	}

	console.log(`[beilu-home] 人设已删除: "${personaName}" (user: ${username})`)
	res.status(200).json({ success: true, name: personaName })
} catch (error) {
	console.error('[beilu-home] Error deleting persona:', error)
	res.status(500).json({ message: error.message })
}
})

		// ============================================================
		// 诊断系统 API 端点 (/api/diag/*)
		// 用于前端控制面板远程控制后端诊断日志
		// ============================================================
		const { diagControl } = await import('../../../../server/diagLogger.mjs')

		// GET /api/diag/status — 获取后端诊断状态
		router.get('/api/diag/status', (_req, res) => {
			try {
				res.json(diagControl.getStatus())
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		// POST /api/diag/enable — 启用后端诊断模块
		router.post('/api/diag/enable', (req, res) => {
			try {
				const { modules } = req.body || {}
				if (!modules) return res.status(400).json({ error: '缺少 modules 参数' })
				diagControl.enable(modules)
				res.json({ success: true, ...diagControl.getStatus() })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		// POST /api/diag/disable — 禁用后端诊断模块
		router.post('/api/diag/disable', (req, res) => {
			try {
				const { modules } = req.body || {}
				if (!modules) return res.status(400).json({ error: '缺少 modules 参数' })
				diagControl.disable(modules)
				res.json({ success: true, ...diagControl.getStatus() })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		// POST /api/diag/level — 设置后端日志级别
		router.post('/api/diag/level', (req, res) => {
			try {
				const { level } = req.body || {}
				if (!level) return res.status(400).json({ error: '缺少 level 参数' })
				diagControl.setLevel(level)
				res.json({ success: true, ...diagControl.getStatus() })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		// GET /api/diag/snapshots — 获取后端状态快照
		router.get('/api/diag/snapshots', (req, res) => {
			try {
				const count = parseInt(req.query.count) || 50
				const module = req.query.module || null
				res.json({ snapshots: diagControl.getSnapshots(count, module) })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})

		// POST /api/diag/clear-snapshots — 清空后端快照
		router.post('/api/diag/clear-snapshots', (_req, res) => {
			try {
				diagControl.clearSnapshots()
				res.json({ success: true })
			} catch (err) {
				res.status(500).json({ error: err.message })
			}
		})
	},
	Unload: () => {},
	interfaces: {
		web: {},
	},
}