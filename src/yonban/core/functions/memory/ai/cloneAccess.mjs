// cloneAccess.mjs — 分身工具资格与实际可执行权限的唯一解释口。

import { resolveCloneConfig } from "./cloneContract.mjs";
import { DELETE_CMD_FIRST_WORDS, FILE_EDIT_TOOLS, gateToolExecution, ideClient } from "../../../transport/ideClient.mjs";

const READ_CAPABILITIES = new Map([
  ["read_file", "read_file"], ["list_files", "list_files"],
  ["search_files", "search_files"], ["search_by_name", "search_by_name"],
  ["get_diagnostics", "get_diagnostics"], ["get_status", "get_status"],
  ["todo_read", "read_file"], ["get_project_summary", "read_file"],
  ["goto_definition", "search_files"], ["find_references", "search_files"],
  ["ast_search", "search_files"], ["smart_search", "search_files"],
  ["validate_html", "get_diagnostics"], ["lint_code", "get_diagnostics"],
]);
const COMMAND_TOOLS = new Set(["run_command", "exec", "run_script"]);
const NETWORK_TOOLS = new Set(["web_search", "web_download"]);

function commandFirstWord(command) {
  return String(command || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
}

export function resolveCloneCapability(clone, tool, params = {}) {
  const permissions = clone?.permissions || {};
  const normalizedTool = String(tool || "").trim();
  let capability = READ_CAPABILITIES.get(normalizedTool);
  if (capability) return { capability, eligible: permissions[capability] === true };
  if (NETWORK_TOOLS.has(normalizedTool)) {
    return { capability: `network.${normalizedTool}`, eligible: permissions[normalizedTool] === true };
  }
  if (normalizedTool === "write_file") {
    capability = String(params.path || "").toLowerCase().endsWith(".md") ? "write_md" : "write_code";
    return { capability, eligible: permissions[capability] === true };
  }
  if (FILE_EDIT_TOOLS.has(normalizedTool)) {
    return { capability: "write_code", eligible: permissions.write_code === true };
  }
  if (normalizedTool === "delete" || normalizedTool === "delete_file") {
    return { capability: "delete", eligible: permissions.delete === true };
  }
  if (COMMAND_TOOLS.has(normalizedTool)) {
    const command = normalizedTool === "run_script"
      ? `${params.lang || params.language || "script"} <inline-code>`
      : String(params.command || params.cmd || params.content || "");
    if (/\bgit\s+push\b/i.test(command) || /\bgh\s+(repo|release|pr)\b/i.test(command)) {
      if (permissions.github_upload !== true) return { capability: "github_upload", eligible: false };
    }
    if (DELETE_CMD_FIRST_WORDS.has(commandFirstWord(command)) && permissions.delete !== true) {
      return { capability: "delete", eligible: false };
    }
    return { capability: "run_command", eligible: permissions.run_command === true };
  }
  return { capability: normalizedTool || "unknown", eligible: permissions[normalizedTool] === true };
}

export function cloneCapabilityDeniedMessage(capability, tool) {
  if (capability === "write_code") return "分身禁止修改代码文件。请在报告中写明建议修改的文件、行号和内容，由有权限的执行者处理。";
  if (capability === "github_upload") return "分身无「上传github」权限（默认关闭）。请勾选 github_upload，或由主AI执行发布。";
  if (capability === "delete") return "分身无「删除文件」权限，删除工具或删除命令均已拒绝。";
  if (capability === "write_md") return "分身无「写MD文件」权限。";
  if (capability === "run_command") return `分身无「运行脚本」权限，已拒绝 ${tool}。`;
  return `分身无「${capability || tool}」权限`;
}

const CLONE_ACCESS_PROBES = Object.freeze([
  ["read_file", { path: "." }], ["list_files", { path: "." }],
  ["search_files", { path: ".", pattern: "FIX" }], ["search_by_name", { path: ".", name: "README" }],
  ["get_diagnostics", {}], ["get_status", {}], ["web_search", { query: "permission-probe" }], ["web_download", { url: "https://example.invalid" }], ["run_command", { command: "git status" }],
  ["run_script", { lang: "node", code: "<permission-probe>" }],
  ["write_file", { path: "permission-probe.md", content: "" }],
  ["replace_lines", { path: "permission-probe.js" }], ["delete_file", { path: "permission-probe.tmp" }],
  ["run_command", { command: "git push", _probeName: "github_upload" }],
]);

export function inspectCloneEffectivePermissions({
  username,
  chatId = "",
  configSnapshot,
  cloneId,
  sourceDetail = "formal",
  configRevision = null,
} = {}) {
  const clone = resolveCloneConfig(configSnapshot, {}, cloneId);
  const runtime = ideClient.getRuntimeSnapshot(chatId || null, username || "");
  const route = {
    connected: runtime.connected === true,
    backendKind: runtime.backendKind || null,
    port: runtime.backendPort || null,
    workspaceRoot: runtime.workspaceRoot || null,
    binding: runtime.binding || null,
  };
  const seen = new Set();
  const capabilities = [];
  for (const [tool, rawParams] of CLONE_ACCESS_PROBES) {
    const params = { ...rawParams };
    const probeName = params._probeName || null;
    delete params._probeName;
    const cloneDecision = resolveCloneCapability(clone, tool, params);
    const key = probeName || tool;
    if (seen.has(key)) continue;
    seen.add(key);
    const commandGate = COMMAND_TOOLS.has(tool) && cloneDecision.eligible
      ? gateToolExecution({ tool, params, source: "subagent", ownerUsername: username })
      : { allowed: true, applicable: false };
    const routeAllowed = NETWORK_TOOLS.has(tool) || route.connected;
    const allowed = cloneDecision.eligible && commandGate.allowed !== false && routeAllowed;
    let blockedBy = null;
    let reason = "已通过分身资格、全局命令闸和当前 IDE route";
    let repairTarget = null;
    if (!cloneDecision.eligible) {
      blockedBy = "clone_capability";
      reason = cloneCapabilityDeniedMessage(cloneDecision.capability, tool);
      repairTarget = "clone_editor";
    } else if (commandGate.allowed === false) {
      blockedBy = "command_gate";
      reason = commandGate.reason || "统一命令闸已拒绝";
      repairTarget = "permission_panel";
    } else if (!routeAllowed) {
      blockedBy = "ide_route";
      reason = "当前会话没有可执行的 IDE route";
      repairTarget = "ide_connection";
    }
    capabilities.push({
      key,
      tool,
      capability: cloneDecision.capability,
      checked: cloneDecision.eligible,
      allowed,
      blockedBy,
      reason,
      repairTarget,
      commandGate: {
        applicable: COMMAND_TOOLS.has(tool),
        allowed: commandGate.allowed !== false,
        needsApproval: commandGate.needsApproval === true,
        approvalState: commandGate.needsApproval === true ? "blocked_no_approval_queue" : "not_required",
        approvalId: null,
        riskLevel: commandGate.riskLevel || null,
      },
      route: { ...route },
      path: params.path ? { requested: params.path, workspaceRoot: route.workspaceRoot, enforcement: "ide_execution_boundary" } : null,
    });
  }
  return {
    schemaVersion: 1,
    source: "subagent",
    sourceDetail,
    ownerUsername: username || "",
    chatId: chatId || "",
    cloneId: clone.id,
    cloneLabel: clone.label || String(clone.id),
    configRevision,
    route,
    capabilities,
  };
}
