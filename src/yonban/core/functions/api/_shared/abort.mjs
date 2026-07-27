// ============================================================================
// _shared/abort.mjs
// 用户中止（AbortError）构造共享层
// ----------------------------------------------------------------------------
// 背景：claude / claude-api / gemini / grok / ollama 五家 provider 共 9 处物理复制
//       了同一段「构造一个 name='AbortError' 的 Error 并抛出」逻辑（signal?.aborted
//       检测命中后、或流式 for-await 中途命中后）。8 处是三行形态：
//         const err = new Error('Aborted by user'); err.name = 'AbortError'; throw err
//       第 9 处（grok/grokAPI.mjs）是单行 Object.assign 变体，语义等价。本模块把
//       「构造该 Error」收敛为单一权威源，各 provider 改调本层。
//
// 为什么导出工厂（makeAbortError 返回 Error）而非 throwIfAborted(signal) 帮助函数：
//   - 各处的 wbT/wbD 埋点参数不同（chatid/line/phase 各异），且埋点位置（在 throw
//     前还是无埋点）也不同；若把检测 + 埋点 + throw 一并收进签名会破坏各 provider
//     的控制流与埋点差异。工厂只收敛「构造 Error」这一所有处逐字相同的部分，throw
//     与埋点仍留在调用方，故收口后各处控制流字节等价。
//   - 工厂不 throw，也兼容非 throw 用法（如 reader.cancel(makeAbortError())）。
//
// 不收口：proxy/lib/httpFetch.mjs 的 5 处。其文案是 'User Aborted'（非 'Aborted by
//   user'），且多数是 `if (e.name === 'AbortError') throw e` 的重抛（非构造），
//   语义与形态均不同，刻意不动。
// ============================================================================

/**
 * 构造一个表示「用户中止」的 Error（name = 'AbortError'）。不抛出，由调用方决定
 * 如何抛出 / 传递（throw / Object.assign 场景 / reader.cancel 场景均可）。
 * @param {string} [message='Aborted by user'] - 错误消息（默认对齐五家 provider 现有文案）
 * @returns {Error} name 已设为 'AbortError' 的 Error 实例
 */
export function makeAbortError(message = 'Aborted by user') {
	const err = new Error(message)
	err.name = 'AbortError'
	return err
}
