import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

const root = new URL("../", import.meta.url);
const generationSource = await readFile(new URL("src/public/parts/shells/beilu-chat/src/lib/generation.mjs", root), "utf8");
const runnerSource = await readFile(new URL("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs", root), "utf8");

assert.match(generationSource, /const _hasEnabledClone = Array\.isArray\(_gwCfg\.clones\)/);
assert.match(generationSource, /group_worker_enabled === true && _hasEnabledClone/);
assert.match(generationSource, /E_GROUP_CLONE_HOST_UNROUTABLE/);
assert.match(generationSource, /group_worker_enabled === true && !_hasEnabledClone/);
assert.ok(
  generationSource.indexOf("group_worker_enabled === true && _hasEnabledClone")
    < generationSource.indexOf("dispatchReplyToGroup"),
  "clone/worker incompatibility must be decided before worker dispatch",
);
assert.match(runnerSource, /job = controller\?\._cloneJob \|\| job/);

const workerModule = new URL("src/yonban/core/functions/memory/handler/cloneAbort.mjs", root).href;
const workerResult = await new Promise((resolve, reject) => {
  const worker = new Worker(`
    const { parentPort } = await import("node:worker_threads");
    globalThis.__beilu_worker_isolate = true;
    globalThis.__beilu_worker_id = "contract-worker-generation";
    const { registerCloneAbort } = await import(${JSON.stringify(workerModule)});
    const controller = registerCloneAbort("worker-owner", "worker-chat", 1, {
      cloneBatchId: "worker-batch",
      jobId: "worker-batch:1",
      executionHost: "main:spoofed",
    });
    parentPort.postMessage(controller._cloneJob);
  `, { eval: true, type: "module" });
  worker.once("message", resolve);
  worker.once("error", reject);
});
assert.equal(workerResult.executionHost, "worker:contract-worker-generation");

console.log("clone worker guard contract test passed: pre-dispatch D13 guard and owner-frozen host identity");
