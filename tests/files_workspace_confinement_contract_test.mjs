/**
 * files_workspace_confinement_contract_test.mjs — 工作区围栏契约（D6 扩展版 2026-08-04 窗口A）。
 * 相对旧版的契约变化（D6 §2/§3）：
 *   · blockedPaths 改 deny-overrides："显式选中根"不再覆盖祖先黑名单；唯一例外=部署锚定
 *     （条目覆盖应用部署根祖先时，部署根内部不受该条目约束——部署位置事实≠用户选根覆盖）。
 *   · 整机浏览（gateBrowseListing）从"沙箱闸失败即旁路"改为受限 grant 模型：
 *     无 grant→E_BROWSE_GRANT_REQUIRED；grant owner-bound 短期；路径过统一政策
 *     （基包含/系统卷/blockedPaths），C 盘/系统 temp 目录不可列。
 *   · fixture 从 os.tmpdir（系统盘）迁到仓库 tests/ 下（浏览/选根基内），与新政策自洽。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { confinePath } from "../src/yonban/core/functions/security/path_confine.mjs";
import filesPlugin, { __workspaceTestHooks, _filesAls } from "../src/public/parts/plugins/beilu-files/main.mjs";

const {
  pluginData,
  validateOpSecurity,
  gateFrontendFileOp,
  gateBrowseListing,
} = __workspaceTestHooks;

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function expectDenied(result, label) {
  assert.equal(result.ok, false, `${label}: expected denial, got ${JSON.stringify(result)}`);
  assert.equal(typeof result.error, "string", `${label}: denial must have a visible error`);
}

Deno.test("workspace confinement: trusted UI vs AI, physical escapes, deny-overrides blockedPaths", async () => {
  const tempBase = fs.mkdtempSync(path.join(_repoRoot, "tests", ".tmp_d6_confine_"));
  const rootA = path.join(tempBase, "workspace-a");
  const otherRoot = path.join(tempBase, "workspace-b");
  const outsideRoot = path.join(tempBase, "outside");
  const blockedDir = path.join(rootA, "blocked");
  const sensitiveDir = path.join(rootA, ".ssh");
  const normalFile = path.join(rootA, "normal.txt");
  const scriptFile = path.join(rootA, "tools.ps1");
  const otherFile = path.join(otherRoot, "other.txt");
  const outsideFile = path.join(outsideRoot, "outside.txt");

  for (const dir of [rootA, otherRoot, outsideRoot, blockedDir, sensitiveDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(normalFile, "inside");
  fs.writeFileSync(scriptFile, "Write-Output inside");
  fs.writeFileSync(otherFile, "other");
  fs.writeFileSync(outsideFile, "outside");
  fs.writeFileSync(path.join(blockedDir, "blocked.txt"), "blocked");
  fs.writeFileSync(path.join(sensitiveDir, "id_rsa"), "sensitive");

  const testUser = `confinement-${crypto.randomUUID()}`;
  await _filesAls.run(
    { username: testUser, dispatchSource: "ai", chatId: "chat-a" },
    async () => {
      const oldRoot = pluginData.workspaceRoot;
      const oldRoots = new Map(pluginData.workspaceRoots);
      const oldAllowed = pluginData.allowedPaths;
      const oldBlocked = pluginData.blockedPaths;
      try {
        pluginData.workspaceRoot = rootA;
        pluginData.workspaceRoots.clear();
        pluginData.workspaceRoots.set("chat-a", rootA);
        pluginData.workspaceRoots.set("chat-b", otherRoot);
        pluginData.allowedPaths = [];
        // [D6 §3.4] 部署锚定例外：仓库盘符根级黑名单（如默认 C:/ 对 C 盘部署）对部署根内部不生效，
        //   根内操作照常；这是"部署位置事实"，不是旧版"选中根覆盖祖先黑名单"语义。
        pluginData.blockedPaths = [path.parse(rootA).root];

        const relativeInside = { type: "read", path: "normal.txt", _cid: "chat-a" };
        assert.equal(validateOpSecurity(relativeInside).ok, true);
        assert.equal(relativeInside.path, fs.realpathSync(normalFile));

        expectDenied(
          validateOpSecurity({ type: "read", path: path.join("..", "outside", "outside.txt"), _cid: "chat-a" }),
          "relative traversal",
        );
        expectDenied(
          validateOpSecurity({ type: "read", path: outsideFile, _cid: "chat-a", _actor: "human", source: "web" }),
          "absolute outside path with spoofed actor",
        );

        expectDenied(
          validateOpSecurity({ type: "read", path: otherFile, _cid: "chat-a" }),
          "cross-chat root",
        );
        assert.equal(validateOpSecurity({ type: "read", path: otherFile, _cid: "chat-b" }).ok, true);

        // AI keeps the root-relative sensitive policy inside the selected root.
        expectDenied(validateOpSecurity({ type: "read", path: scriptFile, _cid: "chat-a" }), "AI script policy");
        expectDenied(
          validateOpSecurity({ type: "read", path: path.join(sensitiveDir, "id_rsa"), _cid: "chat-a" }),
          "AI descendant sensitive directory",
        );

        // Descendant block stays effective.
        pluginData.blockedPaths = [path.parse(rootA).root, blockedDir];
        expectDenied(
          validateOpSecurity({ type: "read", path: path.join(blockedDir, "blocked.txt"), _cid: "chat-a" }),
          "descendant block",
        );

        // [D6 §3.4] deny-overrides：黑名单条目直接覆盖当前根（非部署根祖先）→ 根内 AI 操作被拒，
        //   "显式选中的根"不再豁免（旧契约在此处会放行）。
        pluginData.blockedPaths = [tempBase];
        expectDenied(
          validateOpSecurity({ type: "read", path: "normal.txt", _cid: "chat-a" }),
          "deny-overrides: block covering the selected root itself",
        );
        pluginData.blockedPaths = [path.parse(rootA).root];

        for (const dispatchSource of ["web", "ws"]) {
          await _filesAls.run(
            { username: testUser, dispatchSource, chatId: "chat-a" },
            async () => {
              assert.equal(gateFrontendFileOp("list", rootA, "chat-a").ok, true);
              assert.equal(gateFrontendFileOp("read", scriptFile, "chat-a").ok, true);
              assert.equal(gateFrontendFileOp("read", path.join(sensitiveDir, "id_rsa"), "chat-a").ok, true);
            },
          );
        }

        // ---- [D6 §3] browse grant 模型 ----
        await _filesAls.run(
          { username: testUser, dispatchSource: "web", chatId: "chat-a" },
          async () => {
            // 无 grant → typed 拒绝（不再因"human+闸失败"自动旁路）
            const noGrant = gateBrowseListing(outsideRoot, null);
            expectDenied(noGrant, "browse without grant");
            assert.equal(noGrant.code, "E_BROWSE_GRANT_REQUIRED");

            // 签发 grant（human+认证+部署闸）→ 基内目录可列
            const issued = await filesPlugin.interfaces.config.SetData({ _action: "requestBrowseGrant" });
            assert.equal(issued?._result?.success, true, `grant issuance failed: ${JSON.stringify(issued)}`);
            const grantId = issued._result.grantId;
            const browse = gateBrowseListing(outsideRoot, grantId);
            assert.equal(browse.ok, true, `grant browse failed: ${JSON.stringify(browse)}`);
            assert.equal(browse.path, fs.realpathSync(outsideRoot));

            // grant 不扩大路径：系统 temp（系统盘域/基外）仍拒；应用 data 目录仍拒
            if (process.platform === "win32" && !_repoRoot.toLowerCase().startsWith(os.tmpdir().slice(0, 2).toLowerCase())) {
              expectDenied(gateBrowseListing(os.tmpdir(), grantId), "grant must not open system temp");
            }
            expectDenied(gateBrowseListing(path.join(_repoRoot, "data"), grantId), "grant must not open app data dir");

            // 伪 grant 拒
            const forged = gateBrowseListing(outsideRoot, "bg_forged");
            expectDenied(forged, "forged grant");
            assert.equal(forged.code, "E_BROWSE_GRANT_REQUIRED");

            // 释放后拒
            await filesPlugin.interfaces.config.SetData({ _action: "releaseBrowseGrant" });
            expectDenied(gateBrowseListing(outsideRoot, grantId), "released grant");
          },
        );

        await _filesAls.run(
          { username: "ai", dispatchSource: "ai", chatId: "chat-a" },
          async () => {
            expectDenied(gateFrontendFileOp("list", outsideRoot, "chat-a"), "AI outside list");
            expectDenied(gateBrowseListing(outsideRoot, "bg_any"), "AI picker browse");
            // AI 来源拿不到 grant（human actor 硬性要件）
            const aiGrant = await filesPlugin.interfaces.config.SetData({ _action: "requestBrowseGrant" });
            assert.equal(aiGrant?._result?.success, false, "AI must not obtain a browse grant");
          },
        );

        expectDenied(
          validateOpSecurity({ type: "move", path: normalFile, destPath: outsideFile, _cid: "chat-a" }),
          "move destination outside root",
        );
        const insideMove = { type: "move", path: normalFile, destPath: path.join(rootA, "new.txt"), _cid: "chat-a" };
        assert.equal(validateOpSecurity(insideMove).ok, true);
        assert.equal(insideMove.destPath, path.join(fs.realpathSync(rootA), "new.txt"));

        const escapeLink = path.join(rootA, "escape-link");
        let linkCreated = false;
        try {
          fs.symlinkSync(outsideRoot, escapeLink, process.platform === "win32" ? "junction" : "dir");
          linkCreated = true;
        } catch (err) {
          if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
          console.log(`FILES_WORKSPACE_CONFINEMENT symlink=SKIP code=${err.code}`);
        }
        if (linkCreated) {
          assert.throws(
            () => confinePath(rootA, path.join(escapeLink, "outside.txt"), { realpath: true }),
            /escapes confinement root/,
          );
          assert.throws(
            () => confinePath(rootA, path.join(escapeLink, "not-yet-created", "child.txt"), { realpath: true }),
            /escapes confinement root/,
          );
          expectDenied(
            validateOpSecurity({ type: "move", path: normalFile, destPath: path.join(escapeLink, "new.txt"), _cid: "chat-a" }),
            "move destination behind escaped link",
          );
        }
      } finally {
        pluginData.workspaceRoot = oldRoot;
        pluginData.workspaceRoots.clear();
        for (const [chatId, root] of oldRoots) pluginData.workspaceRoots.set(chatId, root);
        pluginData.allowedPaths = oldAllowed;
        pluginData.blockedPaths = oldBlocked;
      }
    },
  );

  const resolvedTemp = path.resolve(tempBase);
  assert.ok(resolvedTemp.startsWith(path.join(_repoRoot, "tests") + path.sep), "cleanup target must remain below repo tests dir");
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
  console.log("FILES_WORKSPACE_CONFINEMENT PASS");
});
