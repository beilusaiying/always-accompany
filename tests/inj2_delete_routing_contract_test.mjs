import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMemoryDir,
  getUserDataDir,
  loadMemoryPresets,
  saveMemoryPresets,
} from "../src/yonban/core/functions/memory/storage_mod/storage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(
  repoRoot,
  "src/public/parts/plugins/beilu-memory/default_memory_presets.json",
);
const storageSource = fs.readFileSync(
  path.join(repoRoot, "src/yonban/core/functions/memory/storage_mod/storage.mjs"),
  "utf8",
);

Deno.test("INJ-2 routes deletion only through file_op while preserving the mode pair", () => {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const entries = template.injection_prompts || [];
  const inj2Entries = entries.filter((entry) => entry?.id === "INJ-2");
  const inj2CodeEntries = entries.filter((entry) => entry?.id === "INJ-2-code");

  assert.equal(inj2Entries.length, 1, "the canonical template must contain one INJ-2 entry");
  assert.equal(inj2CodeEntries.length, 1, "the existing mutually exclusive INJ-2-code variant must remain present");

  const inj2 = inj2Entries[0];
  const inj2Code = inj2CodeEntries[0];
  assert.deepEqual(
    {
      enabled: inj2.enabled,
      builtin: inj2.builtin,
      deletable: inj2.deletable,
      role: inj2.role,
      depth: inj2.depth,
      order: inj2.order,
      autoMode: inj2.autoMode,
    },
    {
      enabled: true,
      builtin: true,
      deletable: false,
      role: "system",
      depth: 999,
      order: 200,
      autoMode: "file",
    },
    "the routing clarification must not change INJ-2 mode or placement metadata",
  );
  assert.deepEqual(
    { autoMode: inj2Code.autoMode, role: inj2Code.role, depth: inj2Code.depth, order: inj2Code.order },
    { autoMode: "code", role: "system", depth: 1, order: -180 },
    "the INJ-2-code side of the existing mode pair must remain intact",
  );

  assert.match(
    inj2.content,
    /本注入含两套并存的操作系统[\s\S]*内置 CLI 工具表没有 delete\/delete_file，删除不走 <ideToolCall>/,
    "the two-executor overview must state that the CLI registry has no delete tool",
  );
  assert.match(
    inj2.content,
    /删除必须使用 `<file_op type="delete" path="路径"><\/file_op>`；绝不能输出 `<ideToolCall tool="delete">` 或 `<ideToolCall tool="delete_file">`/,
    "the delete rule must route deletion to file_op and forbid invented ideToolCall delete names",
  );
});

Deno.test("INJ-2 delete-routing migration upgrades only the old official default and is idempotent", () => {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const currentInj2 = template.injection_prompts.find((entry) => entry?.id === "INJ-2");
  assert.ok(currentInj2, "the canonical INJ-2 template must exist");

  const oldOfficialContent = currentInj2.content
    .replace(
      "- <ideToolCall>——beilu-cli 后端（YonBan 同款工具表），子标签符号 <old_string>/<new_string>；内置 CLI 工具表没有 delete/delete_file，删除不走 <ideToolCall>\n",
      "- <ideToolCall>——beilu-cli 后端（YonBan 同款工具表），子标签符号 <old_string>/<new_string>\n",
    )
    .replace(
      "- read / list 免审自动执行；search 默认自动执行（{{user}}关掉全局自动批准后进审批）；写类操作默认自动执行（受工作区沙箱保护）；删除必须使用 `<file_op type=\"delete\" path=\"路径\"></file_op>`；绝不能输出 `<ideToolCall tool=\"delete\">` 或 `<ideToolCall tool=\"delete_file\">`。delete 默认进{{user}}审批队列（{{user}}开启 file_delete 权限且自动批准时才自动执行）——等待批准时先做别的，重发不会加快",
      "- read / list 免审自动执行；search 默认自动执行（{{user}}关掉全局自动批准后进审批）；写类操作默认自动执行（受工作区沙箱保护）；delete 默认进{{user}}审批队列（{{user}}开启 file_delete 权限且自动批准时才自动执行）——等待批准时先做别的，重发不会加快",
    );
  assert.equal(
    crypto.createHash("sha256").update(oldOfficialContent, "utf8").digest("hex"),
    "5c3c4e3faf3f33f5b7f40139d375706baf72a31aefe1c6c82219577387f88dd7",
    "the test fixture must reconstruct the exact previous official INJ-2 default",
  );

  const usersRoot = path.resolve(repoRoot, "data", "users");
  const usernames = [
    `inj2-routing-official-${crypto.randomUUID()}`,
    `inj2-routing-custom-${crypto.randomUUID()}`,
  ];
  const userRoots = usernames.map((username) => path.resolve(getUserDataDir(username)));
  for (const userRoot of userRoots) {
    assert.ok(userRoot.startsWith(usersRoot + path.sep), `test user must stay inside ${usersRoot}`);
    assert.equal(fs.existsSync(userRoot), false, `test user path must be new: ${userRoot}`);
  }

  const seed = (username, content) => {
    const injectionPrompts = structuredClone(template.injection_prompts);
    injectionPrompts.find((entry) => entry.id === "INJ-2").content = content;
    saveMemoryPresets(username, "_global", {
      presets: structuredClone(template.presets),
      injection_prompts: injectionPrompts,
    });
    const memDir = getMemoryDir(username, "_global");
    fs.writeFileSync(path.join(memDir, "_inj_data_seed_v1.done"), "already-ran", "utf8");
    fs.writeFileSync(path.join(memDir, "_inj_seed_p0d_v3.done"), "already-ran", "utf8");
    fs.writeFileSync(path.join(memDir, "_inj_restore_zh_v4.done"), "already-ran", "utf8");
    return memDir;
  };

  try {
    const officialMemDir = seed(usernames[0], oldOfficialContent);
    const first = loadMemoryPresets(usernames[0], "_global");
    assert.equal(
      first.injection_prompts.find((entry) => entry.id === "INJ-2")?.content,
      currentInj2.content,
      "an untouched previous official default must upgrade to the current template",
    );
    const markerPath = path.join(officialMemDir, "_inj_delete_routing_v5.done");
    const storePath = path.join(officialMemDir, "_memory_presets", "_injections.json");
    assert.equal(fs.existsSync(markerPath), true, "the migration must write its one-shot marker");
    const firstStore = fs.readFileSync(storePath, "utf8");
    const firstMarker = fs.readFileSync(markerPath, "utf8");

    const second = loadMemoryPresets(usernames[0], "_global");
    assert.equal(second.injection_prompts.find((entry) => entry.id === "INJ-2")?.content, currentInj2.content);
    assert.equal(fs.readFileSync(storePath, "utf8"), firstStore, "a repeated load must not rewrite the migrated store");
    assert.equal(fs.readFileSync(markerPath, "utf8"), firstMarker, "a repeated load must not rewrite the marker");

    const customContent = `${oldOfficialContent}\n\n用户自定义删除规则`;
    const customMemDir = seed(usernames[1], customContent);
    const custom = loadMemoryPresets(usernames[1], "_global");
    assert.equal(
      custom.injection_prompts.find((entry) => entry.id === "INJ-2")?.content,
      customContent,
      "a user-edited INJ-2 must not be overwritten",
    );
    assert.equal(fs.existsSync(path.join(customMemDir, "_inj_delete_routing_v5.done")), true);

    const migrationBlock = storageSource.match(/const _m5 = [\s\S]*?catch \(_seedErr5\)/)?.[0] || "";
    assert.ok(migrationBlock, "the v5 migration block must remain present");
    assert.ok(
      migrationBlock.indexOf("_writeMemoryPresetsStore(memDir, data)") <
        migrationBlock.indexOf("fs.writeFileSync(_m5"),
      "a matching migration must persist the store before writing its marker so a failed write can retry",
    );
  } finally {
    for (const userRoot of userRoots) {
      if (!fs.existsSync(userRoot)) continue;
      assert.equal(fs.lstatSync(userRoot).isSymbolicLink(), false, `refuse to remove symlinked test path: ${userRoot}`);
      assert.ok(userRoot.startsWith(usersRoot + path.sep), `refuse out-of-scope cleanup: ${userRoot}`);
      fs.rmSync(userRoot, { recursive: true });
    }
  }
});
