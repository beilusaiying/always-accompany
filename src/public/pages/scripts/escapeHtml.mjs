/**
 * escapeHtml.mjs — pages（登录页/目录列表等）HTML 转义唯一共享点（T7 收口）
 *
 * why：
 *   pages 下 login/directory-listing 各自 private 一份 escapeHtml（textContent→innerHTML 法，
 *   只转义 & < >，不转义引号——属性上下文不安全）。pages 与 chat 壳跨边界（且 pages 无 import
 *   beilu-chat 先例），故在 pages/scripts 内建单一共享点，逐字对齐 chat 壳权威版
 *   （shells/beilu-chat/.../shared/state/utils.mjs escapeHtml，5 字符含单引号）。
 *
 * 转义 & < > " ' 五字符——属性上下文（含单/双引号）与文本上下文均安全。
 * null/undefined/数字一律 String() 兜底。
 */
export function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}
