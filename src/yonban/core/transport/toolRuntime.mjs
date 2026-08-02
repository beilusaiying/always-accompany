/**
 * 工具运行时配置与 Job 注册表。
 *
 * 本模块只生产系统数据，不生成任何进入 AI 对话的提示词。用户可编辑配置的唯一持久化位置是
 * yonban_config.json 的 tool_runtime 字段；调用链和前端都读取同一份归一化结果。
 */

import fs from "node:fs";
import { getYonbanConfigPath } from "../functions/memory/storage_mod/storage.mjs";

export const TOOL_RUNTIME_DEFAULTS = Object.freeze({
  response_timeout_ms: 180000,
  transport_grace_ms: 10000,
  late_result_retention_ms: 900000,
  long_running_after_ms: 15000,
  notify_long_running: true,
  notify_stalled: true,
  notify_completed: true,
  notify_failed: true,
  auto_continue_late_results: true,
  late_result_continue_delay_ms: 1000,
  history_limit: 200,
  read_default_line_limit: 500,
  read_max_line_limit: 5000,
  read_max_output_chars: 20000,
  search_default_page_size: 50,
  search_max_page_size: 200,
  search_snapshot_ttl_ms: 120000,
  search_max_snapshot_results: 2000,
  search_timeout_ms: 10000,
  search_snapshot_cache_max_entries: 32,
  search_snapshot_cache_max_results: 20000,
  command_watchdog_enabled: true,
  command_watchdog_action: "terminate",
  command_watchdog_stall_ms: 60000,
  command_watchdog_sample_ms: 5000,
  command_watchdog_cpu_delta_ms: 10,
  command_watchdog_rss_delta_bytes: 1048576,
  command_watchdog_progress_ms: 10000,
});

// 已存在的用户配置不可读/损坏时，运行期只能保留工具 I/O 的保守边界；
// 通知与自动续轮必须 fail-closed，不能把用户已经关闭的行为静默重新开启。
const TOOL_RUNTIME_ERROR_FALLBACK = Object.freeze({
  ...TOOL_RUNTIME_DEFAULTS,
  notify_long_running: false,
  notify_stalled: false,
  notify_completed: false,
  notify_failed: false,
  auto_continue_late_results: false,
  command_watchdog_enabled: false,
  command_watchdog_action: "report",
});

const _toolRuntimeReadDiagnostics = new Map();

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "connection_lost",
  "orphan_result",
]);

const STATE_TRANSITIONS = Object.freeze({
  queued: new Set(["sent", "running", "wait_timeout", "detached", ...TERMINAL_STATES]),
  sent: new Set(["running", "wait_timeout", "detached", ...TERMINAL_STATES]),
  running: new Set(["wait_timeout", "detached", ...TERMINAL_STATES]),
  wait_timeout: new Set([...TERMINAL_STATES]),
  detached: new Set([...TERMINAL_STATES]),
});

function _ownerKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function _canTransition(from, to) {
  if (!to || from === to) return true;
  if (TERMINAL_STATES.has(from)) return false;
  return STATE_TRANSITIONS[from]?.has(to) === true;
}

function _boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeToolRuntimeConfig(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const normalized = {
    response_timeout_ms: _boundedInt(
      source.response_timeout_ms,
      TOOL_RUNTIME_DEFAULTS.response_timeout_ms,
      1000,
      3600000,
    ),
    transport_grace_ms: _boundedInt(
      source.transport_grace_ms,
      TOOL_RUNTIME_DEFAULTS.transport_grace_ms,
      0,
      300000,
    ),
    late_result_retention_ms: _boundedInt(
      source.late_result_retention_ms,
      TOOL_RUNTIME_DEFAULTS.late_result_retention_ms,
      60000,
      86400000,
    ),
    long_running_after_ms: _boundedInt(
      source.long_running_after_ms,
      TOOL_RUNTIME_DEFAULTS.long_running_after_ms,
      1000,
      3600000,
    ),
    notify_long_running: source.notify_long_running !== false,
    notify_stalled: source.notify_stalled !== false,
    notify_completed: source.notify_completed !== false,
    notify_failed: source.notify_failed !== false,
    auto_continue_late_results: source.auto_continue_late_results !== false,
    late_result_continue_delay_ms: _boundedInt(
      source.late_result_continue_delay_ms,
      TOOL_RUNTIME_DEFAULTS.late_result_continue_delay_ms,
      0,
      30000,
    ),
    history_limit: _boundedInt(
      source.history_limit,
      TOOL_RUNTIME_DEFAULTS.history_limit,
      20,
      2000,
    ),
    read_default_line_limit: _boundedInt(
      source.read_default_line_limit,
      TOOL_RUNTIME_DEFAULTS.read_default_line_limit,
      50,
      5000,
    ),
    read_max_line_limit: _boundedInt(
      source.read_max_line_limit,
      TOOL_RUNTIME_DEFAULTS.read_max_line_limit,
      100,
      20000,
    ),
    read_max_output_chars: _boundedInt(
      source.read_max_output_chars,
      TOOL_RUNTIME_DEFAULTS.read_max_output_chars,
      2000,
      500000,
    ),
    search_default_page_size: _boundedInt(
      source.search_default_page_size,
      TOOL_RUNTIME_DEFAULTS.search_default_page_size,
      10,
      500,
    ),
    search_max_page_size: _boundedInt(
      source.search_max_page_size,
      TOOL_RUNTIME_DEFAULTS.search_max_page_size,
      10,
      2000,
    ),
    search_snapshot_ttl_ms: _boundedInt(
      source.search_snapshot_ttl_ms,
      TOOL_RUNTIME_DEFAULTS.search_snapshot_ttl_ms,
      10000,
      3600000,
    ),
    search_max_snapshot_results: _boundedInt(
      source.search_max_snapshot_results,
      TOOL_RUNTIME_DEFAULTS.search_max_snapshot_results,
      100,
      20000,
    ),
    search_timeout_ms: _boundedInt(
      source.search_timeout_ms,
      TOOL_RUNTIME_DEFAULTS.search_timeout_ms,
      1000,
      120000,
    ),
    search_snapshot_cache_max_entries: _boundedInt(
      source.search_snapshot_cache_max_entries,
      TOOL_RUNTIME_DEFAULTS.search_snapshot_cache_max_entries,
      4,
      512,
    ),
    search_snapshot_cache_max_results: _boundedInt(
      source.search_snapshot_cache_max_results,
      TOOL_RUNTIME_DEFAULTS.search_snapshot_cache_max_results,
      100,
      500000,
    ),
    command_watchdog_enabled: source.command_watchdog_enabled !== false,
    command_watchdog_action: source.command_watchdog_action === "report"
      ? "report"
      : "terminate",
    command_watchdog_stall_ms: _boundedInt(
      source.command_watchdog_stall_ms,
      TOOL_RUNTIME_DEFAULTS.command_watchdog_stall_ms,
      5000,
      3600000,
    ),
    command_watchdog_sample_ms: _boundedInt(
      source.command_watchdog_sample_ms,
      TOOL_RUNTIME_DEFAULTS.command_watchdog_sample_ms,
      1000,
      60000,
    ),
    command_watchdog_cpu_delta_ms: _boundedInt(
      source.command_watchdog_cpu_delta_ms,
      TOOL_RUNTIME_DEFAULTS.command_watchdog_cpu_delta_ms,
      0,
      60000,
    ),
    command_watchdog_rss_delta_bytes: _boundedInt(
      source.command_watchdog_rss_delta_bytes,
      TOOL_RUNTIME_DEFAULTS.command_watchdog_rss_delta_bytes,
      0,
      1073741824,
    ),
    command_watchdog_progress_ms: _boundedInt(
      source.command_watchdog_progress_ms,
      TOOL_RUNTIME_DEFAULTS.command_watchdog_progress_ms,
      1000,
      300000,
    ),
  };
  normalized.read_default_line_limit = Math.min(
    normalized.read_default_line_limit,
    normalized.read_max_line_limit,
  );
  normalized.search_default_page_size = Math.min(
    normalized.search_default_page_size,
    normalized.search_max_page_size,
  );
  normalized.command_watchdog_stall_ms = Math.max(
    normalized.command_watchdog_stall_ms,
    normalized.command_watchdog_sample_ms * 2,
  );
  return normalized;
}

export function normalizeToolRuntimeConfigForRecovery(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return normalizeToolRuntimeConfig(TOOL_RUNTIME_ERROR_FALLBACK);
  }
  return normalizeToolRuntimeConfig(raw);
}

/**
 * 构造发给独立工具执行端的纯数据策略信封。
 * 该对象只描述当前用户配置，不包含提示词、角色、模式或行为指令。
 * 放在专用命名空间中，避免把内部策略字段混入公开工具参数。
 */
export function buildToolIoRuntimePolicy(config = {}) {
  const normalized = normalizeToolRuntimeConfig(config);
  return {
    read_default_line_limit: normalized.read_default_line_limit,
    read_max_line_limit: normalized.read_max_line_limit,
    read_max_output_chars: normalized.read_max_output_chars,
    search_default_page_size: normalized.search_default_page_size,
    search_max_page_size: normalized.search_max_page_size,
    search_snapshot_ttl_ms: normalized.search_snapshot_ttl_ms,
    search_max_snapshot_results: normalized.search_max_snapshot_results,
    search_timeout_ms: normalized.search_timeout_ms,
    search_snapshot_cache_max_entries: normalized.search_snapshot_cache_max_entries,
    search_snapshot_cache_max_results: normalized.search_snapshot_cache_max_results,
    command_watchdog_enabled: normalized.command_watchdog_enabled,
    command_watchdog_action: normalized.command_watchdog_action,
    command_watchdog_stall_ms: normalized.command_watchdog_stall_ms,
    command_watchdog_sample_ms: normalized.command_watchdog_sample_ms,
    command_watchdog_cpu_delta_ms: normalized.command_watchdog_cpu_delta_ms,
    command_watchdog_rss_delta_bytes: normalized.command_watchdog_rss_delta_bytes,
    command_watchdog_progress_ms: normalized.command_watchdog_progress_ms,
  };
}

export function readToolRuntimeConfigState(username = "") {
  if (!username) {
    return {
      config: normalizeToolRuntimeConfig(),
      source: "default",
      persisted: false,
      error: null,
    };
  }
  let file = "";
  try {
    file = getYonbanConfigPath(username);
    try {
      fs.statSync(file);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          config: normalizeToolRuntimeConfig(),
          source: "default",
          persisted: false,
          error: null,
        };
      }
      throw error;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Object.hasOwn(parsed || {}, "tool_runtime")) {
      return {
        config: normalizeToolRuntimeConfig(),
        source: "default",
        persisted: false,
        error: null,
      };
    }
    if (!parsed.tool_runtime || typeof parsed.tool_runtime !== "object" || Array.isArray(parsed.tool_runtime)) {
      throw new TypeError("tool_runtime 必须是对象");
    }
    return {
      config: normalizeToolRuntimeConfig(parsed.tool_runtime),
      source: "persisted",
      persisted: true,
      error: null,
    };
  } catch (error) {
    const message = String(error?.message || error || "未知读取错误");
    return {
      config: normalizeToolRuntimeConfig(TOOL_RUNTIME_ERROR_FALLBACK),
      source: "error",
      persisted: false,
      error: {
        code: "tool_runtime_config_unreadable",
        message,
        file: file || null,
      },
    };
  }
}

export function readToolRuntimeConfig(username = "") {
  const state = readToolRuntimeConfigState(username);
  if (state.error) {
    const fingerprint = `${username}\0${state.error.file || ""}\0${state.error.message}`;
    if (_toolRuntimeReadDiagnostics.get(username) !== fingerprint) {
      _toolRuntimeReadDiagnostics.set(username, fingerprint);
      console.error(
        `[toolRuntime] 用户 ${username} 的工具运行态配置不可读；通知和自动续轮已安全关闭:`,
        state.error.message,
      );
    }
  } else {
    _toolRuntimeReadDiagnostics.delete(username);
  }
  return state.config;
}

/**
 * 调用方等待时限必须覆盖执行端声明的 timeout，再加传输宽限；否则会重现执行端仍在跑、调用方先弃单。
 */
export function resolveToolResponseTimeout(config, params = {}, explicitTimeout) {
  if (Number.isFinite(Number(explicitTimeout)) && Number(explicitTimeout) > 0) {
    return Math.round(Number(explicitTimeout));
  }
  const cfg = normalizeToolRuntimeConfig(config);
  const declared = Number(params?.timeout);
  const declaredWithGrace = Number.isFinite(declared) && declared > 0
    ? declared + cfg.transport_grace_ms
    : 0;
  return Math.max(cfg.response_timeout_ms, declaredWithGrace);
}

function _targetFromParams(params = {}) {
  const raw = params.path ?? params.directory ?? params.command ?? params.query ?? params.pattern ?? "";
  const text = typeof raw === "string" ? raw : "";
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function _publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    requestId: job.requestId,
    version: job.version,
    chatid: job.chatid,
    tool: job.tool,
    target: job.target,
    backendKind: job.backendKind,
    backendPort: job.backendPort,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    duration: job.duration,
    error: job.error,
    late: !!job.late,
    longRunning: !!job.longRunning,
    waitTimeoutMs: job.waitTimeoutMs,
    progress: job.progress && typeof job.progress === "object" ? { ...job.progress } : null,
  };
}

export class ToolJobRegistry {
  constructor() {
    this._jobs = new Map();
    this._requestToJob = new Map();
  }

  create({
    requestId,
    chatid = null,
    ownerUsername = "",
    tool,
    params = {},
    backendKind = null,
    backendPort = null,
    waitTimeoutMs = null,
    historyLimit = TOOL_RUNTIME_DEFAULTS.history_limit,
  }) {
    const now = new Date().toISOString();
    const jobId = `tooljob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      jobId,
      requestId,
      version: 1,
      chatid: chatid || null,
      ownerUsername: _ownerKey(ownerUsername),
      tool,
      target: _targetFromParams(params),
      backendKind,
      backendPort,
      state: "queued",
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      duration: null,
      error: null,
      late: false,
      longRunning: false,
      waitTimeoutMs,
      progress: null,
      historyLimit: Math.max(20, Number(historyLimit) || TOOL_RUNTIME_DEFAULTS.history_limit),
    };
    this._jobs.set(jobId, job);
    if (requestId) this._requestToJob.set(requestId, jobId);
    this._prune(job.historyLimit, job.ownerUsername);
    return _publicJob(job);
  }

  getByRequestId(requestId) {
    const jobId = this._requestToJob.get(requestId);
    return jobId ? this._jobs.get(jobId) || null : null;
  }

  get(jobId) {
    return this._jobs.get(jobId) || null;
  }

  update(jobId, patch = {}) {
    const job = this._jobs.get(jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    const nextPatch = { ...patch };
    const requestedState = typeof nextPatch.state === "string" ? nextPatch.state : null;
    const stateAccepted = !requestedState || _canTransition(job.state, requestedState);
    if (!stateAccepted) {
      delete nextPatch.state;
      delete nextPatch.completedAt;
      delete nextPatch.duration;
      // error 与被拒绝的状态是一组事实，不能让旧计时器改写当前状态的错误原因。
      delete nextPatch.error;
    }
    Object.assign(job, nextPatch, {
      version: Math.max(1, Number(job.version) || 1) + 1,
      updatedAt: now,
    });
    if (requestedState === "running" && !job.startedAt) job.startedAt = patch.startedAt || now;
    if (stateAccepted && TERMINAL_STATES.has(requestedState)) {
      job.completedAt = patch.completedAt || now;
      const startMs = new Date(job.startedAt || job.createdAt).getTime();
      job.duration = Number.isFinite(Number(patch.duration))
        ? Number(patch.duration)
        : Math.max(0, Date.now() - startMs);
      this._prune(job.historyLimit, job.ownerUsername, job.jobId);
    }
    return _publicJob(job);
  }

  updateByRequestId(requestId, patch = {}) {
    const job = this.getByRequestId(requestId);
    return job ? this.update(job.jobId, patch) : null;
  }

  ownerOf(jobOrId) {
    const job = typeof jobOrId === "string" ? this._jobs.get(jobOrId) : jobOrId;
    return job ? _ownerKey(job.ownerUsername) : "";
  }

  publicSnapshot(jobOrId, ownerUsername) {
    const job = typeof jobOrId === "string" ? this._jobs.get(jobOrId) : jobOrId;
    const owner = _ownerKey(ownerUsername);
    if (!owner || !job || job.ownerUsername !== owner) return null;
    return _publicJob(job);
  }

  list({
    ownerUsername,
    chatid,
    limit = TOOL_RUNTIME_DEFAULTS.history_limit,
    includeTerminal = true,
  } = {}) {
    const owner = _ownerKey(ownerUsername);
    if (!owner) return [];
    const rows = [];
    for (const job of this._jobs.values()) {
      if (job.ownerUsername !== owner) continue;
      if (chatid != null && job.chatid !== chatid) continue;
      if (!includeTerminal && TERMINAL_STATES.has(job.state)) continue;
      rows.push(_publicJob(job));
    }
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return rows.slice(-Math.max(1, Number(limit) || TOOL_RUNTIME_DEFAULTS.history_limit));
  }

  /**
   * 提示词专用视图 — 单次投递语义（凛倾 0731「工具反馈是系统的活：a 执行、b 看到、c 消失」，
   * 缓存归零调查 proxy缓存效率调查_20260731_0154 的机制侧修复）。
   * 活跃 job（queued/sent/running/wait_timeout/detached）持续可见；终态 job 只出现在进入终态后的
   * 第一次提示词构建里，之后不再进提示词——防止整个会话的 job 总账（实测 5.3h/115k 字符）每轮全量
   * 重发挤占上下文。
   * 与 list() 分离的原因：list() 另有面板/REST 消费者（setDataActions.mjs runtime 查询），投递标记
   * 只允许提示词路径推进，面板刷新不得吃掉 AI 还没看到的反馈。标记记在 job 上（_promptDeliveredAt，
   * _publicJob 不导出），不删数据——完整历史仍归 list()/clearTerminal，"消失"只对提示词生效。
   * 标记时点=本方法返回该 job 时（截断在 limit 外的终态 job 不标，下轮仍有机会投递）。
   */
  listForPrompt({
    ownerUsername,
    chatid,
    limit = TOOL_RUNTIME_DEFAULTS.history_limit,
  } = {}) {
    const owner = _ownerKey(ownerUsername);
    if (!owner) return [];
    const jobs = [];
    for (const job of this._jobs.values()) {
      if (job.ownerUsername !== owner) continue;
      if (chatid != null && job.chatid !== chatid) continue;
      if (TERMINAL_STATES.has(job.state) && job._promptDeliveredAt) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const kept = jobs.slice(-Math.max(1, Number(limit) || TOOL_RUNTIME_DEFAULTS.history_limit));
    const now = new Date().toISOString();
    return kept.map((job) => {
      if (TERMINAL_STATES.has(job.state) && !job._promptDeliveredAt) job._promptDeliveredAt = now;
      return _publicJob(job);
    });
  }

  clearTerminal(ownerUsername, chatid = null) {
    const owner = _ownerKey(ownerUsername);
    if (!owner) return 0;
    let removed = 0;
    for (const [jobId, job] of this._jobs) {
      if (job.ownerUsername !== owner) continue;
      if (!TERMINAL_STATES.has(job.state)) continue;
      if (chatid != null && job.chatid !== chatid) continue;
      this._jobs.delete(jobId);
      if (job.requestId) this._requestToJob.delete(job.requestId);
      removed++;
    }
    return removed;
  }

  forgetRequest(requestId, ownerUsername) {
    const owner = _ownerKey(ownerUsername);
    if (!owner) return false;
    const job = this.getByRequestId(requestId);
    if (!job || job.ownerUsername !== owner) return false;
    this._requestToJob.delete(requestId);
    return true;
  }

  forgetChat(chatid, ownerUsername) {
    const owner = _ownerKey(ownerUsername);
    if (!chatid || !owner) return 0;
    let removed = 0;
    for (const [jobId, job] of this._jobs) {
      if (job.chatid !== chatid || job.ownerUsername !== owner) continue;
      this._jobs.delete(jobId);
      if (job.requestId) this._requestToJob.delete(job.requestId);
      removed++;
    }
    return removed;
  }

  _prune(limit, ownerUsername = "", preserveJobId = null) {
    const max = Math.max(20, Number(limit) || TOOL_RUNTIME_DEFAULTS.history_limit);
    const owner = _ownerKey(ownerUsername);
    let ownerCount = 0;
    for (const job of this._jobs.values()) {
      if (job.ownerUsername === owner) ownerCount++;
    }
    if (ownerCount <= max) return;
    for (const [jobId, job] of this._jobs) {
      if (ownerCount <= max) break;
      if (job.ownerUsername !== owner) continue;
      if (jobId === preserveJobId) continue;
      if (!TERMINAL_STATES.has(job.state)) continue;
      this._jobs.delete(jobId);
      if (job.requestId) this._requestToJob.delete(job.requestId);
      ownerCount--;
    }
  }
}

export function isToolJobTerminal(state) {
  return TERMINAL_STATES.has(state);
}
