/**
 * 插件接线短暂不可达的纯判定契约。
 *
 * 只有后端明确证明处理器尚未执行的错误才能重试；普通超时、断连和业务失败可能已有副作用，
 * 不能由传输层猜测重放。保持为无浏览器依赖的叶子模块，便于独立验证该安全边界。
 */
export const PLUGIN_LINK_MAX_ATTEMPTS = 3;
export const PLUGIN_LINK_RETRY_MIN_MS = 150;
export const PLUGIN_LINK_RETRY_MAX_MS = 2000;

export function isRetryablePluginLinkError(error, target) {
	if (typeof target !== "string" || !target.startsWith("plugins:")) return false;
	const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
	const code = String(error?.code ?? payload?.code ?? "");
	const retryable = error?.retryable === true || payload?.retryable === true;
	return code === "E_NODE" || code === "E_PART_ROUTE_UNAVAILABLE" ||
		(code.startsWith("E_PART_") && retryable);
}

export function pluginLinkRetryDelay(error, attempt) {
	const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
	const hinted = Number(error?.retryAfterMs ?? payload?.retryAfterMs);
	const fallback = 200 * attempt;
	return Math.max(
		PLUGIN_LINK_RETRY_MIN_MS,
		Math.min(PLUGIN_LINK_RETRY_MAX_MS, Number.isFinite(hinted) && hinted >= 0 ? hinted : fallback),
	);
}
