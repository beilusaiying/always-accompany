/**
 * 历史改写 Worker 静默等待策略的唯一 schema。
 *
 * 持久化入口：<user>/yonban_config.json
 *   advanced_limits.history_rewrite_worker_settle_timeout_ms
 *
 * 语义：等待真实 request_settled 的时限；超时后同一时限也用于确认 Worker terminate。
 * 缺省 30 秒，合法范围与 parts loader 的 user quiesce 契约一致：5 秒到 10 分钟。
 */
export const HISTORY_REWRITE_WORKER_SETTLE_POLICY = Object.freeze({
  key: "history_rewrite_worker_settle_timeout_ms",
  defaultMs: 30_000,
  minimumMs: 5_000,
  maximumMs: 10 * 60_000,
});

/**
 * @param {unknown} value - advanced_limits 中的原始配置；缺失时返回 schema 缺省值。
 * @returns {number}
 */
export function resolveHistoryRewriteWorkerSettleTimeoutMs(value) {
  const policy = HISTORY_REWRITE_WORKER_SETTLE_POLICY;
  if (value === undefined || value === null || value === "") return policy.defaultMs;
  const number = Number(value);
  if (
    !Number.isFinite(number)
    || !Number.isInteger(number)
    || number < policy.minimumMs
    || number > policy.maximumMs
  ) {
    const error = new Error(
      `advanced_limits.${policy.key} must be an integer from ${policy.minimumMs} to ${policy.maximumMs}; received ${String(value)}`,
    );
    error.code = "E_HISTORY_REWRITE_DEADLINE_INVALID";
    error.policyKey = policy.key;
    error.minimum = policy.minimumMs;
    error.maximum = policy.maximumMs;
    error.actual = value;
    throw error;
  }
  return number;
}
