// ============================================================================
// _shared/buildInfo.mjs
// AI 源 info 字段构建共享层
// ----------------------------------------------------------------------------
// 背景：proxy / claude-api / gemini / ollama / grok / claude 六个 provider 共有
//       逐行等价的 info 字段构建逻辑：
//         Object.fromEntries(Object.entries(structuredClone(info_dynamic)).map(([k, v]) => {
//           v.name = config.name || config.model
//           return [k, v]
//         }))
//       本模块把该逻辑收敛为单一权威源，各 provider 改调本层。
//
// 不收口：
//   - polling：v.name = config.name（无 || config.model），语义不同，刻意不动。
//   - fallback / change-prompt：额外设 v.provider，语义不同，刻意不动。
//   - empty：v.name = config?.name || "Empty"，fallback 值不同，刻意不动。
// ============================================================================

/**
 * 从 info.dynamic.json 数据构建 AI 源的 info 字段。
 * @param {object} infoDynamic - 从 info.dynamic.json import 的对象（将被 structuredClone 保护）
 * @param {object} config - AI 源配置（需含 name 或 model 字段）
 * @returns {object} 构建好的 info 对象（每个 locale key → { name, ...} ）
 */
export function buildProviderInfo(infoDynamic, config) {
	return Object.fromEntries(Object.entries(structuredClone(infoDynamic)).map(([k, v]) => {
		v.name = config.name || config.model
		return [k, v]
	}))
}
