import assert from "node:assert/strict";
import {
  acceptCloneStatus,
  clearCloneStatuses,
  getCloneStatuses,
  requestCloneStop,
  subscribeCloneStatuses,
} from "../src/public/parts/shells/beilu-chat/public/src/shared/state/cloneStatusStore.mjs";

const event = (overrides = {}) => ({
  ownerUsername: "002",
  chatId: "chat-a",
  cloneBatchId: "batch-a",
  jobId: "batch-a:1",
  taskId: 1,
  sequence: 0,
  state: "queued",
  status: "batch_queued",
  timestamp: "2026-08-13T01:02:03.000Z",
  ...overrides,
});

clearCloneStatuses("chat-a");
clearCloneStatuses("chat-b");
let notifications = 0;
const unsubscribe = subscribeCloneStatuses(() => { notifications++; });

assert.equal(acceptCloneStatus(event()), true);
assert.equal(acceptCloneStatus(event()), false, "duplicate sequence must be idempotent");
assert.equal(acceptCloneStatus(event({ sequence: 2, state: "running", status: "working" })), true);
assert.equal(acceptCloneStatus(event({ sequence: 1, state: "accepted", status: "accepted" })), false, "out-of-order event must not roll state back");
assert.equal(acceptCloneStatus(event({ sequence: 3, state: "terminal", status: "stopped", resultStatus: "partial", resumable: true, tools: 7, terminalReason: "max_rounds" })), true);
assert.equal(acceptCloneStatus(event({ sequence: 4, state: "running", status: "working" })), false, "terminal state must reject late non-terminal events");

assert.equal(acceptCloneStatus(event({ cloneBatchId: "batch-b", jobId: "batch-b:1", sequence: 0 })), true, "same task id in another batch must not overwrite");
assert.equal(acceptCloneStatus(event({ chatId: "chat-b", cloneBatchId: "batch-c", jobId: "batch-c:1", sequence: 0 })), true, "same task id in another chat must remain isolated");
assert.equal(getCloneStatuses("chat-a").length, 2);
assert.equal(getCloneStatuses("chat-b").length, 1);
assert.equal(getCloneStatuses("chat-a")[0].jobId, "batch-b:1", "active entries sort before terminal entries");
const terminal = getCloneStatuses("chat-a")[1];
assert.equal(terminal.state, "terminal");
assert.equal(terminal.resultStatus, "partial");
assert.equal(terminal.resumable, true);
assert.equal(terminal.tools, 7);
assert.equal(terminal.terminalReason, "max_rounds");
assert.equal(acceptCloneStatus(event({ ownerUsername: "", jobId: "invalid", sequence: 0 })), false, "incomplete identity must be rejected");

let stopMessage = null;
const stopResult = await requestCloneStop("batch-b:1", "chat-a", async (message) => {
  stopMessage = message;
  return { aborted: true };
});
assert.equal(stopResult.aborted, true);
assert.deepEqual(stopMessage.payload, { chatid: "chat-a", taskId: "1", cloneBatchId: "batch-b", jobId: "batch-b:1" });
await assert.rejects(() => requestCloneStop("batch-b:1", "wrong-chat", async () => ({})), /精确命中一个 job/);

unsubscribe();
const beforeDestroy = notifications;
assert.equal(acceptCloneStatus(event({ chatId: "chat-b", cloneBatchId: "batch-d", jobId: "batch-d:2", taskId: 2, sequence: 0 })), true);
assert.equal(notifications, beforeDestroy, "destroying one subscriber must not receive later events");
assert.equal(getCloneStatuses("chat-b").length, 2, "destroying one view must not clear shared truth");

assert.equal(clearCloneStatuses("chat-a"), true);
assert.equal(getCloneStatuses("chat-a").length, 0);
assert.equal(getCloneStatuses("chat-b").length, 2, "chat-scoped clear must not erase another chat");
clearCloneStatuses("chat-b");

console.log("clone status store contract test passed: identity, sequence, terminal, batch/chat isolation, shared lifetime, exact stop");
