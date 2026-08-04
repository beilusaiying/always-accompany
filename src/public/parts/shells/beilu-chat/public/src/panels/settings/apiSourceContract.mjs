/**
 * API 源保存读回契约。
 *
 * 两套设置 UI 共用同一比较逻辑，避免一处只看 HTTP 成功、另一处只看 generator，
 * 最终把部分落盘或旧缓存读回误报成成功。
 */

function sameJsonValue(left, right) {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((value, index) => sameJsonValue(value, right[index]))
	}
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
	const leftKeys = Object.keys(left).sort()
	const rightKeys = Object.keys(right).sort()
	if (leftKeys.length !== rightKeys.length) return false
	return leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]))
}

export function assertApiSourceReadback(persisted, expected, operation = '保存') {
	if (!persisted || typeof persisted !== 'object')
		throw new Error(`${operation}后无法读回 API 配置`)
	if (persisted.generator !== expected.generator || !sameJsonValue(persisted.config, expected.config))
		throw new Error(`${operation}后读回的 API 配置与提交内容不一致`)
	return persisted
}

export function isApiSourceMarkedUsable(saveResult, sourceName) {
	return Array.isArray(saveResult?.setup?.usableSourceNames)
		&& saveResult.setup.usableSourceNames.includes(sourceName)
}
