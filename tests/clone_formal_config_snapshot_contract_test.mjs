import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultCloneConfigs, normalizeCloneConfigs } from "../src/yonban/core/functions/memory/ai/cloneContract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coordinator = fs.readFileSync(path.join(root, "src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs"), "utf8");
const actions = fs.readFileSync(path.join(root, "src/yonban/core/functions/memory/handler/setDataActions.mjs"), "utf8");
const storage = fs.readFileSync(path.join(root, "src/yonban/core/functions/memory/storage_mod/storage.mjs"), "utf8");
const getClonesCase = actions.slice(actions.indexOf('case "getClones"'), actions.indexOf('case "saveClones"'));
const testCloneCase = actions.slice(actions.indexOf('case "testClone"'), actions.indexOf('case "inspectClonePermissions"'));
const inspectCase = actions.slice(actions.indexOf('case "inspectClonePermissions"'), actions.indexOf('case "runMemoryPreset"'));

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = body; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const readSnapshotSource = extractFunction(coordinator, "function readCloneConfigSnapshot");
const readJsonSnapshotSource = extractFunction(storage, "export function readJsonFileSnapshotStrict").replace("export ", "");
let configPath;
const readJsonSnapshot = new Function("fs", "crypto", `${readJsonSnapshotSource}; return readJsonFileSnapshotStrict;`)(fs, crypto);
const readSnapshot = new Function("getYonbanConfigPath", "createDefaultCloneConfigs", "normalizeCloneConfigs", "readJsonFileSnapshotStrict", `
  ${readSnapshotSource}
  return readCloneConfigSnapshot;
`)(() => configPath, createDefaultCloneConfigs, normalizeCloneConfigs, readJsonSnapshot);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "beilu-clone-config-snapshot-"));
try {
  configPath = path.join(temp, "missing.json");
  const missing = readSnapshot("002");
  assert.equal(missing.revision, null);
  assert.equal(missing.clones.length, 6);
  assert.equal(missing.clones[0].enabled, true);

  configPath = path.join(temp, "valid.json");
  const validSource = JSON.stringify({
    clone_async: { enabled: true },
    clones: [{ id: 9, label: "长任务", enabled: true, maxRounds: 200 }],
  });
  fs.writeFileSync(configPath, validSource);
  const expectedRevision = crypto.createHash("sha256").update(validSource).digest("hex");
  const valid = readSnapshot("002");
  assert.equal(valid.revision, expectedRevision);
  assert.equal(valid.clone_async.enabled, true);
  assert.equal(valid.clones[0].maxRounds, 200);

  const fixedTime = new Date("2026-08-13T00:00:00.000Z");
  fs.utimesSync(configPath, fixedTime, fixedTime);
  const oldRevision = readSnapshot("002").revision;
  fs.writeFileSync(configPath, JSON.stringify({ clones: [{ id: 9, label: "不同内容", enabled: true }] }));
  fs.utimesSync(configPath, fixedTime, fixedTime);
  assert.notEqual(readSnapshot("002").revision, oldRevision, "相同 mtime 的不同内容必须得到不同 revision");

  configPath = path.join(temp, "bom.json");
  fs.writeFileSync(configPath, `\uFEFF${JSON.stringify({ clones: [{ id: 10, label: "BOM", enabled: true }] })}`);
  assert.equal(readSnapshot("002").clones[0].label, "BOM");

  configPath = path.join(temp, "explicit-empty.json");
  fs.writeFileSync(configPath, JSON.stringify({ clones: [] }));
  assert.deepEqual(readSnapshot("002").clones, [], "显式空数组不得复活默认分身");

  configPath = path.join(temp, "custom-only.json");
  fs.writeFileSync(configPath, JSON.stringify({ clones: [{ id: 99, label: "仅自定义", enabled: true }] }));
  assert.deepEqual(readSnapshot("002").clones.map((clone) => clone.id), [99], "缺默认 id 不得静默补种");

  configPath = path.join(temp, "broken.json");
  fs.writeFileSync(configPath, "{ broken");
  assert.throws(() => readSnapshot("002"), /JSON 配置损坏.*拒绝读取/);

  configPath = path.join(temp, "wrong-shape.json");
  fs.writeFileSync(configPath, JSON.stringify({ clones: {} }));
  assert.throws(() => readSnapshot("002"), /分身配置必须是数组/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const snapshotAt = coordinator.indexOf("const config = readCloneConfigSnapshot(username)");
const preflightAt = coordinator.indexOf("const selectedClones = runnableTasks.map");
const admitAt = coordinator.indexOf('if (!admit("clone"');
const registerAt = coordinator.indexOf("const abortControllers = jobs.map");
const queuedAt = coordinator.indexOf("jobs.forEach((job, index) => emitStatus");
assert.ok(snapshotAt >= 0 && snapshotAt < preflightAt && preflightAt < admitAt && admitAt < registerAt && registerAt < queuedAt,
  "snapshot normalize/select must finish before admission, controller registration and queued projection");
assert.match(coordinator, /resolveCloneConfig\(config, task, undefined, \{ requireEnabled: true \}\)/);
assert.match(coordinator, /configSnapshot: config/);
assert.doesNotMatch(coordinator, /node:fs|fstatSync|loadJsonFileIfExists\(getYonbanConfigPath/);
assert.match(coordinator, /readJsonFileSnapshotStrict\(configPath, \{\}\)/);
assert.match(getClonesCase, /_clConfig\.clones = createDefaultCloneConfigs\(\)/);
assert.doesNotMatch(getClonesCase, /const _base = \{ read_file:|_existingIds|const _defaults =/);
assert.match(getClonesCase, /strictRead: true/);
assert.match(getClonesCase, /\}, \{\}, \{ strictRead: true \}\)/, "文件不存在时必须把 clones 保持为缺失态，不能预填显式空数组");
assert.match(coordinator, /缺少 instruction/);
assert.match(coordinator, /rawResults\?\.\[index\] !== undefined/);
assert.match(coordinator, /unregisterCloneAbort\(username, chatId, runnableTasks\[index\]\.id, abortControllers\[index\]\)/);
assert.match(testCloneCase, /configRevision: result\.configRevision/);
assert.doesNotMatch(testCloneCase, /loadJsonFileIfExists\(getYonbanConfigPath/);
assert.match(inspectCase, /readJsonFileSnapshotStrict\(getYonbanConfigPath\(_icpUser\), \{\}\)/);
assert.doesNotMatch(inspectCase, /fs\.statSync|loadJsonFileIfExists/);

console.log("clone formal config snapshot contract test passed: shared defaults, same-handle revision, fail-closed read, pre-registration validation");
