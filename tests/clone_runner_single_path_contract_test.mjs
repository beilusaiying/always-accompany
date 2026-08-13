import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const runner = read("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs");
const access = read("src/yonban/core/functions/memory/ai/cloneAccess.mjs");
const coordinator = read("src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs");
const contract = read("src/yonban/core/functions/memory/ai/cloneContract.mjs");
const storage = read("src/yonban/core/functions/memory/storage_mod/storage.mjs");
const reply = read("src/yonban/core/functions/memory/handler/replyHandler.mjs");
const setData = read("src/yonban/core/functions/memory/handler/setDataActions.mjs");
const ideClient = read("src/yonban/core/transport/ideClient.mjs");
const generation = read("src/public/parts/shells/beilu-chat/src/lib/generation.mjs");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing function: ${signature}`);
  const body = source.indexOf(") {", start) + 2;
  assert.ok(body > 1, `missing function body: ${signature}`);
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${signature}`);
}

const testCaseStart = setData.indexOf('case "testClone":');
const testCaseEnd = setData.indexOf('case "runMemoryPreset":', testCaseStart);
assert.ok(testCaseStart >= 0 && testCaseEnd > testCaseStart, "testClone case must remain");
const testCase = setData.slice(testCaseStart, testCaseEnd);

assert.deepEqual(
  [...runner.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map((match) => match[1]).sort(),
  ["runCloneTask"],
  "Runner public surface is limited to execution",
);
assert.deepEqual(
  [...access.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map((match) => match[1]).sort(),
  ["cloneCapabilityDeniedMessage", "inspectCloneEffectivePermissions", "resolveCloneCapability"].sort(),
  "access owner public surface is limited to policy decisions and inspection",
);
assert.match(contract, /export function createCloneStatusEvent/);
assert.match(runner, /export async function runCloneTask/);
assert.equal((runner.match(/for \(let round = 0; maxWorkRounds === 0 \|\| round < maxWorkRounds; round\+\+\)/g) || []).length, 1, "Runner must own exactly one agent loop");
assert.doesNotMatch(reply, /_clMaxRounds|_DEFAULT_READ_TOOLS|_permMap|unregisterCloneAbort/);
assert.equal((coordinator.match(/registerCloneAbort\(/g) || []).length, 2, "batch owner registers queued jobs and releases only thunks skipped by parent abort");
assert.match(coordinator, /rawResults\?\.\[index\] !== undefined[\s\S]*unregisterCloneAbort\(/, "batch owner must release pre-registered jobs that never entered Runner");
assert.doesNotMatch(reply, /registerCloneAbort\(/, "replyHandler must not own abort registration");
assert.doesNotMatch(setData, /_tcMaxRounds|TEST_CLONE_|testclone_tool_result|parseIdeToolCallTags\(_tc|ideClient\.callTool\(tc/);
assert.equal((reply.match(/coordinateCloneBatch\(/g) || []).length, 1, "formal entry must call the batch coordinator once");
assert.equal((coordinator.match(/runCloneTask\(/g) || []).length, 1, "batch coordinator must call Runner once");
assert.equal((testCase.match(/runCloneTask\(/g) || []).length, 1, "test entry must call Runner once");
assert.match(coordinator, /sourceDetail: "formal"/);
assert.match(testCase, /sourceDetail: "test"/);
assert.match(runner, /requireEnabled: sourceDetail !== "test"/, "only the explicit test entry may inspect and run a disabled clone");
assert.match(testCase, /observe: true/);
assert.match(runner, /abortController \|\| registerCloneAbort\(username, chatId, task\.id/);
assert.match(runner, /unregisterCloneAbort\(username, chatId, task\.id, controller\)/);
assert.match(runner, /ideClient\.callToolWithLock\(call\.tool, call\.params, chatId\)/);
assert.doesNotMatch(runner, /ideClient\.callTool\(/, "Runner must not bypass the clone write-lock/source adapter");
assert.match(ideClient, /callToolWithLock[\s\S]*?source: "subagent"/, "existing IDE adapter must stamp canonical subagent source");
assert.equal((runner.match(/loadMemoryData\(/g) || []).length, 1, "one task must take one memory snapshot");
assert.equal((runner.match(/runMemoryPresetAI\(/g) || []).length, 1, "Runner must have one model call site");
assert.match(runner, /resolvePresetForMemoryAI\(username, clone\.presetName/);
assert.doesNotMatch(runner, /registry\.json|beilu-preset|_loadPresetFile|_orderedPresetPrompts/, "Runner must reuse the per-user preset owner");
assert.match(runner, /INJ-2-code/);
assert.match(runner, /INJ-5-web-work/);
assert.match(runner, /INJ-clone-tables-data/);
assert.match(runner, /INJ-clone-context-data/);
assert.match(runner, /Object\.entries\(item\.params \|\| \{\}\)/, "0811 parameter-sensitive repeat signature must survive the move");
assert.doesNotMatch(runner, /emptyRetries|_abortableDelay|content\.length >= 120|hasStructure/, "Runner must not keep its old empty-replay or length heuristic completion paths");
assert.match(runner, /maxWorkRounds === 0/, "zero work-round budget must mean unlimited");
assert.doesNotMatch(contract, /CLONE_COMPLETION_CONTRACT|clone_completion_contract/, "clone contract must not own model-facing completion prompts");
assert.doesNotMatch(runner, /CLONE_COMPLETION_CONTRACT|completion_uncertain|unverifiedNoToolRounds/, "Runner must not require or re-prompt a clone-only completion tag");
assert.match(runner, /if \(toolCalls\.length === 0\) \{[\s\S]*?terminalReason = "completed";[\s\S]*?break;/, "a non-empty reply without tool calls is the normal completion boundary");
assert.match(coordinator, /results\.every\(\(result\) => result\.success === true\)/, "formal aggregation must not infer success from non-exception status");
assert.match(testCase, /success: result\.success === true/, "test entry must expose task completion truth");
assert.match(coordinator, /terminalReason: result\.terminalReason/);
assert.match(testCase, /terminalReason: result\.terminalReason/);
assert.match(runner, /jobIdentity = null/);
assert.match(runner, /persisted: \{/);
assert.doesNotMatch(runner, /_cloneResumeRecords|getCloneResumeDir|nicerWriteFileSync/, "Runner must not own resume storage");
assert.match(storage, /export function loadCloneResumeSnapshot/);
assert.match(storage, /export function saveCloneResumeSnapshot/);
assert.match(reply, /_cloneAggregate/);
assert.match(reply, /_cloneDuplicateSuppressed/);
assert.match(coordinator, /label: result\.label/);
assert.match(coordinator, /label: task\.cloneName/);
assert.match(coordinator, /completionEvidence: result\.completionEvidence \|\| null/);
assert.doesNotMatch(coordinator, /_checkClaimEvidence\(/, "formal aggregation must not second-guess the Runner terminal owner");
assert.doesNotMatch(coordinator, /_stripCoTForContext/, "formal aggregation must use the shared reasoning-tag stripper");
assert.match(coordinator, /stripReasoningTags\(result\.reply \|\| "", username\)/);
assert.equal((generation.match(/_applyPendingResultMetadata\(/g) || []).length, 5, "all four pending-result consumers must share one metadata projector");
assert.match(generation, /_cloneAggregates/);

const resolveMaxWorkRoundsSource = extractFunction(contract, "export function resolveCloneMaxWorkRounds").replace("export ", "");
const resolveMaxWorkRounds = new Function(`${resolveMaxWorkRoundsSource}; return resolveCloneMaxWorkRounds;`)();
for (const value of [1, 49, 50, 200, 0]) assert.equal(resolveMaxWorkRounds(value), value);
assert.equal(resolveMaxWorkRounds(50, 0), 0, "test override zero must stay unlimited");
assert.equal(resolveMaxWorkRounds(50, 200), 200);
assert.throws(() => resolveMaxWorkRounds(-1), /0-10000/);
assert.throws(() => resolveMaxWorkRounds("abc"), /0-10000/);
assert.throws(() => resolveMaxWorkRounds(1.5), /0-10000/);
assert.throws(() => resolveMaxWorkRounds(10001), /0-10000/);

const parseCloneCompletionSource = extractFunction(contract, "export function parseCloneCompletion").replace("export ", "");
const parseCloneCompletion = new Function(`${parseCloneCompletionSource}; return parseCloneCompletion;`)();
assert.deepEqual(parseCloneCompletion("短结论<completionVerify>证据A</completionVerify>"), {
  explicit: true,
  evidence: "证据A",
  content: "短结论",
});
assert.equal(parseCloneCompletion("长而空洞的文字".repeat(100)).explicit, false);
assert.equal(parseCloneCompletion("<completionVerify></completionVerify>").explicit, false);
assert.equal(parseCloneCompletion("<completionVerify />").explicit, false);
assert.match(runner, /if \(content\.length === 0 && completionSignal\.explicit\)/, "evidence-only completion must finish before the empty-body failure branch");

const terminalShapeSource = extractFunction(contract, "export function cloneTerminalShape").replace("export ", "");
const terminalShape = new Function(`${terminalShapeSource}; return cloneTerminalShape;`)();
assert.deepEqual(terminalShape("completed", true, false), { state: "terminal", status: "completed", terminalReason: "completed", completion: "complete", success: true, resumable: false });
assert.deepEqual(terminalShape("max_rounds", true, true), { state: "terminal", status: "partial", terminalReason: "max_rounds", completion: "partial", success: false, resumable: true });
assert.deepEqual(terminalShape("no_output", false, true), { state: "terminal", status: "error", terminalReason: "no_output", completion: "none", success: false, resumable: true });
assert.deepEqual(terminalShape("exception", true, false), { state: "terminal", status: "error", terminalReason: "exception", completion: "partial", success: false, resumable: false });

const cloneParentSource = extractFunction(coordinator, "function cloneParentGenerationId");
const priorCloneTasksSource = extractFunction(coordinator, "function priorCloneTasksForParent");
const cloneHelpers = new Function(`${cloneParentSource}\n${priorCloneTasksSource}; return { cloneParentGenerationId, priorCloneTasksForParent };`)();
const priorJob = { parentGenerationId: "user-root-1", cloneBatchId: "batch-1", taskId: 8, jobId: "batch-1:8" };
const aggregateEntry = {
  role: "system",
  extension: {
    _cloneAggregates: [{ parentGenerationId: "user-root-1", tasks: [{ job: priorJob, state: "terminal", status: "completed", output: "done" }] }],
  },
};
const history = [{ id: "user-root-1", role: "user" }, aggregateEntry];
assert.equal(cloneHelpers.cloneParentGenerationId(history), "user-root-1");
assert.equal(cloneHelpers.priorCloneTasksForParent(history, "user-root-1").get("8").job.jobId, "batch-1:8");
assert.equal(cloneHelpers.priorCloneTasksForParent(history, "another-parent").size, 0);

const normalizeCloneBatchSource = extractFunction(coordinator, "function normalizeCloneBatchResults");
const normalizeCloneBatch = new Function(`${normalizeCloneBatchSource}; return normalizeCloneBatchResults;`)();
const mixedTasks = [1, 2, 3, 4].map((id) => ({ id, cloneName: `clone-${id}` }));
const mixedJobs = mixedTasks.map(({ id }) => ({ taskId: id, jobId: `batch:${id}` }));
const mixed = normalizeCloneBatch([
  { id: 1, status: "completed", terminalReason: "completed", completion: "complete", success: true, reply: "done", persisted: {} },
  { id: 2, status: "partial", terminalReason: "max_rounds", completion: "partial", success: false, resumable: true, reply: "half", persisted: { resumeSnapshot: true } },
  { _uncaught: true, error: "boom" },
], mixedTasks, mixedJobs, "default");
assert.deepEqual(mixed.map((item) => item.status), ["completed", "partial", "error", "not_started"]);
assert.deepEqual(mixed.map((item) => item.terminalReason), ["completed", "max_rounds", "exception", "parent_aborted"]);
assert.equal(mixed[1].persisted.resumeSnapshot, true);
assert.equal(mixed[2].job.jobId, "batch:3");
assert.equal(mixed[3].completion, "none");

const commandFirstWord = extractFunction(access, "function commandFirstWord");
const resolveCapabilitySource = extractFunction(access, "export function resolveCloneCapability").replace("export ", "");
const resolveCapability = new Function(`
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
  const FILE_EDIT_TOOLS = new Set(["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"]);
  const DELETE_CMD_FIRST_WORDS = new Set(["rm", "rmdir", "del", "erase", "unlink", "remove-item", "ri"]);
  ${commandFirstWord}
  ${resolveCapabilitySource}
  return resolveCloneCapability;
`)();
const result = (permissions, tool, params = {}) => resolveCapability({ permissions }, tool, params);

assert.equal(result({}, "read_file").eligible, false);
assert.deepEqual(result({ read_file: true }, "todo_read"), { capability: "read_file", eligible: true });
assert.deepEqual(result({ search_files: true }, "goto_definition"), { capability: "search_files", eligible: true });
assert.deepEqual(result({ get_diagnostics: true }, "lint_code"), { capability: "get_diagnostics", eligible: true });
assert.deepEqual(result({ write_md: true }, "write_file", { path: "report.md" }), { capability: "write_md", eligible: true });
assert.deepEqual(result({ write_md: true }, "write_file", { path: "app.mjs" }), { capability: "write_code", eligible: false });
assert.deepEqual(result({ write_code: true }, "fuzzy_edit", { path: "app.mjs" }), { capability: "write_code", eligible: true });
assert.deepEqual(result({ delete: false }, "delete", { path: "x.txt" }), { capability: "delete", eligible: false });
assert.deepEqual(result({ run_command: false }, "run_script", { lang: "python", code: "print(1)" }), { capability: "run_command", eligible: false });
assert.deepEqual(result({ run_command: true }, "run_script", { lang: "python", code: "print(1)" }), { capability: "run_command", eligible: true });
assert.deepEqual(result({ run_command: true, github_upload: false }, "run_command", { command: "git push origin main" }), { capability: "github_upload", eligible: false });
assert.deepEqual(result({ run_command: true, delete: false }, "run_command", { command: "Remove-Item x.txt" }), { capability: "delete", eligible: false });
assert.deepEqual(result({ run_command: true, delete: true }, "run_command", { command: "Remove-Item x.txt" }), { capability: "run_command", eligible: true });
assert.equal(result({}, "unknown_tool").eligible, false);
assert.equal(result({}, "web_search").eligible, false, "raw missing network permission must fail closed; canonical normalization supplies explicit defaults");

console.log("clone runner single-path contract test passed");
