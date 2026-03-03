import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDiag } from '../../../../server/diagLogger.mjs'
import info from './info.json' with { type: 'json' }

const diag = createDiag('graphrag')

// ============================================================
// beilu-graphrag 插件 — LightRAG 知识图谱
//
// 职责：
// - 管理 Python LightRAG 子进程
// - 提供知识图谱的构建、查询、增量更新接口
// - 通过 stdin/stdout JSON 协议与 Python worker 通信
// - 复用 beilu-eye 的 Python 子进程管理模式
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pythonWorkerScript = resolve(__dirname, 'graphrag_worker.py')

// Python 子进程状态
let workerProcess = null
let workerStatus = 'stopped' // 'stopped' | 'checking' | 'starting' | 'running' | 'error'
let workerError = null

// 请求队列（通过 stdin/stdout JSON-line 协议通信）
let requestId = 0
const pendingRequests = new Map() // id → { resolve, reject, timeout }

// 配置
let graphConfig = {
	enabled: false,
	workingDir: '',               // 图谱数据存储目录
	llmApiUrl: '',                // LLM API 地址（OpenAI 兼容）
	llmApiKey: '',                // LLM API Key
	llmModel: 'gpt-4o-mini',     // LLM 模型
	embeddingApiUrl: '',          // Embedding API 地址
	embeddingApiKey: '',          // Embedding API Key
	embeddingModel: 'text-embedding-ada-002',
}

// ============================================================
// Python 子进程管理（复用 beilu-eye 模式）
// ============================================================

/**
 * 检查 Python 及 LightRAG 依赖
 */
async function checkPythonDeps() {
	workerStatus = 'checking'
	diag.log('检查 Python 及 LightRAG 依赖...')
	diag.time('checkPythonDeps')
	try {
		const isWindows = Deno.build.os === 'windows'
		const pythonCmd = isWindows ? 'python' : 'python3'
		diag.debug('Python 命令:', pythonCmd, '| 系统:', Deno.build.os)

		const command = new Deno.Command(pythonCmd, {
			args: ['-c', 'import lightrag; print("OK")'],
			stdout: 'piped',
			stderr: 'piped',
		})
		const result = await command.output()
		const stdout = new TextDecoder().decode(result.stdout).trim()
		if (result.success && stdout === 'OK') {
			diag.log('Python 及 LightRAG 依赖检查通过')
			diag.timeEnd('checkPythonDeps')
			return true
		}

		// 依赖缺失，尝试自动安装
		const stderrCheck = new TextDecoder().decode(result.stderr).trim()
		diag.warn('LightRAG 依赖缺失，自动安装...', stderrCheck.substring(0, 200))
		const installCmd = new Deno.Command(pythonCmd, {
			args: ['-m', 'pip', 'install', 'lightrag-hku'],
			stdout: 'piped',
			stderr: 'piped',
		})
		const installResult = await installCmd.output()
		if (installResult.success) {
			diag.log('LightRAG pip install 成功')
			diag.timeEnd('checkPythonDeps')
			return true
		}

		const stderr = new TextDecoder().decode(installResult.stderr)
		diag.error('pip install lightrag-hku 失败:', stderr.substring(0, 500))
		diag.snapshot('pip-install-error', {
			pythonCmd,
			stderr: stderr.substring(0, 1000),
		})
		workerError = 'pip install lightrag-hku 失败'
		workerStatus = 'error'
		diag.timeEnd('checkPythonDeps')
		return false
	} catch (err) {
		diag.error('Python 检查失败:', err.message)
		diag.snapshot('python-check-error', {
			error: err.message,
			hint: 'Python 3.10+ 未安装或不在 PATH 中',
		})
		workerError = 'Python 不可用: ' + err.message
		workerStatus = 'error'
		diag.timeEnd('checkPythonDeps')
		return false
	}
}

/**
 * 启动 Python worker 子进程
 */
async function launchWorker() {
	if (workerProcess) {
		diag.debug('launchWorker: Worker 已存在, PID:', workerProcess.pid)
		return
	}

	workerStatus = 'starting'
	diag.log('启动 LightRAG worker...')

	try {
		// 检查 worker 脚本存在
		try {
			await Deno.stat(pythonWorkerScript)
			diag.debug('Worker 脚本存在:', pythonWorkerScript)
		} catch {
			diag.error('graphrag_worker.py 不存在:', pythonWorkerScript)
			workerError = 'graphrag_worker.py 不存在'
			workerStatus = 'error'
			return
		}

		const isWindows = Deno.build.os === 'windows'
		const pythonCmd = isWindows ? 'python' : 'python3'

		diag.debug('启动配置:', {
			pythonCmd,
			cwd: __dirname,
			workingDir: graphConfig.workingDir,
			llmApiUrl: graphConfig.llmApiUrl ? '已配置' : '未配置',
			llmModel: graphConfig.llmModel,
		})

		const command = new Deno.Command(pythonCmd, {
			args: [pythonWorkerScript],
			cwd: __dirname,
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
			env: {
				GRAPHRAG_WORKING_DIR: graphConfig.workingDir,
				GRAPHRAG_LLM_API_URL: graphConfig.llmApiUrl,
				GRAPHRAG_LLM_API_KEY: graphConfig.llmApiKey,
				GRAPHRAG_LLM_MODEL: graphConfig.llmModel,
				GRAPHRAG_EMBEDDING_API_URL: graphConfig.embeddingApiUrl || graphConfig.llmApiUrl,
				GRAPHRAG_EMBEDDING_API_KEY: graphConfig.embeddingApiKey || graphConfig.llmApiKey,
				GRAPHRAG_EMBEDDING_MODEL: graphConfig.embeddingModel,
			},
		})

		workerProcess = command.spawn()
		workerStatus = 'running'
		diag.log('LightRAG worker 已启动, PID:', workerProcess.pid)

		// 监听进程退出
		workerProcess.status.then(status => {
			diag.log('Worker 进程已退出, code:', status.code,
				status.code !== 0 ? '⚠️ 非正常退出' : '')
			if (status.code !== 0) {
				diag.snapshot('worker-exit', {
					code: status.code,
					pendingRequests: pendingRequests.size,
				})
			}
			workerProcess = null
			workerStatus = 'stopped'
			// 拒绝所有未完成的请求
			const pendingCount = pendingRequests.size
			for (const [id, req] of pendingRequests) {
				req.reject(new Error('Worker process exited'))
				clearTimeout(req.timeout)
			}
			pendingRequests.clear()
			if (pendingCount > 0) {
				diag.warn('Worker 退出时有', pendingCount, '个未完成请求被拒绝')
			}
		}).catch((err) => {
			diag.error('Worker 状态监听异常:', err.message)
			workerProcess = null
			workerStatus = 'stopped'
		})

		// 读取 stdout（JSON-line 响应）
		readWorkerOutput(workerProcess.stdout)
		// 读取 stderr（日志）
		pipeStderr(workerProcess.stderr)

	} catch (err) {
		diag.error('Worker 启动失败:', err.message)
		diag.snapshot('worker-launch-error', {
			error: err.message,
			workerScript: pythonWorkerScript,
		})
		workerError = err.message
		workerStatus = 'error'
		workerProcess = null
	}
}

/**
 * 读取 worker 的 stdout（JSON-line 协议）
 */
async function readWorkerOutput(stream) {
	try {
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() || ''

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					const response = JSON.parse(trimmed)
					const pending = pendingRequests.get(response.id)
					if (pending) {
						pendingRequests.delete(response.id)
						clearTimeout(pending.timeout)
						if (response.error) {
							diag.warn('Worker 返回错误, id:', response.id, 'error:', response.error)
							pending.reject(new Error(response.error))
						} else {
							diag.debug('Worker 返回成功, id:', response.id)
							pending.resolve(response.result)
						}
					} else {
						diag.debug('收到无匹配的 Worker 响应, id:', response.id)
					}
				} catch {
					diag.debug('[worker stdout]', trimmed.substring(0, 200))
				}
			}
		}
	} catch (err) {
		diag.debug('Worker stdout 读取结束:', err?.message || 'EOF')
	}
}

/**
 * 读取 worker 的 stderr（日志输出）
 */
async function pipeStderr(stream) {
	try {
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			const text = decoder.decode(value, { stream: true }).trim()
			if (text) {
				if (text.toLowerCase().includes('error') || text.toLowerCase().includes('traceback')) {
					diag.error('[worker stderr]', text.substring(0, 500))
				} else {
					diag.debug('[worker stderr]', text.substring(0, 300))
				}
			}
		}
	} catch (err) {
		diag.debug('Worker stderr 读取结束:', err?.message || 'EOF')
	}
}

/**
 * 向 worker 发送请求
 * @param {string} method - 方法名
 * @param {object} params - 参数
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<any>}
 */
function sendRequest(method, params = {}, timeoutMs = 120000) {
	if (!workerProcess || workerStatus !== 'running') {
		diag.warn('sendRequest: Worker 未运行, method:', method, ', status:', workerStatus)
		return Promise.reject(new Error('Worker 未运行'))
	}

	const id = ++requestId
	const request = JSON.stringify({ id, method, params }) + '\n'
	diag.log('发送请求:', `id=${id}`, `method=${method}`,
		`| timeout=${Math.floor(timeoutMs / 1000)}s`,
		`| 待处理请求数: ${pendingRequests.size}`)
	diag.time(`request:${id}:${method}`)

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(id)
			diag.error('请求超时:', `id=${id}`, `method=${method}`,
				`| 超时: ${Math.floor(timeoutMs / 1000)}s`)
			diag.snapshot('request-timeout', { id, method, timeoutMs })
			reject(new Error(`请求超时: ${method}`))
		}, timeoutMs)

		pendingRequests.set(id, {
			resolve: (result) => {
				diag.timeEnd(`request:${id}:${method}`)
				resolve(result)
			},
			reject: (err) => {
				diag.timeEnd(`request:${id}:${method}`)
				reject(err)
			},
			timeout,
		})

		const encoder = new TextEncoder()
		const writer = workerProcess.stdin.getWriter()
		writer.write(encoder.encode(request))
			.then(() => writer.releaseLock())
			.catch(err => {
				pendingRequests.delete(id)
				clearTimeout(timeout)
				diag.error('stdin 写入失败:', err.message)
				reject(err)
			})
	})
}

/**
 * 关闭 worker
 */
function killWorker() {
	if (workerProcess) {
		const pid = workerProcess.pid
		try {
			workerProcess.kill('SIGKILL')
		} catch (err) {
			diag.warn('kill Worker 失败:', err.message)
		}
		workerProcess = null
		workerStatus = 'stopped'
		diag.log('Worker 已终止, PID:', pid)
	} else {
		diag.debug('killWorker: 无运行中的 Worker')
	}
}

// ============================================================
// 插件导出
// ============================================================

export default {
	info,
	Load: async () => {
		diag.log('Load() — 知识图谱插件已加载')
		diag.debug('配置状态:', {
			enabled: graphConfig.enabled,
			workingDir: graphConfig.workingDir || '未配置',
			llmApiUrl: graphConfig.llmApiUrl ? '已配置' : '未配置',
			llmModel: graphConfig.llmModel,
			workerScript: pythonWorkerScript,
		})
	},

	Unload: async () => {
		killWorker()
		diag.log('Unload() — 知识图谱插件已卸载')
	},

	interfaces: {
		config: {
			/**
			 * 获取插件状态
			 */
			GetData: async () => ({
				enabled: graphConfig.enabled,
				workerStatus,
				workerError,
				workerPid: workerProcess?.pid || null,
				llmApiUrl: graphConfig.llmApiUrl ? '(已配置)' : '(未配置)',
				llmModel: graphConfig.llmModel,
				workingDir: graphConfig.workingDir || '(未配置)',
				description: '贝露的知识图谱 — LightRAG 增强检索，支持增量更新',
			}),

			/**
			 * 设置数据 / 操作入口
			 */
			SetData: async (data) => {
				if (!data) return

				diag.debug('SetData 收到操作:', data._action || '(无 _action)')

				// 更新配置
				if (data._action === 'updateConfig') {
					if (data.enabled !== undefined) graphConfig.enabled = !!data.enabled
					if (data.workingDir) graphConfig.workingDir = data.workingDir
					if (data.llmApiUrl) graphConfig.llmApiUrl = data.llmApiUrl
					if (data.llmApiKey !== undefined) graphConfig.llmApiKey = data.llmApiKey
					if (data.llmModel) graphConfig.llmModel = data.llmModel
					if (data.embeddingApiUrl) graphConfig.embeddingApiUrl = data.embeddingApiUrl
					if (data.embeddingApiKey !== undefined) graphConfig.embeddingApiKey = data.embeddingApiKey
					if (data.embeddingModel) graphConfig.embeddingModel = data.embeddingModel
					diag.log('配置已更新:', {
						enabled: graphConfig.enabled,
						workingDir: graphConfig.workingDir || '未配置',
						llmModel: graphConfig.llmModel,
					})
					return { success: true }
				}

				// 启动 worker
				if (data._action === 'start') {
					if (!graphConfig.enabled) {
						diag.warn('start: 知识图谱未启用')
						return { success: false, error: '知识图谱未启用' }
					}
					if (!graphConfig.workingDir) {
						diag.warn('start: 未配置 workingDir')
						return { success: false, error: '未配置 workingDir' }
					}
					if (!graphConfig.llmApiUrl) {
						diag.warn('start: 未配置 llmApiUrl')
						return { success: false, error: '未配置 llmApiUrl' }
					}

					diag.log('启动 Worker: 检查依赖...')
					const depsOk = await checkPythonDeps()
					if (!depsOk) {
						diag.error('依赖检查失败:', workerError)
						return { success: false, error: workerError }
					}

					await launchWorker()
					diag.log('启动结果:', workerStatus)
					return { success: workerStatus === 'running', status: workerStatus }
				}

				// 停止 worker
				if (data._action === 'stop') {
					killWorker()
					return { success: true }
				}

				// 插入文档（增量更新）
				if (data._action === 'insertDocument') {
					if (!data.content) {
						diag.warn('insertDocument: 缺少 content')
						return { success: false, error: '缺少 content 参数' }
					}
					try {
						diag.log('插入文档:', data.source || 'unknown',
							`| 内容长度: ${data.content.length}`)
						const result = await sendRequest('insert', {
							content: data.content,
							source: data.source || 'unknown',
						})
						return { success: true, result }
					} catch (err) {
						diag.error('insertDocument 失败:', err.message)
						return { success: false, error: err.message }
					}
				}

				// 查询
				if (data._action === 'query') {
					if (!data.question) {
						diag.warn('query: 缺少 question')
						return { success: false, error: '缺少 question 参数' }
					}
					try {
						diag.log('图谱查询:', data.question.substring(0, 50),
							`| mode=${data.mode || 'hybrid'}`)
						const result = await sendRequest('query', {
							question: data.question,
							mode: data.mode || 'hybrid',
						})
						diag.log('查询完成, 结果长度:', JSON.stringify(result).length)
						return { success: true, result }
					} catch (err) {
						diag.error('query 失败:', err.message)
						return { success: false, error: err.message }
					}
				}

				// 获取图谱统计
				if (data._action === 'getStats') {
					try {
						const result = await sendRequest('stats', {})
						return { success: true, result }
					} catch (err) {
						diag.error('getStats 失败:', err.message)
						return { success: false, error: err.message }
					}
				}

				// 批量导入记忆文件
				if (data._action === 'indexMemory') {
					if (!data.memDir) {
						diag.warn('indexMemory: 缺少 memDir')
						return { success: false, error: '需要 memDir 参数' }
					}
					try {
						diag.log('批量索引记忆:', data.memDir)
						const result = await sendRequest('index_memory', {
							memDir: data.memDir,
						}, 300000) // 5 分钟超时
						diag.log('批量索引完成')
						return { success: true, result }
					} catch (err) {
						diag.error('indexMemory 失败:', err.message)
						return { success: false, error: err.message }
					}
				}
			},
		},
	},
}