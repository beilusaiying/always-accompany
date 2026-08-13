import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const runner = read("src/yonban/core/functions/memory/ai/cloneTaskRunner.mjs");
const contract = read("src/yonban/core/functions/memory/ai/cloneContract.mjs");
const storage = read("src/yonban/core/functions/memory/storage_mod/storage.mjs");
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

const recordsSource = extractFunction(storage, "function _cloneResumeRecords");
const safeIdSource = extractFunction(storage, "function _safeCloneResumeFileId");
const hashSource = extractFunction(storage, "function _cloneJsonHash");
const pruneSource = extractFunction(storage, "function _pruneCloneJsonFiles");
const listSource = extractFunction(storage, "export function listCloneResumeSnapshots").replace("export ", "");
const loadSource = extractFunction(storage, "export function loadCloneResumeSnapshot").replace("export ", "");
const saveSource = extractFunction(storage, "export function saveCloneResumeSnapshot").replace("export ", "");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "beilu-clone-resume-"));
const snapshots = [
  { name: "a.json", job: { ownerUsername: "002", chatId: "chat-a", taskId: 1, jobId: "batch-a:1", cloneBatchId: "batch-a" }, cloneId: 6, label: "测试", messages: [{ role: "system" }], terminalReason: "max_rounds", savedAt: "2026-08-13T01:00:00.000Z" },
  { name: "b.json", job: { ownerUsername: "002", chatId: "chat-b", taskId: 1, jobId: "batch-b:1", cloneBatchId: "batch-b" }, cloneId: 6, label: "测试", messages: [{ role: "system" }], terminalReason: "stopped", savedAt: "2026-08-13T02:00:00.000Z" },
  { name: "empty.json", job: { ownerUsername: "002", chatId: "chat-a", taskId: 3, jobId: "batch-a:3", cloneBatchId: "batch-a" }, cloneId: 7, label: "测试", messages: [], terminalReason: "stopped", savedAt: "2026-08-13T03:00:00.000Z" },
];
for (const item of snapshots) fs.writeFileSync(path.join(temp, item.name), JSON.stringify(item), "utf8");
const api = new Function("fs", "path", "crypto", "nicerWriteFileSync", "getCloneResumeDir", `
  ${safeIdSource}
  ${hashSource}
  ${pruneSource}
  ${recordsSource}
  ${listSource}
  ${loadSource}
  ${saveSource}
  return { listCloneResumeSnapshots, loadCloneResumeSnapshot, saveCloneResumeSnapshot };
`)(fs, path, crypto, (filepath, content) => fs.writeFileSync(filepath, content, "utf8"), () => temp);
try {
  const rows = api.listCloneResumeSnapshots("002", { chatId: "chat-a", cloneId: 6 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, "batch-a:1");
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], "messages"), false);
  assert.equal(api.loadCloneResumeSnapshot("002", { taskId: 1, jobId: "batch-a:1", chatId: "chat-a" }).job.jobId, "batch-a:1");
  assert.throws(() => api.loadCloneResumeSnapshot("002", { taskId: 1, chatId: "chat-a" }), /必须携带 resumeJobId/);
  assert.throws(() => api.loadCloneResumeSnapshot("002", { taskId: 1, jobId: "batch-b:1", chatId: "chat-a" }), /精确匹配 0 个/);
  assert.throws(() => api.loadCloneResumeSnapshot("002", { taskId: 3, jobId: "batch-a:3", chatId: "chat-a" }), /没有可续接消息/);
  const saved = api.saveCloneResumeSnapshot("002", {
    job: { ownerUsername: "002", chatId: "chat-a", taskId: 4, jobId: "batch-a:4", cloneBatchId: "batch-a" },
    cloneId: 6,
    messages: [{ role: "system", content: "resume" }],
  }, { keepDays: 0 });
  assert.equal(saved.job.jobId, "batch-a:4");
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "batch-a_4.json"), "utf8")).messages[0].content, "resume");
  assert.throws(() => api.saveCloneResumeSnapshot("003", saved, { keepDays: 0 }), /owner\/job identity/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

assert.match(storage, /`\$\{_safeCloneResumeFileId\(job\.jobId\)\}\.json`/);
assert.doesNotMatch(runner, /node:fs|node:path|nicerWriteFileSync|getCloneResumeDir|_cloneResumeRecords/);
assert.match(runner, /saveCloneResumeSnapshot\(username/);
assert.match(runner, /loadCloneResumeSnapshot\(username/);
assert.match(actions, /listCloneResumeSnapshots,/);
assert.match(actions, /case "getActiveClones"/);
assert.match(actions, /case "getCloneResumes"/);
assert.match(actions, /resumeTaskId: data\.resumeTaskId, resumeJobId: data\.resumeJobId/);
assert.match(contract, /最大工作轮次必须是 0-10000/);
assert.match(actions, /normalizeCloneConfigs\(data\.clones, _clConfig\.clones\)/);
assert.match(panel, /最大工作轮次（0=无限）/);
assert.match(panel, /field === "maxRounds"/);
assert.match(panel, /verb: "getActiveClones"/);
assert.match(panel, /verb: "getCloneResumes"/);
assert.match(panel, /resumeJobId: btn\.dataset\.job/);
assert.match(panel, /jobId: btn\.dataset\.job, cloneBatchId: btn\.dataset\.batch/);

console.log("clone controls/resume contract test passed: 0/200 editable, active consumer, exact stop, jobId resume isolation");
