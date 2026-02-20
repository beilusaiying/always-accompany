import fs from 'node:fs'
import path from 'node:path'

import { escapeRegExp } from '../../../../../scripts/escape.mjs'
import { margeStructPromptChatLog, structPromptToSingleNoChatLog } from '../../../shells/chat/src/prompt_struct.mjs'

import info_dynamic from './info.dynamic.json' with { type: 'json' }
import info from './info.json' with { type: 'json' }
/** @typedef {import('../../../../../decl/AIsource.ts').AIsource_t} AIsource_t */
/** @typedef {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t */

/**
 * @type {import('../../../../../decl/AIsource.ts').AIsource_interfaces_and_AIsource_t_getter}
 */
export default {
	info,
	interfaces: {
		serviceGenerator: {
			/**
			 * 获取此 AI 源的配置显示内容。
			 * @returns {Promise<object>} 配置显示内容。
			 */
			GetConfigDisplayContent: async () => ({
				js: fs.readFileSync(path.join(import.meta.dirname, 'display.mjs'), 'utf-8')
			}),
			/**
			 * 获取此 AI 源的配置模板。
			 * @returns {Promise<object>} 配置模板。
			 */
			GetConfigTemplate: async () => configTemplate,
			GetSource,
		}
	}
}

const configTemplate = {
	name: 'openai-proxy',
	url: 'https://api.openai.com/v1/chat/completions',
	model: 'gpt-3.5-turbo',
	apikey: '',
	custom_headers: {},
	convert_config: {
		roleReminding: true,
		ignoreFiles: false,
	},
	use_stream: true,
}
/**
 * 获取 AI 源。
 * @param {object} config - 配置对象。
 * @param {object} root0 - 根对象。
 * @param {Function} root0.SaveConfig - 保存配置的函数。
 * @returns {Promise<AIsource_t>} AI 源。
 */
async function GetSource(config, { SaveConfig }) {
	config.use_stream ??= true
	/**
	 * 调用基础模型。
	 * @param {Array<object>} messages - 消息数组。
	 * @param {object} config - 配置对象。
	 * @param {object} options - 选项对象。
	 * @param {AbortSignal} options.signal - 用于中止请求的 AbortSignal。
	 * @param {(result: {content: string, files: any[]}) => void} options.previewUpdater - 处理部分结果的回调函数。
	 * @param {{content: string, files: any[]}} options.result - 包含内容和文件的结果对象。
	 * @returns {Promise<{content: string, files: any[]}>} 模型返回的内容。
	 */
	async function fetchChatCompletion(messages, config, {
		signal, previewUpdater, result
	}) {
		let imgIndex = 0
		const requestBody = JSON.stringify({
			model: config.model,
			messages,
			stream: config.use_stream,
			...config.model_arguments,
		})
		const requestBodySize = new TextEncoder().encode(requestBody).length
		console.log(`[proxy/fetchChatCompletion] 请求体大小: ${(requestBodySize / 1024 / 1024).toFixed(2)} MB (${requestBodySize} bytes), messages数: ${messages.length}, model: ${config.model}`)

		const response = await fetch(config.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: config.apikey ? 'Bearer ' + config.apikey : undefined,
				'HTTP-Referer': 'https://steve02081504.github.io/fount/',
				'X-Title': 'fount',
				...config?.custom_headers
			},
			body: requestBody,
			signal
		})

		console.log(`[proxy/fetchChatCompletion] 请求发送完毕, status: ${response.status}, ok: ${response.ok}`)

		if (!response.ok) try {
			const text = await response.text()
			try {
				const data = JSON.parse(text)
				throw { data, response }
			}
			catch {
				throw { text, response }
			}
		}
		catch {
			throw response
		}

		const reader = response.body.getReader()
		signal?.addEventListener?.('abort', () => {
			const err = new Error('User Aborted')
			err.name = 'AbortError'
			reader.cancel(err)
		}, { once: true })

		const decoder = new TextDecoder()
		let buffer = ''
		let isSSE = false

		const imageProcessingPromises = []

		/**
		 * 处理图片 URL 数组
		 * @param {string[]} imageUrls - 图片 URL 数组。
		 */
		const processImages = (imageUrls) => {
			if (!imageUrls || !Array.isArray(imageUrls)) return

			const promise = (async () => {
				const newFiles = await Promise.all(imageUrls.map(async (url) => {
					try {
						const resp = await fetch(url)
						if (!resp.ok) return null
						return {
							name: `image${imgIndex++}.png`,
							buffer: await resp.arrayBuffer(),
							mimetype: 'image/png'
						}
					} catch (e) {
						console.error('Failed to fetch image:', url, e)
						return null
					}
				}))

				const validFiles = newFiles.filter(Boolean)
				if (validFiles.length > 0) {
					result.files.push(...validFiles)
					previewUpdater(result)
				}
			})()
			imageProcessingPromises.push(promise)
		}

		let totalChunks = 0
		let totalBytes = 0

		try {
			while (true) {
				if (signal?.aborted) {
					const err = new Error('User Aborted')
					err.name = 'AbortError'
					throw err
				}
				const { done, value } = await reader.read()
				if (done) break

				totalChunks++
				totalBytes += value?.length || 0
				// [诊断] 打印前3个chunk的原始内容
				if (totalChunks <= 3) {
					const chunkStr = decoder.decode(value, { stream: true })
					console.log(`[proxy/stream] chunk #${totalChunks}, size: ${value?.length}, content(前200): ${JSON.stringify(chunkStr.substring(0, 200))}`)
					buffer += chunkStr
				} else {
					buffer += decoder.decode(value, { stream: true })
				}

				// Detect SSE format
				if (!isSSE && /^data:/m.test(buffer))
					isSSE = true


				if (isSSE) {
					const lines = buffer.split('\n')
					buffer = lines.pop() // Keep incomplete line

					for (const line of lines) {
						const trimmed = line.trim()
						if (!trimmed.startsWith('data:')) continue

						const data = trimmed.slice(5).trim()
						if (data === '[DONE]') continue

						try {
							const json = JSON.parse(data)
	
							// 检测 SSE 流中的 API 错误（反代返回 HTTP 200 但 body 中含错误）
							if (json.error) {
								const errMsg = json.error.message || json.error.status || JSON.stringify(json.error)
								const errCode = json.error.code || 'UNKNOWN'
								console.error(`[proxy/fetchChatCompletion] SSE 流中检测到 API 错误: code=${errCode}, message=${errMsg}`)
								throw new Error(`API Error (${errCode}): ${errMsg}`)
							}
	
							const delta = json.choices?.[0]?.delta
							const message = json.choices?.[0]?.message // Some non-standard streams might send full message
	
							// 处理思维链/推理内容（Gemini/DeepSeek 等模型的 thinking 阶段）
							const reasoning = delta?.reasoning_content || delta?.reasoning || message?.reasoning_content || ''
							if (reasoning) {
								if (!result._reasoning_started) {
									result._reasoning_started = true
									result.content += '<think>\n'
								}
								result.content += reasoning
								previewUpdater(result)
							}
	
							const content = delta?.content || message?.content || ''
							if (content) {
								// 思维链结束，关闭 <think> 标签
								if (result._reasoning_started && !result._reasoning_ended) {
									result._reasoning_ended = true
									result.content += '\n</think>\n'
								}
								result.content += content
								previewUpdater(result)
							}
	
							// Handle images if present in delta or message (Custom extension support)
							const images = delta?.images || message?.images
							if (images) processImages(images)
						} catch (e) {
							console.warn('Error parsing stream data:', e)
						}
					}
				}
			}

			// 流结束后关闭未闭合的 <think> 标签
			if (result._reasoning_started && !result._reasoning_ended) {
				result.content += '\n</think>\n'
				result._reasoning_ended = true
			}
	
			// If not SSE, try parsing as standard JSON
			if (!isSSE && buffer.trim())
				try {
					const json = JSON.parse(buffer)
					const message = json.choices?.[0]?.message
					if (message) {
						let fullContent = ''
						// 处理思维链内容（非流式响应）
						if (message.reasoning_content) {
							fullContent += '<think>\n' + message.reasoning_content + '\n</think>\n'
						}
						fullContent += message.content || ''
						result.content = fullContent
						if (message.images) processImages(message.images)
					}
				} catch (e) {
					if (!result.content) console.error('Failed to parse response as JSON:', e)
				}
		} catch (e) {
			if (e.name === 'AbortError') throw e
			console.error('Stream reading error:', e)
			throw e
		} finally {
			reader.releaseLock()
		}

		// Wait for all image processing to complete
		if (imageProcessingPromises.length > 0)
			await Promise.allSettled(imageProcessingPromises)

		// 清理内部追踪标记
		delete result._reasoning_started
		delete result._reasoning_ended

		// [诊断日志] 打印最终结果
		console.log(`[proxy/fetchChatCompletion] 响应解析完毕, content长度: ${result.content?.length || 0}, files: ${result.files?.length || 0}, 总chunks: ${totalChunks}, 总bytes: ${totalBytes}, isSSE: ${isSSE}`)
		if (!result.content && result.files?.length === 0) {
			console.warn(`[proxy/fetchChatCompletion] ⚠️ AI返回空内容！buffer剩余(前200):`, JSON.stringify(buffer?.substring(0, 200)))
		}

		return result
	}

	/**
	 * 调用基础模型（带重试）。
	 * @param {Array<object>} messages - 消息数组。
	 * @param {{ signal?: AbortSignal, previewUpdater?: (result: {content: string, files: any[]}) => void, result: {content: string, files: any[]} }} options - 包含信号、预览更新器和结果的选项对象。
	 * @returns {Promise<{content: string, files: any[]}>} 模型返回的内容。
	 */
	async function fetchChatCompletionWithRetry(messages, options) {
		const errors = []
		let retryConfigs = [
			{}, // 第一次尝试，使用原始配置
			{ urlSuffix: '/v1/chat/completions' },
			{ urlSuffix: '/chat/completions' },
		]
		if (config.url.endsWith('/chat/completions'))
			retryConfigs = retryConfigs.filter(config => !config?.urlSuffix?.endsWith?.('/chat/completions'))

		for (const retryConfig of retryConfigs) {
			const currentConfig = { ...config } // 复制配置，避免修改原始配置
			if (retryConfig.urlSuffix) currentConfig.url += retryConfig.urlSuffix

			try {
				const result = await fetchChatCompletion(messages, currentConfig, options)

				if (retryConfig.urlSuffix) {
					console.warn(`the api url of ${config.model} need to change from ${config.url} to ${currentConfig.url}`)
					Object.assign(config, currentConfig)
					SaveConfig()
				}

				return result
			} catch (error) {
				if (error.name === 'AbortError') throw error
				errors.push(error)
			}
		}
		throw errors.length == 1 ? errors[0] : errors
	}
	/** @type {AIsource_t} */
	const result = {
		type: 'text-chat',
		info: Object.fromEntries(Object.entries(structuredClone(info_dynamic)).map(([k, v]) => {
			v.name = config.name || config.model
			return [k, v]
		})),
		is_paid: false,
		extension: {},

		/**
		 * 调用 AI 源。
		 * @param {string} prompt - 要发送给 AI 的提示。
		 * @returns {Promise<{content: string, files: any[]}>} 来自 AI 的结果。
		 */
		Call: async prompt => {
			return await fetchChatCompletionWithRetry([
				{
					role: 'system',
					content: prompt
				}
			])
		},
		/**
		 * 使用结构化提示调用 AI 源。
		 * @param {prompt_struct_t} prompt_struct - 要发送给 AI 的结构化提示。
		 * @param {import('../../../../../decl/AIsource.ts').GenerationOptions} [options] - 生成选项。
		 * @returns {Promise<{content: string, files: any[]}>} 来自 AI 的结果。
		 */
		StructCall: async (prompt_struct, options = {}) => {
			const { base_result = {}, replyPreviewUpdater, signal, modelOverrides } = options

			// per-call 参数覆盖（记忆AI等独立调用者使用）
			// 单线程安全：临时修改 config，调用完成后恢复
			let _saved_model, _saved_stream, _saved_model_arguments
			if (modelOverrides) {
				if (modelOverrides.model) {
					_saved_model = config.model
					config.model = modelOverrides.model
				}
				if (modelOverrides.stream !== undefined) {
					_saved_stream = config.use_stream
					config.use_stream = modelOverrides.stream
				}
				const argOverrides = {}
				if (modelOverrides.temperature !== undefined) argOverrides.temperature = modelOverrides.temperature
				if (modelOverrides.max_tokens !== undefined) argOverrides.max_tokens = modelOverrides.max_tokens
				if (modelOverrides.top_p !== undefined) argOverrides.top_p = modelOverrides.top_p
				if (Object.keys(argOverrides).length > 0) {
					_saved_model_arguments = config.model_arguments
					config.model_arguments = { ...(config.model_arguments || {}), ...argOverrides }
				}
			}

			try {

			const ignoreFiles = config.convert_config?.ignoreFiles ?? configTemplate.convert_config.ignoreFiles

			// ================================================================
			// 检测司令员模式（beilu-preset commander mode）
			// ================================================================
			const presetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
			const commanderMode = presetExt?.commander_mode && presetExt?.beilu_preset_messages

			let messages
			let useXmlFormat = true // 是否使用 XML 消息格式（司令员模式不使用）

			if (commanderMode) {
					// ============================================================
					// 司令员模式：预设完全掌控消息序列（5 段结构）
					// ============================================================
					const beforeChat = presetExt.beilu_preset_before || []
					const afterChat = presetExt.beilu_preset_after || []
					const injectionAbove = presetExt.beilu_injection_above || []
					const injectionBelow = presetExt.beilu_injection_below || []
					const modelParams = presetExt.beilu_model_params || {}
	
					useXmlFormat = false // 司令员模式不使用 XML 包裹
	
					const toApiMsg = msg => ({
						role: msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system',
						content: msg.content || '',
					})
	
					// 步骤 1：构建头部预设消息（system only）
					const beforeMsgs = beforeChat.map(toApiMsg)
	
					// 步骤 2：构建注入上方消息（@D>=1，可选 role）
					const aboveMsgs = injectionAbove.map(toApiMsg)
	
					// 步骤 3：构建聊天记录消息
					const chatLogMsgs = buildChatLogMessages(prompt_struct, ignoreFiles)
	
					// 步骤 4：构建注入下方消息（@D=0，可选 role）
					const belowMsgs = injectionBelow.map(toApiMsg)
	
					// 步骤 5：构建尾部预设消息（system only）
					const afterMsgs = afterChat.map(toApiMsg)
	
					// 步骤 6：合并为最终消息序列 = 头部预设 + 注入上 + 聊天记录 + 注入下 + 尾部预设
					messages = [...beforeMsgs, ...aboveMsgs, ...chatLogMsgs, ...belowMsgs, ...afterMsgs]

				// 步骤 6：处理压缩系统消息
				if (modelParams.squash_system_messages) {
					messages = squashSystemMessages(messages)
				}
	
				// 步骤 6.5：预填充开关处理
				// 预填充开关控制 afterMsgs 中 assistant 条目的发送方式：
				// - 开启：保持 assistant 身份（真正的预填充，AI 从此处继续生成）
				// - 关闭：转为 system 身份 + "assistant:\n" 前缀（伪装模式）
				const prefillEnabled = !!(modelParams.prefill_enabled || modelParams.claude_prefill_enabled
					|| config.convert_config?.prefill_enabled)
	
				if (!prefillEnabled) {
					// 预填充关闭：将 afterMsgs 中的 assistant 条目转为 system 角色
					messages = convertTrailingAssistantToSystem(messages)
				}
	
				// 提示词后处理（替代旧的严格角色模式）
				const postProcessing = modelParams.prompt_post_processing
					|| config.convert_config?.prompt_post_processing || 'none'
				if (postProcessing !== 'none') {
					messages = postProcessMessages(messages, postProcessing)
				}

				// 步骤 8：应用预设的模型参数到 config.model_arguments
				const effectiveModelArgs = { ...(config.model_arguments || {}) }
				if (modelParams.temperature !== undefined) effectiveModelArgs.temperature = modelParams.temperature
				if (modelParams.top_p !== undefined && modelParams.top_p !== 1) effectiveModelArgs.top_p = modelParams.top_p
				if (modelParams.top_k !== undefined && modelParams.top_k > 0) effectiveModelArgs.top_k = modelParams.top_k
				if (modelParams.frequency_penalty !== undefined && modelParams.frequency_penalty !== 0) effectiveModelArgs.frequency_penalty = modelParams.frequency_penalty
				if (modelParams.presence_penalty !== undefined && modelParams.presence_penalty !== 0) effectiveModelArgs.presence_penalty = modelParams.presence_penalty
				if (modelParams.max_tokens !== undefined) effectiveModelArgs.max_tokens = modelParams.max_tokens
				if (modelParams.seed !== undefined && modelParams.seed !== -1) effectiveModelArgs.seed = modelParams.seed
				if (modelParams.min_p !== undefined && modelParams.min_p > 0) effectiveModelArgs.min_p = modelParams.min_p
				if (modelParams.repetition_penalty !== undefined && modelParams.repetition_penalty !== 1) effectiveModelArgs.repetition_penalty = modelParams.repetition_penalty

				// 思维链参数
				if (modelParams.show_thoughts) {
					effectiveModelArgs.include_reasoning = true
				}
				if (modelParams.reasoning_effort && modelParams.reasoning_effort !== 'auto') {
					effectiveModelArgs.reasoning_effort = modelParams.reasoning_effort
				}

				// 临时覆盖 model_arguments
				config.model_arguments = effectiveModelArgs

				// stream 参数：支持前端流式开关通过 beilu_model_params 控制
				if (modelParams.stream !== undefined) {
					if (_saved_stream === undefined) _saved_stream = config.use_stream
					config.use_stream = modelParams.stream
				}
			} else {
				// ============================================================
				// 兼容模式：原始逻辑（无预设接管）
				// ============================================================
				const mergedChatLog = margeStructPromptChatLog(prompt_struct)
	
				// 找到最后一条含图片文件的条目索引（只嵌入这一条的图片，避免历史图片累积）
				let lastImageEntryIdx = -1
				for (let i = mergedChatLog.length - 1; i >= 0; i--) {
					if (mergedChatLog[i].files?.some(f => f.mime_type?.startsWith('image/'))) {
						lastImageEntryIdx = i
						break
					}
				}
	
				messages = mergedChatLog.map((chatLogEntry, entryIdx) => {
					const uid = Math.random().toString(36).slice(2, 10)
					let textContent = `\
	<message "${uid}">
	<sender>${chatLogEntry.name}</sender>
	<content>
	${chatLogEntry.content}
	</content>
	</message "${uid}">
	`
	
					/** @type {{role: 'user'|'assistant'|'system', content: string | object[]}} */
					const message = {
						role: chatLogEntry.role === 'user' ? 'user' : chatLogEntry.role === 'system' ? 'system' : 'assistant',
						content: textContent,
					}
	
					if (chatLogEntry.files?.length) {
						// 只嵌入最后一条含图片消息的图片，历史图片用文字提示替代
						const shouldEmbedImages = (entryIdx === lastImageEntryIdx) && !ignoreFiles
	
						if (ignoreFiles || !shouldEmbedImages) {
							const notices = chatLogEntry.files.map((file) => {
								const mime_type = file.mime_type || 'application/octet-stream'
								const name = file.name ?? 'unknown'
								if (mime_type.startsWith('image/'))
									return `[附件: 图片 ${name}（历史图片已省略）]`
								return `[System Notice: can't show you about file '${name}' because you cant take the file input of type '${mime_type}', but you may be able to access it by using code tools if you have.]`
							})
							textContent += '\n' + notices.join('\n')
							message.content = textContent
							return message
						}
						const contentParts = [{ type: 'text', text: textContent }]
	
						for (const file of chatLogEntry.files) {
							if (!file.mime_type) continue
	
							// Handle image files
							if (file.mime_type.startsWith('image/'))
								contentParts.push({
									type: 'image_url',
									image_url: {
										url: `data:${file.mime_type};base64,${file.buffer.toString('base64')}`,
									},
								})
							// Handle audio files
							else if (file.mime_type.startsWith('audio/')) {
								const formatMap = {
									'audio/wav': 'wav',
									'audio/wave': 'wav',
									'audio/x-wav': 'wav',
									'audio/mpeg': 'mp3',
									'audio/mp3': 'mp3',
									'audio/mp4': 'mp4',
									'audio/m4a': 'm4a',
									'audio/webm': 'webm',
									'audio/ogg': 'webm',
								}
								const format = formatMap[file.mime_type.toLowerCase()] || 'wav'
	
								contentParts.push({
									type: 'input_audio',
									input_audio: {
										data: file.buffer.toString('base64'),
										format,
									},
								})
							}
						}
	
						if (contentParts.length > 1)
							message.content = contentParts
					}
	
					return message
				})

				const system_prompt = structPromptToSingleNoChatLog(prompt_struct)
				if (config.system_prompt_at_depth ?? 10)
					messages.splice(Math.max(messages.length - (config.system_prompt_at_depth ?? 10), 0), 0, {
						role: 'system',
						content: system_prompt
					})
				else
					messages.unshift({
						role: 'system',
						content: system_prompt
					})

				if (config.convert_config?.roleReminding ?? true) {
					const isMutiChar = new Set(prompt_struct.chat_log.map(chatLogEntry => chatLogEntry.name).filter(Boolean)).size > 2
					if (isMutiChar)
						messages.push({
							role: 'system',
							content: `现在请以${prompt_struct.Charname}的身份续写对话。`
						})
				}
	
				// 兼容模式：预填充和后处理
				// 兼容模式没有 modelParams，只使用 convert_config
				const compatPrefillEnabled = !!(config.convert_config?.prefill_enabled)
	
				if (!compatPrefillEnabled) {
					// 预填充关闭：将尾部 assistant 转为 system
					messages = convertTrailingAssistantToSystem(messages)
				}
	
				// 兼容模式后处理
				const compatPostProcessing = config.convert_config?.prompt_post_processing || 'none'
				if (compatPostProcessing !== 'none') {
					messages = postProcessMessages(messages, compatPostProcessing)
				}
			}

			/**
			 * 清理 AI 响应的格式，移除 XML 标签和不完整的标记。
			 * @param {object} res - 原始响应对象。
			 * @param {string} res.content - 响应内容。
			 * @returns {object} - 清理后的响应对象。
			 */
			function clearFormat(res) {
				let text = res.content
				// 司令员模式不使用 XML 格式，跳过 XML 清理
				if (!useXmlFormat) {
					res.content = text
					return res
				}
				if (text.match(/<\/sender>\s*<content>/))
					text = (text.match(/<\/sender>\s*<content>([\S\s]*)/)?.[1] ?? text).split(new RegExp(
						`(${(prompt_struct.alternative_charnames || []).map(Object).map(
							s => s instanceof String ? escapeRegExp(s) : s.source
						).join('|')})\\s*<\\/sender>\\s*<content>`
					)).pop().split(/<\/content>\s*<\/message/).shift()
				if (text.match(/<\/content>\s*<\/message[^>]*>\s*$/))
					text = text.split(/<\/content>\s*<\/message[^>]*>\s*$/).shift()
				// 清理可能出现的不完整的结束标签
				text = text.replace(/<\/content\s*$/, '').replace(/<\/message\s*$/, '').replace(/<\/\s*$/, '')
				res.content = text
				return res
			}

			const result = {
				content: '',
				files: [...base_result?.files || []],
			}

			/**
			 * 预览更新器
			 * @param {{content: string, files: any[]}} r - 结果对象
			 * @returns {void}
			 */
			const previewUpdater = r => replyPreviewUpdater?.(clearFormat({ ...r }))

			await fetchChatCompletionWithRetry(messages, {
				signal, previewUpdater, result
			})

			return Object.assign(base_result, clearFormat(result))

			} finally {
				// 恢复 config（per-call 覆盖 / 司令员模式清理）
				if (modelOverrides) {
					if (_saved_model !== undefined) config.model = _saved_model
					if (_saved_model_arguments !== undefined) config.model_arguments = _saved_model_arguments
				}
				// stream 恢复独立处理（可能来自 modelOverrides 或 司令员模式 beilu_model_params）
				if (_saved_stream !== undefined) config.use_stream = _saved_stream
			}
		},
		tokenizer: {
			/**
			 * 释放分词器。
			 * @returns {number} 0
			 */
			free: () => 0,
			/**
			 * 编码提示。
			 * @param {string} prompt - 要编码的提示。
			 * @returns {string} 编码后的提示。
			 */
			encode: prompt => prompt,
			/**
			 * 解码令牌。
			 * @param {string} tokens - 要解码的令牌。
			 * @returns {string} 解码后的令牌。
			 */
			decode: tokens => tokens,
			/**
			 * 解码单个令牌。
			 * @param {string} token - 要解码的令牌。
			 * @returns {string} 解码后的令牌。
			 */
			decode_single: token => token,
			/**
			 * 获取令牌计数。
			 * @param {string} prompt - 要计算令牌的提示。
			 * @returns {number} 令牌数。
			 */
			get_token_count: prompt => prompt.length
		}
	}
	return result
}

// ============================================================
// 司令员模式辅助函数
// ============================================================

/**
	* 从 prompt_struct 构建聊天记录消息（司令员模式用）
	* 不使用 XML 包裹，直接以纯文本形式传递
	*
	* @param {prompt_struct_t} prompt_struct - 结构化提示
	* @param {boolean} ignoreFiles - 是否忽略文件
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function buildChatLogMessages(prompt_struct, ignoreFiles) {
	const chatLog = prompt_struct.chat_log || []
	const messages = []

	// 找到最后一条含图片文件的条目索引（只嵌入这一条的图片，避免历史图片累积导致请求体过大）
	let lastImageEntryIndex = -1
	for (let i = chatLog.length - 1; i >= 0; i--) {
		if (chatLog[i].files?.some(f => f.mime_type?.startsWith('image/'))) {
			lastImageEntryIndex = i
			break
		}
	}

	for (let idx = 0; idx < chatLog.length; idx++) {
		const entry = chatLog[idx]
		// 跳过临时注入的条目（由预设在 TweakPrompt Round 3 注入的）
		if (entry.extension?.ephemeral) continue

		const role = entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant'
		const content = entry.content || ''

		/** @type {{role: string, content: string|object[]}} */
		const message = { role, content }

		// 处理附带的文件
		if (entry.files?.length) {
			// 判断是否应该嵌入此条目的图片（只嵌入最后一条含图片的消息）
			const shouldEmbedImages = (idx === lastImageEntryIndex) && !ignoreFiles

			if (ignoreFiles || !shouldEmbedImages) {
				// 不嵌入图片：用文字说明替代
				const notices = entry.files.map((file) => {
					const mime_type = file.mime_type || 'application/octet-stream'
					const name = file.name ?? 'unknown'
					if (mime_type.startsWith('image/'))
						return `[附件: 图片 ${name}（历史图片已省略）]`
					return `[System Notice: can't show you about file '${name}' because you cant take the file input of type '${mime_type}', but you may be able to access it by using code tools if you have.]`
				})
				message.content = content + '\n' + notices.join('\n')
			} else {
				// 嵌入图片（仅最后一条含图片的消息）
				const contentParts = [{ type: 'text', text: content }]

				for (const file of entry.files) {
					if (!file.mime_type) continue

					if (file.mime_type.startsWith('image/'))
						contentParts.push({
							type: 'image_url',
							image_url: {
								url: `data:${file.mime_type};base64,${file.buffer.toString('base64')}`,
							},
						})
					else if (file.mime_type.startsWith('audio/')) {
						const formatMap = {
							'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
							'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
							'audio/mp4': 'mp4', 'audio/m4a': 'm4a',
							'audio/webm': 'webm', 'audio/ogg': 'webm',
						}
						const format = formatMap[file.mime_type.toLowerCase()] || 'wav'
						contentParts.push({
							type: 'input_audio',
							input_audio: { data: file.buffer.toString('base64'), format },
						})
					}
				}

				if (contentParts.length > 1)
					message.content = contentParts
			}
		}

		messages.push(message)
	}

	return messages
}

/**
	* 提示词后处理：对消息序列应用不同级别的角色规范化
	* 参考 SillyTavern prompt-converters.js 的 mergeMessages 实现
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @param {'merge'|'semi'|'strict'} type 后处理类型
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function postProcessMessages(messages, type) {
	switch (type) {
		case 'merge':
			return mergeConsecutiveRoles(messages)
		case 'semi':
			return semiStrictProcess(messages)
		case 'strict':
			return strictProcess(messages)
		default:
			return messages
	}
}

/**
	* 合并相同角色连续的发言（参考 SillyTavern mergeMessages）
	* 支持多模态 content（数组类型），将其中的文本部分扁平化后合并
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function mergeConsecutiveRoles(messages) {
	const result = []
	for (const msg of messages) {
		// 将数组类型 content 扁平化为字符串（图片/音频等非文本部分先用随机 token 占位）
		const flatMsg = { ...msg }
		/** @type {Map<string, object>} */
		const contentTokens = new Map()
		if (Array.isArray(flatMsg.content)) {
			const text = flatMsg.content.map((part) => {
				if (part.type === 'text') return part.text || ''
				if (['image_url', 'input_audio'].includes(part.type)) {
					const token = '@@' + Math.random().toString(36).slice(2, 18) + '@@'
					contentTokens.set(token, part)
					return token
				}
				return ''
			}).join('\n\n')
			flatMsg.content = text
			flatMsg._contentTokens = contentTokens
		}

		const last = result[result.length - 1]
		if (last && last.role === flatMsg.role && flatMsg.content) {
			// 合并字符串内容
			if (typeof last.content === 'string' && typeof flatMsg.content === 'string') {
				last.content += '\n\n' + flatMsg.content
				// 合并 token 映射
				if (flatMsg._contentTokens) {
					last._contentTokens = last._contentTokens || new Map()
					for (const [k, v] of flatMsg._contentTokens) last._contentTokens.set(k, v)
				}
			} else {
				result.push(flatMsg)
			}
		} else {
			result.push(flatMsg)
		}
	}

	// 还原含 token 的消息为多模态数组格式
	for (const msg of result) {
		if (msg._contentTokens && msg._contentTokens.size > 0 && typeof msg.content === 'string') {
			const hasToken = Array.from(msg._contentTokens.keys()).some(t => msg.content.includes(t))
			if (hasToken) {
				const parts = msg.content.split('\n\n')
				const merged = []
				for (const part of parts) {
					if (msg._contentTokens.has(part)) {
						merged.push(msg._contentTokens.get(part))
					} else if (merged.length > 0 && merged[merged.length - 1].type === 'text') {
						merged[merged.length - 1].text += '\n\n' + part
					} else {
						merged.push({ type: 'text', text: part })
					}
				}
				msg.content = merged
			}
		}
		delete msg._contentTokens
	}

	// 空消息兜底
	if (result.length === 0) {
		result.push({ role: 'user', content: '[Start a new chat]' })
	}

	return result
}

/**
	* 半严格模式（参考 SillyTavern mergeMessages strict=true, placeholders=false）：
	* 处理顺序（与 SillyTavern 一致）：
	*   1. 先合并连续同角色消息
	*   2. 将 i>0 的 system 消息转为 user
	*   3. 再次合并（因为 system→user 后可能产生新的连续同角色）
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function semiStrictProcess(messages) {
	// 步骤 1：先合并连续同角色
	let merged = mergeConsecutiveRoles(messages)

	// 步骤 2：i>0 的 system → user
	for (let i = 1; i < merged.length; i++) {
		if (merged[i].role === 'system') {
			merged[i] = { ...merged[i], role: 'user' }
		}
	}

	// 步骤 3：再次合并（system→user 后可能产生连续 user）
	return mergeConsecutiveRoles(merged)
}

/**
	* 严格模式（参考 SillyTavern mergeMessages strict=true, placeholders=true）：
	* 在半严格的基础上：
	*   - 如果第一条是 system 且后面不是 user，插入占位 user
	*   - 如果第一条既不是 system 也不是 user，插入占位 user
	*   - 最终再合并一次
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function strictProcess(messages) {
	// 步骤 1：先合并连续同角色
	let merged = mergeConsecutiveRoles(messages)

	// 步骤 2：i>0 的 system → user
	for (let i = 1; i < merged.length; i++) {
		if (merged[i].role === 'system') {
			merged[i] = { ...merged[i], role: 'user' }
		}
	}

	// 步骤 3：插入占位符确保 user 在前
	if (merged.length > 0) {
		if (merged[0].role === 'system') {
			if (merged.length === 1 || merged[1].role !== 'user') {
				merged.splice(1, 0, { role: 'user', content: '[Start a new chat]' })
			}
		} else if (merged[0].role !== 'user') {
			merged.unshift({ role: 'user', content: '[Start a new chat]' })
		}
	}

	// 步骤 4：最终合并（插入占位后可能产生连续同角色）
	return mergeConsecutiveRoles(merged)
}

/**
	* 将消息序列末尾连续的 assistant 消息转为 system 角色（伪装模式）
	* 预填充关闭时使用：尾部 assistant 条目以 system 身份发送，内容加 "assistant:\n" 前缀
	* 这样 AI 不会将其视为自己说过的话，而是作为系统指令
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function convertTrailingAssistantToSystem(messages) {
	// 从末尾向前查找连续的 assistant 消息
	const result = [...messages]
	for (let i = result.length - 1; i >= 0; i--) {
		if (result[i].role === 'assistant') {
			const content = result[i].content
			result[i] = {
				...result[i],
				role: 'system',
				content: typeof content === 'string' ? `assistant:\n${content}` : content,
			}
		} else {
			break // 遇到非 assistant 消息就停止
		}
	}
	return result
}

/**
	* 压缩系统消息：将连续的 system 消息合并为一条
	* 不包括被 assistant 消息分隔的部分（保留示例对话结构）
	*
	* @param {Array<{role: string, content: string|object[]}>} messages
	* @returns {Array<{role: string, content: string|object[]}>}
	*/
function squashSystemMessages(messages) {
	const result = []
	let pendingSystem = []

	function flushSystem() {
		if (pendingSystem.length === 0) return
		if (pendingSystem.length === 1) {
			result.push(pendingSystem[0])
		} else {
			// 合并多条 system 消息
			const merged = pendingSystem
				.map(m => typeof m.content === 'string' ? m.content : '[complex content]')
				.join('\n\n')
			result.push({ role: 'system', content: merged })
		}
		pendingSystem = []
	}

	for (const msg of messages) {
		if (msg.role === 'system') {
			pendingSystem.push(msg)
		} else {
			flushSystem()
			result.push(msg)
		}
	}
	flushSystem()

	return result
}
