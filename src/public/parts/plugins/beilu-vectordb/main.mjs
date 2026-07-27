import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { count, create, insert, remove, search } from 'npm:@orama/orama'
import { persist, restore } from 'npm:@orama/plugin-data-persistence'

import { createDiag } from '../../../../server/diagLogger.mjs'
import info from './info.json' with { type: 'json' }
import { wbT, wbD } from "../../../../server/wbStub.mjs";

const diag = createDiag('vectordb')

// ============================================================
// beilu-vectordb 插件 — Orama 语义搜索
//
// 职责：
// - 使用 Orama 构建记忆文件的向量索引
// - 支持全文搜索、向量语义搜索、混合搜索
// - Embedding 通过可配置的 OpenAI 兼容 API 获取
// - 消费方：yonban memory/tools/vectorBridge.mjs（saveJsonFile 双写增量索引 +
//   <memorySearch> 关键词零结果 fallback + AI P1 前置向量初筛）
//
// 【架构约束 · 盘为真相（2026-07-22 接入 P1 时重构）】
// AI 回合跑在组 worker isolate（yonban transport/isolateBridge.mjs），本模块的
// 内存单例在主进程与各 worker 间物理隔离——因此一切跨 isolate 状态以磁盘为权威：
// - 配置：data/plugins/beilu-vectordb/config.json，各 isolate 按 mtime 失效重读；
//   前端面板 updateConfig（主进程 REST）写盘后，worker 侧下次动作即读到。
// - 索引：按 memDir（data/users/<u>/chars/<c>/memory/）分区，一区一个 Orama 实例，
//   持久化在 <memDir>/_vector/index.json（"_"前缀目录，rebuild 遍历天然跳过）。
//   load 按盘 mtime 失效重载；并发写 last-writer-wins（与 saveJsonFile
//   "跨进程并发写由 tmp+rename 原子性兜底"同口径），JSON 记忆文件是数据源头，
//   索引可随时重建（凛倾拍板：向量DB是索引层，不替代JSON双写）。
// - 多用户/多角色隔离：搜索/索引/重建动作必须带 memDir——无全局索引，杜绝跨账号
//   记忆互串（原单全局 db 是单用户时代设计）。
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// 插件位于 <root>/src/public/parts/plugins/beilu-vectordb → 上 5 级 = 项目根
const PROJECT_ROOT = resolve(__dirname, '../../../../..')
const CONFIG_DIR = join(PROJECT_ROOT, 'data', 'plugins', 'beilu-vectordb')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

// ============================================================
// 配置（内存镜像；权威在 CONFIG_FILE，mtime 失效重读）
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

let _configMtime = -1 // -1=从未读过盘（与"文件不存在"的 0 区分开）

/** 从盘同步配置（mtime 未变则跳过）。文件不存在=保持代码默认（disabled），合法路径。 */
function loadConfigFromDisk() {
	let mt = 0
	try { mt = Deno.statSync(CONFIG_FILE).mtime?.getTime() || 0 } catch { /* 无配置文件 */ }
	if (mt === _configMtime) return
	_configMtime = mt
	if (mt === 0) return
	try {
		const j = JSON.parse(Deno.readTextFileSync(CONFIG_FILE))
		if (j && typeof j === 'object') Object.assign(vectorConfig, j)
		diag.debug('配置已从盘重载 (mtime:', mt, ')')
	} catch (e) {
		diag.warn('配置文件读取失败（保持当前内存值）:', e.message)
	}
}

function saveConfigToDisk() {
	try {
		Deno.mkdirSync(CONFIG_DIR, { recursive: true })
		Deno.writeTextFileSync(CONFIG_FILE, JSON.stringify(vectorConfig, null, 2))
		try { _configMtime = Deno.statSync(CONFIG_FILE).mtime?.getTime() || 0 } catch { /* stat 失败下次重读 */ }
	} catch (e) {
		diag.error('配置落盘失败（本 isolate 内仍生效，跨 isolate 不可见）:', e.message)
	}
}

// ============================================================
// per-memDir 索引 store
// ============================================================

/**
 * memDirKey → store
 * store = { db, dims, stats:{documentCount,lastIndexTime,indexErrors[]},
 *           fileDocIds: Map<relFile, id[]>（增量重索引时按文件删旧 chunk，不猜 Orama 过滤语义）,
 *           loadedMtime（盘上 index.json 装载时的 mtime）, persistTimer, dirty }
 */
const _stores = new Map()
const PERSIST_DEBOUNCE_MS = 3000
const INDEX_WRAPPER_VERSION = 1

function _memDirKey(memDir) { return String(memDir || '').replace(/\\/g, '/').replace(/\/+$/, '') }
function _indexFileOf(memDir) { return join(memDir, '_vector', 'index.json') }

async function _createEmptyDb(dims) {
	return await create({
		schema: {
			content: 'string',          // 文本内容
			file: 'string',             // 源文件相对路径（相对 memDir）
			layer: 'string',            // 记忆层级：hot/warm/cold/table/root
			chunkIndex: 'number',        // 分块索引
			timestamp: 'number',         // 时间戳
			embedding: `vector[${dims}]`,
		},
	})
}

function _emptyStore(dims) {
	return {
		db: null, dims,
		stats: { documentCount: 0, lastIndexTime: null, indexErrors: [] },
		fileDocIds: new Map(),
		loadedMtime: 0, persistTimer: null, dirty: false,
	}
}

/** 读盘上 index.json 的 mtime（无文件=0） */
function _indexFileMtime(memDir) {
	try { return Deno.statSync(_indexFileOf(memDir)).mtime?.getTime() || 0 } catch { return 0 }
}

/**
 * 取得（必要时装载/新建）memDir 对应的 store。
 * 跨 isolate 一致性：盘上 index.json mtime 比 store.loadedMtime 新 → 弃内存重载
 * （别的 isolate 已写过更新的索引）；本 store 有未落盘增量(dirty)时不弃——先落自己的。
 */
async function _getStore(memDir) {
	loadConfigFromDisk()
	const key = _memDirKey(memDir)
	let store = _stores.get(key)
	const diskMtime = _indexFileMtime(memDir)
	if (store && !store.dirty && diskMtime > store.loadedMtime) {
		diag.debug('盘上索引更新(别的 isolate 写过)，重载:', key)
		store = null
	}
	if (store) return store

	store = _emptyStore(vectorConfig.embeddingDimensions)
	// 尝试从持久化恢复
	if (diskMtime > 0) {
		try {
			const wrapper = JSON.parse(await Deno.readTextFile(_indexFileOf(memDir)))
			if (wrapper?.dims === vectorConfig.embeddingDimensions && wrapper?.model === vectorConfig.embeddingModel && wrapper?.orama) {
				store.db = await restore('json', wrapper.orama)
				store.fileDocIds = new Map(Object.entries(wrapper.fileDocIds || {}))
				store.stats.documentCount = await count(store.db)
				store.stats.lastIndexTime = wrapper.savedAt || null
				store.loadedMtime = diskMtime
				wbT(null, 'vectordb:index', 'store_restored', { memDir: key, documentCount: store.stats.documentCount })
				diag.log('索引已从盘恢复:', key, '| 文档数:', store.stats.documentCount)
			} else {
				// 维度/模型与当前配置不符：旧向量不可比，弃档空建（JSON 记忆是源头，可 rebuild）
				wbD(null, 'vectordb:index', 'store_discardStale', false, '持久化索引维度/模型不匹配，弃档', { memDir: key, fileDims: wrapper?.dims, cfgDims: vectorConfig.embeddingDimensions })
				diag.warn('持久化索引维度/模型不匹配，弃档空建:', key)
			}
		} catch (e) {
			diag.warn('索引恢复失败，空建:', key, e.message)
		}
	}
	if (!store.db) {
		store.db = await _createEmptyDb(store.dims)
		wbT(null, 'vectordb:index', 'store_created', { memDir: key, dims: store.dims })
	}
	_stores.set(key, store)
	return store
}

async function _persistStore(memDir, store) {
	try {
		const data = await persist(store.db, 'json')
		const wrapper = {
			v: INDEX_WRAPPER_VERSION,
			dims: store.dims,
			model: vectorConfig.embeddingModel,
			savedAt: Date.now(),
			fileDocIds: Object.fromEntries(store.fileDocIds),
			orama: data,
		}
		Deno.mkdirSync(join(memDir, '_vector'), { recursive: true })
		const target = _indexFileOf(memDir)
		const tmp = target + '.tmp'
		await Deno.writeTextFile(tmp, JSON.stringify(wrapper))
		await Deno.rename(tmp, target) // 原子替换，读侧不见半文件
		store.loadedMtime = _indexFileMtime(memDir)
		store.dirty = false
		diag.log('索引已持久化:', _memDirKey(memDir), '| 大小:', Math.round(String(data).length / 1024), 'KB')
	} catch (err) {
		diag.error('索引持久化失败:', err.message)
	}
}

function _schedulePersist(memDir, store) {
	store.dirty = true
	if (store.persistTimer) clearTimeout(store.persistTimer)
	store.persistTimer = setTimeout(() => {
		store.persistTimer = null
		_persistStore(memDir, store)
	}, PERSIST_DEBOUNCE_MS)
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
	wbT(null, 'vectordb:embed', 'getEmbedding_enter', { textLen: text?.length || 0, model: vectorConfig.embeddingModel })
	if (!vectorConfig.embeddingApiUrl) {
		wbD(null, 'vectordb:embed', 'getEmbedding_noUrl', false, 'embedding API URL 未配置', null)
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
			wbD(null, 'vectordb:embed', 'getEmbedding_httpError', false, `HTTP ${response.status}`, { status: response.status })
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
			wbD(null, 'vectordb:embed', 'getEmbedding_dimCheck', dims === vectorConfig.embeddingDimensions, '维度不匹配', { expected: vectorConfig.embeddingDimensions, actual: dims })
			if (dims !== vectorConfig.embeddingDimensions) {
				diag.warn('embedding 维度不匹配! 配置:', vectorConfig.embeddingDimensions,
					', 实际:', dims, '— 可能导致索引错误')
			}
			wbT(null, 'vectordb:embed', 'getEmbedding_ok', { dims })
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
		wbD(null, 'vectordb:embed', 'getEmbedding_fail', false, err.message, null)
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
 * 索引单个文档（文件内容）。同文件重复索引=先删旧 chunk 再插（fileDocIds 精确定位，
 * 记忆文件被反复追加/编辑是常态，不删旧会无限堆重复块）。
 * @param {string} memDir - 记忆目录（索引分区键）
 * @param {string} filePath - 文件相对路径（相对 memDir）
 * @param {string} content - 文件内容
 * @param {string} layer - 记忆层级
 * @param {number} [timestamp] - 时间戳
 */
async function indexDocument(memDir, filePath, content, layer = 'unknown', timestamp = Date.now()) {
	wbT(null, 'vectordb:index', 'indexDocument_enter', { memDir: _memDirKey(memDir), file: filePath, contentLen: content?.length || 0, layer })
	const store = await _getStore(memDir)

	diag.time(`indexDocument:${filePath}`)
	try {
		// 删同文件旧 chunk
		const oldIds = store.fileDocIds.get(filePath) || []
		for (const id of oldIds) {
			try { await remove(store.db, id) } catch { /* 已不存在 */ }
		}
		store.fileDocIds.delete(filePath)

		const chunks = splitIntoChunks(content, vectorConfig.maxChunkSize, vectorConfig.chunkOverlap)
		diag.debug('indexDocument:', filePath, `| 内容长度: ${content.length}`,
			`| 分块数: ${chunks.length}`, `| 层级: ${layer}`)

		const embeddings = await getEmbeddings(chunks)

		let indexed = 0
		let embeddingFailed = 0
		const newIds = []
		for (let i = 0; i < chunks.length; i++) {
			const embedding = embeddings[i]
			if (!embedding) {
				embeddingFailed++
				store.stats.indexErrors.push(`${filePath} chunk ${i}: embedding 获取失败`)
				continue
			}

			const id = await insert(store.db, {
				content: chunks[i],
				file: filePath,
				layer,
				chunkIndex: i,
				timestamp,
				embedding,
			})
			newIds.push(id)
			indexed++
		}
		if (newIds.length > 0) store.fileDocIds.set(filePath, newIds)

		store.stats.documentCount = await count(store.db)
		store.stats.lastIndexTime = Date.now()
		_schedulePersist(memDir, store)

		wbD(null, 'vectordb:index', 'indexDocument_embedFail', embeddingFailed === 0, `${embeddingFailed} chunk embedding 失败`, { file: filePath, embeddingFailed, total: chunks.length })
		wbT(null, 'vectordb:index', 'indexDocument_done', { file: filePath, indexed, total: chunks.length, documentCount: store.stats.documentCount })
		diag.log('索引完成:', filePath,
			`| ${indexed}/${chunks.length} chunks`,
			embeddingFailed > 0 ? `| ${embeddingFailed} 失败` : '',
			`| 分区文档数: ${store.stats.documentCount}`)
		diag.timeEnd(`indexDocument:${filePath}`)
		return { success: true, indexed, total: chunks.length }
	} catch (err) {
		wbD(null, 'vectordb:index', 'indexDocument_fail', false, err.message, { file: filePath, layer })
		diag.error('索引文档失败:', filePath, err.message)
		diag.snapshot('indexDocument-error', { filePath, layer, error: err.message })
		store.stats.indexErrors.push(`${filePath}: ${err.message}`)
		diag.timeEnd(`indexDocument:${filePath}`)
		return { success: false, error: err.message }
	}
}

/**
 * 语义搜索（限定 memDir 分区）
 * @param {string} memDir - 记忆目录（索引分区键）
 * @param {string} query - 搜索查询
 * @param {object} options - { topK, mode, layer }
 * @returns {Promise<object>}
 */
async function semanticSearch(memDir, query, options = {}) {
	wbT(null, 'vectordb:query', 'semanticSearch_enter', { memDir: _memDirKey(memDir), queryLen: query?.length || 0, mode: options?.mode || 'hybrid', layer: options?.layer || null })
	const store = await _getStore(memDir)
	if (store.stats.documentCount === 0) {
		// 空索引=诚实空结果（不静默触发全量重建烧 embedding 费；重建走显式 rebuildIndex）
		wbD(null, 'vectordb:query', 'semanticSearch_emptyIndex', false, '索引为空', { memDir: _memDirKey(memDir) })
		return { results: [], count: 0, query, mode: options?.mode || 'hybrid', note: '索引为空（增量双写会逐步填充，或显式触发 rebuildIndex）' }
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
				wbD(null, 'vectordb:query', 'semanticSearch_vecEmbedFail', false, '纯向量搜索 embedding 获取失败', { mode })
				diag.warn('纯向量搜索失败: embedding 获取失败')
				diag.timeEnd('semanticSearch')
				return { results: [], error: 'embedding 获取失败，无法执行纯向量搜索' }
			} else {
				wbD(null, 'vectordb:query', 'semanticSearch_hybridDowngrade', false, '混合搜索降级为全文', { mode })
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

		const searchResults = await search(store.db, searchParams)

		const results = searchResults.hits.map(hit => ({
			score: hit.score,
			content: hit.document.content,
			file: hit.document.file,
			layer: hit.document.layer,
			chunkIndex: hit.document.chunkIndex,
			timestamp: hit.document.timestamp,
		}))

		wbD(null, 'vectordb:query', 'semanticSearch_zeroHit', results.length > 0, '零命中', { query: query.substring(0, 80), mode: searchParams.mode, layer: layer || null })
		wbT(null, 'vectordb:query', 'semanticSearch_done', { hits: results.length, count: searchResults.count, mode: searchParams.mode, topScore: results.length > 0 ? results[0].score : null })
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
		wbD(null, 'vectordb:query', 'semanticSearch_fail', false, err.message, { mode })
		diag.error('搜索失败:', err.message)
		diag.snapshot('semanticSearch-error', { query, mode, error: err.message })
		diag.timeEnd('semanticSearch')
		return { results: [], error: err.message }
	}
}

/**
 * 重建 memDir 分区索引（遍历记忆目录）
 * @param {string} memDir - 记忆目录路径
 */
async function rebuildIndex(memDir) {
	wbT(null, 'vectordb:index', 'rebuildIndex_enter', { memDir })
	loadConfigFromDisk()
	if (!vectorConfig.enabled) {
		wbD(null, 'vectordb:index', 'rebuildIndex_disabled', false, '向量搜索未启用', null)
		diag.warn('rebuildIndex: 向量搜索未启用')
		return { success: false, error: '向量搜索未启用' }
	}

	diag.log('开始重建索引... memDir:', memDir)
	diag.time('rebuildIndex')

	// 重置本分区（不动其他用户/角色的分区）
	const store = _emptyStore(vectorConfig.embeddingDimensions)
	store.db = await _createEmptyDb(store.dims)
	_stores.set(_memDirKey(memDir), store)

	let totalFiles = 0
	let totalIndexed = 0

	async function walkDir(dir, layer) {
		try {
			for await (const entry of Deno.readDir(dir)) {
				const fullPath = dir.replace(/\\/g, '/') + '/' + entry.name

				if (entry.isDirectory) {
					if (entry.name.startsWith('_')) continue // 跳过索引目录（含 _vector 自身）
					// 自动识别层级
					let subLayer = layer
					if (entry.name === 'hot') subLayer = 'hot'
					else if (entry.name === 'warm') subLayer = 'warm'
					else if (entry.name === 'cold') subLayer = 'cold'
					await walkDir(fullPath, subLayer)
					continue
				}

				if (!entry.name.endsWith('.json')) continue
				if (entry.name.startsWith('_')) continue // _config.json 等机制文件不入索引

				try {
					const stat = await Deno.stat(fullPath)
					if (stat.size > 100 * 1024) continue // 跳过大文件

					const content = await Deno.readTextFile(fullPath)
					const relativePath = fullPath.replace(memDir.replace(/\\/g, '/'), '').replace(/^\//, '')

					totalFiles++
					const result = await indexDocument(memDir, relativePath, content, layer, stat.mtime?.getTime())
					if (result.success) totalIndexed += result.indexed
				} catch (e) { console.warn(`[vectordb] 跳过读取失败的文件（该文件不入索引，检索会漏）: ${fullPath}`, e?.message || e) /* T021 留痕 */ }
			}
		} catch { /* 跳过无法读取的目录 */ }
	}

	await walkDir(memDir, 'unknown')

	store.stats.documentCount = await count(store.db)
	store.stats.lastIndexTime = Date.now()
	if (store.persistTimer) { clearTimeout(store.persistTimer); store.persistTimer = null }
	await _persistStore(memDir, store) // 重建完立即落盘（不等去抖）

	diag.log('索引重建完成:',
		`| ${totalFiles} 文件`, `| ${totalIndexed} chunks`,
		`| 分区文档数: ${store.stats.documentCount}`,
		`| 错误数: ${store.stats.indexErrors.length}`)
	diag.timeEnd('rebuildIndex')
	wbD(null, 'vectordb:index', 'rebuildIndex_errors', store.stats.indexErrors.length === 0, `${store.stats.indexErrors.length} 个索引错误`, { errors: store.stats.indexErrors.length })
	wbT(null, 'vectordb:index', 'rebuildIndex_done', { totalFiles, totalIndexed, documentCount: store.stats.documentCount, errors: store.stats.indexErrors.length })
	if (store.stats.indexErrors.length > 0) {
		diag.warn('索引错误列表:', store.stats.indexErrors.slice(0, 5).join('; '))
	}
	return {
		success: true,
		totalFiles,
		totalChunks: totalIndexed,
		documentCount: store.stats.documentCount,
		errors: store.stats.indexErrors.length,
	}
}

// ============================================================
// 插件导出
// ============================================================

const pluginExport = {
	info,
	Load: async ({ router } = {}) => {
		// config REST 端点（范式=web/main.mjs Load）：此前零 HTTP 门=前端无配置入口（0722 差集审计确诊）
		if (router) {
			const { authenticate } = await import('../../../../yonban/core/functions/security/auth.mjs')
			router.get(/\/config\/getdata$/, authenticate, async (_req, res) => {
				try { res.json(await pluginExport.interfaces.config.GetData()) }
				catch (e) { res.status(500).json({ error: e.message }) }
			})
			router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
				try { res.json(await pluginExport.interfaces.config.SetData(req.body) ?? { success: true }) }
				catch (e) { res.status(500).json({ error: e.message }) }
			})
		}
		loadConfigFromDisk()
		diag.log('Load() — 语义搜索插件已加载')
		diag.debug('配置状态:', {
			enabled: vectorConfig.enabled,
			embeddingApiUrl: vectorConfig.embeddingApiUrl ? '已配置' : '未配置',
			embeddingModel: vectorConfig.embeddingModel,
			dimensions: vectorConfig.embeddingDimensions,
		})
		if (vectorConfig.enabled && !vectorConfig.embeddingApiUrl) {
			diag.warn('向量搜索已启用但 embedding API 未配置 — 请在设置中配置 embeddingApiUrl')
		}
		// 索引分区按 memDir 惰性装载（首次动作时 _getStore），Load 不做全量初始化
	},

	Unload: async () => {
		let total = 0
		for (const [memDir, store] of _stores) {
			total += store.stats.documentCount
			if (store.persistTimer) { clearTimeout(store.persistTimer); store.persistTimer = null }
			if (store.dirty) _persistStore(memDir, store) // 尽力落盘（async 不等）
		}
		diag.log('Unload() — 语义搜索插件已卸载', `| 分区数: ${_stores.size}`, `| 文档数: ${total}`)
		_stores.clear()
	},

	interfaces: {
		config: {
			/**
			 * 获取插件状态和统计
			 */
			GetData: async () => {
				loadConfigFromDisk()
				let totalDocs = 0
				for (const store of _stores.values()) totalDocs += store.stats.documentCount
				const recentErrors = []
				for (const store of _stores.values()) recentErrors.push(...store.stats.indexErrors.slice(-3))
				return {
					enabled: vectorConfig.enabled,
					indexReady: totalDocs > 0,
					embeddingApiUrl: vectorConfig.embeddingApiUrl ? '(已配置)' : '(未配置)',
					embeddingModel: vectorConfig.embeddingModel,
					embeddingDimensions: vectorConfig.embeddingDimensions,
					topK: vectorConfig.topK,
					// 控件元数据单源下发（0722 禁前端硬编码）：前端设置面纯渲染。
					// 脱敏键（url/key）type=password + skipEmpty：留空=不覆盖后端已有值。
					meta: [
						{ key: 'enabled', group: '基础设置', type: 'toggle', label: '启用语义搜索', desc: '开启后记忆检索可用向量语义搜索（需配置 embedding API）' },
						{ key: 'embeddingApiUrl', group: 'Embedding API', type: 'password', label: 'API 端点', desc: 'OpenAI 兼容 /v1/embeddings 端点；已配置时留空=保持现值', skipEmpty: true, placeholder: vectorConfig.embeddingApiUrl ? '已配置，留空保持' : '未配置' },
						{ key: 'embeddingApiKey', group: 'Embedding API', type: 'password', label: 'API Key', desc: '已配置时留空=保持现值', skipEmpty: true, placeholder: vectorConfig.embeddingApiKey ? '已配置，留空保持' : '未配置' },
						{ key: 'embeddingModel', group: 'Embedding API', type: 'text', label: '模型名', desc: 'embedding 模型标识' },
						{ key: 'embeddingDimensions', group: 'Embedding API', type: 'number', label: '向量维度', desc: '与模型输出维度一致，不匹配会索引错误', min: 64, max: 4096 },
						{ key: 'topK', group: '检索', type: 'number', label: '返回条数 (top-k)', desc: '语义搜索返回的最大结果数', min: 1, max: 50 },
					],
					setdataWrap: 'updateConfig',
					stats: {
						documentCount: totalDocs,
						storeCount: _stores.size,
						errorCount: recentErrors.length,
						recentErrors: recentErrors.slice(-5),
					},
					description: '语义搜索 — Orama 向量数据库，支持全文/语义/混合搜索（按用户/角色记忆目录分区）',
				}
			},

			/**
			 * 设置数据 / 操作入口
			 */
			SetData: async (data) => {
				if (!data) return

				diag.debug('SetData 收到操作:', data._action || '(无 _action)')

				// 更新配置（写盘=跨 isolate 生效的唯一路径）
				if (data._action === 'updateConfig') {
					loadConfigFromDisk() // 先合最新盘值，避免用旧内存镜像覆盖别的 isolate 的更新
					const oldEnabled = vectorConfig.enabled
					if (data.enabled !== undefined) vectorConfig.enabled = !!data.enabled
					if (data.embeddingApiUrl) vectorConfig.embeddingApiUrl = data.embeddingApiUrl
					if (data.embeddingApiKey !== undefined && data.embeddingApiKey !== '') vectorConfig.embeddingApiKey = data.embeddingApiKey
					if (data.embeddingModel) vectorConfig.embeddingModel = data.embeddingModel
					if (data.embeddingDimensions) vectorConfig.embeddingDimensions = Math.max(64, Math.min(4096, data.embeddingDimensions))
					if (data.topK) vectorConfig.topK = Math.max(1, Math.min(50, data.topK))
					saveConfigToDisk()

					diag.log('配置已更新并落盘',
						!oldEnabled && vectorConfig.enabled ? '| ⚡ 向量搜索已启用' : '',
						oldEnabled && !vectorConfig.enabled ? '| ❌ 向量搜索已禁用' : '')
					return { success: true, config: { ...vectorConfig, embeddingApiKey: '***' } }
				}

				// 索引单个文档
				if (data._action === 'indexDocument') {
					loadConfigFromDisk()
					if (!vectorConfig.enabled) {
						diag.warn('indexDocument: 向量搜索未启用')
						return { success: false, error: '向量搜索未启用' }
					}
					if (!diag.guard(data, ['memDir', 'file', 'content'], 'indexDocument')) {
						return { success: false, error: '缺少 memDir、file 或 content 参数' }
					}
					return await indexDocument(data.memDir, data.file, data.content, data.layer, data.timestamp)
				}

				// 语义搜索
				if (data._action === 'search') {
					loadConfigFromDisk()
					if (!vectorConfig.enabled) {
						diag.warn('search: 向量搜索未启用')
						return { results: [], error: '向量搜索未启用' }
					}
					if (!data.query || !data.memDir) {
						diag.warn('search: 缺少 query 或 memDir 参数')
						return { results: [], error: '缺少 query 或 memDir 参数' }
					}
					return await semanticSearch(data.memDir, data.query, {
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
					loadConfigFromDisk()
					const perStore = {}
					for (const [k, store] of _stores) {
						perStore[k] = { documentCount: store.stats.documentCount, lastIndexTime: store.stats.lastIndexTime }
					}
					return {
						enabled: vectorConfig.enabled,
						storeCount: _stores.size,
						stores: perStore,
					}
				}

				// 持久化（立即落指定分区，不等去抖）
				if (data._action === 'persist') {
					if (!data.memDir) {
						diag.warn('persist: 缺少 memDir 参数')
						return { success: false, error: '需要 memDir 参数' }
					}
					const store = _stores.get(_memDirKey(data.memDir))
					if (!store) return { success: false, error: '该分区未装载' }
					if (store.persistTimer) { clearTimeout(store.persistTimer); store.persistTimer = null }
					await _persistStore(data.memDir, store)
					return { success: true }
				}
			},
		},
	},
}
export default pluginExport
