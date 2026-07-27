/**
 * importExport.mjs — 导入导出集中管理面板（设置弹窗「导入导出」section，快速模式直连）
 *
 * 功能链：打开设置弹窗「导入导出」section → _initImportExportPanel(slot) 渲染两块：
 *   1. 六类对象聚合区（角色卡 / 世界书 / 预设 / 正则 / 记忆包 / 主题），每类一张卡：
 *      「导入」「导出」= 快速模式**直连**——当场选文件/选对象，直接走各类型既有后端 verb 完成，
 *      不跳转任何其他界面（凛倾 07-10：快速模式点击却是转跳=错，且跳转目标会被设置弹窗遮挡）：
 *        - 角色卡  导入 importChar verb（FormData，shells:chat）；导出 listAllCached 列表→beiluSelect 选卡
 *                  → GET char/{name}/export 路由（PNG，后端无头像自动降级 JSON，镜像 charsel.mjs 范式）
 *        - 世界书  导入 import_worldbook verb（校验 entries + beiluPrompt 命名 + 重名 beiluConfirm 覆盖确认，
 *                  镜像 panels.mjs #wb-import）；导出 getData 列表→beiluSelect→export_worldbook verb→st_json 下载
 *        - 预设    导入 updatePresetConfig{import_preset}（duplicate 确认 + regex_scripts 同步 syncPresetRegex，
 *                  镜像 panels.mjs #pp-import）；导出 getData preset_list→beiluSelect（默认=运行时激活预设）
 *                  →{export_st_preset}→st_json 下载
 *        - 正则    导入 importST verb（beiluChoice 三分作用域 全局/角色/预设，镜像 regexEditor pickImportScope
 *                  语义：scoped 绑 getCharId、preset 绑运行时激活预设）；导出 exportAll verb→JSON 下载
 *        - 记忆包  导入 importMemory verb（zip→base64 或旧 JSON 格式，beiluConfirm 前置，镜像 memoryPresetChat）；
 *                  导出 exportMemory verb→zipBase64 解码下载（charName=getCharId() 当前角色）
 *        - 主题    直调 settingsSlots.mjs importThemeFile/exportCurrentTheme（纯前端实现单源在彼处）
 *      「完整管理 →」= 跳各类型完整界面。跳浮窗类目标前**先关设置弹窗**（遮挡修复：设置弹窗 z=1000
 *        盖死记忆浮窗 z=150；charsel z=2000 有 stacking context 陷阱——统一先关，杜绝层级赌博）；
 *        编辑器 tab 类走 beilu:openEditorTab（W59 互斥自关设置弹窗）；主题跳设置内「界面」section（同弹窗不关）。
 *   2. 导入历史区（getImportHistory() 读 localStorage KEYS.BEILU_IMPORT_HISTORY，倒序展示「何时导入了什么」）。
 *
 * why：凛倾「文件树没有文件,导入导出专门做个窗口然后专门进行管理」（06-25 1c36b376:2286）建聚合层；
 *   凛倾 07-10「这个是快速模式,但是点击却是跳转,而不是直接导入或者导出」+「没有考虑遮挡和层级问题」——
 *   首版纯跳转两病：①快速语义落空 ②跳转目标（记忆浮窗等）被设置弹窗压住不可见。
 *   本版直连后端 verb（后端实现单源不动），前端薄接线镜像各既有入口范式；主题类实现较厚，
 *   抽 settingsSlots 模块级函数共用，禁复制第二份（双源病）。
 *
 * 关联链：
 *   ← settings.mjs（section 切换到 "import-export" 时懒加载调用 _initImportExportPanel）
 *   → sendAction（importChar/import_worldbook/export_worldbook/updatePresetConfig/importST/exportAll/
 *     importMemory/exportMemory/listAllCached/getData/syncPresetRegex 各 verb）
 *   → apiFetch（角色卡导出二进制流，raw，R1-SKIP 同 charsel.mjs）
 *   → beiluDialog（beiluSelect 选导出对象 / beiluChoice 选正则作用域 / beiluPrompt 世界书命名 / beiluConfirm 覆盖确认）
 *   → settingsSlots.mjs（importThemeFile/exportCurrentTheme；注意 settingsSlots 反向 import 本模块
 *     recordImportHistory——ESM 函数声明循环引用，运行时调用安全）
 *   → settings.mjs（_toggleSettingsModal 关设置弹窗防遮挡；同为函数声明循环引用，安全）
 *   → sharedState（getCharId/getCharName：角色卡导出默认项、正则角色作用域、记忆包目标角色）
 *   → storage.mjs（KEYS.BEILU_IMPORT_HISTORY：导入历史本地存储集中收口，R2 规范）
 *   recordImportHistory 被各现有导入入口成功后调用（charsel/memoryPresetChat/panels/regexEditor/settingsSlots），
 *   本模块是导入历史的唯一读写权威（各入口只 import recordImportHistory 上报，不裸写 localStorage）。
 *
 * 影响范围：
 *   DOM：#settings-import-export-slot 内容（打开该 section 时注入）；body 下临时 <dialog>（beiluDialog 自清理）；
 *   localStorage：KEYS.BEILU_IMPORT_HISTORY（导入历史，最多保留 MAX_HISTORY 条）；
 *   后端：仅在用户点导入/导出时发对应 verb 请求（面板渲染本身零请求）。
 *
 * 使用效果：
 *   用户打开设置→导入导出：点某类「导入」当场弹文件选择、选完直接导入完成（toast 反馈 + 历史区落记录）；
 *   点「导出」需要选对象的弹下拉选一个、直接下载文件；点「完整管理 →」去对应完整界面（不再被遮挡）。
 */
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2：导入历史 localStorage 集中收口
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { apiFetch } from "../../shared/transport/api-client.mjs"; // 角色卡导出二进制流（raw，R1-SKIP 同 charsel）
import { beiluConfirm, beiluPrompt, beiluChoice, beiluSelect } from "../../shared/widgets/beiluDialog.mjs";
import { getCharId, getCharName } from "../../shared/state/sharedState.mjs";
import { showToast } from "../../../../../../scripts/toast.mjs";
import { _toggleSettingsModal } from "./settings.mjs"; // 跳浮窗类完整界面前关设置弹窗（防遮挡）
import { importThemeFile, exportCurrentTheme } from "./settingsSlots.mjs"; // 主题实现单源在 settingsSlots
import { escapeHtml, downloadBlob as _utilsDownloadBlob } from "../../shared/state/utils.mjs"; // T7b：escapeHtml 统一二期——收口到壳权威版（原 _esc 为等价 5 字符自实现副本）；0716 下载基元收口

const MAX_HISTORY = 100; // 导入历史保留上限（超出丢最旧，防 localStorage 无限膨胀）

/**
 * 记录一条导入历史（各现有导入入口成功后调用；本模块是唯一写权威，禁裸 localStorage）。
 * @param {string} type - 对象类型标签（角色卡/世界书/预设/正则/记忆包/主题）。
 * @param {string} name - 导入对象名称（文件名或对象名）。
 */
export function recordImportHistory(type, name) {
  try {
    const list = getImportHistory();
    list.unshift({ type: String(type || "未知"), name: String(name || "—"), at: Date.now() });
    if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
    storage.set(KEYS.BEILU_IMPORT_HISTORY, JSON.stringify(list));
    // 若历史面板正打开，实时刷新（不打开则下次 init 时读取）
    _renderHistory();
  } catch { /* 私隐模式/配额满：静默降级，不阻断导入主流程 */ }
}

/**
 * 读取导入历史（倒序，最新在前）。JSON 损坏时返回 []（不抛错）。
 * @returns {Array<{type:string,name:string,at:number}>}
 */
export function getImportHistory() {
  try {
    const raw = storage.get(KEYS.BEILU_IMPORT_HISTORY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _clearImportHistory() {
  storage.remove(KEYS.BEILU_IMPORT_HISTORY);
  _renderHistory();
}

const _esc = escapeHtml; // T7b：alias 保调用点名不变，实现走壳权威版（原自实现与之逐字等价）

// ============================================================
// 快速模式共用小件
// ============================================================

/**
 * 弹系统文件选择框。注意：用户点「取消」时 change 不触发、Promise 永不 resolve——
 * 调用方不得依赖本 Promise 做状态恢复（如按钮 disable），本面板因此不锁按钮。
 * @param {string} accept - accept 属性（如 ".json,.png"）。
 * @param {boolean} [multiple=false]
 * @returns {Promise<File[]>}
 */
function _pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve([...(input.files || [])]));
    input.click();
  });
}

/** blob 下载：0716 轮子收口 → utils.downloadBlob 单源（本地签名保留，调用点零改） */
function _downloadBlob(blob, filename) {
  _utilsDownloadBlob(blob, filename);
}

/** 预设插件字段分派桥（镜像 panels.mjs postApi：verb=updatePresetConfig，payload 字段路由真动作） */
const _presetApi = (body) => sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: body });

/** 运行时激活预设名（权威真值：_beiluResolveActivePreset 优先，镜像 panels.mjs:172 范式） */
async function _getActivePreset() {
  const pd = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
  return { pd, active: (window._beiluResolveActivePreset?.(pd) ?? pd?.active_preset) || "" };
}

// ============================================================
// 六类对象：快速导入 / 快速导出 / 完整管理入口
// imp/exp 直连各类型既有后端 verb（后端实现单源）；openFull 跳完整界面（浮窗类先关设置弹窗防遮挡）
// ============================================================
const CATEGORIES = [
  {
    key: "char", icon: '<i data-ic="drama"></i>', label: "角色卡", hint: "SillyTavern 角色卡 (.png/.json)",
    imp: async () => {
      const files = await _pickFiles(".json,.png", true);
      if (!files.length) return;
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append("file", file);
          // 镜像 charsel.mjs:254：payload._form=FormData 直传，apiFetch 识别不 JSON 化
          const r = await sendAction({ verb: "importChar", target: "shells:chat", source: "web", payload: { _form: fd } });
          recordImportHistory("角色卡", r?.name || file.name);
          showToast("success", `已导入角色卡「${r?.name || file.name}」`);
        } catch (e) { showToast("error", `导入 ${file.name} 失败: ${e.message}`); }
      }
      // 系统事件：角色列表已变，charsel 若开着自刷新（镜像 charsel 监听契约）
      window.dispatchEvent(new CustomEvent("beilu:chars-changed"));
    },
    exp: async () => {
      const rd = await sendAction({ verb: "listAllCached", target: "server:chars", source: "web" });
      const names = [...Object.keys(rd?.cachedDetails || {}), ...(rd?.uncachedNames || [])];
      if (!names.length) { showToast("info", "暂无角色卡可导出"); return; }
      const cur = getCharId();
      const name = await beiluSelect("选择要导出的角色卡：", names, { title: "导出角色卡", defaultValue: names.includes(cur) ? cur : names[0] });
      if (!name) return;
      // 镜像 charsel.mjs:196-207：PNG 优先，后端无头像自动降级 JSON（Content-Type 区分）
      const resp = await apiFetch(`/api/parts/shells:chat/char/${encodeURIComponent(name)}/export?format=png`, { raw: true });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); showToast("error", "导出失败: " + (e.message || resp.status)); return; }
      const blob = await resp.blob();
      const ext = (resp.headers.get("Content-Type") || "").includes("application/json") ? ".json" : ".png";
      _downloadBlob(blob, name + ext);
      showToast("success", "角色卡已导出: " + name + ext);
    },
    // charsel overlay z=2000 数字上盖过设置弹窗 z=1000，但两者 DOM 位置不同、有 stacking context
    // 局部化陷阱（凛倾实测被遮）——统一先关设置弹窗，不赌层级。
    openFull: () => { _toggleSettingsModal("settings", false); document.getElementById("header-char-name")?.click(); },
  },
  {
    key: "worldbook", icon: '<i data-ic="book"></i>', label: "世界书", hint: "ST 世界书 (.json)",
    imp: async () => {
      const [file] = await _pickFiles(".json,application/json");
      if (!file) return;
      let json;
      try { json = JSON.parse(await file.text()); } catch (e) { showToast("error", "导入失败: JSON 格式无效 — " + e.message); return; }
      // 契约（镜像 panels.mjs #wb-import）：json.entries 缺失=后端静默 no-op → 前端先校验
      if (!json?.entries || typeof json.entries !== "object") { showToast("error", "不是有效的 ST lorebook JSON（缺 entries 字段）"); return; }
      const name = (await beiluPrompt("导入为世界书名称：", file.name.replace(/\.json$/i, "")))?.trim();
      if (!name) return;
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });
      // 重名=后端直接覆盖 → 前端 beiluConfirm 前置
      if ((data?.worldbook_list || []).includes(name) && !(await beiluConfirm(`世界书「${name}」已存在，导入将覆盖其全部条目，继续？`))) return;
      const r = await sendAction({ verb: "import_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { json, name } }) || {};
      const rr = r._result || r; // 后端裹 {_result:{success}}，facade 不拆
      if (rr.success === false) throw new Error(rr.error || "导入失败");
      window.dispatchEvent(new CustomEvent("beilu-worldbook-changed"));
      recordImportHistory("世界书", name);
      showToast("success", `世界书「${name}」已导入（默认关闭，绑定/启用后生效）`);
    },
    exp: async () => {
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-worldbook", source: "web" });
      const list = data?.worldbook_list || [];
      if (!list.length) { showToast("info", "暂无世界书可导出"); return; }
      const name = await beiluSelect("选择要导出的世界书：", list, { title: "导出世界书", defaultValue: data?.active_worldbook || list[0] });
      if (!name) return;
      const r = await sendAction({ verb: "export_worldbook", target: "plugins:beilu-worldbook", source: "web", payload: { name } }) || {};
      const res = r._result || r; // 后端裹 {_result:{success,name,st_json}}，facade 不拆
      if (!res.success || !res.st_json) { showToast("error", "导出失败: " + (res.error || "无 st_json")); return; }
      _downloadBlob(new Blob([res.st_json], { type: "application/json" }), `${res.name || name}.json`);
      showToast("success", `世界书「${res.name || name}」已导出`);
    },
    openFull: () => window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "worldbook-edit" })),
  },
  {
    key: "preset", icon: '<i data-ic="tune"></i>', label: "预设", hint: "ST 预设 (.json)",
    imp: async () => {
      const [file] = await _pickFiles(".json");
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { showToast("error", "导入失败: JSON 格式无效 — " + e.message); return; }
      const presetName = data.name || file.name.replace(/\.json$/i, "");
      // 镜像 panels.mjs #pp-import：后端重名检测 duplicate=true 时弹确认，用户选覆盖则 force_overwrite 重试
      const importResult = await _presetApi({ import_preset: { json: data, name: presetName } });
      if (importResult?.duplicate) {
        if (!(await beiluConfirm(importResult.message || `预设「${presetName}」已存在，是否覆盖？`))) return;
        await _presetApi({ import_preset: { json: data, name: presetName, force_overwrite: true } });
      }
      // W63 镜像：导入预设时同步 regex scripts 到 beilu-regex（部分成功需用户可见）
      const regexScripts = data?.extensions?.regex_scripts;
      if (Array.isArray(regexScripts) && regexScripts.length > 0) {
        try {
          await sendAction({ verb: "syncPresetRegex", target: "plugins:beilu-regex", source: "web", payload: { presetName, scripts: regexScripts } });
        } catch (e) { showToast("warning", "预设已导入，但 regex 脚本同步失败: " + (e?.message || e)); }
      }
      recordImportHistory("预设", presetName);
      showToast("success", `预设「${presetName}」已导入`);
    },
    exp: async () => {
      const { pd, active } = await _getActivePreset();
      const list = pd?.preset_list || [];
      if (!list.length) { showToast("info", "暂无预设可导出"); return; }
      const name = await beiluSelect("选择要导出的预设：", list, { title: "导出预设", defaultValue: list.includes(active) ? active : list[0] });
      if (!name) return;
      // 镜像 panels.mjs #pp-export：export_st_preset 单一权威序列化，返回 {success,st_json,name}
      const res = await _presetApi({ export_st_preset: { name } });
      if (!res?.success || !res.st_json) { showToast("error", "导出失败: " + (res?.error || "无 st_json")); return; }
      const base = (res.name || name).replace(/\.json$/i, "");
      _downloadBlob(new Blob([res.st_json], { type: "application/json" }), base + ".json");
      showToast("success", `预设「${base}」已导出`);
    },
    openFull: () => window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "preset-edit" })),
  },
  {
    key: "regex", icon: '<i data-ic="abc"></i>', label: "正则", hint: "ST 正则脚本 (.json)",
    imp: async () => {
      const [file] = await _pickFiles(".json");
      if (!file) return;
      let json;
      try { json = JSON.parse(await file.text()); } catch (e) { showToast("error", "导入失败: JSON 格式无效 — " + e.message); return; }
      // 三分作用域（镜像 regexEditor pickImportScope 语义）：scoped 绑角色目录 id（P-A根修：非显示名）、
      // preset 绑运行时激活预设（不读 #preset-selector——编辑器未开时该元素无值）
      const charId = getCharId() || "";
      const { active: activePreset } = await _getActivePreset();
      const scope = await beiluChoice("导入到哪个作用域？", [
        { label: "全局", value: "global" },
        { label: `角色（${getCharName() || charId || "当前角色"}）`, value: "scoped" },
        { label: `预设（${activePreset.replace(/\.json$/i, "") || "当前预设"}）`, value: "preset" },
      ], { title: "导入正则" });
      if (!scope) return;
      const scripts = Array.isArray(json) ? json : [json];
      const result = await sendAction({ verb: "importST", target: "plugins:beilu-regex", source: "web", payload: {
        scripts, scope,
        boundCharName: scope === "scoped" ? charId : "",
        boundPresetName: scope === "preset" ? activePreset : "",
      } });
      recordImportHistory("正则", file.name);
      const scopeLabel = { global: "全局", scoped: "角色", preset: "预设" }[scope] || scope;
      showToast("success", `已导入 ${result?._result?.count || scripts.length} 条正则规则（${scopeLabel}）`);
    },
    exp: async () => {
      const result = await sendAction({ verb: "exportAll", target: "plugins:beilu-regex", source: "web" });
      if (!result?._result) { showToast("error", "导出失败: 后端无返回"); return; }
      _downloadBlob(new Blob([JSON.stringify(result._result, null, 2)], { type: "application/json" }), "regex_scripts_all.json");
      showToast("success", "全部正则规则已导出");
    },
    openFull: () => window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: "regex-edit" })),
  },
  {
    key: "memory", icon: '<i data-ic="brain"></i>', label: "记忆包", hint: "记忆整包 (.zip)",
    imp: async () => {
      const [file] = await _pickFiles(".zip,.json");
      if (!file) return;
      const charName = getCharId();
      if (file.name.endsWith(".zip")) {
        // 镜像 memoryPresetChat handleImportFile zip 分支：zip→base64 发后端
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        const CHUNK = 0x8000; // 分块防 String.fromCharCode 参数上限爆栈
        for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        const zipBase64 = btoa(binary);
        if (!(await beiluConfirm(`确认导入 zip 记忆文件？\n文件: ${file.name}\n大小: ${(file.size / 1024).toFixed(1)} KB\n\n现有文件将被备份为 .import_bak`))) return;
        const result = await sendAction({ verb: "importMemory", target: "plugins:beilu-memory", source: "web", payload: { charName, zipBase64, backupExisting: true } });
        if (!result?.success) throw new Error(result?.error || "未知错误");
        recordImportHistory("记忆包", file.name);
        showToast("success", `记忆导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`);
        if (result.errors?.length) showToast("warning", "部分错误:\n" + result.errors.join("\n"));
      } else {
        // 旧 JSON 格式兼容（镜像 memoryPresetChat）
        let importData;
        try { importData = JSON.parse(await file.text()); } catch { showToast("error", "文件不是有效的 JSON 或 ZIP"); return; }
        if (importData._format !== "beilu-memory-export") { showToast("error", "文件格式不正确（缺少 beilu-memory-export 标识）"); return; }
        const fileCount = Object.keys(importData.files || {}).length;
        if (!(await beiluConfirm(`确认导入 ${fileCount} 个记忆文件？\n来源: ${importData.charName || "未知角色"}\n\n现有文件将被备份为 .import_bak`))) return;
        const result = await sendAction({ verb: "importMemory", target: "plugins:beilu-memory", source: "web", payload: { charName, importData, backupExisting: true } });
        if (!result?.success) throw new Error(result?.error || "未知错误");
        recordImportHistory("记忆包", file.name);
        showToast("success", `记忆导入完成: 成功 ${result.imported} 个, 跳过 ${result.skipped} 个`);
        if (result.errors?.length) showToast("warning", "部分错误:\n" + result.errors.join("\n"));
      }
    },
    exp: async () => {
      const charName = getCharId();
      const result = await sendAction({ verb: "exportMemory", target: "plugins:beilu-memory", source: "web", payload: { charName } });
      if (!result?.success || !result.zipBase64) { showToast("error", "导出失败: " + (result?.error || "未知响应格式")); return; }
      // 镜像 memoryPresetChat handleExport：base64→bytes→zip 下载
      const binaryStr = atob(result.zipBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      _downloadBlob(new Blob([bytes], { type: "application/zip" }), result.fileName || `beilu-memory_${charName || "export"}.zip`);
      showToast("success", `记忆已导出: ${result.fileCount} 个文件`);
    },
    // 遮挡根因修复：mem-io-window 是 .floating-window z=150 < 设置弹窗 z=1000，必被盖死——先关设置弹窗
    openFull: () => { _toggleSettingsModal("settings", false); document.getElementById("mem-export-btn")?.click(); },
  },
  {
    key: "theme", icon: '<i data-ic="palette"></i>', label: "主题", hint: "beilu 主题配色 (.json)",
    imp: async () => {
      const [file] = await _pickFiles(".json");
      if (!file) return;
      await importThemeFile(file); // 实现单源在 settingsSlots（toast/历史上报在其内部）
    },
    exp: () => exportCurrentTheme(),
    // 主题完整界面=设置弹窗内「界面」section，同弹窗内切换无遮挡，不关弹窗
    openFull: () => document.querySelector('.settings-activity-bar [data-settings-section="ui"]')?.click(),
  },
];

let _slotEl = null;

function _fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _renderHistory() {
  if (!_slotEl) return;
  const listEl = _slotEl.querySelector("#ie-history-list");
  if (!listEl) return;
  const hist = getImportHistory();
  if (hist.length === 0) {
    listEl.innerHTML = '<p class="text-xs text-base-content/40 text-center py-3">暂无导入记录</p>';
    return;
  }
  listEl.innerHTML = hist.map((h) => `
    <div class="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200 text-xs">
      <span class="opacity-70">${_esc(h.type)}</span>
      <span class="flex-1 truncate" title="${_esc(h.name)}">${_esc(h.name)}</span>
      <span class="text-base-content/40 font-mono shrink-0">${_esc(_fmtTime(h.at))}</span>
    </div>`).join("");
}

/**
 * 初始化导入导出集中管理面板（settings.mjs section 切换时懒加载调用）。
 * @param {HTMLElement} [slot] - 目标容器；不传则按 id 查找 #settings-import-export-slot。
 */
export function _initImportExportPanel(slot) {
  _slotEl = slot || document.getElementById("settings-import-export-slot");
  if (!_slotEl) return;

  _slotEl.innerHTML = `
    <div class="space-y-4 mt-2">
      <!-- 六类对象聚合区（快速模式直连） -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2" id="ie-cat-grid">
        ${CATEGORIES.map((c) => `
          <div class="bg-base-200/50 rounded-lg p-3 space-y-2" data-ie-cat="${c.key}">
            <div class="flex items-center gap-2 font-semibold text-sm">
              <span>${c.icon}</span><span>${_esc(c.label)}</span>
            </div>
            <p class="text-xs text-base-content/50">${_esc(c.hint)}</p>
            <div class="flex gap-2">
              <button class="btn btn-xs btn-outline flex-1" data-ie-imp="${c.key}"><i data-ic="download"></i> 导入</button>
              <button class="btn btn-xs btn-outline flex-1" data-ie-exp="${c.key}"><i data-ic="upload"></i> 导出</button>
            </div>
            <button class="btn btn-xs btn-ghost w-full opacity-60 hover:opacity-100" data-ie-open="${c.key}">完整管理 →</button>
          </div>`).join("")}
      </div>

      <!-- 导入历史区 -->
      <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-sm"><i data-ic="script"></i> 导入历史</span>
          <button id="ie-history-clear" class="btn btn-xs btn-ghost text-error">清空</button>
        </div>
        <p class="text-xs text-base-content/40">记录最近导入的对象（本地记录，仅本浏览器）。</p>
        <div id="ie-history-list" class="max-h-64 overflow-y-auto space-y-0.5"></div>
      </div>
    </div>
  `;

  // 快速模式直连：导入/导出 按钮 → CATEGORIES.imp/exp（异常统一 toast，不静默）
  const _bind = (attr, fnKey) => {
    _slotEl.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cat = CATEGORIES.find((c) => c.key === btn.getAttribute(attr));
        if (!cat || typeof cat[fnKey] !== "function") return;
        try { await cat[fnKey](); } catch (e) {
          console.error(`[importExport] ${fnKey} ${cat.key}`, e);
          showToast("error", `${cat.label}${fnKey === "imp" ? "导入" : "导出"}失败: ${e?.message || e}`);
        }
      });
    });
  };
  _bind("data-ie-imp", "imp");
  _bind("data-ie-exp", "exp");

  // 完整管理入口（浮窗类目标已在 openFull 内先关设置弹窗防遮挡）
  _slotEl.querySelectorAll("[data-ie-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = CATEGORIES.find((c) => c.key === btn.dataset.ieOpen);
      if (cat) { try { cat.openFull(); } catch (e) { console.error("[importExport] openFull " + cat.key, e); } }
    });
  });

  // 清空历史
  _slotEl.querySelector("#ie-history-clear")?.addEventListener("click", () => {
    _clearImportHistory();
  });

  _renderHistory();
}
