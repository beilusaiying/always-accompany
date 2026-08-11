import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import filesPlugin, {
  __workspaceTestHooks,
  _filesAls,
  drainPendingOpResultsForSession,
  setActiveModeForSession,
} from "../src/public/parts/plugins/beilu-files/main.mjs";
import { serializeReplyForWorker } from "../src/workers/groupReplyRunner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

Deno.test("file_op continuation signal follows queued-result contract locally and across worker serialization", async () => {
  const username = `fileop-continuation-${crypto.randomUUID()}`;
  const chatid = `chat-${crypto.randomUUID()}`;
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, "tests", ".tmp_fileop_continuation_"));
  const samplePath = path.join(tempRoot, "sample.txt");
  fs.writeFileSync(samplePath, "one\ntwo\n", "utf8");

  const { pluginData } = __workspaceTestHooks;
  await _filesAls.run({ username }, async () => {
    pluginData.enabled = true;
    pluginData.workspaceRoot = tempRoot;
    pluginData.workspaceRoots.set(chatid, tempRoot);
    pluginData.allowedPaths = [];
    pluginData.blockedPaths = [];
    pluginData.autoApprove = true;
    pluginData.autoApproveRead = true;
    pluginData.allowExec = false;
    pluginData.permissions = {
      ...pluginData.permissions,
      file_read: true,
      file_write: true,
      file_delete: true,
    };
    setActiveModeForSession(chatid, "file");
  });

  const handle = (reply) => filesPlugin.interfaces.chat.ReplyHandler(reply, { username, chatid, chat_log: [] });
  const drain = () => _filesAls.run({ username }, () => drainPendingOpResultsForSession(chatid));

  try {
    const success = { content: `<file_op type="read" path="${samplePath}" />` };
    await handle(success);
    assert.equal(success.pendingFileOps, true, "completed operation must request continuation after queueing its result");
    assert.equal(serializeReplyForWorker(success).pendingFileOps, true, "worker serialization must preserve explicit true");
    assert.equal(drain().length, 1);

    const rejected = { content: '<file_op type="exec" command="echo rejected" />' };
    await handle(rejected);
    assert.equal(rejected.pendingFileOps, true, "rejected operation must continue after queueing rejection context");
    assert.equal(serializeReplyForWorker(rejected).pendingFileOps, true);
    assert.equal(drain().length, 1);

    await _filesAls.run({ username }, () => { pluginData.permissions.file_write = false; });
    const pending = { content: `<file_op type="write" path="${samplePath}">pending</file_op>` };
    await handle(pending);
    assert.equal(pending.pendingFileOps, false, "pending approval must not request continuation");
    assert.equal(serializeReplyForWorker(pending).pendingFileOps, false);
    assert.equal(drain().length, 0);

    await _filesAls.run({ username }, () => { pluginData.permissions.file_write = true; });
    const failed = { content: `<file_op type="replace_lines" path="${samplePath}" start_line="99" end_line="99">x</file_op>` };
    await handle(failed);
    assert.equal(failed.pendingFileOps, false, "failed operation must stop without a queued AI result");
    assert.equal(serializeReplyForWorker(failed).pendingFileOps, false);
    assert.equal(drain().length, 0);

    const regenerated = { content: "plain regenerated reply", pendingFileOps: true };
    await handle(regenerated);
    assert.equal(regenerated.pendingFileOps, false, "a later no-op round must clear the prior signal");
    assert.equal(serializeReplyForWorker(regenerated).pendingFileOps, false);

    const workerSource = fs.readFileSync(path.join(repoRoot, "src/workers/groupReplyRunner.mjs"), "utf8");
    assert.match(workerSource, /!!reply\.pendingFileOps\s*\|\|\s*!!_files\._filesAls\.run/, "worker must OR explicit signal with isolate Map peek");
    assert.doesNotMatch(workerSource, /pendingFileOpsFail[\s\S]{0,240}reply\.pendingFileOps\s*=\s*false/, "worker error path must not erase explicit true");
  } finally {
    await _filesAls.run({ username }, () => {
      drainPendingOpResultsForSession(chatid);
      pluginData.pendingOperations = pluginData.pendingOperations.filter((op) => op?._cid !== chatid);
      pluginData.pendingErrors = pluginData.pendingErrors.filter((entry) => entry?._cid !== chatid);
      pluginData.workspaceRoots.delete(chatid);
    });
    const resolved = path.resolve(tempRoot);
    assert.ok(resolved.startsWith(path.join(repoRoot, "tests") + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
