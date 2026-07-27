// ============================================================================
// _shared/applyModelParams.mjs
// X1 统一参数应用层（A1 修 claude-api 缺 max_tokens→400 / 缺 model_override 切模型失效）
// ----------------------------------------------------------------------------
// 背景：提取层单源 ✓（preset_engine.mjs:725 extractModelParams 产 beilu_model_params 全量），
//       但消费层无共享映射——proxy/gemini/ollama/grok/claude/claude-api 六家各自手写
//       「读 beilu_model_params → 按自己 API 命名映射」，导致(a)覆盖面不一致 (b)claude-api
//       整段漏（0 参数）(c)改一处漏别处。本模块把「canonical → provider 形状映射 + 能力
//       白名单 + model_override 统一解析」收敛为单一权威源。
//
// canonical 字段（来自 preset_engine.mjs:725-743，单一来源）：
//   temperature / frequency_penalty / presence_penalty / top_p / top_k / top_a /
//   min_p / repetition_penalty / max_tokens / seed / n
//   + model_override（不在 extractor，子模式/分身切模型时另注入 beilu_model_params.model_override）
//
// 市场事实（Batch1-A 查证）：Anthropic Opus 4.7+（含 4.8）已不支持 temperature/top_p/top_k
//   （设非默认→400），但 max_tokens 必填。→ anthropic 形状白名单默认空采样器、只 max_tokens+
//   model；老模型经 behavior.allowSamplers 放行。top_a=OpenRouter 专属，仅 openai 形状含。
//
// Phase 1+2+3 完成：claude-api(anthropic) + proxy(openai) + gemini(gemini) + ollama(ollama) + grok(openai) + claude(anthropic)
//   六家已全部接入本共享层。注：grok/claude 为逆向 API，底层不支持标准采样器参数，
//   仅经共享层统一解析 model_override。各 provider main.mjs StructCall 内 applyModelParams 调用可 grep 复核。
// ============================================================================

/**
 * 各 shape 的默认能力白名单（canonical 键集合）。
 * 不传 spec.whitelist 时按此 shape 默认裁剪采样器。
 * - openai: 全采样器（proxy/grok，top_a 仅此 shape 有）
 * - gemini: generationConfig 支持的子集
 * - ollama: native options 支持的子集
 * - anthropic: 默认空采样器（Opus4.7+ 拒），max_tokens 始终单独必传、不在此白名单内
 */
// 参数缺省单源（2026-07-08 链路2）：空窗兜底值改读 PARAM_SCHEMA，与引擎层/前端 UI 同一张表
import { paramDefault } from '../../prompt/preset/engine/paramSchema.mjs'

const SHAPE_DEFAULT_WHITELIST = {
	openai: ['temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'],
	gemini: ['temperature', 'top_p', 'top_k', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'seed'],
	ollama: ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_tokens', 'min_p', 'seed'],
	anthropic: [], // 默认不传采样器；老模型经 behavior.allowSamplers 放行 temperature/top_p/top_k
}

/**
 * canonical 键 → 各 shape 的目标命名（仅命名不同者列出；未列=同名）。
 * openai/ollama 多数同名；gemini/anthropic 需改名。
 */
const SHAPE_RENAME = {
	openai: {}, // 全同名
	gemini: { top_p: 'topP', top_k: 'topK', max_tokens: 'maxOutputTokens', frequency_penalty: 'frequencyPenalty', presence_penalty: 'presencePenalty' },
	ollama: { repetition_penalty: 'repeat_penalty', max_tokens: 'num_predict' },
	anthropic: {}, // max_tokens 单独处理，采样器默认不传
}

/**
 * 哨兵守卫：与提取层默认值相等（= 用户未改）时不下发，避免无谓覆盖各 provider 自身默认。
 * 对齐 proxy/main.mjs:220-261 的 `!== 1 / > 0 / !== -1 / !== 0` 语义。
 * 返回 true = 该值有效、应下发。
 */
function _isMeaningful(key, v) {
	if (v === undefined || v === null) return false
	switch (key) {
		case 'temperature': return true // temperature 任何显式值都下发（含 0）
		case 'top_p': return v !== 1
		case 'top_k': return v > 0
		case 'top_a': return v > 0
		case 'min_p': return v > 0
		case 'repetition_penalty': return v !== 1
		case 'frequency_penalty': return v !== 0
		case 'presence_penalty': return v !== 0
		case 'seed': return v !== -1
		case 'max_tokens': return Number(v) > 0
		default: return true
	}
}

/**
 * 解析统一的 model_override：beilu_model_params.model_override（子模式/分身切模型）优先，
 * 否则回退 spec.model（= config.model）。6 provider 一致。
 * @param {object} mp - beilu_model_params
 * @param {object} spec
 * @returns {string|undefined}
 */
function resolveModel(mp, spec) {
	return (mp && mp.model_override) || (spec && spec.model) || undefined
}

/**
 * 统一参数应用层：把 canonical beilu_model_params 映射为目标 provider 形状的参数对象，
 * 并统一解析 model_override。
 *
 * @param {object} beilu_model_params - 提取层产物（preset_engine extractModelParams），可空。
 * @param {object} spec
 * @param {'openai'|'gemini'|'ollama'|'anthropic'} spec.shape - API 形状（必填）
 * @param {string[]} [spec.whitelist] - 限制下发的 canonical 采样器键集合；不传=按 shape 默认
 * @param {string} [spec.model] - 该 provider 的 config.model，用于 model_override 兜底
 * @param {object} [spec.behavior] - 形状内行为开关
 * @param {boolean} [spec.behavior.allowSamplers] - anthropic 老模型放行 temperature/top_p/top_k
 * @returns {{args: object, model: (string|undefined)}}
 *   args  = 目标形状的参数对象（openai/ollama 扁平；gemini generationConfig 命名；
 *           anthropic 仅 { max_tokens }，采样器默认不含）
 *   model = model_override || spec.model
 */
export function applyModelParams(beilu_model_params, spec = {}) {
	const shape = spec.shape
	if (!shape || !(shape in SHAPE_DEFAULT_WHITELIST))
		throw new TypeError(`[applyModelParams] 未知 shape: ${String(shape)}（须为 openai/gemini/ollama/anthropic）`)

	const mp = beilu_model_params && typeof beilu_model_params === 'object' ? beilu_model_params : {}
	const model = resolveModel(mp, spec)
	const args = {}

	if (shape === 'anthropic') {
		// Anthropic：max_tokens 必传（缺省回退 PARAM_SCHEMA 单源，与 extractor 同表）。
		// 采样器默认不传（Opus4.7+ 设非默认→400）；behavior.allowSamplers=true 时放行老模型。
		const _mt = mp.max_tokens
		args.max_tokens = _isMeaningful('max_tokens', _mt) ? Number(_mt) : paramDefault('max_tokens')
		if (spec.behavior && spec.behavior.allowSamplers) {
			for (const key of ['temperature', 'top_p', 'top_k']) {
				if (_isMeaningful(key, mp[key])) args[key] = mp[key]
			}
		}
		return { args, model }
	}

	// openai / gemini / ollama：按 shape 默认白名单 ∩ spec.whitelist 裁剪，按 rename 映射，过哨兵守卫。
	const whitelist = Array.isArray(spec.whitelist)
		? SHAPE_DEFAULT_WHITELIST[shape].filter(k => spec.whitelist.includes(k))
		: SHAPE_DEFAULT_WHITELIST[shape]
	const rename = SHAPE_RENAME[shape]

	for (const key of whitelist) {
		const v = mp[key]
		if (!_isMeaningful(key, v)) continue
		const targetKey = rename[key] || key
		args[targetKey] = v
	}

	return { args, model }
}

export default applyModelParams
