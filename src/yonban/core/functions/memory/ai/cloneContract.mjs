/** Pure clone command/result/event contract. No IO, AI, storage, transport or UI dependencies. */

export const CLONE_CONFIG_DEFAULTS = Object.freeze({
  contextMessages: 10,
  maxContext: 1000000,
  maxTokens: 60000,
  maxRounds: 50,
  temperature: 0.5,
  promptPostProcessing: "strict",
  prefillEnabled: true,
  claudePrefillMode: "",
  includeReasoning: false,
});

export const CLONE_READ_MD_PERMISSIONS = Object.freeze({
  read_file: true,
  list_files: true,
  search_files: true,
  search_by_name: true,
  get_diagnostics: true,
  get_status: false,
  run_command: false,
  write_md: true,
  write_code: false,
  delete: false,
  github_upload: false,
  web_search: true,
  web_download: true,
});

export function createDefaultCloneConfigs() {
  const readMd = { ...CLONE_READ_MD_PERMISSIONS };
  return normalizeCloneConfigs([
    { id: 1, label: "审查分身", enabled: true, presetName: "分身_全能型", apiSource: "", modelName: "", permissions: { ...readMd } },
    { id: 2, label: "收集分身", enabled: false, presetName: "分身_大型调查", apiSource: "", modelName: "", permissions: { ...readMd }, contextMessages: 8 },
    { id: 3, label: "代码工作分身", enabled: false, presetName: "分身_代码更改", apiSource: "", modelName: "", permissions: { ...readMd, write_code: true, run_command: true, fuzzy_edit: true, replace_lines: true, insert_at_line: true }, contextMessages: 12 },
    { id: 4, label: "框架线路追踪分身", enabled: false, presetName: "分身_调查追踪", apiSource: "", modelName: "", permissions: { ...readMd }, contextMessages: 15 },
    { id: 5, label: "批量任务分身", enabled: false, presetName: "分身_全能型", apiSource: "", modelName: "", permissions: { ...readMd, run_command: true }, contextMessages: 6 },
    { id: 6, label: "测试分身", enabled: false, presetName: "分身_测试实验", apiSource: "", modelName: "", permissions: { ...readMd, run_command: true } },
  ]);
}

function cloneConfigError(clone, message) {
  return new Error(`分身 ${clone?.id ?? "?"} ${message}`);
}

export function normalizeCloneConfig(rawClone, previousClone = {}) {
  if (!rawClone || typeof rawClone !== "object" || Array.isArray(rawClone)) throw new Error("分身配置项必须是对象");
  const clone = {
    ...CLONE_CONFIG_DEFAULTS,
    ...(previousClone && typeof previousClone === "object" ? previousClone : {}),
    ...rawClone,
    permissions: {
      ...CLONE_READ_MD_PERMISSIONS,
      ...(previousClone?.permissions && typeof previousClone.permissions === "object" && !Array.isArray(previousClone.permissions) ? previousClone.permissions : {}),
      ...(rawClone.permissions && typeof rawClone.permissions === "object" && !Array.isArray(rawClone.permissions) ? rawClone.permissions : {}),
    },
  };
  if (clone.id === undefined || clone.id === null || String(clone.id).trim() === "") throw cloneConfigError(clone, "id 不能为空");
  clone.label = typeof clone.label === "string" ? clone.label.trim() : "";
  if (!clone.label) throw cloneConfigError(clone, "名称不能为空");
  if (rawClone.enabled !== undefined && typeof rawClone.enabled !== "boolean") throw cloneConfigError(clone, "enabled 必须是布尔值");
  clone.enabled = clone.enabled === true;
  if (rawClone.permissions !== undefined && (!rawClone.permissions || typeof rawClone.permissions !== "object" || Array.isArray(rawClone.permissions))) {
    throw cloneConfigError(clone, "permissions 必须是对象");
  }
  for (const key of ["contextMessages", "maxContext", "maxTokens"]) {
    if (!Number.isInteger(clone[key]) || clone[key] <= 0) throw cloneConfigError(clone, `${key} 必须是正整数`);
  }
  if (!Number.isInteger(clone.maxRounds) || clone.maxRounds < 0 || clone.maxRounds > 10000) {
    throw cloneConfigError(clone, "最大工作轮次必须是 0-10000 的整数（0=无限）");
  }
  if (!Number.isFinite(clone.temperature) || clone.temperature < 0 || clone.temperature > 2) throw cloneConfigError(clone, "temperature 必须是 0-2 的有限数");
  if (typeof clone.promptPostProcessing !== "string" || !clone.promptPostProcessing.trim()) throw cloneConfigError(clone, "promptPostProcessing 不能为空");
  clone.promptPostProcessing = clone.promptPostProcessing.trim();
  if (typeof clone.prefillEnabled !== "boolean") throw cloneConfigError(clone, "prefillEnabled 必须是布尔值");
  if (typeof clone.claudePrefillMode !== "string") throw cloneConfigError(clone, "claudePrefillMode 必须是字符串");
  if (typeof clone.includeReasoning !== "boolean") throw cloneConfigError(clone, "includeReasoning 必须是布尔值");
  return clone;
}

export function normalizeCloneConfigs(rawClones, previousClones = []) {
  if (!Array.isArray(rawClones)) throw new Error("分身配置必须是数组");
  const previousById = new Map((Array.isArray(previousClones) ? previousClones : []).map((clone) => [String(clone?.id), clone]));
  const clones = rawClones.map((clone) => normalizeCloneConfig(clone, previousById.get(String(clone?.id))));
  const ids = new Set();
  const labels = new Set();
  for (const clone of clones) {
    const id = String(clone.id);
    if (ids.has(id)) throw cloneConfigError(clone, `id 重复: ${id}`);
    if (labels.has(clone.label)) throw cloneConfigError(clone, `名称重复: ${clone.label}`);
    ids.add(id);
    labels.add(clone.label);
  }
  return clones;
}

export function resolveCloneMaxWorkRounds(configuredValue, overrideValue) {
  const hasOverride = overrideValue !== undefined && overrideValue !== null && overrideValue !== "";
  const raw = hasOverride ? overrideValue : configuredValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10000) {
    throw new Error(`分身最大工作轮次无效: ${String(raw)}（必须是 0-10000 的整数，0=无限）`);
  }
  return value;
}

export function parseCloneCompletion(content) {
  const source = String(content || "");
  const matches = [...source.matchAll(/<completionVerify(?:\s[^>]*)?>([\s\S]*?)<\/completionVerify>/gi)];
  const evidence = matches.map((item) => String(item[1] || "").trim()).find(Boolean) || "";
  return {
    explicit: evidence.length > 0,
    evidence,
    content: source
      .replace(/<completionVerify(?:\s[^>]*)?\/>/gi, "")
      .replace(/<completionVerify(?:\s[^>]*)?>[\s\S]*?<\/completionVerify>/gi, "")
      .trim(),
  };
}

export function cloneTerminalShape(terminalReason, hasProgress, snapshotSaved) {
  const success = terminalReason === "completed";
  const partialReason = new Set(["max_rounds", "repeat_stopped", "user_aborted", "parent_aborted"]);
  const completion = success ? "complete" : (hasProgress ? "partial" : "none");
  const status = success ? "completed" : (partialReason.has(terminalReason) ? "partial" : "error");
  return { state: "terminal", status, terminalReason, completion, success, resumable: !success && snapshotSaved === true };
}

const CLONE_TERMINAL_EVENT_STATUSES = new Set(["completed", "stopped", "error"]);

export function isCloneTerminalEventStatus(status) {
  return CLONE_TERMINAL_EVENT_STATUSES.has(status);
}

export function createCloneStatusEvent(job, {
  sequence,
  round = 0,
  tools = 0,
  status,
  detail = "",
  occurredAt = new Date().toISOString(),
  label = "",
  terminalReason = null,
  completion = null,
  resultStatus = null,
  resumable = null,
  ai = null,
} = {}) {
  const seq = Number(sequence);
  const taskId = job?.taskId;
  if (!job?.ownerUsername || !job?.chatId || !job?.cloneBatchId || !job?.jobId
    || taskId === undefined || taskId === null || !Number.isInteger(seq) || seq < 0 || !status) {
    throw new Error("分身状态事件缺少完整 job 身份/sequence/status");
  }
  const eventJob = Object.freeze({ ...job });
  const state = isCloneTerminalEventStatus(status)
    ? "terminal"
    : status === "batch_queued" || status === "ai_queued" || status === "ai_waiting"
      ? "queued"
      : status === "accepted"
        ? "accepted"
        : "running";
  return Object.freeze({
    schemaVersion: 1,
    eventId: `${eventJob.jobId}:${seq}`,
    occurredAt,
    timestamp: occurredAt,
    sequence: seq,
    state,
    status,
    detail: String(detail || ""),
    round: Number(round) || 0,
    tools: Number(tools) || 0,
    label: String(label || ""),
    terminalReason,
    completion,
    resultStatus,
    resumable,
    ai,
    job: eventJob,
    ownerUsername: eventJob.ownerUsername,
    chatId: eventJob.chatId,
    parentGenerationId: eventJob.parentGenerationId || null,
    cloneBatchId: eventJob.cloneBatchId,
    taskId: eventJob.taskId,
    jobId: eventJob.jobId,
    source: eventJob.source || "subagent",
  });
}

export function inferCloneTaskType(label, instruction) {
  const hay = `${label || ""}\n${instruction || ""}`;
  if (/改代码|改\s*bug|修复|实现|重构|打补丁|写函数|编码|coding|代码专家|coder|fix\b|implement|refactor|施工|写入代码|修改.*(函数|方法|文件.*代码)/i.test(hay)) return "code";
  if (/配表|公式|表格|单元格|xlsx|excel|数值|重算|校验.*(表|数)|赏池|gacha|权重表|参数表|配置表|spreadsheet|formula|cell\b/i.test(hay)) return "data";
  if (/调查|采集|溯源|审计|审查|侦察|梳理|分析|搜集|阅读|读取|查找|定位|总结|归纳|报告|调研|research|investigate|audit|survey|读.*(代码|文件|表|MD)|找.*(实现|代码|出处|根因)/i.test(hay)) return "research";
  return null;
}

export function resolveCloneConfig(configSnapshot, task = {}, cloneId, { requireEnabled = false } = {}) {
  const clones = normalizeCloneConfigs(configSnapshot?.clones || []);
  let selected;
  if (cloneId !== undefined && cloneId !== null && String(cloneId) !== "") {
    selected = clones.find((item) => String(item.id) === String(cloneId));
    if (!selected) throw new Error(`未找到分身配置 ${cloneId}`);
  } else if (task?.cloneName) {
    selected = clones.find((item) => item.label === String(task.cloneName).trim());
    if (!selected) throw new Error(`未找到分身配置：${task.cloneName}`);
  } else {
    selected = clones.find((item) => item.enabled);
    if (!selected) throw new Error("没有启用的分身配置");
  }
  if (requireEnabled && !selected.enabled) throw new Error(`分身配置已关闭：${selected.label}`);
  return selected;
}
