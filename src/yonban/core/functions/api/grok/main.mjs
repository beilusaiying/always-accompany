import { wbT, wbD } from "../../../../../server/wbStub.mjs";

import { buildMessagesFromPromptStruct } from '../_shared/buildMessages.mjs'
import { makeAbortError } from '../_shared/abort.mjs'
import { clearXmlFormat } from '../proxy/lib/messageTransform.mjs'
import { applyModelParams } from '../_shared/applyModelParams.mjs'

import { GrokAPI } from './grokAPI.mjs'
import info_dynamic from '../../../../../public/parts/serviceGenerators/AI/grok/info.dynamic.json' with { type: 'json' }
import info from '../../../../../public/parts/serviceGenerators/AI/grok/info.json' with { type: 'json' }
import { buildProviderInfo } from '../_shared/buildInfo.mjs'

/**
 * @typedef {import('../../../../../decl/AIsource.ts').AIsource_t} AIsource_t
 * @typedef {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t
 */

/**
 *
 */
export default {
	info,
	interfaces: {
		serviceGenerator: {
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
	name: 'Grok',
	model: 'grok-3',
	cookies: [],
	use_stream: true,
	// T15-3：代码已消费（main.mjs:143-144 `config.system_prompt_at_depth ?? 10`）但模板缺此字段，
	//   前端无入口调控。补默认值 10 使前端可见可调；代码兜底 10 保持不变（值一致，无行为变化）。
	system_prompt_at_depth: 10,
	convert_config: {
		roleReminding: true
	}
}

/**
 * 创建一个 Grok AI 来源生成器
 * @param {object} config - 配置对象
 * @param {string} [config.name] - AI 来源的名称，默认为模型名称
 * @param {string} [config.model] - 使用的模型，默认为 'grok-3'
 * @param {string[]} [config.cookies] - Grok Cookies 数组
 * @returns {Promise<AIsource_t>} AI 来源对象
 */
async function GetSource(config) {
	const grok = new GrokAPI(config)

	/** @type {AIsource_t} */
	const result = {
		type: 'text-chat',
		info: buildProviderInfo(info_dynamic, config),
		is_paid: false, // 根据实际情况设置
		extension: {},

		/**
		 * 卸载 AI 源。
		 */
		Unload: () => {
			// 清理操作（如果有的话）
		},

		/**
		 * 调用 AI 源。
		 * @param {string} prompt - 要发送给 AI 的提示。
		 * @returns {Promise<{content: string}>} 来自 AI 的结果。
		 */
		Call: async prompt => {
			wbT(null, 'ai:grok', 'Call:enter', { promptLen: prompt?.length ?? 0 })
			const messages = [{ role: 'user', content: prompt }]
			const model = config.model || 'grok-3'
			const returnStream = config?.use_stream || false
			const result = await grok.call(messages, model, returnStream)
			wbT(null, 'ai:grok', 'Call:return', { contentLen: typeof result === 'string' ? result.length : 0 })
			return {
				content: result,
			}
		},

		/**
		 * 使用结构化提示调用 AI 源。
		 * @param {prompt_struct_t} prompt_struct - 要发送给 AI 的结构化提示。
		 * @param {import('../../../../../decl/AIsource.ts').GenerationOptions} [options] - 生成选项。
		 * @returns {Promise<{content: string, files: any[]}>} 来自 AI 的结果。
		 */
		StructCall: async (/** @type {prompt_struct_t} */ prompt_struct, options = {}) => {
			const { base_result = {}, replyPreviewUpdater, signal } = options
			const _wbChatid = prompt_struct?.chatid ?? null
			wbT(_wbChatid, 'ai:grok', 'StructCall:enter', { charname: prompt_struct?.Charname, chatLogLen: prompt_struct?.chat_log?.length ?? 0, hasPreview: !!replyPreviewUpdater })
			wbD(_wbChatid, 'ai:grok', 'StructCall:promptStruct', !!prompt_struct, 'prompt_struct 缺失', null)

			// ★ 消息构建统一管线（2026-07-18 收口）：buildMessagesFromPromptStruct 是所有 generator 的单源，
			//   含 commander/compat 两分支 + 图片注入 + 宏替换 + roleReminding + 文本附件。
			const callConfig = {
				...config,
				username: prompt_struct?.username || config.username,
				model_arguments: config.model_arguments ? { ...config.model_arguments } : {},
				convert_config: config.convert_config ? { ...config.convert_config } : {},
			}
			const { messages, useXmlFormat } = buildMessagesFromPromptStruct(prompt_struct, callConfig, configTemplate)
			wbT(_wbChatid, 'ai:grok', 'StructCall:assemble', { msgCount: messages.length, useXmlFormat })

			/** 清理 AI 响应的 XML 格式（收口到 messageTransform.clearXmlFormat）。 */
			function clearFormat(res) {
				res.content = clearXmlFormat(res.content, prompt_struct.alternative_charnames)
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
			// Check for abort before starting
			if (signal?.aborted) {
				throw makeAbortError()
			}

			// applyModelParams 仍需本地调用：grok 原生 API 走 openai shape，统一管线 commander 分支内部也走 openai
			// 但 compat 路径不走 applyModelParams，需在此保留
			const _grokPresetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
			const _grokModelParams = _grokPresetExt?.beilu_model_params || {}
			const { model: _grokModel } = applyModelParams(_grokModelParams, { shape: 'openai', model: config.model })
			const model = _grokModel || config.model || 'grok-3'

			// Use streaming based on config
			const useStream = (config.use_stream ?? true) && !!replyPreviewUpdater
			wbT(_wbChatid, 'ai:grok', 'StructCall:dispatch', { model, useStream })

			if (useStream) {
				/**
				 * 处理流式增量
				 * @param {string} delta - 增量内容
				 */
				const onDelta = (delta) => {
					result.content += delta
					previewUpdater(result)
				}
				// Use grok's streaming support via the call method
				await grok.call(messages, model, true, onDelta, signal)
			} else {
				// Use non-streaming mode
				result.content = await grok.call(messages, model, false)
				previewUpdater(result)
			}

			wbT(_wbChatid, 'ai:grok', 'StructCall:return', { contentLen: result.content?.length ?? 0, files: result.files?.length ?? 0 })
			wbD(_wbChatid, 'ai:grok', 'StructCall:emptyContent', !!(result.content && result.content.length), 'Grok 返回空内容', null)
			return Object.assign(base_result, clearFormat(result))
		},

		tokenizer: {
			/**
			 * 释放分词器。
			 * @returns {number} 0
			 */
			free: () => 0, // 或者根据实际情况计算
			/**
			 * 编码提示。
			 * @param {string} prompt - 要编码的提示。
			 * @returns {string} 编码后的提示。
			 */
			encode: prompt => prompt, // Grok 不需要特殊的编码
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
			 * @returns {Promise<number>} 令牌数。
			 */
			get_token_count: prompt => grok.countTokens(prompt),
		},
		/**
		 * 生成图像。
		 * @param {string} prompt - 提示。
		 * @param {number} n - 生成图像的数量。
		 * @returns {Promise<{data: any}>} 图像数据。
		 */
		generateImage: async (prompt, n) => {
			const images = await grok.generateImage(prompt, n)
			return {
				data: images
			}
		}
	}

	return result
}
