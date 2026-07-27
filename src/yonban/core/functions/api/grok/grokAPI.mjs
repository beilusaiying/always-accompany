/**
 * Grok（逆向） — 逆向 grok.com 网页 API
 * API端点：https://grok.com/rest/app-chat/conversations/new（对话创建）、/responses（流式生成）
 * 认证：Cookie 轮换（sso=<token>，多 Cookie 池 + mutex 互斥锁 + think/非think 独立索引）
 * ⚠ 逆向 API：请求头模拟 Chrome 浏览器（sec-ch-ua/User-Agent/Referer 伪造），
 *   grok.com 接口变更将直接导致本模块失效；图片生成走 generateImage 端点（非标准 API）。
 *   本文件只提供 GrokAPI 类，由同目录 main.mjs 包装为 beilu AIsource_t 接口。
 */
// grokAPI.mjs — axios removed, using native fetch (2026-03-31 安全修复)

// SEC-F4（红方 round2，多用户）：server 部署下用户自配 grok 端点不可指内网。
import { assertSafeOutboundInServerMode } from '../../security/safe_fetch.mjs'
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { makeAbortError } from '../_shared/abort.mjs'

/**
 * 获取标准请求头。
 * @param {string} cookie - Cookie。
 * @returns {object} 标准请求头。
 */
const getStandardHeaders = cookie => {
	return {
		accept: '*/*',
		'accept-encoding': 'gzip, deflate',
		'accept-language': 'en-US,en;q=0.9',
		'content-type': 'application/json',
		cookie,
		dnt: '1',
		origin: 'https://grok.com',
		referer: 'https://grok.com/',
		'sec-ch-ua': '"Not(A:Brand";v="99", "Chromium";v="122", "Google Chrome";v="122"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'sec-fetch-dest': 'empty',
		'sec-fetch-mode': 'cors',
		'sec-fetch-site': 'same-origin',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
	}
}

const MIME_TYPE_EXTENSIONS = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg'
}

/**
 * 原生fetch POST请求（替代axios.post）
 * @param {string} url
 * @param {object} data
 * @param {object} headers
 * @returns {Promise<Response>}
 */
async function fetchPost(url, data, headers) {
	await assertSafeOutboundInServerMode(url) // SEC-F4：server 下拒内网目标
	// 连接/响应头超时：原 fetch 无超时，服务器接受连接却不回响应头时永挂。独立 controller 限 120s，
	// 拿到响应头即 clearTimeout（body 由调用方各自的流读取/非流读取超时接管）。
	const _ctrl = new AbortController()
	const _timer = setTimeout(() => _ctrl.abort(new Error('[grok] 等待响应头超时（120s 无响应）')), 120000)
	let response
	try {
		response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(data),
			signal: _ctrl.signal,
		})
	} finally {
		clearTimeout(_timer)
	}
	if (!response.ok) {
		const err = new Error(`HTTP ${response.status}`)
		err.response = { status: response.status }
		throw err
	}
	return response
}

/**
 * 带超时的 reader.read()：Promise.race 读取 + 120s 超时。
 * 超时或读取异常时自动 cancel reader 并抛出原始错误。
 * @param {ReadableStreamDefaultReader} reader - fetch body reader
 * @param {string} timeoutMsg - 超时 Error 的 message（各调用点不同）
 * @param {function|null} [onError] - catch 内额外的副作用（如 wbD 日志），在 cancel+rethrow 之前调用
 * @returns {Promise<ReadableStreamReadResult>} { done, value }
 */
async function readWithTimeout(reader, timeoutMsg, onError) {
	let _timer
	let result
	try {
		result = await Promise.race([
			reader.read(),
			new Promise((_, rej) => { _timer = setTimeout(() => rej(new Error(timeoutMsg)), 120000) }),
		])
	} catch (e) {
		if (onError) onError(e)
		try { await reader.cancel() } catch {}
		throw e
	} finally {
		clearTimeout(_timer)
	}
	return result
}

/**
 * GrokAPI 类，用于与 Grok API 进行交互。
 */
export class GrokAPI {
	/**
	 * 创建 GrokAPI 的实例。
	 * @param {object} config - 配置对象。
	 */
	constructor(config) {
		this.config = config
		this.cookies = config.cookies || []
		this.currentCookieIndex = 0
		this.lastSuccessfulCookieIndex = 0
		this.currentThinkCookieIndex = 0
		this.lastSuccessfulThinkCookieIndex = 0
		this.mutex = new Map()
		this.tokenCounts = {}
	}

	async acquireLock() {
		const _deadline = Date.now() + 5000 // 5s 上限：持锁者异常未释放时强夺，防整进程死等挂起
		while (this.mutex.get('cookie')) {
			if (Date.now() > _deadline) break
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		this.mutex.set('cookie', true)
	}

	releaseLock() {
		this.mutex.delete('cookie')
	}

	async getNextCookie(useLastSuccessful = true, isThinkModel = false) {
		if (!this.cookies.length) return ''
		try {
			await this.acquireLock()
			let selectedIndex
			if (this.cookies.length === 1)
				selectedIndex = 0
			else
				if (useLastSuccessful)
					selectedIndex = isThinkModel ? this.lastSuccessfulThinkCookieIndex : this.lastSuccessfulCookieIndex
				else {
					const currentIndex = isThinkModel ? this.currentThinkCookieIndex : this.currentCookieIndex
					selectedIndex = currentIndex % this.cookies.length
					if (isThinkModel)
						this.currentThinkCookieIndex = selectedIndex
					else
						this.currentCookieIndex = selectedIndex
				}
			return `sso=${this.cookies[selectedIndex]}`
		}
		finally {
			this.releaseLock()
		}
	}

	/**
	 * 检查配额。
	 */
	async checkQuota(cookie, isThinkModel = false) {
		try {
			const headers = getStandardHeaders(`sso=${cookie}`)
			const response = await fetchPost(
				'https://grok.com/rest/rate-limits',
				{
					requestKind: isThinkModel ? 'REASONING' : 'DEFAULT',
					modelName: 'grok-3' // grok.com/rest/rate-limits 协议固定值（查 grok-3 家族额度），非用户模型名，保留
				},
				headers
			)
			return await response.json()
		}
		catch (error) {
			console.error(`Failed to check quota for cookie: ${error.message}`)
			return null
		}
	}

	async checkCurrentCookieQuota(cookie, isThinkModel = false) {
		if (cookie) try {
			const cookieValue = cookie.replace('sso=', '')
			const quota = await this.checkQuota(cookieValue, isThinkModel)
			if (quota) {
				const cookieIndex = isThinkModel ? this.currentThinkCookieIndex : this.currentCookieIndex
				const modelType = isThinkModel ? 'Think' : 'Default'
				console.debug(`[${new Date().toISOString()}] ${modelType} Cookie #${cookieIndex + 1} 剩余额度: ${quota.remainingQueries}`)
				if (quota.remainingQueries <= 0) {
					if (isThinkModel)
						this.currentThinkCookieIndex++
					else
						this.currentCookieIndex++
					console.debug(`[${new Date().toISOString()}] ${modelType} Cookie #${cookieIndex + 1} 额度已用尽，下次请求将切换到 Cookie #${(isThinkModel ? this.currentThinkCookieIndex : this.currentCookieIndex) % this.cookies.length + 1}`)
				}
			}
		} catch (error) {
			console.error(`[${new Date().toISOString()}] 检查额度时出错:`, error)
		}
	}

	/**
	 * 将文件上传到 Grok。
	 */
	async uploadFileToGrok(base64Content, fileName, mimeType, cookie) {
		const _doUpload = async () => {
			const headers = getStandardHeaders(cookie)
			const payload = {
				fileName,
				fileMimeType: mimeType,
				content: base64Content
			}
			const response = await fetchPost(
				'https://grok.com/rest/app-chat/upload-file',
				payload,
				headers
			)
			const data = await response.json()
			return data.fileMetadataId
		}
		try {
			return await _doUpload()
		}
		catch (error) {
			// [0716 网络波动容错·凛倾拍板] 上传瞬态失败重试一次（原单发即抛）
			console.warn(`File upload failed, retrying once (${fileName}):`, error?.message || error)
			await new Promise(r => setTimeout(r, 1000))
			try {
				return await _doUpload()
			}
			catch (error2) {
				console.error('File upload error:', error2)
				throw error2
			}
		}
	}

	/**
	 * 从消息中提取文件。
	 */
	async extractFilesFromMessage(message, cookie) {
		const fileIds = []
		let { content } = message
		if (!Array.isArray(content))
			content = [{ type: 'text', text: content }]

		for (const item of content)
			if (item.type === 'image_url') {
				let base64Content = ''
				let mimeType = ''
				let fileName = ''
				const imageUrl = Object(item.image_url) instanceof String
					? item.image_url
					: item.image_url?.url

				if (imageUrl?.startsWith('data:')) {
					const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
					if (matches) {
						mimeType = matches[1]
						base64Content = matches[2]
						const extension = MIME_TYPE_EXTENSIONS[mimeType] || 'jpg'
						fileName = `image_${Date.now()}.${extension}`
						try {
							const fileId = await this.uploadFileToGrok(base64Content, fileName, mimeType, cookie)
							fileIds.push({ id: fileId, fileName })
						}
						catch (error) {
							console.error(`Failed to upload image ${fileName}:`, error)
						}
					}
				}
			}
		return fileIds
	}

	/**
	 * 将 OpenAI 请求转换为 Grok 格式。
	 */
	async convertToGrokFormat(openaiRequest) {
		let messageText = ''
		const allFileIds = []
		const cookie = await this.getNextCookie(true, false)

		for (const message of openaiRequest.messages)
			if (Array.isArray(message.content)) {
				const textContent = message.content
					.filter(content => content.type === 'text')
					.map(content => content.text)
					.join('\n')

				const hasImages = message.content.some(content =>
					content.type === 'image_url' && (
						(Object(content.image_url) instanceof String && content.image_url.startsWith('data:')) ||
						content.image_url?.url?.startsWith('data:')
					)
				)

				if (hasImages) {
					const fileResults = await this.extractFilesFromMessage(message, cookie)
					allFileIds.push(...fileResults.map(f => f.id))
					const imageNames = fileResults.map(f => f.fileName).join(', ')
					messageText += `${message.role}: ${textContent}\n[Attached images: ${imageNames}]\n`
				}
				else messageText += `${message.role}: ${textContent}\n`
			}
			else messageText += `${message.role}: ${message.content}\n`

		const isThinkModel = openaiRequest.model === 'grok-3-think'
		const isSearchModel = openaiRequest.model === 'grok-3-search'
		// T12：payload.modelName 消费 config.model。think/search 是同底层模型的模式别名，其 modelName 仍须为
		// grok.com 协议要求的 'grok-3'（think/search 靠 isReasoning/disableSearch 区分）；其余情况透传传入 model，
		// 使自部署/镜像可用别的模型名（渠道限制禁按名字强加）。缺省仍回退 grok-3。
		const _payloadModelName = (isThinkModel || isSearchModel) ? 'grok-3' : (openaiRequest.model || 'grok-3')
		const disableSearch = !isSearchModel
		const toolOverrides = isSearchModel ? {} : {
			imageGen: false,
			webSearch: false,
			xSearch: false,
			xMediaSearch: false,
			trendsSearch: false,
			xPostAnalyze: false
		}

		return {
			temporary: true,
			modelName: _payloadModelName,
			message: messageText.trim(),
			fileAttachments: allFileIds,
			imageAttachments: [],
			disableSearch,
			enableImageGeneration: true,
			returnImageBytes: false,
			returnRawGrokInXaiRequest: false,
			enableImageStreaming: !!openaiRequest.stream,
			imageGenerationCount: 2,
			forceConcise: false,
			toolOverrides,
			enableSideBySide: true,
			isPreset: false,
			sendFinalMetadata: true,
			customInstructions: '',
			deepsearchPreset: '',
			isReasoning: isThinkModel,
		}
	}

	/**
	 * 发出 Grok 请求（原生fetch流式）。
	 * @returns {Promise<Response>} fetch Response对象。
	 */
	async makeGrokRequest(grokPayload, isStream, startIndex = 0, isThinkModel = false) {
		if (isThinkModel)
			this.currentThinkCookieIndex = startIndex
		else
			this.currentCookieIndex = startIndex

		wbT(null, 'ai:grok', 'api:request:start', { isStream, startIndex, isThinkModel, cookies: this.cookies.length })
		for (let i = 0; i < this.cookies.length; i++) try {
			const cookie = await this.getNextCookie(false, isThinkModel)
			const headers = getStandardHeaders(cookie)
			wbT(null, 'ai:grok', 'api:request:send', { attempt: i + 1, cookieIdx: i })
			const response = await fetchPost(
				'https://grok.com/rest/app-chat/conversations/new',
				grokPayload,
				headers
			)
			wbT(null, 'ai:grok', 'api:request:ok', { attempt: i + 1, status: response?.status })
			const currentCookie = cookie.replace('sso=', '')
			const index = this.cookies.findIndex(c => c === currentCookie)
			if (isThinkModel)
				this.lastSuccessfulThinkCookieIndex = index
			else
				this.lastSuccessfulCookieIndex = index

			return response
		} catch (error) {
			const isLastCookie = i === this.cookies.length - 1
			const _st = error?.response?.status
			wbD(null, 'ai:grok', 'api:request:error', false, `Grok 请求失败 status=${_st ?? 'n/a'}`, { attempt: i + 1, status: _st ?? null, isLastCookie, name: error?.name, msg: error?.message })
			if (error.response && [429, 401, 403].includes(error.response.status)) {
				console.log(`Cookie ${i + 1} 失败，状态码: ${error.response.status}`)
				if (isLastCookie) {
					console.log('已到达最后一个Cookie，重新从第1个开始尝试')
					if (isThinkModel)
						this.currentThinkCookieIndex = 0
					else
						this.currentCookieIndex = 0
					continue
				}
				if (isThinkModel)
					this.currentThinkCookieIndex++
				else
					this.currentCookieIndex++
				continue
			}
			throw error
		}

		wbD(null, 'ai:grok', 'api:request:allFailed', false, '所有 cookie 已尝试且全部失败', { cookies: this.cookies.length })
		throw new Error('All cookies have been tried and failed')
	}

	/**
	 * 调用 API。
	 */
	async call(messages, model, stream = false, onDelta = null, signal = null) {
		const isThinkModel = model === 'grok-3-think'
		wbT(null, 'ai:grok', 'api:call:enter', { model, stream, isThinkModel, msgCount: messages?.length ?? 0, cookies: this.cookies?.length ?? 0 })
		wbD(null, 'ai:grok', 'api:call:noCookie', (this.cookies?.length ?? 0) > 0, 'Grok cookies 为空，请求将失败', null)
		const openaiRequest = { messages, model, stream }
		const grokPayload = await this.convertToGrokFormat(openaiRequest)
		wbT(null, 'ai:grok', 'api:call:payloadBuilt', { msgTextLen: grokPayload?.message?.length ?? 0, files: grokPayload?.fileAttachments?.length ?? 0, isReasoning: grokPayload?.isReasoning })
		const response = await this.makeGrokRequest(grokPayload, stream, 0, isThinkModel)
		if (stream)
			return this.processStream(response, model, onDelta, signal)
		else
			return this.handleNonStreamResponse(response, isThinkModel)
	}

	/**
	 * 处理流式响应（原生fetch ReadableStream）。
	 */
	async processStream(response, model, onDelta, signal) {
		const isThinkModel = model === 'grok-3-think'
		wbT(null, 'ai:grok', 'api:stream:start', { model, isThinkModel })
		wbD(null, 'ai:grok', 'api:stream:noBody', !!response?.body, 'Grok 流式响应无 body', null)
		const reader = response.body.getReader()
		const decoder = new TextDecoder()

		let buffer = ''
		let fullContent = ''
		let thinkingBlockActive = false
		let _wbChunks = 0
		let _wbReadCount = 0

		try {
			while (true) {
				if (signal?.aborted) {
					wbD(null, 'ai:grok', 'api:stream:aborted', false, 'Grok 流被用户中止', { chunks: _wbChunks })
					reader.cancel()
					throw makeAbortError()
				}

				// §三-#1：流读超时。半死上游(头正常 body 永挂)
				//   会让 reader.read() 永挂 → generation for-await 永挂 → 该 chat 生成锁 .finally 不触发 → 锁/socket 泄漏。
				const { done, value } = await readWithTimeout(reader, 'grok stream read timeout', (e) => {
					wbD(null, 'ai:grok', 'api:stream:readError', false, `Grok 流式读取失败/超时: ${e?.message}`, { name: e?.name, chunks: _wbChunks })
				})
				if (done) break
				_wbReadCount++

				buffer += decoder.decode(value, { stream: true })

				while (true) {
					const newlineIndex = buffer.indexOf('\n')
					if (newlineIndex === -1) break
					const line = buffer.slice(0, newlineIndex)
					buffer = buffer.slice(newlineIndex + 1)
					if (!line.trim()) continue

					try {
						if (line.startsWith('{"result":')) {
							const data = JSON.parse(line)
							if (data.result?.response?.token !== undefined) {
								const { token, isThinking } = data.result.response
								let delta = ''
								if (isThinkModel) {
									if (isThinking && !thinkingBlockActive) {
										thinkingBlockActive = true
										delta += '\n<think>\n'
									}
									if (!isThinking && thinkingBlockActive) {
										delta += '\n</think>\n'
										thinkingBlockActive = false
									}
								}
								if (token === '' && data.result.response.isSoftStop) continue
								delta += token
								if (delta) {
									_wbChunks++
									fullContent += delta
									if (onDelta) onDelta(delta)
								}
							}
							if (data.result?.response?.finalMetadata)
								if (isThinkModel && thinkingBlockActive) {
									const delta = '\n</think>\n'
									fullContent += delta
									if (onDelta) onDelta(delta)
									thinkingBlockActive = false
								}
						}
					} catch (e) {
						console.warn('Incomplete or invalid JSON, skipping chunk', e)
					}
				}
			}
		} finally {
			if (thinkingBlockActive) {
				const delta = '\n</think>\n'
				fullContent += delta
				if (onDelta) onDelta(delta)
			}
			const cookie = await this.getNextCookie(true, isThinkModel)
			await this.checkCurrentCookieQuota(cookie, isThinkModel)
		}

		wbT(null, 'ai:grok', 'api:stream:end', { chunks: _wbChunks, reads: _wbReadCount, contentLen: fullContent.length })
		wbD(null, 'ai:grok', 'api:stream:empty', fullContent.length > 0, 'Grok 流式返回空内容', { chunks: _wbChunks })
		return fullContent
	}

	/**
	 * 处理非流式响应（原生fetch ReadableStream）。
	 */
	async handleNonStreamResponse(response, isThinkModel) {
		wbT(null, 'ai:grok', 'api:nonstream:start', { isThinkModel })
		wbD(null, 'ai:grok', 'api:nonstream:noBody', !!response?.body, 'Grok 非流式响应无 body', null)
		let fullResponse = ''
		let buffer = ''
		const reader = response.body.getReader()
		const decoder = new TextDecoder()

		while (true) {
			const { done, value } = await readWithTimeout(reader, 'grok non-stream read timeout', (e) => {
				wbD(null, 'ai:grok', 'api:nonstream:readError', false, `Grok 非流式读取失败/超时: ${e?.message}`, { name: e?.name })
			})
			if (done) break

			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() || ''

			for (const line of lines) if (line.trim()) try {
				if (line.startsWith('{"result":')) {
					const data = JSON.parse(line)
					if (data.result?.response?.modelResponse?.message)
						fullResponse = data.result.response.modelResponse.message
				}
			} catch {
				console.warn('Failed to parse line in non-stream mode')
			}
		}

		if (buffer.trim()) try {
			const data = JSON.parse(buffer)
			if (data.result?.response?.modelResponse?.message)
				fullResponse = data.result.response.modelResponse.message
		} catch {
			console.warn('Failed to parse final buffer in non-stream mode')
		}

		if (isThinkModel)
			fullResponse = '\n<think>\n' + fullResponse + '\n</think>\n'

		wbT(null, 'ai:grok', 'api:nonstream:end', { contentLen: fullResponse.length })
		wbD(null, 'ai:grok', 'api:nonstream:empty', fullResponse.length > 0, 'Grok 非流式返回空内容', null)
		const cookie = await this.getNextCookie(true, isThinkModel)
		await this.checkCurrentCookieQuota(cookie, isThinkModel)
		return fullResponse
	}

	/**
	 * 生成图像。
	 */
	async generateImage(prompt, n = 1) {
		const grokPayload = {
			temporary: true,
			modelName: 'grok-3',
			message: `Please generate the image: ${prompt}`,
			fileAttachments: [],
			imageAttachments: [],
			disableSearch: false,
			enableImageGeneration: true,
			returnImageBytes: false,
			returnRawGrokInXaiRequest: false,
			enableImageStreaming: true,
			imageGenerationCount: n,
			forceConcise: false,
			toolOverrides: {},
			enableSideBySide: true,
			isPreset: false,
			sendFinalMetadata: true,
			customInstructions: '',
			deepsearchPreset: '',
			isReasoning: false
		}

		const response = await this.makeGrokRequest(grokPayload, true, 0)
		const reader = response.body.getReader()
		const decoder = new TextDecoder()

		let generatedImages = []
		let buffer = ''

		while (true) {
			// §三-#1：图像流读超时，防半死上游永挂。
			const { done, value } = await readWithTimeout(reader, 'grok image read timeout')
			if (done) break

			buffer += decoder.decode(value, { stream: true })
			while (true) {
				const newlineIndex = buffer.indexOf('\n')
				if (newlineIndex === -1) break
				const line = buffer.slice(0, newlineIndex)
				buffer = buffer.slice(newlineIndex + 1)
				if (line.trim()) try {
					if (line.startsWith('{"result":')) {
						const data = JSON.parse(line)
						if (data.result?.response?.modelResponse?.generatedImageUrls)
							generatedImages = data.result.response.modelResponse.generatedImageUrls.map(url => ({
								url: `https://assets.grok.com/${url}`,
								revised_prompt: prompt
							}))
					}
				} catch (e) {
					console.warn('Failed to parse JSON:', e)
				}
			}
		}

		const cookie = await this.getNextCookie()
		await this.checkCurrentCookieQuota(cookie)
		return generatedImages
	}

	/**
	 * 计算令牌数（粗略估算）。
	 */
	countTokens(text) {
		const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length
		const englishWordCount = (text.match(/[A-Za-z]+/g) || []).length
		const numberCount = (text.match(/\d+/g) || []).length
		const otherCharCount = (text.match(/[^\d\sA-Za-z\u4e00-\u9fa5]/g) || []).length
		const estimatedTokens = chineseCharCount * 2 + englishWordCount * 1.5 + numberCount * 1 + otherCharCount * 1
		return Math.ceil(estimatedTokens)
	}
}
