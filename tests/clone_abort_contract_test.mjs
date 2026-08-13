import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  abortClones,
  listActiveClones,
  registerCloneAbort,
  unregisterCloneAbort,
} from "../src/yonban/core/functions/memory/handler/cloneAbort.mjs";

const username = `contract-${Date.now()}`;
const chatid = "chat-a";
const firstJob = { parentGenerationId: "parent-1", cloneBatchId: "batch-1", taskId: 7, jobId: "batch-1:7", sourceDetail: "formal", executionHost: "worker:spoofed-by-caller" };
const secondJob = { parentGenerationId: "parent-2", cloneBatchId: "batch-2", taskId: 7, jobId: "batch-2:7", sourceDetail: "formal" };
const first = registerCloneAbort(username, chatid, 7, firstJob, { detached: false });
const second = registerCloneAbort(username, chatid, 7, secondJob, { detached: true });
assert.equal(first._cloneJob.executionHost, `main:${process.pid}`, "executionHost must be frozen by the real controller owner, not accepted from caller payload");
assert.equal(second._cloneJob.executionHost, first._cloneJob.executionHost, "jobs registered in one process generation share the same main host identity");

assert.deepEqual(listActiveClones(username, chatid).map((item) => ({
  jobId: item.jobId,
  parentGenerationId: item.parentGenerationId,
  cloneBatchId: item.cloneBatchId,
  taskId: item.taskId,
  executionMode: item.executionMode,
})), [
  { jobId: "batch-1:7", parentGenerationId: "parent-1", cloneBatchId: "batch-1", taskId: "7", executionMode: "attached" },
  { jobId: "batch-2:7", parentGenerationId: "parent-2", cloneBatchId: "batch-2", taskId: "7", executionMode: "detached" },
]);

const ambiguous = abortClones(username, { chatid, taskId: 7 });
assert.deepEqual(ambiguous, { aborted: 0, matched: 2, ambiguous: true, jobIds: ["batch-1:7", "batch-2:7"] });
assert.equal(first.signal.aborted, false, "bare duplicate taskId must not kill the older batch");
assert.equal(second.signal.aborted, false, "bare duplicate taskId must not kill the newer batch");

assert.deepEqual(abortClones(username, { chatid, jobId: "batch-1:7" }), {
  aborted: 1,
  matched: 1,
  ambiguous: false,
  jobIds: ["batch-1:7"],
});
assert.equal(first.signal.aborted, true);
assert.equal(second.signal.aborted, false);
assert.equal(listActiveClones(username, chatid).length, 1);
assert.deepEqual(abortClones(username, { chatid, jobId: "batch-1:7" }), {
  aborted: 0,
  matched: 0,
  ambiguous: false,
  jobIds: [],
}, "repeated stop must be idempotent");

assert.deepEqual(abortClones(username, { chatid, cloneBatchId: "batch-2", taskId: 7 }), {
  aborted: 1,
  matched: 1,
  ambiguous: false,
  jobIds: ["batch-2:7"],
});
assert.equal(second.signal.aborted, true);
assert.equal(listActiveClones(username, chatid).length, 0);

const thirdJob = { parentGenerationId: "parent-3", cloneBatchId: "batch-3", taskId: 8, jobId: "batch-3:8", sourceDetail: "test" };
const third = registerCloneAbort(username, chatid, 8, thirdJob);
unregisterCloneAbort(username, chatid, 8, third);
assert.equal(listActiveClones(username, chatid).length, 0, "Runner finally must unregister exact controller identity");

const root = new URL("../", import.meta.url);
const replySource = await readFile(new URL("src/yonban/core/functions/memory/handler/replyHandler.mjs", root), "utf8");
const coordinatorSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs", root), "utf8");
const runnerSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs", root), "utf8");
const setDataSource = await readFile(new URL("src/yonban/core/functions/memory/handler/setDataActions.mjs", root), "utf8");
const progressCardSource = await readFile(new URL("src/public/parts/shells/beilu-chat/public/src/panels/task/cloneProgressCard.mjs", root), "utf8");
const backendMonitorSource = await readFile(new URL("src/public/parts/shells/beilu-chat/public/src/shared/widgets/backendMonitor.mjs", root), "utf8");
const statusStoreSource = await readFile(new URL("src/public/parts/shells/beilu-chat/public/src/shared/state/cloneStatusStore.mjs", root), "utf8");
assert.ok(coordinatorSource.indexOf("const abortControllers") < coordinatorSource.indexOf('"batch_queued"'), "all queued jobs must be registered before status projection and scheduling");
assert.ok(coordinatorSource.indexOf('"batch_queued"') < coordinatorSource.indexOf("const thunks"));
assert.match(coordinatorSource, /abortController: abortControllers\[index\]/);
assert.doesNotMatch(replySource, /registerCloneAbort\(/);
assert.ok(runnerSource.indexOf("if (controller.signal.aborted)") < runnerSource.indexOf("runtime = await _buildPromptRuntime"), "cancelled batch-queued jobs must terminate before prompt or AI startup");
assert.match(runnerSource, /任务在批内排队阶段被中止，未启动 AI/);
assert.match(setDataSource, /jobId: _sctJob/);
assert.match(setDataSource, /cloneBatchId: _sctBatch/);
assert.match(setDataSource, /success: !_sctResult\.ambiguous/);
assert.match(setDataSource, /请携带 jobId 精确停止/);
for (const source of [progressCardSource, backendMonitorSource]) {
  assert.match(source, /requestCloneStop\(jobId/);
  assert.match(source, /subscribeCloneStatuses/);
  assert.doesNotMatch(source, /const _clones = new Map/);
}
assert.match(statusStoreSource, /const jobId = String\(/);
assert.match(statusStoreSource, /statuses\.get\(key\)/);
assert.match(statusStoreSource, /statuses\.set\(key/);
assert.match(statusStoreSource, /payload: \{ chatid: entry\.chatId, taskId: entry\.taskId, cloneBatchId: entry\.cloneBatchId, jobId: entry\.jobId \}/);
assert.match(statusStoreSource, /batch_queued:[\s\S]*?ai_queued:[\s\S]*?ai_running:/);
assert.match(statusStoreSource, /sequence <= previous\.sequence/);
assert.ok(runnerSource.indexOf("late_ai_result_discarded") < runnerSource.indexOf("const completionSignal = parseCloneCompletion"), "late AI output after stop must be discarded before completion parsing");

console.log("clone abort contract test passed: full identity, frozen execution host, ambiguity rejection, exact stop, repeat stop, queued pre-registration");
