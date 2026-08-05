/**
 * files_settings_store_contract_test.mjs — D6 §4 settings 单写者契约（2026-08-04 窗口A）。
 * 覆盖：三写者并发不丢字段 / revision 单调 / CAS 冲突 typed 错误 / 原子写读回 /
 *       损坏 fail-closed（备份+禁写+视图最严默认）/ 显式 repair 成功 readback 才恢复 /
 *       旧格式迁移（legacyUnassigned，不自动授予）+ owner 显式认领 /
 *       root/browse 统一政策（C 盘普通目录/敏感目录/blockedPaths deny-overrides/盘符根）。
 * 全程经 __setSettingsPathForTest 指向临时文件，绝不触碰真实 data/beilu-files-settings.json。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  __setSettingsPathForTest,
  readSnapshot,
  mutate,
  patchUserFilesSettings,
  patchCommandGate,
  setWorkspaceScope,
  getCommandGateView,
  getFilesPermissionView,
  getWorkspaceView,
  getOwnerWorkspaceRoot,
  getSettingsHealth,
  listCorruptBackups,
  repair,
  ensureMigrated,
  adoptLegacyWorkspace,
  resolveWorkspaceRootCandidate,
  resolveBrowseListingTarget,
  listBrowseBases,
} from "../src/yonban/core/functions/security/filesSettingsStore.mjs";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freshStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beilu-settings-store-"));
  const file = path.join(dir, "beilu-files-settings.json");
  __setSettingsPathForTest(file);
  return { dir, file };
}

function cleanup(dir) {
  __setSettingsPathForTest(null);
  const resolved = path.resolve(dir);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), "cleanup must stay in OS temp");
  fs.rmSync(resolved, { recursive: true, force: true });
}

Deno.test("store: initial snapshot, concurrent writers, monotonic revision, CAS conflict", async () => {
  const { dir, file } = freshStoreFile();
  try {
    const init = readSnapshot();
    assert.equal(init.ok, true);
    assert.equal(init.persisted, false);
    assert.equal(init.revision, 0);
    assert.equal(fs.existsSync(file), false, "ENOENT snapshot must not persist");

    // 三写者并发（user bucket / commandGate / workspace scope）→ 全部字段都在，revision 单调 +3
    await Promise.all([
      patchUserFilesSettings("alice", { enabled: true, blockedPaths: ["C:/"] }),
      patchCommandGate("owner", (g) => { g.allowChannelBExec = false; g.failClosedUnknown = true; }),
      setWorkspaceScope("bob", "chatbob1", path.join(_repoRoot, "tests")),
    ]);
    const snap = readSnapshot();
    assert.equal(snap.ok, true);
    assert.equal(snap.revision, 3, "three serialized mutates → revision 3");
    assert.equal(snap.doc.schemaVersion, 2);
    assert.deepEqual(snap.doc.alice.blockedPaths, ["C:/"], "user bucket survived concurrent writers");
    assert.equal(snap.doc.commandGate.failClosedUnknown, true, "commandGate survived");
    assert.equal(
      snap.doc._global.workspaceByOwner.bob.byChatId.chatbob1,
      path.join(_repoRoot, "tests"),
      "workspace scope survived",
    );

    // CAS 冲突：旧 revision → E_SETTINGS_REVISION_CONFLICT + currentRevision，不覆盖
    await assert.rejects(
      () => mutate(1, { kind: "test" }, (doc) => { doc.commandGate = {}; }),
      (e) => e.code === "E_SETTINGS_REVISION_CONFLICT" && e.currentRevision === 3,
    );
    assert.equal(readSnapshot().doc.commandGate.failClosedUnknown, true, "conflict must not overwrite");

    // 正确 CAS 通过
    const r = await mutate(3, { kind: "test" }, (doc) => { doc.commandGate.rulesEnabled = false; });
    assert.equal(r.revision, 4);

    // 视图读路
    assert.equal(getCommandGateView().commandGate.rulesEnabled, false);
    assert.equal(getFilesPermissionView("nobody", "questions", true), true, "missing → def");
    assert.equal(getOwnerWorkspaceRoot("bob", "chatbob1"), path.join(_repoRoot, "tests"));
    assert.equal(getOwnerWorkspaceRoot("alice", "chatbob1"), "", "owner partition: no cross-owner root");
  } finally {
    cleanup(dir);
  }
  console.log("FILES_SETTINGS_STORE concurrent/CAS PASS");
});

Deno.test("store: corrupt → backup + fail-closed views/mutations; explicit repair restores", async () => {
  const { dir, file } = freshStoreFile();
  try {
    await patchUserFilesSettings("alice", { enabled: true, permissions: { questions: true } });
    // 制造损坏
    fs.writeFileSync(file, "{ this is not json", "utf-8");
    const bad = readSnapshot();
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "E_FILES_SETTINGS_CORRUPT");
    assert.ok(getSettingsHealth()?.state === "corrupt");
    const backups = listCorruptBackups();
    assert.ok(backups.length >= 1, "corrupt original must be backed up");

    // fail-closed：mutation 全拒、commandGate 视图最严默认、permissions 视图恒 false
    await assert.rejects(
      () => patchUserFilesSettings("alice", { enabled: false }),
      (e) => e.code === "E_FILES_SETTINGS_CORRUPT",
    );
    assert.equal(getCommandGateView().commandGate, null, "corrupt → null → callers use strictest defaults");
    assert.equal(getFilesPermissionView("alice", "questions", true), false, "corrupt → deny, not wide default");
    assert.equal(getOwnerWorkspaceRoot("alice"), "", "corrupt → no root served");

    // 无 repair 前健康故障不自清（即使文件被外部修好，仍等显式 revalidate）
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, revision: 9, _global: {} }), "utf-8");
    assert.equal(readSnapshot().ok, false, "health persists until explicit repair");

    // 显式 repair（revalidate 现文件）→ readback 成功才清故障
    const rep = await repair({ username: "owner" }, { revalidate: true });
    assert.equal(rep.repaired, true);
    assert.equal(getSettingsHealth(), null);
    assert.equal(readSnapshot().ok, true);
    assert.equal(readSnapshot().revision, 10, "repair advances revision");
    // repair 后 mutation 恢复
    await patchUserFilesSettings("alice", { enabled: true });
    assert.equal(readSnapshot().doc.alice.enabled, true);
  } finally {
    cleanup(dir);
  }
  console.log("FILES_SETTINGS_STORE corrupt/repair PASS");
});

Deno.test("store: legacy migration → legacyUnassigned (no auto-grant) → explicit adopt", async () => {
  const { dir, file } = freshStoreFile();
  try {
    // 旧格式（live 现场形状：_global.workspaceRoot + workspaceRoots + 用户桶）
    fs.writeFileSync(file, JSON.stringify({
      _global: {
        workspaceRoot: "D:\\old-root",
        workspaceRoots: { tlel3fq2eeh: "/c/Users/x/Temp/claude/ghost" },
      },
      _default: { enabled: true, blockedPaths: ["C:/"] },
    }, null, 2), "utf-8");

    const m = await ensureMigrated();
    assert.equal(m.migrated, true);
    const snap = readSnapshot();
    assert.equal(snap.ok, true);
    assert.equal(snap.doc.schemaVersion, 2);
    assert.equal(snap.doc._global.workspaceRoot, undefined, "legacy global root removed from runtime read path");
    assert.equal(snap.doc._global.legacyUnassigned.workspaceRoot, "D:\\old-root");
    assert.equal(snap.doc._global.legacyUnassigned.workspaceRoots.tlel3fq2eeh, "/c/Users/x/Temp/claude/ghost");
    assert.deepEqual(snap.doc._default.blockedPaths, ["C:/"], "existing user block remains explicit and must not be silently removed");
    // 运行时不自动授予：无 owner 分区 → 任何 owner 读根为空
    assert.equal(getOwnerWorkspaceRoot("_default"), "");
    assert.equal(getOwnerWorkspaceRoot("anyone", "tlel3fq2eeh"), "");

    // 幂等
    const m2 = await ensureMigrated();
    assert.equal(m2.migrated, false);

    // owner 显式认领 → 进入该 owner 分区并清 legacyUnassigned
    await adoptLegacyWorkspace("alice");
    const v = getWorkspaceView();
    assert.equal(v.legacyUnassigned, null);
    assert.equal(v.workspaceByOwner.alice.defaultRoot, "D:\\old-root");
    assert.equal(v.workspaceByOwner.alice.byChatId.tlel3fq2eeh, "/c/Users/x/Temp/claude/ghost");
  } finally {
    cleanup(dir);
  }
  console.log("FILES_SETTINGS_STORE legacy migration PASS");
});

Deno.test("store policy: root candidate & browse target (base containment / system / blocked / drive root)", async () => {
  const { dir } = freshStoreFile();
  const fixture = fs.mkdtempSync(path.join(_repoRoot, "tests", ".tmp_d6_policy_"));
  const sub = path.join(fixture, "workspace-a");
  fs.mkdirSync(sub, { recursive: true });
  try {
    // 合法候选（项目根基内、已存在）→ canonical 绝对路径
    const okExisting = resolveWorkspaceRootCandidate("alice", sub, { userBlockedPaths: ["C:/"] });
    assert.equal(okExisting.ok, true);
    assert.equal(okExisting.root, fs.realpathSync(sub));

    // 一层可建（父真实存在）；父链不存在=幽灵路径拒
    const okCreate = resolveWorkspaceRootCandidate("alice", path.join(fixture, "new-one"), {});
    assert.equal(okCreate.ok, true);
    assert.equal(okCreate.exists, false);
    const ghost = resolveWorkspaceRootCandidate("alice", path.join(fixture, "no", "such", "chain"), {});
    assert.equal(ghost.ok, false);
    assert.equal(ghost.code, "E_WORKSPACE_ROOT_INVALID");

    // 项目根本体可作为 IDE/用户工作区与 browse 目标；内部 data/src/.git 仍拒。
    const projectWorkspace = resolveWorkspaceRootCandidate("alice", _repoRoot, {});
    assert.equal(projectWorkspace.ok, true, `project root must be a valid workspace: ${JSON.stringify(projectWorkspace)}`);
    assert.equal(projectWorkspace.root, fs.realpathSync(_repoRoot));
    const projectBrowse = resolveBrowseListingTarget("alice", _repoRoot, {});
    assert.equal(projectBrowse.ok, true, `project root must be browsable: ${JSON.stringify(projectBrowse)}`);
    assert.equal(projectBrowse.path, fs.realpathSync(_repoRoot));
    for (const p of [path.join(_repoRoot, "data"), path.join(_repoRoot, "src"), path.join(_repoRoot, ".git")]) {
      const r = resolveWorkspaceRootCandidate("alice", p, {});
      assert.equal(r.ok, false, `${p} must be denied`);
      assert.equal(r.code, "E_WORKSPACE_ROOT_SYSTEM");
      const b = resolveBrowseListingTarget("alice", p, {});
      assert.equal(b.ok, false, `${p} must not be browsable`);
      // 附加 worktree 的 .git 是指向主仓的文件而非目录，仍须拒绝，但会在
      // browse 的“只能列目录”层返回 E_BROWSE_SCOPE；普通 clone 保持 SYSTEM_VOLUME。
      assert.ok(["E_BROWSE_SYSTEM_VOLUME", "E_BROWSE_SCOPE"].includes(b.code));
    }

    // blockedPaths deny-overrides：条目覆盖 fixture 时其内根候选被拒（不可被"显式选根"覆盖）
    const blocked = resolveWorkspaceRootCandidate("alice", sub, { userBlockedPaths: [fixture] });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "E_WORKSPACE_ROOT_BLOCKED");

    // 无 owner 拒
    assert.equal(resolveWorkspaceRootCandidate("", sub, {}).ok, false);

    if (process.platform === "win32") {
      const cOrdinary = fs.mkdtempSync(path.join(os.homedir(), ".beilu_c_drive_policy_"));
      try {
        // C 盘普通目录进入现有统一政策；盘符根只可 browse，仍不可作工作区根。
        const cWorkspace = resolveWorkspaceRootCandidate("alice", cOrdinary, {});
        assert.equal(cWorkspace.ok, true, `ordinary C-drive workspace must be allowed: ${JSON.stringify(cWorkspace)}`);
        assert.equal(cWorkspace.root, fs.realpathSync(cOrdinary));
        const cBrowse = resolveBrowseListingTarget("alice", cOrdinary, {});
        assert.equal(cBrowse.ok, true, `ordinary C-drive browse must be allowed: ${JSON.stringify(cBrowse)}`);

        // 用户显式 C:/ 黑名单仍 deny-overrides；含其他条目的配置不会被迁移删除。
        const explicitCBlock = resolveWorkspaceRootCandidate("alice", cOrdinary, { userBlockedPaths: ["C:/", "D:/private"] });
        assert.equal(explicitCBlock.ok, false);
        assert.equal(explicitCBlock.code, "E_WORKSPACE_ROOT_BLOCKED");

        // 系统/用户敏感目录继续拒绝，即使它们位于现在可浏览的 C 盘基内。
        const sensitive = [
          "C:\\Windows",
          "C:\\Program Files",
          "C:\\ProgramData",
          path.join(os.homedir(), "AppData"),
          path.join(os.homedir(), ".ssh"),
          path.join(os.homedir(), ".gnupg"),
        ];
        for (const target of sensitive) {
          const denied = resolveWorkspaceRootCandidate("alice", target, {});
          assert.equal(denied.ok, false, `${target} must remain denied`);
          assert.equal(denied.code, "E_WORKSPACE_ROOT_SYSTEM");
        }
      } finally {
        fs.rmSync(cOrdinary, { recursive: true, force: true });
      }

      const driveRoot = resolveWorkspaceRootCandidate("alice", path.parse(_repoRoot).root, {});
      assert.equal(driveRoot.ok, false, "drive root cannot be a workspace root");
      // browse：C:/ 可列举用于 picker 探测；但不能被设为工作区根。
      const bc = resolveBrowseListingTarget("alice", "C:\\", {});
      assert.equal(bc.ok, true, `C:/ drive root must be browsable for picker discovery: ${JSON.stringify(bc)}`);
      const bd = resolveBrowseListingTarget("alice", path.parse(_repoRoot).root, {});
      assert.equal(bd.ok, true, "repo drive root must be browsable");
      const bases = listBrowseBases();
      assert.ok(bases.some((b) => b.toLowerCase().startsWith("c:")), "C drive must be present in default browse bases");
    }

    // browse：目录合法、文件拒、blocked 拒
    const bOk = resolveBrowseListingTarget("alice", fixture, {});
    assert.equal(bOk.ok, true);
    const fileInFixture = path.join(fixture, "f.txt");
    fs.writeFileSync(fileInFixture, "x");
    assert.equal(resolveBrowseListingTarget("alice", fileInFixture, {}).ok, false, "browse lists directories only");
    const bBlocked = resolveBrowseListingTarget("alice", sub, { userBlockedPaths: [fixture] });
    assert.equal(bBlocked.ok, false);
    assert.equal(bBlocked.code, "E_BROWSE_BLOCKED");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    cleanup(dir);
  }
  console.log("FILES_SETTINGS_STORE policy PASS");
});
