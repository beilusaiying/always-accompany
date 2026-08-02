/**
 * Claude API（官方） — 官方 Anthropic SDK（npm:@anthropic-ai/sdk）
 * API端点：https://api.anthropic.com（默认，可通过 config.base_url 覆盖）
 * 认证：API Key（config.apikey），支持 HTTP 代理（config.proxy_url → undici.ProxyAgent）
 *
 * 支持文本生成（流式/非流式）、图片输入（Base64 嵌入，仅 jpeg/png/gif/webp）、
 * 思考模式（extended_thinking + budgetTokens）、司令员模式（H1 五段式提示词组装）。
 * ⚠ Anthropic 必填 max_tokens，由 applyModelParams 共享层补齐（缺省回退 2048）。
 *
 * 【消息构建】2026-07-18 收口至 _shared/buildMessagesFromPromptStruct（所有 generator 单源）。
 *   buildMessages 输出 OpenAI 格式 → 本模块转 Anthropic 格式（system 提顶 + image_url→image + 仅 user/assistant）。
 *   发送端特有逻辑保留：Anthropic SDK 调用 / 缓存断点 / usage 统计。
 */
import { escapeRegExp } from '../../../../../scripts/escape.mjs'
// X1 统一参数应用层（A1）：anthropic 形状补 max_tokens（必填，修 400）+ model_override（修分身/子模式切模型）。
import { applyModelParams } from '../_shared/applyModelParams.mjs'
import { buildMessagesFromPromptStruct } from '../_shared/buildMessages.mjs'
import { findVolatileStart, resolveBpIndex } from '../_shared/volatileBoundary.mjs'
import { makeAbortError } from '../_shared/abort.mjs'

// 消息构建（commander/compat/图片/附件/宏替换）已收口到 _shared/buildMessages.mjs 统一管线。
// 本模块只做 OpenAI→Anthropic 格式转换 + Anthropic SDK 调用 + 缓存断点 + usage 统计。

import info_dynamic from '../../../../../public/parts/serviceGenerators/AI/claude-api/info.dynamic.json' with { type: 'json' }
import info from '../../../../../public/parts/serviceGenerators/AI/claude-api/info.json' with { type: 'json' }
import { buildProviderInfo } from '../_shared/buildInfo.mjs'

import { wbT, wbD } from "../../../../../server/wbStub.mjs";

/** @typedef {import('../../../../../decl/AIsource.ts').AIsource_t} AIsource_t */
/** @typedef {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t */

// Claude 支持的图片 MIME 类型
const defaultSupportedImageTypes = [
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
]

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

// Claude 模块的默认配置模板
const configTemplate = {
	name: 'claude-3.5-sonnet',
	apikey: '',
	model: '',
	model_arguments: {
	},
	proxy_url: '', // 例如 'http://127.0.0.1:7890'
	base_url: '', // 例如 'https://api.deepseek.com/anthropic'
	use_stream: true,
	allowed_mime_types: defaultSupportedImageTypes,
	// 文件处理占位文案逐键覆盖（键见 DEFAULT_FILE_NOTICES，空对象=全用默认）
	file_notices: {},
}

// 文件处理占位文案（0722 铁律迁移：进 messages 的文本必须用户可配，代码只持默认值——
//   gemini DEFAULT_ROLEPLAY_PROMPTS 同范式逐键覆盖；文本原样迁移未改一字。{mime} 由消费点填充）
const DEFAULT_FILE_NOTICES = {
	image_type_unsupported: '[System Info: Image type {mime} not supported by Claude]',
	image_non_base64_skipped: '[System Info: Non-base64 image URL skipped]',
}
/** 占位文案读取：config.file_notices 逐键覆盖 → 默认表；{k} 占位符插值 */
const _fnText = (config, key, params = {}) => {
	let t = config?.file_notices?.[key] || DEFAULT_FILE_NOTICES[key]
	for (const k in params) t = t.replaceAll(`{${k}}`, String(params[k]))
	return t
}

/**
 * 获取 AI 源。
 * @param {object} config - 配置对象。
 * @returns {Promise<AIsource_t>} AI 源。
 */
async function GetSource(config) {
	const { default: Anthropic } = await import('npm:@anthropic-ai/sdk')
	const supportedImageTypes = config.allowed_mime_types ?? defaultSupportedImageTypes
	wbD(null, 'ai:claude-api', 'GetSource:apikey', !!config.apikey, 'claude-api 未配置 apikey（出站将 401）', { hasBaseUrl: !!config.base_url, hasProxy: !!config.proxy_url })
	// 初始化 Anthropic 客户端
	const clientOptions = {
		apiKey: config.apikey,
		// 1h 缓存 TTL beta（0716 对齐本机代理参考实现 interceptor v5）：CACHE_MARK 用 ttl:"1h"，
		// API 只在带此 beta 标志时接受（无则 1h 被拒/忽略只按 5m）。官方直连无中转透传顾虑，直接挂默认头。
		defaultHeaders: { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
	}

	// 如果配置了 base_url，则设置自定义API地址
	if (config.base_url)
		clientOptions.baseURL = config.base_url


	// 如果配置了代理 URL，则设置HTTP代理
	if (config.proxy_url) {
		const undici = await import('npm:undici')
		clientOptions.fetchOptions = {
			dispatcher: new undici.ProxyAgent(config.proxy_url),
		}
		wbT(null, 'ai:claude-api', 'GetSource:proxy', { proxy_url: config.proxy_url })
	}

	const client = new Anthropic(clientOptions)
	wbT(null, 'ai:claude-api', 'GetSource:ready', { model: config.model, baseURL: config.base_url || '(default)', use_stream: config.use_stream !== false })

	/** @type {AIsource_t} */
	const result = {
		type: 'text-chat',
		info: buildProviderInfo(info_dynamic, config),
		is_paid: true,
		extension: {},

		// 简单的文本调用
		/**
		 * 调用 AI 源。
		 * @param {string} prompt - 要发送给 AI 的提示。
		 * @returns {Promise<{content: string}>} 来自 AI 的结果。
		 */
		Call: async prompt => {
			wbT(null, 'ai:claude-api', 'Call:enter', { model: config.model, promptLen: prompt?.length ?? 0, stream: !!config.use_stream })
			// X1 统一参数应用层（A1）：Call 路径无 prompt_struct（仅 prompt 字符串），无 beilu_model_params，
			// 经共享层补 anthropic 必填 max_tokens（缺省回退 2048，修 400）；采样器不传。
			const { args: _callApplied } = applyModelParams(undefined, { shape: 'anthropic', model: config.model })
			const params = {
				model: config.model,
				messages: [{ role: 'user', content: prompt }],
				..._callApplied,
				...config.model_arguments,
			}

			let text = ''

			try {
				if (config.use_stream) {
					const stream = await client.messages.create({ ...params, stream: true })
					for await (const event of stream)
						if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
							text += event.delta.text
				}
				else {
					const message = await client.messages.create(params)
					// Claude 的响应 content 是一个数组，我们只取文本部分
					text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
				}
			} catch (err) {
				wbD(null, 'ai:claude-api', 'Call:error', false, `claude-api Call 出站失败: ${err?.status ?? ''} ${err?.message || err}`, { status: err?.status, name: err?.name, type: err?.error?.type })
				throw err
			}

			wbD(null, 'ai:claude-api', 'Call:empty', !!text, 'claude-api Call 返回空内容', { len: text?.length ?? 0 })
			return { content: text }
		},

		// 结构化的多模态调用
		/**
		 * 使用结构化提示调用 AI 源。
		 * @param {prompt_struct_t} prompt_struct - 要发送给 AI 的结构化提示。
		 * @param {import('../../../../../decl/AIsource.ts').GenerationOptions} [options] - 生成选项。
		 * @returns {Promise<{content: string, files: any[]}>} 来自 AI 的结果。
		 */
		StructCall: async (/** @type {prompt_struct_t} */ prompt_struct, options = {}) => {
			const { base_result = {}, replyPreviewUpdater, signal } = options
			const _wbChatid = prompt_struct?.chatid ?? null
			wbT(_wbChatid, 'ai:claude-api', 'StructCall:enter', { model: config.model, chatLogLen: prompt_struct?.chat_log?.length ?? 0, stream: config.use_stream !== false })

			// Check for abort before starting
			if (signal?.aborted) {
				wbT(_wbChatid, 'ai:claude-api', 'StructCall:aborted', { phase: 'before-call' })
				throw makeAbortError()
			}

			// ★ 消息构建统一管线（2026-07-18 收口）：buildMessagesFromPromptStruct 是所有 generator 的单源，
			//   含 commander/compat 两分支 + 图片注入 + 宏替换。输出 OpenAI 格式 messages。
			//   Anthropic SDK 需 system 独立顶层 + messages 仅 user/assistant + 图片用 image source 格式，
			//   故下方做 OpenAI→Anthropic 格式转换。
			const callConfig = {
				...config,
				username: prompt_struct?.username || config.username,
				model_arguments: config.model_arguments ? { ...config.model_arguments } : {},
				convert_config: config.convert_config ? { ...config.convert_config } : {},
			}
			const { messages: oaiMessages, useXmlFormat, volatileStart: _caVolStartOai } = buildMessagesFromPromptStruct(prompt_struct, callConfig, configTemplate)
			const _caCommander = !useXmlFormat
			wbT(_wbChatid, 'ai:claude-api', _caCommander ? 'commander_mode' : 'compat_mode', { msgCount: oaiMessages.length })

			// ── OpenAI → Anthropic 格式转换 ──
			// 1. system 角色消息提取为顶层 system 参数（Anthropic 约束：messages 仅 user/assistant）
			// 2. image_url data URI → Anthropic image source（type:base64）
			// 3. 字符串 content → [{type:'text', text}] 数组
			let _systemText = ''
			const messages = []
			// [0722 审计 M2 收口] buildMessages 输出的权威 volatileStart 在本转换（剔 system 条）中
			//   同步换算成 Anthropic messages 下标——终结"权威值被丢弃、此处兜底扫描"的双源病。
			let _caVolRemapped = -1
			for (let _caI = 0; _caI < oaiMessages.length; _caI++) {
				const msg = oaiMessages[_caI]
				if (_caI === _caVolStartOai) _caVolRemapped = messages.length
				if (msg.role === 'system') {
					const _t = typeof msg.content === 'string' ? msg.content
						: Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
					if (_t) _systemText += (_systemText ? '\n\n' : '') + _t
					continue
				}
				const role = msg.role === 'user' ? 'user' : 'assistant'
				let content
				if (typeof msg.content === 'string') {
					content = [{ type: 'text', text: msg.content }]
				} else if (Array.isArray(msg.content)) {
					content = msg.content.map(part => {
						if (part.type === 'image_url' && part.image_url?.url) {
							// data:mime;base64,xxx → Anthropic {type:'image', source:{type:'base64', media_type, data}}
							const _m = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
							if (_m) {
								// 过滤不支持的图片类型
								if (!supportedImageTypes.includes(_m[1])) return { type: 'text', text: _fnText(config, 'image_type_unsupported', { mime: _m[1] }) }
								return { type: 'image', source: { type: 'base64', media_type: _m[1], data: _m[2] } }
							}
							return { type: 'text', text: _fnText(config, 'image_non_base64_skipped') }
						}
						return part // text parts pass through
					})
				} else {
					content = [{ type: 'text', text: '' }]
				}
				messages.push({ role, content })
			}

			// ── Anthropic SDK 请求参数构建 ──
			// X1 统一参数应用层（A1）：经共享层 anthropic 形状补 max_tokens（Anthropic 必填，修 400）
			// + 统一解析 model_override。采样器按 anthropic 白名单默认不传（Opus4.7+ 设非默认→400）。
			// commander 模式下 buildMessages 已将 model_override 写入 callConfig.model，此处再经 anthropic 形状确保 max_tokens。
			const _caPresetExt = prompt_struct.plugin_prompts?.['beilu-preset']?.extension
			const _caModelParams = _caPresetExt?.beilu_model_params
			const { args: _caApplied, model: _caModel } = applyModelParams(_caModelParams, { shape: 'anthropic', model: callConfig.model })
			const params = {
				model: _caModel || callConfig.model,
				system: _systemText,
				messages,
				..._caApplied,
				...config.model_arguments,
			}

			// ★ 缓存断点（0716 拍板对齐本机代理参考实现的断点）：interceptor v5 两断点设计
			//   bp1=顶层 system 末块；bp2=易变区前 2 条（seam-2）。
			//   易变区起点：② 尾部 8 条正文 volatile 标签扫描 ③ 倒数第 3 条位置启发式。
			//   ttl:"1h"（需 client defaultHeaders 的 extended-cache-ttl beta，已挂）。
			//   开关 config.cache_breakpoints===false 显式关。
			if (config.cache_breakpoints !== false) {
				const _CACHE_MARK = { type: 'ephemeral', ttl: '1h' }
				let _bps = 0
				if (typeof params.system === 'string' && params.system) {
					params.system = [{ type: 'text', text: params.system, cache_control: _CACHE_MARK }]
					_bps++
				}
				const _len2 = params.messages.length
				// [0722 审计 M1/M2/H1 收口] 易变起点=组装现场权威值换算（_caVolRemapped），未知时回退
				//   volatileBoundary 单源扫描（判据全集+共享常量，替换原本地 _VOL_RE/魔数 8/-3 副本）。
				const _volStart2 = _caVolRemapped >= 0 ? _caVolRemapped : findVolatileStart(params.messages)
				let _bp2idx = resolveBpIndex(_volStart2, _len2)
				if (_bp2idx > 0 && _bp2idx < _len2 - 1 && Array.isArray(params.messages[_bp2idx]?.content) && params.messages[_bp2idx].content.length > 0) {
					params.messages[_bp2idx].content[params.messages[_bp2idx].content.length - 1].cache_control = _CACHE_MARK
					_bps++
				} else _bp2idx = -1
				if (_bps > 0) console.log(`[claude-api] 缓存断点: ${_bps} 个 (bp1=system, bp2=@${_bp2idx}/${_len2}, vol=${_volStart2})`)
			}

			/**
			 * 清理 AI 响应的格式，移除 XML 标签和不完整的标记。
			 * @param {object} res - 原始响应对象。
			 * @param {string} res.content - 响应内容。
			 * @returns {object} - 清理后的响应对象。
			 */
			function clearFormat(res) {
				let text = res.content
				// ★ 适配新格式：<sender>名字</sender>\n内容
				// AI可能会在回复开头模仿 <sender>角色名</sender> 格式
				if (text.match(/<sender>/)) {
					// 移除AI回复中可能出现的sender标签
					text = text.replace(/^<sender>[^<]*<\/sender>\s*/i, '')
					// 如果AI模仿了其他角色的sender
					if (prompt_struct.alternative_charnames?.length) {
						const altPattern = new RegExp(
							`<sender>(?:${(prompt_struct.alternative_charnames || []).map(Object).map(
								s => s instanceof String ? escapeRegExp(s) : s.source
							).join('|')})<\\/sender>\\s*`, 'g'
						)
						text = text.split(altPattern).pop()
					}
				}
				// 兼容旧格式（<message><content>...）
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

			// Use streaming based on config（commander 模式下 buildMessages 可能覆盖 callConfig.use_stream）
			const useStream = (callConfig.use_stream ?? true) && !!replyPreviewUpdater

			// ★ 捕获usage信息（含cache token统计）
			let _usage = null

			// sysLen 语义校准（0716 断点批）：system 可能已是数组形态（bp1 标记），取文本总长而非数组长度
			const _wbSysLen = typeof params.system === 'string' ? params.system.length
				: Array.isArray(params.system) ? params.system.reduce((s, b) => s + (b?.text?.length || 0), 0) : 0
			wbD(_wbChatid, 'ai:claude-api', 'StructCall:system', !!_wbSysLen, 'claude-api system 段为空', { sysLen: _wbSysLen, msgCount: messages.length, commander: _caCommander })
			wbT(_wbChatid, 'ai:claude-api', 'StructCall:request:before', { model: params.model, msgCount: messages.length, useStream })
			try {
				if (useStream) {
					const stream = await client.messages.create({ ...params, stream: true, signal })
					for await (const event of stream) {
						if (signal?.aborted) {
							throw makeAbortError()
						}
						if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
							result.content += event.delta.text
							previewUpdater?.(result) // [2026-08-01 严重bug修·可选回调] 调用方可不传预览回调（同 proxy httpFetch 修）
						}
						// ★ 捕获 message_start 和 message_delta 中的 usage
						if (event.type === 'message_start' && event.message?.usage) {
							_usage = { ...event.message.usage }
						}
						if (event.type === 'message_delta' && event.usage) {
							_usage = { ..._usage, ...event.usage }
						}
					}
				}
				else {
					const message = await client.messages.create({ ...params, signal })
					result.content = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
					_usage = message.usage || null
					previewUpdater?.(result) // [2026-08-01 严重bug修·可选回调] 调用方可不传预览回调（同 proxy httpFetch 修）
				}
			} catch (err) {
				if (err?.name === 'AbortError') { wbT(_wbChatid, 'ai:claude-api', 'StructCall:aborted', { phase: 'in-stream' }); throw err }
				// Anthropic SDK 错误：401/403 鉴权、429 限流、4xx 请求、5xx/网络 出站失败
				const _s = err?.status
				const _cat = _s === 401 || _s === 403 ? 'auth' : _s === 429 ? 'rate_limit' : (_s >= 500 || _s === undefined) ? 'network' : 'request'
				wbD(_wbChatid, 'ai:claude-api', 'StructCall:error', false, `claude-api 出站失败(${_cat}) ${_s ?? ''}`, { category: _cat, status: _s, name: err?.name, type: err?.error?.type, message: String(err?.message || err).slice(0, 200) })
				throw err
			}
			wbT(_wbChatid, 'ai:claude-api', 'StructCall:request:after', { contentLen: result.content?.length ?? 0 })
			wbD(_wbChatid, 'ai:claude-api', 'StructCall:empty', !!result.content, 'claude-api StructCall 返回空内容', { len: result.content?.length ?? 0 })

			// ★ 将cache token信息附加到结果的extension中
			if (_usage) {
				result.extension = result.extension || {}
				result.extension._token_usage = {
					input_tokens: _usage.input_tokens || 0,
					output_tokens: _usage.output_tokens || 0,
					cache_creation_input_tokens: _usage.cache_creation_input_tokens || 0,
					cache_read_input_tokens: _usage.cache_read_input_tokens || 0,
				}
				const _cacheRead = _usage.cache_read_input_tokens || 0
				const _cacheWrite = _usage.cache_creation_input_tokens || 0
				const _input = _usage.input_tokens || 0
				if (_cacheRead > 0 || _cacheWrite > 0) {
					console.debug(`[claude-api] Token usage: input=${_input}, output=${_usage.output_tokens || 0}, cache_read=${_cacheRead}, cache_write=${_cacheWrite} (命中率: ${_input > 0 ? Math.round(_cacheRead / (_input + _cacheRead) * 100) : 0}%)`)
				}
			}

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
			get_token_count: prompt => prompt?.length ?? 0,
		}
	}

	return result
}
