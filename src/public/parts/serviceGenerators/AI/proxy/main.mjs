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
		const response = await fetch(config.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: config.apikey ? 'Bearer ' + config.apikey : undefined,
				'HTTP-Referer': 'https://steve02081504.github.io/fount/',
				'X-Title': 'fount',
				...config?.custom_headers
			},
			body: JSON.stringify({
				model: config.model,
				messages,
				stream: config.use_stream,
				...config.model_arguments,
			}),
			signal
		})

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

		try {
			while (true) {
				if (signal?.aborted) {
					const err = new Error('User Aborted')
					err.name = 'AbortError'
					throw err
				}
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })

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
							const delta = json.choices?.[0]?.delta
							const message = json.choices?.[0]?.message // Some non-standard streams might send full message

							const content = delta?.content || message?.content || ''
							if (content) {
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

			// If not SSE, try parsing as standard JSON
			if (!isSSE && buffer.trim())
				try {
					const json = JSON.parse(buffer)
					const message = json.choices?.[0]?.message
					if (message) {
						result.content = message.content || ''
						if (message.images) processImages(message.images)
					}
				} catch (e) {
					if (!result.content) console.error('Failed to parse response as JSON:', e) // Fix: Use result.content instead of undefined 'text'
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
			const { base_result = {}, replyPreviewUpdater, signal } = options

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

				// 步骤 7：处理继续预填充
				if (modelParams.continue_prefill) {
					// 如果最后一条消息是 user 发的，尝试找到最近的 assistant 消息作为预填充
					const lastMsg = messages[messages.length - 1]
					if (lastMsg && lastMsg.role === 'assistant') {
						// 最后一条已经是 assistant，作为继续预填充使用
						// （某些 API 支持 assistant 预填充来引导输出）
					}
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
			} else {
				// ============================================================
				// 兼容模式：原始逻辑（无预设接管）
				// ============================================================
				messages = margeStructPromptChatLog(prompt_struct).map(chatLogEntry => {
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
						if (ignoreFiles) {
							const notices = chatLogEntry.files.map((file) => {
								const mime_type = file.mime_type || 'application/octet-stream'
								const name = file.name ?? 'unknown'
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
								// Map MIME types to OpenAI audio formats
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

	for (const entry of chatLog) {
		// 跳过临时注入的条目（由预设在 TweakPrompt Round 3 注入的）
		if (entry.extension?.ephemeral) continue

		const role = entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant'
		const content = entry.content || ''

		/** @type {{role: string, content: string|object[]}} */
		const message = { role, content }

		// 处理附带的文件
		if (entry.files?.length) {
			if (ignoreFiles) {
				const notices = entry.files.map((file) => {
					const mime_type = file.mime_type || 'application/octet-stream'
					const name = file.name ?? 'unknown'
					return `[System Notice: can't show you about file '${name}' because you cant take the file input of type '${mime_type}', but you may be able to access it by using code tools if you have.]`
				})
				message.content = content + '\n' + notices.join('\n')
			} else {
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
