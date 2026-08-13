import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const chatService = read("yonban-vscode/src/services/ChatService.ts");
const provider = read("yonban-vscode/src/YonBanProvider.ts");
const modes = read("yonban-vscode/webview-ui/chat-modes.js");
const chat = read("yonban-vscode/webview-ui/chat.js");

for (const field of [
  "eventId", "sequence", "ownerUsername", "chatId", "parentGenerationId",
  "cloneBatchId", "taskId", "jobId", "terminalReason", "source", "tools",
]) {
  assert.match(chatService, new RegExp(`\\b${field}\\??:`), `TypeScript event schema missing ${field}`);
}
assert.match(chatService, /isCloneStatusEvent\(msg\.payload, ownerChatId\)/);
assert.match(chatService, /event\.sequence <= previous\.sequence \|\| previous\.terminal/);
assert.match(chatService, /this\._chatWs !== ws \|\| this\._currentChatId !== chatId/);
assert.doesNotMatch(chatService, /_onCloneStatus\.fire\(msg\.payload as \{ taskId:/);
assert.match(chat, /msg\.payload\.terminalReason \|\| msg\.payload\.detail/);
assert.match(modes, /type: "stopCloneTask", payload: \{ taskId: tid, jobId: btn\.getAttribute\("data-job"\) \}/);
assert.match(provider, /stopCloneTask\(chatId, pl\)/);
assert.match(chatService, /stopCloneTask\(chatId: string, identity: \{ taskId\?: string; jobId\?: string \} = \{\}\)/);
assert.match(chatService, /\{ _action: "stopCloneTask", chatid: chatId \|\| "", \.\.\.identity \}/);

const start = modes.indexOf("YB.onCloneStatus = function(payload) {");
const end = modes.indexOf("};  // ← 闭合 YB.onCloneStatus", start) + 2;
assert.ok(start >= 0 && end > start, "missing YonBan clone consumer");
const createConsumer = new Function(`
  var YB = {};
  var _cloneMap = {};
  var renders = 0;
  function _renderClonePanel() { renders++; }
  ${modes.slice(start, end)}
  return { consume: YB.onCloneStatus, state: function() { return _cloneMap; }, renders: function() { return renders; } };
`);
const consumer = createConsumer();
const event = (overrides = {}) => {
  const jobId = overrides.jobId || "batch-a:1";
  const sequence = overrides.sequence ?? 1;
  return {
    ownerUsername: "002",
    chatId: "chat-a",
    parentGenerationId: "parent-a",
    cloneBatchId: jobId.split(":")[0],
    taskId: 1,
    jobId,
    eventId: `${jobId}:${sequence}`,
    sequence,
    state: "running",
    status: "ai_running",
    round: 1,
    tools: 2,
    detail: "running",
    label: "审查分身#1",
    source: "subagent",
    terminalReason: null,
    ...overrides,
  };
};

consumer.consume(event());
consumer.consume(event({ sequence: 1, detail: "duplicate" }));
consumer.consume(event({ jobId: "batch-b:1", eventId: "batch-b:1:1", cloneBatchId: "batch-b" }));
consumer.consume(event({ sequence: 2, state: "terminal", status: "stopped", resultStatus: "partial", resumable: true, tools: 3, terminalReason: "max_rounds" }));
consumer.consume(event({ sequence: 3, state: "running", status: "ai_running", detail: "late" }));
const rows = consumer.state();
assert.equal(Object.keys(rows).length, 2, "same taskId in different batches must not overwrite");
assert.equal(rows["batch-a:1"].sequence, 2);
assert.equal(rows["batch-a:1"].state, "terminal");
assert.equal(rows["batch-a:1"].resultStatus, "partial");
assert.equal(rows["batch-a:1"].resumable, true);
assert.equal(rows["batch-a:1"].tools, 3);
assert.equal(rows["batch-a:1"].terminalReason, "max_rounds");
assert.equal(consumer.renders(), 3, "duplicate and late events must not re-render");
assert.match(modes, /var terminal = c\.state === "terminal"/);
assert.match(modes, /var resultStatus = c\.resultStatus \|\| c\.status/);
assert.match(modes, /!terminal \? '<span class="yb-clone-stop"/);

console.log("clone YonBan projection contract test passed: full TS schema, connection/chat guard, jobId+sequence idempotence");
