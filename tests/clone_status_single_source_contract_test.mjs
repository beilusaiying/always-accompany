import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const runner = read("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs");
const contract = read("src/yonban/core/functions/memory/ai/cloneContract.mjs");
const coordinator = read("src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs");
const storage = read("src/yonban/core/functions/memory/storage_mod/storage.mjs");
const broadcast = read("src/public/parts/shells/beilu-chat/src/lib/broadcast.mjs");
const prompt = read("src/yonban/core/functions/memory/handler/getPromptHandler.mjs");
const card = read("src/public/parts/shells/beilu-chat/public/src/panels/task/cloneProgressCard.mjs");
const store = read("src/public/parts/shells/beilu-chat/public/src/shared/state/cloneStatusStore.mjs");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing function: ${signature}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function: ${signature}`);
}

const terminalSource = extractFunction(contract, "export function isCloneTerminalEventStatus").replace("export ", "");
const createSource = extractFunction(contract, "export function createCloneStatusEvent");
const createEvent = new Function(`
  const CLONE_TERMINAL_EVENT_STATUSES = new Set(["completed", "stopped", "error"]);
  ${terminalSource}
  ${createSource.replace("export ", "")}
  return createCloneStatusEvent;
`)();
const job = {
  ownerUsername: "002",
  chatId: "chat-a",
  parentGenerationId: "parent-a",
  cloneBatchId: "batch-a",
  taskId: 1,
  jobId: "batch-a:1",
  source: "subagent",
  sourceDetail: "formal",
  executionMode: "detached",
};
const queued = createEvent(job, { sequence: 0, status: "batch_queued", detail: "queued", occurredAt: "2026-08-13T00:00:00.000Z" });
const running = createEvent(job, { sequence: 3, status: "ai_running", detail: "running", occurredAt: "2026-08-13T00:00:01.000Z" });
const terminal = createEvent(job, {
  sequence: 4,
  status: "completed",
  detail: "done",
  tools: 3,
  terminalReason: "completed",
  completion: "complete",
  resultStatus: "completed",
  resumable: false,
  occurredAt: "2026-08-13T00:00:02.000Z",
});
assert.equal(queued.eventId, "batch-a:1:0");
assert.equal(queued.state, "queued");
assert.equal(running.state, "running");
assert.equal(terminal.state, "terminal");
assert.equal(terminal.parentGenerationId, "parent-a");
assert.equal(terminal.timestamp, terminal.occurredAt);
assert.throws(() => createEvent({ ...job, chatId: "" }, { sequence: 1, status: "working" }), /\u7f3a\u5c11\u5b8c\u6574 job/);

// 同一语义事件驱动持久快照；重复、乱序、晚到非终态都不能覆盖已落终态。
const projectSource = extractFunction(storage, "export function projectCloneRuntimeEvent").replace("export ", "");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beilu-clone-status-"));
const snapshotPath = path.join(tempRoot, "work", "_clone_runtime_chat-a.json");
const projectEvent = new Function("path", "ensureMemoryDir", "loadJsonFileIfExists", "saveJsonFile", "diag", `
  ${projectSource}
  return projectCloneRuntimeEvent;
`)(
  path,
  () => tempRoot,
  (filepath, fallback) => fs.existsSync(filepath) ? JSON.parse(fs.readFileSync(filepath, "utf8")) : fallback,
  (filepath, content) => {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(content), "utf8");
  },
  { warn() {} },
);
try {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify({ version: 2, cid: "chat-a", kind: "clone", clones: [{ jobId: "legacy", eventStatus: "stopped", status: "error" }] }), "utf8");
  assert.equal(projectEvent("002", "char-a", "chat-a", queued), true);
  assert.equal(projectEvent("002", "char-a", "chat-a", running), true);
  assert.equal(projectEvent("002", "char-a", "chat-a", terminal), true);
  assert.equal(projectEvent("002", "char-a", "chat-a", running), true, "late lower sequence is an idempotent no-op");
  assert.equal(projectEvent("wrong-owner", "char-a", "chat-a", terminal), false);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.clones.length, 1);
  assert.equal(snapshot.clones.some((row) => row.jobId === "legacy"), false, "legacy v2 rows must not be relabeled as canonical v3");
  assert.equal(snapshot.clones[0].eventId, "batch-a:1:4");
  assert.equal(snapshot.clones[0].status, "completed");
  assert.equal(snapshot.clones[0].resultStatus, "completed");
  assert.equal(snapshot.clones[0].tools, 3);
  assert.equal("eventStatus" in snapshot.clones[0], false);
  assert.equal(snapshot.clones[0].state, "terminal");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// Runner 生成状态和唯一 terminal；批次协调器只传输 event，不再手拼 status payload。
assert.match(runner, /const projected = emitStatus\(event\)/);
assert.match(runner, /tools: totalTools/);
assert.equal((runner.match(/status\([^\n]*"(?:completed|stopped|error)"/g) || []).length, 0, "only finalizeResult may derive a terminal event status");
assert.doesNotMatch(runner, /terminalStatusEmitted/);
assert.match(runner, /finalizeResult\(\{ \.\.\.resultBase/);
assert.equal((coordinator.match(/type: "clone_status"/g) || []).length, 1);
assert.match(coordinator, /payload: event/);
assert.doesNotMatch(coordinator, /payload: \{\s*job,\s*parentGenerationId/);
assert.match(coordinator, /createCloneStatusEvent\(job, \{/);
assert.doesNotMatch(storage, /eventStatus: event\.status/);
assert.match(storage, /tools: Number\(event\.tools\) \|\| 0/);
assert.doesNotMatch(storage, /event\.state === "terminal" \?/);
assert.doesNotMatch(coordinator, /writeCloneRuntimeSnapshot\(/);

// 断线重连从同一 version=3 canonical snapshot 经原 clone_status 通道补发，旧 v2 不混入。
assert.match(broadcast, /_replayCloneStatusSnapshot/);
assert.match(broadcast, /snapshot\?\.version !== 3/);
assert.match(broadcast, /type: "clone_status"/);
assert.match(broadcast, /payload: \{ \.\.\.row, snapshot: true \}/);
assert.doesNotMatch(broadcast, /row\.eventStatus/);
const statusProjection = prompt.match(/const _resultStatus = c\.resultStatus \|\| c\.status;\s*const _st = ([^;]+);/);
assert.ok(statusProjection, "clone_runtime must project the canonical result status");
const statusLabel = new Function("c", `const _resultStatus = c.resultStatus || c.status; return ${statusProjection[1]};`);
assert.equal(statusLabel({ state: "running", status: "ai_running" }), "🔄在跑");
assert.equal(statusLabel({ state: "terminal", status: "stopped", resultStatus: "error", resumable: true }), "⏸中断");
assert.equal(statusLabel({ state: "terminal", status: "stopped", resultStatus: "partial", resumable: false }), "⚠部分完成");
assert.equal(statusLabel({ state: "terminal", status: "error", resultStatus: "error", resumable: false }), "❌失败");
assert.equal(statusLabel({ state: "terminal", status: "completed", resultStatus: "completed", resumable: false }), "✅完成");
assert.equal(statusLabel({ state: "terminal", status: "stopped", resultStatus: "not_started", resumable: false }), "❌失败");
assert.equal(statusLabel({ state: "terminal", status: "stopped", resultStatus: null, resumable: false }), "❌失败");
assert.match(store, /identityKey\(ownerUsername, chatId, jobId\)/);
assert.match(store, /sequence <= previous\.sequence/);
assert.match(store, /previous\.state === "terminal"/);
assert.match(store, /const current = \{\s*\.\.\.payload/);
assert.match(card, /subscribeCloneStatuses/);
assert.doesNotMatch(card, /const _clones = new Map/);

console.log("clone status single-source contract test passed: canonical event, one terminal, snapshot replay, job/sequence idempotence");
