import { buildMessagesFromPromptStruct } from '../_shared/buildMessages.mjs'
import { makeAbortError } from '../_shared/abort.mjs'
import { applyModelParams } from '../_shared/applyModelParams.mjs'

import { ClaudeAPI } from './claude_api.mjs'
import info_dynamic from '../../../../../public/parts/serviceGenerators/AI/claude/info.dynamic.json' with { type: 'json' }
import info from '../../../../../public/parts/serviceGenerators/AI/claude/info.json' with { type: 'json' }
import { buildProviderInfo } from '../_shared/buildInfo.mjs'

import { wbT, wbD } from "../../../../../server/wbStub.mjs";

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
			 * 获取此 AI 源的配置模板。
			 * @returns {Promise<object>} 配置模板。
			 */
			GetConfigTemplate: async () => configTemplate,
			GetSource,
		}
	}
}

const configTemplate = {
	name: 'Claude',
	model: '',
	// T15-3：主请求（completion）等待响应头超时（ms）。原死值 10000 从未被消费（claude_api.mjs
	//   fetch 曾硬编码 120000），改成诚实的现行为值 120000 + 代码读 config.timeout 单源可调。
	//   冷路径 orgs auth GET 的 30000 是独立短超时语义，不并入本字段。
	timeout: 120000,
	cookie_array: [], // 填入你的 Cookie, 格式: ["sessionKey=sk-ant-sid01-..."]
	cookie_counter: 3,
	proxy_password: '',
	r_proxy: '', // 代理
	renew_always: false,       // 是否总是创建新对话, 默认为 false
	prevent_imperson: true, // 是否阻止角色扮演, 默认为 true
	// Call（非结构化简单调用）路径的置顶 system 文案，用户可改；空=用下方 DEFAULT_CALL_SYSTEM_PROMPT
	call_system_prompt: '',
}

// Call 路径置顶 system 单源（2026-07-08 链路3·代码零提示词方向）：原逐字写死在 Call 的
// messages.unshift 处。首条 system 非空可提高 claude 前缀缓存命中（保留默认值的原因），
// 用户经 config.call_system_prompt 可改。文本原样迁移。
const DEFAULT_CALL_SYSTEM_PROMPT = 'You are a helpful assistant.'
/**
 * 获取 AI 源。
 * @param {object} config - 配置对象。
 * @param {object} root0 - 根对象。
 * @param {Function} root0.SaveConfig - 保存配置的函数。
 * @returns {Promise<import('../../../../../decl/AIsource.ts').AIsource_t>} AI 源。
 */
async function GetSource(config, { SaveConfig }) { // 接收 SaveConfig
	const { countTokens } = await import('npm:@anthropic-ai/tokenizer')
	const claudeAPI = new ClaudeAPI(config, SaveConfig) // 传入 SaveConfig

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
			wbT(null, 'ai:claude', 'Call:enter', { model: config.model, promptLen: prompt?.length ?? 0 })
			const messages = [{ role: 'user', content: prompt }]
			messages.unshift({  //系统信息置顶（文案：config.call_system_prompt 可改，空=单源默认）
				role: 'system',
				content: config.call_system_prompt || DEFAULT_CALL_SYSTEM_PROMPT
			})
			const result = await claudeAPI.callClaudeAPI(messages, config.model)
			wbD(null, 'ai:claude', 'Call:after', !!result, 'Call返回空内容', { len: result?.length ?? 0 })
			return { content: result }
		},

		/**
	 * 使用结构化提示调用 AI 源。
	 * @param {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct - 要发送给 AI 的结构化提示。
	 * @param {import('../../../../../decl/AIsource.ts').GenerationOptions} [options] - 生成选项。
	 * @returns {Promise<{content: string}>} 来自 AI 的结果。
	 */
		StructCall: async (/** @type {prompt_struct_t} */ prompt_struct, options = {}) => {
			const { base_result = {}, replyPreviewUpdater, signal } = options
			const _wbChatid = prompt_struct?.chatid ?? null
			wbT(_wbChatid, 'ai:claude', 'StructCall:enter', { model: config.model, chatLogLen: prompt_struct?.chat_log?.length ?? 0 })

			// ★ 消息构建统一管线（2026-07-18 收口）：buildMessagesFromPromptStruct 是所有 generator 的单源，
			//   含 commander/compat 两分支 + 图片注入 + 宏替换 + roleReminding + 文本附件。
			const callConfig = {
				...config,
				username: prompt_struct?.username || config.username,
				model_arguments: config.model_arguments ? { ...config.model_arguments } : {},
				convert_config: config.convert_config ? { ...config.convert_config } : {},
			}
			const { messages, useXmlFormat } = buildMessagesFromPromptStruct(prompt_struct, callConfig, configTemplate)
			wbD(_wbChatid, 'ai:claude', 'StructCall:messages', messages.length > 0, '组装后messages为空', { msgCount: messages.length, useXmlFormat })

			/**
			 * 清理 AI 响应的格式，移除 XML 标签和不完整的标记。
			 * @param {object} res - 原始响应对象。
			 * @param {string} res.content - 响应内容。
			 * @returns {object} - 清理后的响应对象。
			 */
			// ★ 清理AI回复中可能模仿的sender标签
			function clearFormat(res) {
				let text = res.content
				if (text.match(/<sender>/))
					text = text.replace(/^<sender>[^<]*<\/sender>\s*/i, '')
				// 兼容旧格式
				if (text.match(/<\/content>\s*<\/message[^>]*>\s*$/))
					text = text.split(/<\/content>\s*<\/message[^>]*>\s*$/).shift()
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

			// Check for abort before starting
			if (signal?.aborted) {
				wbT(_wbChatid, 'ai:claude', 'StructCall:aborted', { phase: 'before-call' })
				throw makeAbortError()
			}

			// applyModelParams 仍需本地调用：claude 原生 API 走 anthropic shape，统一管线走 openai shape
			const _clPresetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
			const _clModelParams = _clPresetExt?.beilu_model_params || {}
			const { model: _clModel } = applyModelParams(_clModelParams, { shape: 'anthropic', model: config.model })
			const _clFinalModel = _clModel || config.model
			wbT(_wbChatid, 'ai:claude', 'StructCall:call:before', { model: _clFinalModel, msgCount: messages.length })
			result.content = await claudeAPI.callClaudeAPI(messages, _clFinalModel)
			wbD(_wbChatid, 'ai:claude', 'StructCall:call:after', !!result.content, 'callClaudeAPI返回空内容', { len: result.content?.length ?? 0 })
			previewUpdater?.(result) // [2026-08-01 严重bug修·可选回调] 调用方可不传预览回调（同 proxy httpFetch 修）

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
			encode: prompt => prompt, // 实际上不需要
			/**
			 * 解码令牌。
			 * @param {string} tokens - 要解码的令牌。
			 * @returns {string} 解码后的令牌。
			 */
			decode: tokens => tokens, // 实际上不需要
			/**
			 * 解码单个令牌。
			 * @param {string} token - 要解码的令牌。
			 * @returns {string} 解码后的令牌。
			 */
			decode_single: token => token, // 实际上不需要
			/**
			 * 获取令牌计数。
			 * @param {string} prompt - 要计算令牌的提示。
			 * @returns {number} 令牌数。
			 */
			get_token_count: prompt => countTokens(prompt),
		}
	}

	return result
}
