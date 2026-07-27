/**
 * Ollama — 官方 Ollama REST API（npm:ollama SDK 封装）
 * API端点：http://127.0.0.1:11434（默认，通过 config.host 覆盖）
 * 认证：无（本地部署，无鉴权）
 *
 * 支持文本生成（流式/非流式）、图片输入（Base64 嵌入最后一条 user 消息）、
 * 角色提醒（roleReminding）、系统提示词深度控制（system_prompt_at_depth）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { Ollama } from 'npm:ollama'

import { buildMessagesFromPromptStruct } from '../_shared/buildMessages.mjs'
import { applyModelParams } from '../_shared/applyModelParams.mjs'
import { makeAbortError } from '../_shared/abort.mjs'

import info_dynamic from '../../../../../public/parts/serviceGenerators/AI/ollama/info.dynamic.json' with { type: 'json' }
import info from '../../../../../public/parts/serviceGenerators/AI/ollama/info.json' with { type: 'json' }
import { buildProviderInfo } from '../_shared/buildInfo.mjs'
/** @typedef {import('../../../../../decl/AIsource.ts').AIsource_t} AIsource_t */
/** @typedef {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t */

import { wbT, wbD } from "../../../../../server/wbStub.mjs";

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
	name: 'ollama',
	host: 'http://127.0.0.1:11434',
	model: 'llama3',
	model_arguments: {
		temperature: 1,
		num_predict: -1, // -1 for infinite
	},
	use_stream: true,
	system_prompt_at_depth: 10,
	convert_config: {
		roleReminding: true
	}
}

/**
 * 获取 AI 源。
 * @param {object} config - 配置对象。
 * @returns {Promise<AIsource_t>} AI 源。
 */
async function GetSource(config) {
	const ollama = new Ollama({ host: config.host })

	/** @type {AIsource_t} */
	const result = {
		type: 'text-chat',
		info: buildProviderInfo(info_dynamic, config),
		is_paid: false,
		extension: {},

		/**
		 * 调用 AI 源。
		 * @param {string} prompt - 要发送给 AI 的提示。
		 * @returns {Promise<{content: string}>} 来自 AI 的结果。
		 */
		Call: async prompt => {
			wbT(null, 'ai:ollama', 'call_enter', { model: config.model, host: config.host })
			const response = await ollama.generate({
				model: config.model,
				prompt,
				stream: false,
				options: config.model_arguments
			})
			wbD(null, 'ai:ollama', 'call_empty', !!response.response, 'Call 返回空内容（本地 ollama 服务/模型异常）', { model: config.model })
			return {
				content: response.response,
			}
		},
		/**
	 * 使用结构化提示调用 AI 源。
	 * @param {prompt_struct_t} prompt_struct - 要发送给 AI 的结构化提示。
	 * @param {import('../../../../../decl/AIsource.ts').GenerationOptions} [options] - 生成选项。
	 * @returns {Promise<{content: string, files: any[]}>} 来自 AI 的结果。
	 */
		StructCall: async (/** @type {prompt_struct_t} */ prompt_struct, options = {}) => {
			const _wbChatid = prompt_struct?.chatid ?? null
			wbT(_wbChatid, 'ai:ollama', 'structcall_enter', { model: config.model, host: config.host })

			const { base_result = {}, replyPreviewUpdater, signal } = options

			// ★ 消息构建统一管线（2026-07-18 收口）：buildMessagesFromPromptStruct 是所有 generator 的单源，
			//   含 commander/compat 两分支 + 图片注入 + 宏替换 + roleReminding + 文本附件。
			// 本次调用的有效配置（子模式覆盖只作用本轮，绝不改闭包 config 污染后续调用）
			let _cfg = {
				...config,
				username: prompt_struct?.username || config.username,
				model_arguments: config.model_arguments ? { ...config.model_arguments } : {},
				convert_config: config.convert_config ? { ...config.convert_config } : {},
			}
			const { messages } = buildMessagesFromPromptStruct(prompt_struct, _cfg, configTemplate)
			wbT(_wbChatid, 'ai:ollama', 'messages_assembled', { count: messages.length })

			// commander 模式下 applyModelParams 仍需本地调用（ollama 特有的 shape:'ollama' 采样器映射）
			const _olPresetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
			if (_olPresetExt?.commander_mode && _olPresetExt?.beilu_preset_messages) {
				const _mp = _olPresetExt.beilu_model_params || {}
				const { args: _olApplied, model: _olModel } = applyModelParams(_mp, { shape: 'ollama', model: _cfg.model })
				if (_olModel) _cfg = { ..._cfg, model: _olModel }
				_cfg = { ..._cfg, model_arguments: { ..._cfg.model_arguments, ..._olApplied } }
				wbT(_wbChatid, 'ai:ollama', 'commander_mode', { msgCount: messages.length, model: _cfg.model })
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
			const previewUpdater = r => replyPreviewUpdater?.(r)

			// Check for abort before starting
			if (signal?.aborted) {
				throw makeAbortError()
			}

			// Use streaming based on config
			const useStream = (_cfg.use_stream ?? true) && !!replyPreviewUpdater

			if (useStream) {
				wbT(_wbChatid, 'ai:ollama', 'request_send', { mode: 'stream', model: _cfg.model })
				// Use ollama's streaming support
				const stream = await ollama.chat({
					model: _cfg.model,
					messages,
					stream: true,
					options: _cfg.model_arguments
				})
				wbT(_wbChatid, 'ai:ollama', 'stream_start', { model: _cfg.model })

				let _wbChunks = 0
				for await (const chunk of stream) {
					if (signal?.aborted) {
						throw makeAbortError()
					}

					if (chunk.message?.content) {
						_wbChunks++
						wbT(_wbChatid, 'ai:ollama', 'stream_chunk', { n: _wbChunks, len: chunk.message.content.length })
						result.content += chunk.message.content
						previewUpdater(result)
					}
				}
				wbT(_wbChatid, 'ai:ollama', 'stream_end', { chunks: _wbChunks, totalLen: result.content.length })
				wbD(_wbChatid, 'ai:ollama', 'stream_empty', _wbChunks > 0, '流式返回 0 段（本地 ollama 服务/模型异常）', { model: _cfg.model })
			} else {
				wbT(_wbChatid, 'ai:ollama', 'request_send', { mode: 'non-stream', model: _cfg.model })
				// Use non-streaming mode
				const response = await ollama.chat({
					model: _cfg.model,
					messages,
					stream: false,
					options: _cfg.model_arguments
				})
				result.content = response.message.content
				wbT(_wbChatid, 'ai:ollama', 'response_received', { totalLen: result.content?.length ?? 0 })
				wbD(_wbChatid, 'ai:ollama', 'response_empty', !!result.content, '非流式返回空内容（本地 ollama 服务/模型异常）', { model: _cfg.model })
				previewUpdater(result)
			}

			wbT(_wbChatid, 'ai:ollama', 'structcall_done', { len: result.content.length })
			return Object.assign(base_result, result)
		},
		tokenizer: {
			/**
			 * 释放分词器。
			 * @param {any} _ - 未使用。
			 * @returns {number} 0
			 */
			free: _ => 0,
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
			 * @returns {Promise<number>} 令牌数。
			 */
			get_token_count: async prompt => {
				if (!prompt) return 0
				try {
					const response = await ollama.encode({ model: config.model, prompt })
					return response.tokens.length
				}
				catch (error) {
					console.warn('Failed to get token count from Ollama API, falling back to character count.', error)
					return (prompt?.length ?? 0) / 4
				}
			}
		}
	}
	return result
}
