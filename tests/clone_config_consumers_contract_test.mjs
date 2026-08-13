import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const storage = read("src/yonban/core/functions/memory/storage_mod/storage.mjs");
const coordinator = read("src/yonban/core/functions/memory/ai/cloneBatchCoordinator.mjs");
const actions = read("src/yonban/core/functions/memory/handler/setDataActions.mjs");
const prompt = read("src/yonban/core/functions/memory/handler/getPromptHandler.mjs");
const panel = read("src/public/parts/shells/beilu-chat/public/src/panels/work/subModePanel.mjs");
const yonbanModes = read("yonban-vscode/webview-ui/chat-modes.js");
const yonbanProvider = read("yonban-vscode/src/YonBanProvider.ts");
const yonbanService = read("yonban-vscode/src/services/ChatService.ts");

const testCloneCase = actions.slice(actions.indexOf('case "testClone"'), actions.indexOf('case "inspectClonePermissions"'));
const inspectCase = actions.slice(actions.indexOf('case "inspectClonePermissions"'), actions.indexOf('case "runMemoryPreset"'));
const getClonesCase = actions.slice(actions.indexOf('case "getClones"'), actions.indexOf('case "saveClones"'));
const saveClonesCase = actions.slice(actions.indexOf('case "saveClones"'), actions.indexOf("// === 编程表格定期清理频率配置"));
const webSaveFunction = panel.slice(panel.indexOf("async function _saveClones"), panel.indexOf("function _renderCloneDetail"));
const cloneMacroBlock = prompt.slice(prompt.indexOf("let _cloneMacroSnapshotMemo"), prompt.indexOf("// {{clone_runtime}}"));

assert.doesNotMatch(panel, /function _renderCloneListInner|clone-list-test-/);
assert.match(panel, /clone-detail-test-run/);
assert.equal((panel.match(/verb: "testClone"/g) || []).length, 2, "Web keeps the reachable per-clone test and resume actions, not a second list-level form");
assert.match(panel, /id="tableclean-freq"/);
assert.match(panel, /container\.appendChild\(tableCleanSection\);\s*_initTableCleanControl\(\);/);

assert.match(storage, /export function readJsonFileSnapshotStrict/);
assert.match(storage, /fs\.readFileSync\(handle, "utf8"\)[\s\S]*crypto\.createHash\("sha256"\)\.update\(source\)/);
assert.match(storage, /JSON 配置损坏，拒绝读取且未改写原文件/);
assert.doesNotMatch(coordinator, /from "node:fs"|fstatSync|fs\.readFileSync/);
assert.match(coordinator, /readJsonFileSnapshotStrict\(configPath, \{\}\)/);

assert.match(testCloneCase, /readJsonFileSnapshotStrict\(getYonbanConfigPath\(username\), \{\}\)/);
assert.match(testCloneCase, /revision: _tcSnapshot\.revision/);
assert.match(testCloneCase, /configRevision: result\.configRevision/);
assert.doesNotMatch(testCloneCase, /loadJsonFileIfExists\(getYonbanConfigPath|fs\.statSync/);
assert.match(inspectCase, /readJsonFileSnapshotStrict\(getYonbanConfigPath\(_icpUser\), \{\}\)/);
assert.match(inspectCase, /configRevision: _icpSnapshot\.revision/);
assert.doesNotMatch(inspectCase, /loadJsonFileIfExists|fs\.statSync/);
assert.match(getClonesCase, /await updateYonbanConfig[\s\S]*readJsonFileSnapshotStrict\(getYonbanConfigPath\(_clUser\), \{\}\)/);
assert.match(getClonesCase, /clones: _clClones, configRevision: _clReadback\.revision/);
assert.doesNotMatch(getClonesCase, /fs\.statSync|existsSync/);
assert.match(saveClonesCase, /clones: _clReadback\.value\.clones, configRevision: _clReadback\.revision/);
assert.match(saveClonesCase, /Object\.hasOwn\(data, "configRevision"\)[\s\S]*data\.configRevision !== _clCurrentRevision[\s\S]*normalizeCloneConfigs/);
assert.match(saveClonesCase, /\{ strictRead: true, snapshot: true \}/);
assert.match(storage, /revision: crypto\.createHash\("sha256"\)\.update\(source\)\.digest\("hex"\)/);
assert.match(storage, /mutator\(cfg, snapshot\?\.revision \?\? null\)/);
assert.match(storage, /options\?\.snapshot \? readJsonFileSnapshotStrict\(cfgPath\) : ret/);
assert.match(webSaveFunction, /payload: \{ clones: _clones, configRevision: _cloneConfigRevision \}/);
assert.doesNotMatch(webSaveFunction, /verb: "getClones"|var readback/);

assert.equal((cloneMacroBlock.match(/readJsonFileSnapshotStrict\(/g) || []).length, 1, "两个宏必须共用一次快照读");
assert.equal((cloneMacroBlock.match(/normalizeCloneConfigs\(/g) || []).length, 1, "两个宏必须共用一次 canonical 归一");
assert.equal((cloneMacroBlock.match(/_cloneMacroSnapshot\(\)/g) || []).length, 2, "clone_list/clone_configs 各消费同一 memo");
assert.doesNotMatch(cloneMacroBlock, /loadJsonFileIfExists|\.filter\(c => c\.enabled\)/);
assert.match(cloneMacroBlock, /c\.maxRounds === 0 \? "工作轮次:无限"/);
assert.match(cloneMacroBlock, /分身配置错误/);

const webSaveBlock = panel.slice(panel.indexOf('form.querySelector("#cl-save")'), panel.indexOf("if (rightInner) rightInner.appendChild(form)"));
assert.match(webSaveBlock, /var cloneBase = isEdit \? existing : \(_cloneTemplate \|\| \{\}\)/);
assert.match(webSaveBlock, /var perms = Object\.assign\(\{\}, \(_cloneTemplate && _cloneTemplate\.permissions\) \|\| \{\}, \(cloneBase && cloneBase\.permissions\) \|\| \{\}\)/);
assert.match(webSaveBlock, /var cloneData = Object\.assign\(\{\}, cloneBase, \{/);
assert.doesNotMatch(webSaveBlock, /var perms = \{\};|var cloneData = \{/);

const yonbanConfigHandler = yonbanModes.slice(yonbanModes.indexOf("function onClonesConfig"), yonbanModes.indexOf("function renderCloneList"));
const yonbanDeleteHandler = yonbanModes.slice(yonbanModes.indexOf('container.querySelectorAll("[data-cl-del]")'), yonbanModes.indexOf("function showCloneForm"));
const yonbanSaveStart = yonbanModes.indexOf('form.querySelector("#clf-save")');
const yonbanSaveHandler = yonbanModes.slice(yonbanSaveStart, yonbanModes.indexOf("document.body.appendChild(overlay)", yonbanSaveStart));
const providerCloneSave = yonbanProvider.slice(yonbanProvider.indexOf('case "saveClones"'), yonbanProvider.indexOf('case "stopCloneTask"'));
const providerCloneGet = yonbanProvider.slice(yonbanProvider.indexOf('case "getClones"'), yonbanProvider.indexOf('case "saveClones"'));
assert.match(yonbanConfigHandler, /state\._clones = payload\.clones \|\| \[\]/);
assert.match(yonbanConfigHandler, /state\._cloneConfigRevision = payload\.configRevision/);
assert.match(yonbanConfigHandler, /if \(payload\.saved\)[\s\S]*savedOverlay\.remove\(\)[\s\S]*已保存分身/);
assert.doesNotMatch(yonbanDeleteHandler, /state\._clones\.splice|renderCloneList\(\)|已删除分身/);
assert.match(yonbanDeleteHandler, /state\._cloneSavePending = true[\s\S]*state\._clones\.filter/);
assert.match(yonbanModes, /id="clf-maxrounds"[\s\S]*_numVal\("maxRounds"\)/);
assert.match(yonbanSaveHandler, /Object\.assign\(\{\}, _tplPerms, _cloneBase\.permissions \|\| \{\}\)/);
assert.match(yonbanSaveHandler, /Object\.assign\(\{\}, _cloneBase, \{/);
assert.match(yonbanSaveHandler, /maxRounds: _num\("#clf-maxrounds", "maxRounds", true\)/);
assert.doesNotMatch(yonbanSaveHandler, /state\._clones\.push|state\._clones\[[^\]]+\]\s*=|overlay\.remove\(\)|renderCloneList\(\)|showToast\(/);
assert.doesNotMatch(yonbanProvider.slice(yonbanProvider.indexOf("const ACTION_NOTIFY"), yonbanProvider.indexOf("export class")), /saveClones:/);
assert.match(providerCloneSave, /result\?\.success !== true[\s\S]*type: "clonesConfig"[\s\S]*saved: true/);
assert.match(providerCloneSave, /catch \(err: unknown\)[\s\S]*success: false[\s\S]*saved: true/);
assert.equal((yonbanModes.match(/type: "saveClones", payload: \{ clones:[^\n]+configRevision: state\._cloneConfigRevision/g) || []).length, 2);
assert.match(yonbanModes, /function showCloneForm\(existing\) \{\s*if \(state\._cloneSavePending\) return/);
assert.match(yonbanProvider, /handleMessage\(message, webviewView\)/);
assert.equal((providerCloneGet.match(/!sourceView \|\| this\._view === sourceView/g) || []).length, 2, "getClones 成功与失败都必须隔离旧视图");
assert.match(providerCloneSave, /saveClones\(pl\.clones, pl\.configRevision\)[\s\S]*sourceView && this\._view !== sourceView/);
assert.match(yonbanService, /saveClones\(clones: unknown\[\], configRevision: string \| null\)[\s\S]*\{ _action: "saveClones", clones, configRevision \}/);

console.log("clone config consumers contract test passed: canonical snapshots, Web/YonBan edit preservation, save readback before UI commit");
