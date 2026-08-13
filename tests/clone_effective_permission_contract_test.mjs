import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCloneConfig } from "../src/yonban/core/functions/memory/ai/cloneContract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const access = read("src/yonban/core/functions/memory/ai/cloneAccess.mjs");
const actions = read("src/yonban/core/functions/memory/handler/setDataActions.mjs");
const panel = read("src/public/parts/shells/beilu-chat/public/src/panels/work/subModePanel.mjs");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const commandFirstWord = extractFunction(access, "function commandFirstWord");
const resolveCapability = extractFunction(access, "export function resolveCloneCapability").replace("export ", "");
const deniedMessage = extractFunction(access, "export function cloneCapabilityDeniedMessage").replace("export ", "");
const inspect = extractFunction(access, "export function inspectCloneEffectivePermissions").replace("export ", "");
const probesMatch = access.match(/const CLONE_ACCESS_PROBES = Object\.freeze\((\[[\s\S]*?\])\);/);
assert.ok(probesMatch, "missing inspect probes");

function makeInspect({ connected, gateAllowed, needsApproval = false }) {
  return new Function("ideClient", "gateToolExecution", "resolveCloneConfig", `
    const READ_CAPABILITIES = new Map([
      ["read_file", "read_file"], ["list_files", "list_files"], ["search_files", "search_files"],
      ["search_by_name", "search_by_name"], ["get_diagnostics", "get_diagnostics"], ["get_status", "get_status"]
    ]);
    const COMMAND_TOOLS = new Set(["run_command", "exec", "run_script"]);
    const NETWORK_TOOLS = new Set(["web_search", "web_download"]);
    const FILE_EDIT_TOOLS = new Set(["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"]);
    const DELETE_CMD_FIRST_WORDS = new Set(["rm", "del"]);
    const CLONE_ACCESS_PROBES = Object.freeze(${probesMatch[1]});
    ${commandFirstWord}
    ${resolveCapability}
    ${deniedMessage}
    ${inspect}
    return inspectCloneEffectivePermissions;
  `)(
    { getRuntimeSnapshot: () => ({ connected, backendKind: connected ? "yonban" : null, backendPort: connected ? 8931 : null, workspaceRoot: "D:/repo", binding: null }) },
    () => ({ allowed: gateAllowed, needsApproval, reason: gateAllowed ? "ok" : "channel blocked", riskLevel: "medium" }),
    resolveCloneConfig,
  );
}

const base = {
  username: "002",
  chatId: "chat-a",
  cloneId: 1,
  configRevision: 42,
  configSnapshot: { clones: [{ id: 1, label: "审查", permissions: { read_file: true, run_command: true, write_md: true } }] },
};
const globalBlocked = makeInspect({ connected: true, gateAllowed: false, needsApproval: true })(base);
assert.equal(globalBlocked.source, "subagent");
assert.equal(globalBlocked.sourceDetail, "formal");
assert.equal(globalBlocked.configRevision, 42);
assert.equal(globalBlocked.capabilities.find((row) => row.key === "run_command").blockedBy, "command_gate");
assert.equal(globalBlocked.capabilities.find((row) => row.key === "run_command").commandGate.approvalState, "blocked_no_approval_queue");
assert.equal(globalBlocked.capabilities.find((row) => row.key === "read_file").allowed, true);
assert.equal(globalBlocked.capabilities.find((row) => row.key === "web_search").allowed, true);
assert.equal(globalBlocked.capabilities.find((row) => row.key === "web_download").allowed, true);

const routeBlocked = makeInspect({ connected: false, gateAllowed: true })(base);
assert.equal(routeBlocked.capabilities.find((row) => row.key === "read_file").blockedBy, "ide_route");
const cloneBlocked = makeInspect({ connected: true, gateAllowed: true })({ ...base, configSnapshot: { clones: [{ id: 1, label: "关闭", enabled: false, permissions: { read_file: false, run_command: false } }] } });
assert.equal(cloneBlocked.capabilities.find((row) => row.key === "read_file").blockedBy, "clone_capability");

assert.match(actions, /case "inspectClonePermissions"/);
assert.match(actions, /configRevision: _icpSnapshot\.revision/);
const panelSave = extractFunction(panel, "async function _saveClones");
assert.match(panelSave, /clones: _clones, configRevision: _cloneConfigRevision/);
assert.doesNotMatch(panelSave, /verb: "getClones"|readback/);
assert.match(actions, /\{ strictRead: true, snapshot: true \}/);
assert.match(panel, /blocked_no_approval_queue|打开全局命令权限/);
assert.match(panel, /Object\.keys\(\(_cloneTemplate && _cloneTemplate\.permissions\) \|\| \{\}\)\.map/);
assert.doesNotMatch(panel, /_clonePermCheckbox\("read_file"/);
assert.match(access, /NETWORK_TOOLS\.has\(normalizedTool\)[\s\S]*permissions\[normalizedTool\] === true/);
assert.doesNotMatch(access, /source\s*:\s*"unknown"/);

console.log("clone effective permission contract test passed: clone/global gate/route layers, no fake approval, save-readback revision");
