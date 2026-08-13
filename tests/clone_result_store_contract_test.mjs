import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getUserDataDir,
  markCloneResultDelivery,
  readCloneResult,
  saveCloneResult,
} from "../src/yonban/core/functions/memory/storage_mod/storage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const username = `__clone_result_contract_${process.pid}_${Date.now()}`;
const charName = "result-char";
const chatId = "chat-result-a";
const cloneBatchId = "batch-result-a";
const aggregate = {
  version: 1,
  parentGenerationId: "parent-result-a",
  cloneBatchId,
  state: "terminal",
  status: "completed",
  completion: "complete",
  success: true,
  tasks: [{
    id: 1,
    job: { ownerUsername: username, chatId, parentGenerationId: "parent-result-a", cloneBatchId, taskId: 1, jobId: `${cloneBatchId}:1` },
    state: "terminal",
    status: "completed",
    output: "persistent-output",
  }],
};

const userDir = path.resolve(getUserDataDir(username));
const expectedUsersRoot = path.resolve(root, "data", "users");
assert.equal(path.dirname(userDir), expectedUsersRoot, "contract user must resolve to the isolated repository users directory");

try {
  const stored = saveCloneResult(username, charName, chatId, aggregate, { text: "delivery-text" });
  assert.equal(stored.verified, true);
  assert.match(stored.resultId, /^clone-result:[a-f0-9]{40}$/);
  assert.match(stored.resultHash, /^[a-f0-9]{64}$/);
  assert.equal(path.resolve(stored.filepath).startsWith(`${userDir}${path.sep}`), true);

  aggregate.tasks[0].output = "mutated-after-save";
  const readback = readCloneResult(username, charName, chatId, cloneBatchId);
  assert.equal(readback.result.tasks[0].output, "persistent-output", "stored fact must not share a mutable aggregate reference");
  assert.equal(readback.result.tasks[0].persisted.resultStored, true);
  assert.equal(readback.result.tasks[0].persisted.resultId, stored.resultId);
  assert.equal(readback.delivery.enqueued, false);
  assert.equal(readback.delivery.userVisible, false);
  assert.equal(readCloneResult(username, charName, "other-chat", cloneBatchId), null, "chat isolation must not scan or guess another result");

  const marked = markCloneResultDelivery(username, charName, chatId, cloneBatchId, { enqueued: true });
  assert.equal(marked.delivery.enqueued, true);
  assert.equal(marked.delivery.userVisible, false);
  assert.equal(marked.resultHash, stored.resultHash, "delivery state changes must not alter terminal-result hash");

  const consumedAt = new Date().toISOString();
  const consumed = markCloneResultDelivery(username, charName, chatId, cloneBatchId, { userVisible: true, consumedAt });
  assert.equal(consumed.delivery.userVisible, true);
  assert.equal(consumed.delivery.consumedAt, consumedAt);
  assert.equal(consumed.resultHash, stored.resultHash, "visible/consumed delivery state must not alter terminal-result hash");

  const storageUrl = pathToFileURL(path.join(root, "src/yonban/core/functions/memory/storage_mod/storage.mjs")).href;
  const childSource = `
    import { readCloneResult } from ${JSON.stringify(storageUrl)};
    const row = readCloneResult(${JSON.stringify(username)}, ${JSON.stringify(charName)}, ${JSON.stringify(chatId)}, ${JSON.stringify(cloneBatchId)});
    if (!row || row.resultHash !== ${JSON.stringify(stored.resultHash)} || row.delivery?.enqueued !== true || row.delivery?.userVisible !== true || row.delivery?.consumedAt !== ${JSON.stringify(consumedAt)}) process.exit(3);
    console.log("RESTART_READBACK_OK:" + row.resultId);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], { cwd: root, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /RESTART_READBACK_OK:clone-result:/, "a fresh process must read the same terminal fact");

  const coordinatorSource = fs.readFileSync(path.join(root, "src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs"), "utf8");
  const ideSource = fs.readFileSync(path.join(root, "src/yonban/core/transport/ideClient.mjs"), "utf8");
  const storeCallIndex = coordinatorSource.indexOf("const storedResult = saveCloneResult(");
  const readbackCallIndex = coordinatorSource.indexOf("const storedReadback = readCloneResult(", storeCallIndex);
  const deliveryCallIndex = coordinatorSource.indexOf("ideClient.enqueuePendingResult({", storeCallIndex);
  assert.ok(storeCallIndex >= 0 && storeCallIndex < deliveryCallIndex, "persistent save must precede pending delivery");
  assert.ok(readbackCallIndex > storeCallIndex && readbackCallIndex < deliveryCallIndex, "readback verification must precede pending delivery");
  assert.match(coordinatorSource, /resultId: storedResult\.resultId, resultHash: storedResult\.resultHash/);
  assert.match(ideSource, /const CAP = 200/);
  assert.equal(readCloneResult(username, charName, chatId, cloneBatchId)?.resultHash, stored.resultHash, "pending CAP policy cannot delete the persistent owner");

  console.log("clone result store contract test passed: write/readback, restart, isolation, delivery separation, CAP independence");
} finally {
  if (fs.existsSync(userDir)) {
    const stat = fs.lstatSync(userDir);
    assert.equal(stat.isSymbolicLink(), false, "refuse cleanup through a symlink");
    assert.equal(path.dirname(userDir), expectedUsersRoot);
    fs.rmSync(userDir, { recursive: true, force: false });
  }
}
