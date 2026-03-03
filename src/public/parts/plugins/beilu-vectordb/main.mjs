import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { count, create, insert, search } from 'npm:@orama/orama'
import { persist, restore } from 'npm:@orama/plugin-data-persistence'

import { createDiag } from '../../../../server/diagLogger.mjs'
import info from './info.json' with { type: 'json' }

const diag = createDiag('vectordb')

// ============================================================
// beilu-vectordb 插件 — Orama 语义搜索
//
// 职责：
// - 使用 Orama 构建记忆文件的向量索引
// - 支持全文搜索、向量语义搜索、混合搜索
// - Embedding 通过可配置的 OpenAI 兼容 API 获取
// - 与 beilu-memory 集成：新增 semanticSearch 操作
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ============================================================
// 配置
// ============================================================

let vectorConfig = {
	enabled: false,                    // 默认关闭，需要配置 embedding API 后开启
	embeddingApiUrl: '',               // OpenAI 兼容的 /v1/embeddings 端点
	embeddingApiKey: '',               // API Key
	embeddingModel: 'text-embedding-ada-002', // 模型名
	embeddingDimensions: 1536,         // 向量维度
	maxChunkSize: 500,                 // 文本分块大小（字符数）
	chunkOverlap: 50,                  // 分块重叠
	topK: 10,                          // 搜索返回 top-k 结果
}

// Orama 数据库实例
let db = null
let indexReady = false
let indexStats = { documentCount: 0, lastIndexTime: null, indexErrors: [] }

// ============================================================
// Orama 数据库管理
// ============================================================

/**
 * 创建或恢复 Orama 数据库
 * @param {string} [persistPath] - 持久化路径（可选）
 */
async function initDatabase(persistPath) {
	diag.log('initDatabase: 开始初始化', persistPath ? `(持久化路径: ${persistPath})` : '(无持久化)')
	diag.time('initDatabase')
	try {
		// 尝试从持久化文件恢复
		if (persistPath) {
			try {
				const data = await Deno.readTextFile(persistPath)
				db = await restore('json', data)
				indexStats.documentCount = await count(db)
				indexReady = true
				diag.log('从持久化恢复索引，文档数:', indexStats.documentCount)
				diag.timeEnd('initDatabase')
				return
			} catch (e) {
				// 持久化文件不存在或损坏，创建新数据库
				diag.warn('持久化恢复失败，创建新索引:', e.message)
			}
		}

		db = await create({
			schema: {
				content: 'string',          // 文本内容
				file: 'string',             // 源文件路径
				layer: 'string',            // 记忆层级：hot/warm/cold/table
				chunkIndex: 'number',        // 分块索引
				timestamp: 'number',         // 时间戳
				embedding: `vector[${vectorConfig.embeddingDimensions}]`,
			},
		})
		indexReady = true
		diag.log('新索引已创建, 向量维度:', vectorConfig.embeddingDimensions)
		diag.timeEnd('initDatabase')
	} catch (err) {
		diag.error('初始化数据库失败:', err.message)
		diag.snapshot('initDatabase-error', {
			error: err.message,
			config: { ...vectorConfig, embeddingApiKey: '***' },
		})
		indexReady = false
		diag.timeEnd('initDatabase')
	}
}

/**
 * 持久化数据库到文件
 * @param {string} persistPath - 保存路径
 */
async function persistDatabase(persistPath) {
	if (!db || !persistPath) {
		diag.warn('persistDatabase: 跳过 (db:', !!db, ', path:', !!persistPath, ')')
		return
	}
	diag.time('persistDatabase')
	try {
		const data = await persist(db, 'json')
		await Deno.writeTextFile(persistPath, data)
		diag.log('索引已持久化, 大小:', Math.round(data.length / 1024), 'KB')
		diag.timeEnd('persistDatabase')
	} catch (err) {
		diag.error('持久化失败:', err.message)
		diag.timeEnd('persistDatabase')
	}
}

// ============================================================
// Embedding API
// ============================================================

/**
 * 调用 OpenAI 兼容的 embedding API 获取向量
 * @param {string} text - 要编码的文本
 * @returns {Promise<number[]|null>} 向量数组
 */
async function getEmbedding(text) {
	if (!vectorConfig.embeddingApiUrl) {
		diag.warn('embedding API URL 未配置 — 请在设置中配置 embeddingApiUrl')
		return null
	}

	diag.time('getEmbedding')
	try {
		const inputLen = Math.min(text.length, 8000)
		diag.debug('embedding 请求:', {
			url: vectorConfig.embeddingApiUrl,
			model: vectorConfig.embeddingModel,
			inputLength: inputLen,
		})

		const response = await fetch(vectorConfig.embeddingApiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(vectorConfig.embeddingApiKey ? { 'Authorization': `Bearer ${vectorConfig.embeddingApiKey}` } : {}),
			},
			body: JSON.stringify({
				model: vectorConfig.embeddingModel,
				input: text.substring(0, 8000), // 防止超长
			}),
		})

		if (!response.ok) {
			const errText = await response.text()
			diag.error('embedding API 返回错误:', response.status, errText.substring(0, 200))
			diag.snapshot('embedding-api-error', {
				status: response.status,
				url: vectorConfig.embeddingApiUrl,
				model: vectorConfig.embeddingModel,
				errorBody: errText.substring(0, 500),
			})
			throw new Error(`HTTP ${response.status}: ${errText.substring(0, 200)}`)
		}

		const json = await response.json()

		// OpenAI 格式: { data: [{ embedding: [...] }] }
		if (json.data?.[0]?.embedding) {
			const dims = json.data[0].embedding.length
			diag.debug('embedding 成功, 维度:', dims)
			if (dims !== vectorConfig.embeddingDimensions) {
				diag.warn('embedding 维度不匹配! 配置:', vectorConfig.embeddingDimensions,
					', 实际:', dims, '— 可能导致索引错误')
			}
			diag.timeEnd('getEmbedding')
			return json.data[0].embedding
		}
		// 某些 API 直接返回数组
		if (Array.isArray(json)) {
			diag.debug('embedding 成功 (直接数组), 维度:', json.length)
			diag.timeEnd('getEmbedding')
			return json
		}

		throw new Error('无法解析 embedding 响应格式')
	} catch (err) {
		diag.error('embedding 请求失败:', err.message)
		diag.timeEnd('getEmbedding')
		return null
	}
}

/**
 * 批量获取 embeddings
 * @param {string[]} texts - 文本数组
 * @returns {Promise<(number[]|null)[]>}
 */
async function getEmbeddings(texts) {
	// 串行处理，避免并发过多
	const results = []
	for (const text of texts) {
		results.push(await getEmbedding(text))
		// 简单限流
		if (texts.length > 5) {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	return results
}

// ============================================================
// 文本分块
// ============================================================

/**
 * 将长文本分割为有重叠的 chunks
 * @param {string} text - 原始文本
 * @param {number} chunkSize - 分块大小
 * @param {number} overlap - 重叠字符数
 * @returns {string[]}
 */
function splitIntoChunks(text, chunkSize = 500, overlap = 50) {
	if (text.length <= chunkSize) return [text]

	const chunks = []
	let start = 0
	while (start < text.length) {
		const end = Math.min(start + chunkSize, text.length)
		chunks.push(text.substring(start, end))
		start += chunkSize - overlap
		if (start >= text.length) break
	}
	return chunks
}

// ============================================================
// 索引操作
// ============================================================

/**
 * 索引单个文档（文件内容）
 * @param {string} filePath - 文件路径
 * @param {string} content - 文件内容
 * @param {string} layer - 记忆层级
 * @param {number} [timestamp] - 时间戳
 */
async function indexDocument(filePath, content, layer = 'unknown', timestamp = Date.now()) {
	if (!db || !indexReady) {
		diag.warn('indexDocument: 索引未就绪 (db:', !!db, ', indexReady:', indexReady, ')')
		return { success: false, error: 'index not ready' }
	}

	diag.time(`indexDocument:${filePath}`)
	try {
		const chunks = splitIntoChunks(content, vectorConfig.maxChunkSize, vectorConfig.chunkOverlap)
		diag.debug('indexDocument:', filePath, `| 内容长度: ${content.length}`,
			`| 分块数: ${chunks.length}`, `| 层级: ${layer}`)

		const embeddings = await getEmbeddings(chunks)

		let indexed = 0
		let embeddingFailed = 0
		for (let i = 0; i < chunks.length; i++) {
			const embedding = embeddings[i]
			if (!embedding) {
				embeddingFailed++
				indexStats.indexErrors.push(`${filePath} chunk ${i}: embedding 获取失败`)
				continue
			}

			await insert(db, {
				content: chunks[i],
				file: filePath,
				layer,
				chunkIndex: i,
				timestamp,
				embedding,
			})
			indexed++
		}

		indexStats.documentCount = await count(db)
		indexStats.lastIndexTime = Date.now()

		diag.log('索引完成:', filePath,
			`| ${indexed}/${chunks.length} chunks`,
			embeddingFailed > 0 ? `| ${embeddingFailed} 失败` : '',
			`| 总文档数: ${indexStats.documentCount}`)
		diag.timeEnd(`indexDocument:${filePath}`)
		return { success: true, indexed, total: chunks.length }
	} catch (err) {
		diag.error('索引文档失败:', filePath, err.message)
		diag.snapshot('indexDocument-error', { filePath, layer, error: err.message })
		indexStats.indexErrors.push(`${filePath}: ${err.message}`)
		diag.timeEnd(`indexDocument:${filePath}`)
		return { success: false, error: err.message }
	}
}

/**
 * 语义搜索
 * @param {string} query - 搜索查询
 * @param {object} options - { topK, mode, layer }
 * @returns {Promise<object>}
 */
async function semanticSearch(query, options = {}) {
	if (!db || !indexReady) {
		diag.warn('semanticSearch: 索引未就绪')
		return { results: [], error: 'index not ready' }
	}

	const { topK = vectorConfig.topK, mode = 'hybrid', layer } = options
	diag.time('semanticSearch')
	diag.log('semanticSearch:', `query="${query.substring(0, 50)}"`,
		`| mode=${mode}`, `| topK=${topK}`, layer ? `| layer=${layer}` : '')

	try {
		const searchParams = { limit: topK }

		if (mode === 'fulltext' || mode === 'hybrid') {
			searchParams.term = query
		}

		if (mode === 'vector' || mode === 'hybrid') {
			const queryEmbedding = await getEmbedding(query)
			if (queryEmbedding) {
				searchParams.vector = {
					value: queryEmbedding,
					property: 'embedding',
				}
				diag.debug('查询向量已获取, 维度:', queryEmbedding.length)
			} else if (mode === 'vector') {
				diag.warn('纯向量搜索失败: embedding 获取失败')
				diag.timeEnd('semanticSearch')
				return { results: [], error: 'embedding 获取失败，无法执行纯向量搜索' }
			} else {
				diag.warn('混合搜索降级为全文搜索: embedding 获取失败')
			}
		}

		// mode 设置
		if (mode === 'fulltext') searchParams.mode = 'fulltext'
		else if (mode === 'vector' && searchParams.vector) searchParams.mode = 'vector'
		else if (searchParams.vector && searchParams.term) searchParams.mode = 'hybrid'
		else searchParams.mode = 'fulltext'

		// 层级过滤
		if (layer) {
			searchParams.where = { layer: { eq: layer } }
		}

		const searchResults = await search(db, searchParams)

		const results = searchResults.hits.map(hit => ({
			score: hit.score,
			content: hit.document.content,
			file: hit.document.file,
			layer: hit.document.layer,
			chunkIndex: hit.document.chunkIndex,
			timestamp: hit.document.timestamp,
		}))

		diag.log('搜索完成:',
			`| 结果数: ${results.length}/${searchResults.count}`,
			`| 耗时: ${searchResults.elapsed?.formatted || '?'}`,
			`| 实际模式: ${searchParams.mode}`,
			results.length > 0 ? `| 最高分: ${results[0].score.toFixed(3)}` : '')
		diag.timeEnd('semanticSearch')

		return {
			results,
			count: searchResults.count,
			elapsed: searchResults.elapsed,
			query,
			mode,
		}
	} catch (err) {
		diag.error('搜索失败:', err.message)
		diag.snapshot('semanticSearch-error', { query, mode, error: err.message })
		diag.timeEnd('semanticSearch')
		return { results: [], error: err.message }
	}
}

/**
 * 重建整个索引（遍历记忆目录）
 * @param {string} memDir - 记忆目录路径
 */
async function rebuildIndex(memDir) {
	if (!vectorConfig.enabled) {
		diag.warn('rebuildIndex: 向量搜索未启用')
		return { success: false, error: '向量搜索未启用' }
	}

	diag.log('开始重建索引... memDir:', memDir)
	diag.time('rebuildIndex')
	indexStats.indexErrors = []

	// 重新创建空数据库
	db = await create({
		schema: {
			content: 'string',
			file: 'string',
			layer: 'string',
			chunkIndex: 'number',
			timestamp: 'number',
			embedding: `vector[${vectorConfig.embeddingDimensions}]`,
		},
	})

	let totalFiles = 0
	let totalIndexed = 0

	async function walkDir(dir, layer) {
		try {
			for await (const entry of Deno.readDir(dir)) {
				const fullPath = dir.replace(/\\/g, '/') + '/' + entry.name

				if (entry.isDirectory) {
					if (entry.name.startsWith('_')) continue // 跳过索引目录
					// 自动识别层级
					let subLayer = layer
					if (entry.name === 'hot') subLayer = 'hot'
					else if (entry.name === 'warm') subLayer = 'warm'
					else if (entry.name === 'cold') subLayer = 'cold'
					await walkDir(fullPath, subLayer)
					continue
				}

				if (!entry.name.endsWith('.json')) continue

				try {
					const stat = await Deno.stat(fullPath)
					if (stat.size > 100 * 1024) continue // 跳过大文件

					const content = await Deno.readTextFile(fullPath)
					const relativePath = fullPath.replace(memDir.replace(/\\/g, '/'), '').replace(/^\//, '')

					totalFiles++
					const result = await indexDocument(relativePath, content, layer, stat.mtime?.getTime())
					if (result.success) totalIndexed += result.indexed
				} catch { /* 跳过读取失败的文件 */ }
			}
		} catch { /* 跳过无法读取的目录 */ }
	}

	await walkDir(memDir, 'unknown')

	indexStats.documentCount = await count(db)
	indexStats.lastIndexTime = Date.now()

	diag.log('索引重建完成:',
		`| ${totalFiles} 文件`, `| ${totalIndexed} chunks`,
		`| 总文档数: ${indexStats.documentCount}`,
		`| 错误数: ${indexStats.indexErrors.length}`)
	diag.timeEnd('rebuildIndex')
	if (indexStats.indexErrors.length > 0) {
		diag.warn('索引错误列表:', indexStats.indexErrors.slice(0, 5).join('; '))
	}
	return {
		success: true,
		totalFiles,
		totalChunks: totalIndexed,
		documentCount: indexStats.documentCount,
		errors: indexStats.indexErrors.length,
	}
}

// ============================================================
// 插件导出
// ============================================================

export default {
	info,
	Load: async () => {
		diag.log('Load() — 语义搜索插件已加载')
		diag.debug('配置状态:', {
			enabled: vectorConfig.enabled,
			embeddingApiUrl: vectorConfig.embeddingApiUrl ? '已配置' : '未配置',
			embeddingModel: vectorConfig.embeddingModel,
			dimensions: vectorConfig.embeddingDimensions,
		})
		if (vectorConfig.enabled && vectorConfig.embeddingApiUrl) {
			diag.log('自动初始化索引...')
			await initDatabase()
		} else if (vectorConfig.enabled && !vectorConfig.embeddingApiUrl) {
			diag.warn('向量搜索已启用但 embedding API 未配置 — 请在设置中配置 embeddingApiUrl')
		}
	},

	Unload: async () => {
		diag.log('Unload() — 语义搜索插件已卸载',
			`| 文档数: ${indexStats.documentCount}`)
		db = null
		indexReady = false
	},

	interfaces: {
		config: {
			/**
			 * 获取插件状态和统计
			 */
			GetData: async () => ({
				enabled: vectorConfig.enabled,
				indexReady,
				embeddingApiUrl: vectorConfig.embeddingApiUrl ? '(已配置)' : '(未配置)',
				embeddingModel: vectorConfig.embeddingModel,
				embeddingDimensions: vectorConfig.embeddingDimensions,
				stats: {
					documentCount: indexStats.documentCount,
					lastIndexTime: indexStats.lastIndexTime,
					errorCount: indexStats.indexErrors.length,
					recentErrors: indexStats.indexErrors.slice(-5),
				},
				description: '贝露的语义搜索 — Orama 向量数据库，支持全文/语义/混合搜索',
			}),

			/**
			 * 设置数据 / 操作入口
			 */
			SetData: async (data) => {
				if (!data) return

				diag.debug('SetData 收到操作:', data._action || '(无 _action)')

				// 更新配置
				if (data._action === 'updateConfig') {
					const oldEnabled = vectorConfig.enabled
					if (data.enabled !== undefined) vectorConfig.enabled = !!data.enabled
					if (data.embeddingApiUrl) vectorConfig.embeddingApiUrl = data.embeddingApiUrl
					if (data.embeddingApiKey !== undefined) vectorConfig.embeddingApiKey = data.embeddingApiKey
					if (data.embeddingModel) vectorConfig.embeddingModel = data.embeddingModel
					if (data.embeddingDimensions) vectorConfig.embeddingDimensions = Math.max(64, Math.min(4096, data.embeddingDimensions))
					if (data.topK) vectorConfig.topK = Math.max(1, Math.min(50, data.topK))

					// 配置更新后初始化数据库
					if (vectorConfig.enabled && vectorConfig.embeddingApiUrl && !indexReady) {
						diag.log('配置更新后自动初始化索引')
						await initDatabase()
					}

					diag.log('配置已更新',
						!oldEnabled && vectorConfig.enabled ? '| ⚡ 向量搜索已启用' : '',
						oldEnabled && !vectorConfig.enabled ? '| ❌ 向量搜索已禁用' : '')
					return { success: true, config: { ...vectorConfig, embeddingApiKey: '***' } }
				}

				// 索引单个文档
				if (data._action === 'indexDocument') {
					if (!vectorConfig.enabled) {
						diag.warn('indexDocument: 向量搜索未启用')
						return { success: false, error: '向量搜索未启用' }
					}
					if (!diag.guard(data, ['file', 'content'], 'indexDocument')) {
						return { success: false, error: '缺少 file 或 content 参数' }
					}
					return await indexDocument(data.file, data.content, data.layer, data.timestamp)
				}

				// 语义搜索
				if (data._action === 'search') {
					if (!vectorConfig.enabled) {
						diag.warn('search: 向量搜索未启用')
						return { results: [], error: '向量搜索未启用' }
					}
					if (!data.query) {
						diag.warn('search: 缺少 query 参数')
						return { results: [], error: '缺少 query 参数' }
					}
					return await semanticSearch(data.query, {
						topK: data.topK,
						mode: data.mode,
						layer: data.layer,
					})
				}

				// 重建索引
				if (data._action === 'rebuildIndex') {
					if (!data.memDir) {
						diag.warn('rebuildIndex: 缺少 memDir 参数')
						return { success: false, error: '需要 memDir 参数' }
					}
					return await rebuildIndex(data.memDir)
				}

				// 获取统计
				if (data._action === 'getStats') {
					return {
						enabled: vectorConfig.enabled,
						indexReady,
						documentCount: indexStats.documentCount,
						lastIndexTime: indexStats.lastIndexTime,
						errors: indexStats.indexErrors.slice(-10),
					}
				}

				// 持久化
				if (data._action === 'persist') {
					if (!data.path) {
						diag.warn('persist: 缺少 path 参数')
						return { success: false, error: '需要 path 参数' }
					}
					await persistDatabase(data.path)
					return { success: true }
				}
			},
		},
	},
}