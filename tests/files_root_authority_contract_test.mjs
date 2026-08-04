import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dispatch } from "../src/yonban/core/dispatch/dispatcher.mjs";
import { register } from "../src/yonban/core/dispatch/registry.mjs";
import filesPlugin, { _filesAls } from "../src/public/parts/plugins/beilu-files/main.mjs";
import { resolveTrustedBridgeScope } from "../src/server/web_server/yonban_bridge.mjs";
import "../src/yonban/core/functions/files/index.mjs";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

Deno.test("HTTP bridge resolves chat scope against authenticated owner", async () => {
	const ownerCheck = async (chatId, username) => chatId === "owned-chat" && username === "owner";
	const globalScope = await resolveTrustedBridgeScope({ user: "forged", chatId: "" }, "owner", ownerCheck);
	assert.equal(globalScope.ok, true);
	assert.deepEqual(globalScope.scope, { user: "owner" });
	assert.equal(Object.isFrozen(globalScope.scope), true);

	const owned = await resolveTrustedBridgeScope({ user: "forged", chatId: "owned-chat" }, "owner", ownerCheck);
	assert.equal(owned.ok, true);
	assert.deepEqual(owned.scope, { user: "owner", chatId: "owned-chat" });

	for (const [scope, code] of [
		[{ chatId: " other-chat" }, "E_SCOPE_CHAT_INVALID"],
		[{ chatId: "../other-chat" }, "E_SCOPE_CHAT_INVALID"],
		[{ chatId: "other-chat" }, "E_SCOPE_CHAT_OWNER"],
		[{ chatId: 42 }, "E_SCOPE_CHAT_INVALID"],
	]) {
		const denied = await resolveTrustedBridgeScope(scope, "owner", ownerCheck);
		assert.equal(denied.ok, false);
		assert.equal(denied.error?.code, code);
	}
});

Deno.test("dispatcher pins source and files facade enforces root/path authority", async () => {
	const probeTarget = `test:dispatch-context-${crypto.randomUUID()}`;
	register(probeTarget, {
		transport: "local",
		handlers: {
			inspect(_payload, context) {
				return { ok: true, data: { source: context.dispatchSource, frozen: Object.isFrozen(context) } };
			},
		},
	});
	const probe = await dispatch({
		target: probeTarget,
		verb: "inspect",
		source: "ai",
		payload: { dispatchSource: "web" },
		scope: { dispatchSource: "web" },
	});
	assert.deepEqual(probe, { ok: true, data: { source: "ai", frozen: true } });

	const config = filesPlugin.interfaces.config;
	const originalGetData = config.GetData;
	const originalSetData = config.SetData;
	const calls = [];
	config.GetData = async () => {
		calls.push({ verb: "getData", store: { ...(_filesAls.getStore() ?? {}) } });
		return { kind: "read" };
	};
	config.SetData = async (data) => {
		calls.push({ verb: "setData", data, store: { ...(_filesAls.getStore() ?? {}) } });
		return { accepted: true };
	};

	try {
		for (const source of ["ai", "scheduler", "yonban", "test", undefined]) {
			const before = calls.length;
			const denied = await dispatch({
				target: "functions:files",
				verb: "setData",
				source,
				payload: {
					dispatchSource: "web",
					source: "web",
					username: "forged-user",
					data: { _action: "setWorkspaceRoot", rootPath: "forged-root", dispatchSource: "web" },
				},
				scope: { user: "trusted-user", chatId: "trusted-chat" },
			});
			assert.equal(denied.ok, false);
			assert.equal(denied.error?.code, "E_FILES_ROOT_AUTHORITY");
			assert.equal(calls.length, before, `${source ?? "missing"} reached the plugin`);
		}

		const webRoot = await dispatch({
			target: "functions:files",
			verb: "setData",
			source: "web",
			payload: { username: "forged-user", data: { _action: "setWorkspaceRoot", rootPath: "web-root", chatid: "web-chat" } },
			scope: { user: "web-user", chatId: "web-chat", dispatchSource: "ai" },
		});
		assert.equal(webRoot.ok, true);
		assert.deepEqual(calls.at(-1), {
			verb: "setData",
			data: { _action: "setWorkspaceRoot", rootPath: "web-root", chatid: "web-chat" },
			store: { username: "web-user", dispatchSource: "web", chatId: "web-chat" },
		});

		const wsRoot = await dispatch({
			target: "functions:files",
			verb: "setData",
			source: "ws",
			payload: { data: { _action: "setMode", mode: "file", rootPath: "ws-root" } },
			scope: { user: "ws-user", chatId: "ws-chat" },
		});
		assert.equal(wsRoot.ok, true);
		assert.equal(calls.at(-1).data.chatid, "ws-chat");

		for (const data of [
			{ _action: "setWorkspaceRoot", rootPath: "root", chatid: "other-chat" },
			{ _action: "readFile", path: "a.txt", chatId: "other-chat" },
		]) {
			const before = calls.length;
			const denied = await dispatch({
				target: "functions:files",
				verb: "setData",
				source: "web",
				payload: { data },
				scope: { user: "web-user", chatId: "trusted-chat" },
			});
			assert.equal(denied.ok, false);
			assert.equal(denied.error?.code, data._action === "readFile" ? "E_FILES_CHAT_AUTHORITY" : "E_FILES_ROOT_AUTHORITY");
			assert.equal(calls.length, before);
		}

		const list = await dispatch({
			target: "functions:files",
			verb: "setData",
			source: "ai",
			payload: { username: "payload-user", dispatchSource: "web", data: { _action: "listDir", path: ".", dispatchSource: "web" } },
			scope: { user: "ai-user", chatId: "ai-chat" },
		});
		assert.equal(list.ok, true);
		assert.equal(calls.at(-1).data.chatid, "ai-chat");
		assert.deepEqual(calls.at(-1).store, { username: "ai-user", dispatchSource: "ai", chatId: "ai-chat" });

		const approveAll = await dispatch({
			target: "functions:files",
			verb: "setData",
			source: "web",
			payload: { data: { _action: "approveAll" } },
			scope: { user: "web-user", chatId: "web-chat" },
		});
		assert.equal(approveAll.ok, true);
		assert.equal(calls.at(-1).data.chatid, "web-chat");

		for (const action of ["approveOp", "rejectOp"]) {
			const singleApproval = await dispatch({
				target: "functions:files",
				verb: "setData",
				source: "web",
				payload: { data: { _action: action, opId: "op-1" } },
				scope: { user: "web-user", chatId: "web-chat" },
			});
			assert.equal(singleApproval.ok, true);
			assert.equal(calls.at(-1).data.chatid, "web-chat");
		}

		for (const scope of [{ user: "ai-user" }, { user: "ai-user", chatId: "" }]) {
			const before = calls.length;
			const denied = await dispatch({
				target: "functions:files",
				verb: "setData",
				source: "ai",
				payload: { data: { _action: "listDir", path: "." } },
				scope,
			});
			assert.equal(denied.ok, false);
			assert.equal(denied.error?.code, "E_FILES_CHAT_REQUIRED");
			assert.equal(calls.length, before);
		}

		const read = await dispatch({
			target: "functions:files",
			verb: "getData",
			source: "scheduler",
			payload: { username: "legacy-user", dispatchSource: "web" },
			scope: {},
		});
		assert.deepEqual(read, { ok: true, data: { kind: "read" } });
		assert.deepEqual(calls.at(-1).store, { username: "legacy-user", dispatchSource: "scheduler", chatId: undefined });

		// ---- [D6 2026-08-04 扩展] browse 授权与 IDE 根确认的 facade 权威闸 ----
		// requestBrowseGrant/adoptLegacyWorkspaceRoots：非 web/ws 来源或无认证用户 → E_BROWSE_SCOPE，零到插件
		for (const [source, scope] of [["ai", { user: "ai-user", chatId: "ai-chat" }], ["web", {}]]) {
			for (const action of ["requestBrowseGrant", "adoptLegacyWorkspaceRoots"]) {
				const before = calls.length;
				const denied = await dispatch({
					target: "functions:files",
					verb: "setData",
					source,
					payload: { data: { _action: action } },
					scope,
				});
				assert.equal(denied.ok, false, `${source}/${action} must be denied`);
				assert.equal(denied.error?.code, "E_BROWSE_SCOPE");
				assert.equal(calls.length, before, `${source}/${action} reached the plugin`);
			}
		}
		// confirmIdeWorkspaceRoot=根变更同级：AI 来源拒（E_FILES_ROOT_AUTHORITY），零到插件
		{
			const before = calls.length;
			const denied = await dispatch({
				target: "functions:files",
				verb: "setData",
				source: "ai",
				payload: { data: { _action: "confirmIdeWorkspaceRoot", rootPath: "x" } },
				scope: { user: "ai-user", chatId: "ai-chat" },
			});
			assert.equal(denied.ok, false);
			assert.equal(denied.error?.code, "E_FILES_ROOT_AUTHORITY");
			assert.equal(calls.length, before);
		}
		// web+认证 → 可达插件（此处 SetData 已桩化，仅验证 facade 放行面与 chatid 绑定）
		{
			const ok = await dispatch({
				target: "functions:files",
				verb: "setData",
				source: "web",
				payload: { data: { _action: "requestBrowseGrant" } },
				scope: { user: "web-user", chatId: "web-chat" },
			});
			assert.equal(ok.ok, true);
			assert.equal(calls.at(-1).data._action, "requestBrowseGrant");
			assert.deepEqual(calls.at(-1).store, { username: "web-user", dispatchSource: "web", chatId: "web-chat" });
		}
	} finally {
		config.GetData = originalGetData;
		config.SetData = originalSetData;
	}
});

Deno.test("settings single-writer source contract: no direct settings JSON writers outside the store", () => {
	// [D6 §4] B1 三写者退役的回归锁：endpoints/commandGate/ideClient/beilu-files 不得再自行
	//   read/parse/write beilu-files-settings.json（唯一 owner=filesSettingsStore）。
	const read = (p) => fs.readFileSync(path.join(_repoRoot, p), "utf-8");

	const endpoints = read("src/server/web_server/endpoints.mjs");
	assert.ok(!/_FILES_SETTINGS_PATH/.test(endpoints), "endpoints must not hold the settings path");
	assert.ok(!/writeFile\([^)]*beilu-files-settings/.test(endpoints), "endpoints must not write the settings file");
	assert.ok(endpoints.includes("filesSettingsStore.mjs"), "endpoints must go through the store");

	const commandGate = read("src/yonban/core/functions/security/commandGate.mjs");
	assert.ok(!/readFileSync\(\s*getFilesSettingsPath/.test(commandGate), "commandGate must not parse the settings file directly");
	assert.ok(commandGate.includes("getCommandGateView"), "commandGate must read the store view");

	const ideClient = read("src/yonban/core/transport/ideClient.mjs");
	assert.ok(!/readFileSync\(\s*getFilesSettingsPath/.test(ideClient), "ideClient must not parse the settings file directly");
	assert.ok(ideClient.includes("getFilesPermissionView"), "ideClient must read the store view");
	assert.ok(!ideClient.includes("_reconcileWorkspaceToCanonical()"), "IDE no-owner reverse root write must stay deleted");

	const plugin = read("src/public/parts/plugins/beilu-files/main.mjs");
	assert.ok(!/Deno\.writeTextFile\(\s*PERSIST_FILE/.test(plugin), "plugin must not write the settings file directly");
	assert.ok(plugin.includes("settingsStore.mutate"), "plugin persistence must go through store.mutate");
	console.log("SETTINGS_SINGLE_WRITER source contract PASS");
});

Deno.test("file explorer breadcrumb switches root before reading", () => {
	const source = fs.readFileSync(
		path.join(_repoRoot, "src/public/parts/shells/beilu-chat/public/src/panels/code/fileExplorer.mjs"),
		"utf-8",
	);
	const breadcrumbStart = source.indexOf('querySelectorAll(".file-root-crumb[data-root-path]")');
	const pickerStart = source.indexOf("data-root-action=\"pick\"", breadcrumbStart);
	assert.ok(breadcrumbStart >= 0 && pickerStart > breadcrumbStart, "breadcrumb handler must exist");
	const handler = source.slice(breadcrumbStart, pickerStart);
	assert.match(handler, /setFileExplorerRoot\(crumb\.dataset\.rootPath, originChatId\)/,
		"ancestor breadcrumbs must establish the new authoritative root");
	assert.doesNotMatch(handler, /\bhandleGoToPath\(|\bopenFileInEditor\(|_action:\s*["']readFile["']/,
		"ancestor breadcrumbs must not probe outside the old root or reinterpret directories as files");
});
