// ============================================================================
// _shared/roleReminding.mjs
// R10 dedup：多角色 roleReminding 检测 + 提醒消息注入（2026-06-23）
// ----------------------------------------------------------------------------
// 原 grok:152-160 / proxy:237-249 / ollama:181-191 各自手抄一份等价检测逻辑，
// 收敛到此。检测部分三家逐字等价（isMutiChar = Set(name).size > 2），
// 提醒文案作参数（中/英），whitebox 遥测作可选回调（各家 tag 不同）。
// ============================================================================

// 提醒文案单源（2026-07-08 链路3·代码零提示词方向）：原 proxy/grok 各写死中文、ollama 写死
// 英文=同功能三份不同源文案；收敛为此一份（中文为主语言，ollama 英文并入）。
// 用户可改路径：convert_config.role_reminding_text（源级配置，display.mjs 有编辑框，
// 三家调用点读用户值传入，未配置回退此默认）。文本本身归用户/凛倾域，此处仅机制收敛。
export const DEFAULT_ROLE_REMINDING_TEXT = '现在请以{charname}的身份续写对话。'

/**
 * 检测 chat_log 是否为多角色对话（>2 个不同 name）。
 * 等价于原 grok/proxy/ollama 的 isMutiChar 检测。
 * @param {Array<object>} chatLog - prompt_struct.chat_log
 * @returns {boolean}
 */
export function isMultiChar(chatLog) {
	return new Set((chatLog || []).map(e => e.name).filter(Boolean)).size > 2
}

/**
 * roleReminding 完整流程：检测多角色 → 可选遥测 → 向 messages 尾部追加系统提醒。
 *
 * @param {object} opts
 * @param {Array<object>} opts.messages    - 当前消息数组（会被 push 修改）
 * @param {object}        opts.promptStruct - prompt_struct（取 .chat_log 和 .Charname）
 * @param {string}        [opts.text]       - 提醒文案模板，`{charname}` 会被替换为 Charname；
 *                                            缺省=DEFAULT_ROLE_REMINDING_TEXT（调用方传用户配置值，未配置传 undefined 即回退单源）
 * @param {(isMutiChar:boolean)=>void} [opts.onDetect] - 检测后回调（无论是否命中），用于 wbT 遥测
 * @param {(isMutiChar:boolean)=>void} [opts.onHit]    - 命中多角色时回调（push 前），用于 wbT/wbD 遥测
 * @returns {boolean} 是否追加了提醒消息
 */
export function maybeAppendRoleReminder(opts) {
	const { messages, promptStruct, text = DEFAULT_ROLE_REMINDING_TEXT, onDetect, onHit } = opts
	const _isMulti = isMultiChar(promptStruct.chat_log)
	if (typeof onDetect === 'function') try { onDetect(_isMulti) } catch { /* 遥测失败不影响主逻辑 */ }
	if (_isMulti) {
		if (typeof onHit === 'function') try { onHit(_isMulti) } catch { /* 遥测失败不影响主逻辑 */ }
		messages.push({
			role: 'system',
			content: text.replace('{charname}', promptStruct.Charname || '')
		})
		return true
	}
	return false
}
