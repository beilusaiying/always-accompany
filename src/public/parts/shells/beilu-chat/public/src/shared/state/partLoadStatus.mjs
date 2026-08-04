/**
 * partLoadStatus.mjs — 部件加载状态的前端协议语义
 *
 * 只描述 server/parts_loader.mjs 经 monitor.reportPluginStatus 当前真实产生的状态。
 * 本模块必须保持无 DOM、无 transport、无初始化副作用，供监控面板与设置面板共同复用。
 */

export const PART_LOAD_STATUS_KIND = Object.freeze({
  "load-error": "failure",
  "shallow-load-error": "failure",
  "preload-error": "failure",
  "unload-error": "failure",
  inited: "pending",
  loaded: "success",
  unloaded: "inactive",
});

/**
 * 将后端部件状态归一为前端展示语义；未知值保持 unknown，不能误标为健康。
 */
export function classifyPartLoadStatus(status) {
  return PART_LOAD_STATUS_KIND[typeof status === "string" ? status : ""] || "unknown";
}

function legacyDetailFields(payload) {
  const detail = payload?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return {
      message: detail.detail ?? detail.message ?? "",
      code: payload?.code ?? detail.code ?? "",
      classification: payload?.classification ?? detail.classification ?? "",
    };
  }
  return {
    message: detail ?? payload?.message ?? "",
    code: payload?.code ?? "",
    classification: payload?.classification ?? "",
  };
}

/**
 * 为即时 event 和 poll entry 生成同一去重键。
 * 新协议必须共用 occurrenceId；旧 producer 缺 ID 时明确返回 legacyFingerprint=true，
 * 由消费端可见告警，不得把协议缺口静默吞掉。
 */
export function resolvePartLoadOccurrence(payload, fallbackPartpath = "") {
  const occurrenceId = typeof payload?.occurrenceId === "string" ? payload.occurrenceId.trim() : "";
  if (occurrenceId) {
    return { key: `occurrence:${occurrenceId}`, occurrenceId, legacyFingerprint: false };
  }

  const partpath = String(payload?.partpath || payload?.name || fallbackPartpath || "?");
  const status = String(payload?.status || "load-error");
  const { message, code, classification } = legacyDetailFields(payload);
  const fingerprint = JSON.stringify([
    partpath,
    status,
    String(code || ""),
    String(classification || ""),
    typeof message === "string" ? message : JSON.stringify(message),
  ]);
  return { key: `legacy:${fingerprint}`, occurrenceId: null, legacyFingerprint: true };
}
