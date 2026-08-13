import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const gateSource = await readFile(new URL("src/yonban/core/functions/api/proxy/lib/aiConcurrencyGate.mjs", ROOT), "utf8");
const runnerSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs", ROOT), "utf8");
const contractSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneContract.mjs", ROOT), "utf8");
const coordinatorSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs", ROOT), "utf8");
const storageSource = await readFile(new URL("src/yonban/core/functions/memory/storage_mod/storage.mjs", ROOT), "utf8");
const replySource = await readFile(new URL("src/yonban/core/functions/memory/handler/replyHandler.mjs", ROOT), "utf8");
const aiRunnerSource = await readFile(new URL("src/yonban/core/functions/memory/ai/aiRunner.mjs", ROOT), "utf8");

function buildGateHarness(source) {
  const executable = source
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/function _readLimit\(username\) \{[\s\S]*?^\}/m, "function _readLimit() { return __limit; }")
    .replace("export async function acquireAiSlot", "async function acquireAiSlot");
  return new Function(`
    let __limit = 0;
    const wbT = () => {};
    ${executable}
    return {
      acquireAiSlot,
      setLimit(value) { __limit = value; },
      reset() { _users.clear(); },
    };
  `)();
}

function buildBatchRunner(source) {
  const match = source.match(/async function _runWithConcurrency\(thunks, limit = 0, signal = null\) \{[\s\S]*?^\}/m);
  assert.ok(match, "must find the production batch scheduler");
  return new Function("diag", `return (${match[0]});`)({ error() {} });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runWithConcurrency = buildBatchRunner(replySource);

async function verifyBatchLimit(limit, expectedMax) {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const thunks = Array.from({ length: 12 }, (_, index) => async () => {
    starts.push(index);
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(8);
    active--;
    return index;
  });
  const results = await runWithConcurrency(thunks, limit);
  assert.equal(maxActive, expectedMax, `limit=${limit} must grant the truthful batch concurrency`);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(starts.slice().sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index));
}

await verifyBatchLimit(0, 12);
await verifyBatchLimit(1, 1);
await verifyBatchLimit(2, 2);

{
  const controller = new AbortController();
  const started = [];
  const pending = runWithConcurrency(Array.from({ length: 12 }, (_, index) => async () => {
    started.push(index);
    await delay(20);
    return index;
  }), 1, controller.signal);
  await delay(3);
  controller.abort();
  const results = await pending;
  assert.deepEqual(started, [0], "abort must leave batch-queued slots unstarted");
  assert.equal(results[0], 0);
  assert.equal(results.slice(1).every((item) => item === undefined), true);
}

const gate = buildGateHarness(gateSource);

{
  gate.reset();
  gate.setLimit(2);
  const events = [];
  const observe = (name) => (event) => events.push(`${name}:${event.phase}`);
  const releaseLow1 = await gate.acquireAiSlot("priority-order", undefined, { tier: "low", onLifecycle: observe("low1") });
  const releaseLow2 = await gate.acquireAiSlot("priority-order", undefined, { tier: "low", onLifecycle: observe("low2") });
  const low3Promise = gate.acquireAiSlot("priority-order", undefined, { tier: "low", onLifecycle: observe("low3") });
  const highPromise = gate.acquireAiSlot("priority-order", undefined, { tier: "high", onLifecycle: observe("high") });
  await Promise.resolve();
  assert.ok(events.includes("low3:queued"));
  assert.ok(events.includes("high:queued"));
  releaseLow1();
  const releaseHigh = await highPromise;
  releaseLow2();
  const releaseLow3 = await low3Promise;
  assert.ok(events.indexOf("high:granted") < events.indexOf("low3:granted"), "main AI must be granted before an older low-priority clone");
  releaseHigh();
  releaseLow3();
  assert.ok(events.includes("high:released"));
  assert.ok(events.includes("low3:released"));
}

{
  gate.reset();
  gate.setLimit(1);
  const events = [];
  const releaseFirst = await gate.acquireAiSlot("cancel-queued", undefined, { tier: "low", onLifecycle: (event) => events.push(`first:${event.phase}`) });
  const controller = new AbortController();
  const queued = gate.acquireAiSlot("cancel-queued", controller.signal, { tier: "low", onLifecycle: (event) => events.push(`second:${event.phase}`) });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(queued, (error) => error?.name === "AbortError");
  releaseFirst();
  assert.deepEqual(events.filter((event) => event.startsWith("second:")), ["second:waiting", "second:queued", "second:cancelled"]);
  assert.equal(events.includes("second:granted"), false, "cancelled queued work must never become running");
}

{
  gate.reset();
  gate.setLimit(0);
  const events = [];
  const release = await gate.acquireAiSlot("unlimited", undefined, { tier: "low", onLifecycle: (event) => events.push(event.phase) });
  release();
  release();
  assert.deepEqual(events, ["waiting", "granted", "released"], "unlimited mode remains direct and release is idempotent");
}

assert.ok(runnerSource.indexOf('status(0, "accepted"') < runnerSource.indexOf("runtime = await _buildPromptRuntime"), "accepted must precede prompt preparation");
for (const state of ["ai_waiting", "ai_queued", "ai_running", "ai_released", "ai_cancelled"]) {
  assert.ok(runnerSource.includes(`"${state}"`), `Runner must project ${state}`);
}
assert.ok(runnerSource.includes('aiPriority: { tier: "low", onLifecycle: aiLifecycle }'));
const backupCall = aiRunnerSource.match(/const _bkResult = await _bkAiSource\.StructCall\([\s\S]*?\n\s*\}\);/);
assert.ok(backupCall, "must find backup provider call");
assert.ok(backupCall[0].includes("options.aiPriority"), "backup provider must preserve the same AI lifecycle observer");
assert.ok(coordinatorSource.indexOf('"batch_queued"') < coordinatorSource.indexOf("const thunks"), "all batch slots must be projected before any Runner starts");
assert.match(contractSource, /export function createCloneStatusEvent/);
assert.match(contractSource, /eventId: `\$\{eventJob\.jobId\}:\$\{seq\}`/);
assert.match(coordinatorSource, /payload: event/);
assert.doesNotMatch(storageSource, /eventStatus: event\.status/);
assert.match(storageSource, /tools: Number\(event\.tools\) \|\| 0/);
assert.match(coordinatorSource, /emitStatus,/);
assert.doesNotMatch(coordinatorSource, /sequence: metadata\?\.sequence/);
assert.equal(/state:\s*"running"[\s\S]{0,120}status:\s*"running"/.test(coordinatorSource), false, "dispatch snapshot must not claim queued work is running");

console.log("clone lifecycle contract test passed: limits=0/1/2, tasks=12, priority, cancellation, lifecycle projection");
