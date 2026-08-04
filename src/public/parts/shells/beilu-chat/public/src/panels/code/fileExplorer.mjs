/**
 * fileExplorer.mjs — 文件浏览器 + 多标签编辑器
 *
 * 功能链：
 *   initFileExplorer → 渲染文件树（rootPath 下目录列表）→ 点目录展开/折叠 → 点文件
 *     → openFileTab → GET beilu-files getdata {_action:"readFile", path} → textarea 展示内容
 *   Ctrl+S / 点「保存」→ 冻结发起窗口 chatId → POST beilu-files setdata
 *     → scope.chatId 经服务端 facade 盖章 → workspaceRoots per-chatId 隔离写文件
 *   点「打开文件夹」→ showFolderPicker → 用户选目录 → rootPath 更新 → 刷新文件树
 *   右键文件/目录 → 上下文菜单（新建/重命名/删除）→ 对应 setdata action
 *   AI 审批队列：file_op pending 条目 → 点「允许/拒绝」→ approveAll/rejectAll → 后端执行/丢弃
 *
 * why（多窗口会话隔离）：
 *   每次用户动作只冻结一次发起窗口 chatId；所有文件动作只传 scope.chatId，由服务端
 *   facade 从可信 context 统一盖章，前端不再维护 payload.chatid 动作清单。
 *
 * 关联链：
 *   → filePicker.mjs showFolderPicker / showFilePicker（打开文件夹/文件弹窗）
 *   → shared/transport/api-client.mjs apiFetch（beilu-files 所有 REST 调用统一出口）
 *   → shared/transport/endpoints.mjs currentChatId（窗口函数不可用时的归属后备来源）
 *   → shared/state/storage.mjs（rootPath / 展开目录集合持久化）
 *   → shared/widgets/beiluDialog.mjs（beiluConfirm/beiluPrompt 替换 window.confirm/prompt）
 *   ← idePanel.mjs / layout.mjs（IDE 模式初始化时挂载到 #file-explorer-container）
 *
 * 影响范围：
 *   #file-tree-container（左栏文件树）、#file-editor-container（中栏多标签）、
 *   localStorage rootPath / expandedDirs、后端 beilu-files 插件文件读写。
 *
 * 使用效果：
 *   点目录展开树；点文件 → 在右侧标签页打开可编辑；Ctrl+S 实时保存；
 *   AI 写文件请求在审批队列出现，点允许后真实落盘，点拒绝则丢弃不写。
 */

import { getPathBreadcrumbSegments, showFilePicker, showFolderPicker } from "./filePicker.mjs";
import { getDetectedFileType, getFileType, getFileTypeIconMarkup } from "./fileTypeRegistry.mjs";
import { escapeHtml, positionContextMenu, bindClickOutsideClose } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 点外关闭收口单源
// 多窗口会话隔离：动作入口先冻结发起窗口，后续 await 链不得重新读取当前窗口。
// currentChatId 仅是窗口函数不可用时的后备来源，不能在 payload 与 scope 形成双源。
import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { wbDetect } from "../../shared/widgets/whitebox.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（getFilesData→beilu-files#getData；setFilesData verb=真动作→通配）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { createDiag } from "../../shared/state/diagLogger.mjs";
// 任务B多类型预览：md/代码高亮复用聊天同一条渲染管线（Shiki/KaTeX/Mermaid/sanitize 全在里面，零新依赖）。
//   路径形式对齐 messageList.mjs:29 同款（URL 层上跳 clamp 到站点根 /scripts/）。
import { renderMarkdownAsString } from "../../../../../../scripts/markdown.mjs";

// ============================================================
// 任务F artifact 保存（凛倾 2026-07-09「AI 给前端代码…类似 claude 网页渲染…用户可编辑」）：
// 对话代码块 artifact 面板的「保存」按钮 dispatch beilu:artifact-save（markdownConvertor 侧，
// 事件解耦——pages 共享层不 import shell）。本模块随壳入口 index.mjs 静态加载，顶层订阅即全局生效。
// 路径给相对文件名 → 后端 resolveCanonicalOpPath 锚当前会话工作区根（默认=ai玩耍空间，防护闭环）。
// ============================================================
if (typeof window !== "undefined" && !window.__beiluArtifactSaveWired) {
  window.__beiluArtifactSaveWired = true;
  window.addEventListener("beilu:artifact-save", async (e) => {
    const code = e?.detail?.code;
    if (!code) return;
    const ext = /^[a-z0-9]{1,8}$/i.test(e?.detail?.ext || "") ? e.detail.ext : "html";
    const name = `artifact_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.${ext}`;
    let originChatId = null;
    try {
      originChatId = freezeFileActionOriginChatId();
      // 传导链核修：后端前端 case 的相对路径锚 CWD（resolveWorkspacePath）而非工作区根——裸文件名会
      //   落 app 根且被沙箱闸拒。必须显式拼工作区根：rootPath 有则用；无（用户没开过文件面板）则
      //   ensureDefaultWorkspace 幂等拿默认根（=ai玩耍空间，与任务A同源）。
      let _base = rootPath;
      if (!_base) {
        const _dw = await setFilesData({ _action: "ensureDefaultWorkspace" }, { originChatId });
        _base = _dw?._result?.path || null;
      }
      if (!_base) throw new Error("无可用工作区根");
      const _savePath = joinPath(_base, name);
      const _res = await setFilesData(
        { _action: "createFile", path: _savePath, content: code },
        { originChatId },
      );
      if (_res?._result?.error) throw new Error(_res._result.error);
      showFileActionToast(originChatId, `已保存到工作区: ${name}`, "success");
      if (treeContainer) await loadFileTree(rootPath || _base, originChatId);
    } catch (err) {
      showFileActionToast(originChatId, "保存失败: " + (err?.message || err), "error");
    }
  });
}

// ============================================================
// API 通信
// ============================================================

function freezeFileActionOriginChatId(originChatId = null) {
  let owner = originChatId;
  if (!owner) {
    try { owner = window._beiluCurWinChatId?.() || null; } catch { owner = null; }
  }
  if (!owner) owner = currentChatId || null;
  if (typeof owner !== "string" || !owner.trim()) {
    throw new Error("当前窗口没有有效对话归属，无法执行窗口隔离文件动作");
  }
  return owner.trim();
}

function showFileActionToast(ownerChatId, message, type = "info") {
  const owner = String(ownerChatId || "").trim();
  let visibleOwner = "";
  try { visibleOwner = String(window._beiluCurWinChatId?.() || "").trim(); } catch { /* 无窗口桥 */ }
  const prefix = owner && visibleOwner && owner !== visibleOwner
    ? `后台对话 ${owner.slice(0, 8)}…：`
    : "";
  showToast(prefix + message, type);
}

async function getFilesData({ originChatId = null } = {}) {
  const ownerChatId = freezeFileActionOriginChatId(originChatId);
  // 门面 getData（GET getdata）：返回后端配置对象（含 pendingOperations 等），形状与原 REST 等价。
  return sendAction({
    verb: "getData", target: "plugins:beilu-files", source: "web",
    scope: { chatId: ownerChatId },
  });
}

async function setFilesData(data, { originChatId = null } = {}) {
  const ownerChatId = freezeFileActionOriginChatId(originChatId);
  // 路径/工作区动作只把冻结 owner 放入 scope，由 functions:files facade 在可信服务端
  // context 中盖章；不再把 ES live binding 的 currentChatId 另塞进 payload 形成双源。
  const { _action, chatid: _ignoredChatId, chatId: _ignoredCamelChatId, ...payload } =
    (data && typeof data === "object") ? data : {};
  return sendAction({
    verb: _action,
    target: "plugins:beilu-files",
    source: "web",
    scope: { chatId: ownerChatId },
    payload,
  });
}

/**
 * beilu-files 写动作的业务成功断言。传输 resolve 不等于写盘成功：后端会把
 * 沙箱拒绝和 Deno 写入异常作为 `{ _result: { error } }` 正常回包。
 */
function assertFileActionSuccess(response, action) {
  const result = response?._result;
  if (!result || typeof result !== "object") {
    throw new Error(`${action} 返回缺少有效 _result`);
  }
  if (Object.prototype.hasOwnProperty.call(result, "error")) {
    throw new Error(`${action} 失败: ${result.error || "未知业务错误"}`);
  }
  if (result.success !== true) {
    throw new Error(`${action} 未返回 success:true，无法确认写盘成功`);
  }
  return result;
}

function assertApprovalActionHandled(response, action) {
  const result = response?._result;
  if (!result || typeof result !== "object" || result.success !== true) {
    throw new Error(result?.error || `${action} 未返回可确认的处理结果`);
  }
  return result;
}

/** 将本次发送的内容作为成功基线；保存期间产生的新输入仍保持 dirty。 */
async function persistTabContent(tab, writeFile) {
  const contentToSave = tab.content;
  const response = await writeFile({
    _action: "writeFile",
    path: tab.path,
    content: contentToSave,
  }, { originChatId: tab.ownerChatId });
  const result = assertFileActionSuccess(response, "writeFile");
  tab.originalContent = contentToSave;
  tab.isDirty = tab.content !== contentToSave;
  return result;
}

function detectLineEnding(content, fallback = "LF") {
  const value = String(content ?? "");
  if (value.includes("\r\n")) return "CRLF";
  if (value.includes("\n")) return "LF";
  return fallback === "CRLF" ? "CRLF" : "LF";
}

function detectIndentation(content) {
  let tabIndented = 0;
  const spaceWidths = [];
  for (const line of String(content ?? "").split(/\r?\n/)) {
    if (/^\t+\S/.test(line)) tabIndented += 1;
    const spaces = line.match(/^( +)\S/)?.[1].length || 0;
    if (spaces > 0) spaceWidths.push(spaces);
  }
  if (tabIndented && spaceWidths.length) return "混合缩进";
  if (tabIndented) return "Tab";
  if (!spaceWidths.length) return "无缩进";
  const width = Math.min(...spaceWidths);
  return `空格: ${Math.max(1, Math.min(width, 8))}`;
}

function getLineColumn(content, selectionStart = 0) {
  const value = String(content ?? "");
  const offset = Math.max(0, Math.min(Number(selectionStart) || 0, value.length));
  const beforeCursor = value.slice(0, offset).replace(/\r\n/g, "\n");
  const lines = beforeCursor.split("\n");
  return Object.freeze({ line: lines.length, column: (lines.at(-1)?.length || 0) + 1 });
}

/**
 * 将 TabState 投影为 IDE breadcrumb/status 所需的稳定只读模型。
 * 文件语言与 readonly/editable 始终来自 fileTypeRegistry，不在状态层重判扩展名。
 */
export function createEditorTabProjection(tab, selectionStart = tab?.selectionStart || 0, visibleContent = tab?.content || "") {
  if (!tab) {
    return Object.freeze({
      path: "", language: "", encoding: "UTF-8", eol: "", indent: "",
      line: 1, column: 1, readonly: false, dirty: false, state: "idle",
      stateLabel: "就绪", stateTitle: "未打开文件",
    });
  }

  const fileType = tab.fileType || getFileType(tab.path);
  const position = getLineColumn(visibleContent, selectionStart);
  const readonly = fileType.readonly === true;
  let state = "saved";
  let stateLabel = "已保存";
  let stateTitle = "内容与已确认保存版本一致";
  if (tab.saveState === "error") {
    state = "error";
    stateLabel = "保存错误";
    stateTitle = tab.lastError || "文件保存失败";
  } else if (tab.saveState === "saving") {
    state = "saving";
    stateLabel = "保存中";
    stateTitle = "正在写入文件";
  } else if (tab.isDirty) {
    state = "dirty";
    stateLabel = "未保存";
    stateTitle = "存在尚未保存的更改";
  } else if (readonly) {
    state = "readonly";
    stateLabel = "只读";
    stateTitle = `${fileType.languageLabel} 仅支持只读预览`;
  } else if (tab.saveState === "auto-saved") {
    state = "saved";
    stateLabel = "已自动保存";
    stateTitle = "自动保存已完成";
  }

  return Object.freeze({
    path: tab.path,
    language: fileType.languageLabel,
    encoding: tab.encoding || "UTF-8",
    eol: tab.lineEnding || detectLineEnding(tab.content),
    indent: detectIndentation(visibleContent),
    line: position.line,
    column: position.column,
    readonly,
    dirty: tab.isDirty === true,
    state,
    stateLabel,
    stateTitle,
  });
}

// ============================================================
// 状态
// ============================================================

const diag = createDiag("fileExplorer");

/** @type {HTMLElement|null} */
let treeContainer = null;
/** @type {HTMLElement|null} */
let editorContainer = null;

/** 默认安全根路径：null = 未设置，首次使用引导用户选择文件夹而非盲目列不存在的目录 */
const DEFAULT_SAFE_ROOT = null;

/** 文件树根路径（可通过打开文件夹或路径输入框更改） */
let rootPath = DEFAULT_SAFE_ROOT;
/** 当前展开的目录路径 */
let currentPath = ".";
let expandedDirs = new Set(["."]);

/** 文件排序模式："name" | "mtime" | "size" */
let sortMode = "name";

// ============================================================
// 多标签状态
// ============================================================

/**
 * @typedef {Object} TabState
 * @property {string} path - 文件路径
 * @property {string} ownerChatId - 打开该标签的窗口会话（读写作用域单源）
 * @property {string} content - 文件内容
 * @property {string} originalContent - 最近一次已确认读入或写盘成功的内容
 * @property {boolean} isDirty - 是否有未保存修改
 * @property {number} scrollTop - textarea 滚动位置
 * @property {number} scrollLeft - textarea 水平滚动位置
 * @property {number} selectionStart - 光标起始位置
 * @property {number} selectionEnd - 光标结束位置
 * @property {ReturnType<typeof getFileType>} fileType - 注册表解析后的文件类型与能力
 * @property {string} kind - 预览路由类型（由 fileType.previewKind 投影）
 * @property {"UTF-8"} encoding - 当前文件编码展示值
 * @property {"LF"|"CRLF"} lineEnding - 最近一次真实内容检测到的换行格式
 * @property {"saved"|"auto-saved"|"dirty"|"saving"|"error"} saveState - 保存状态
 * @property {string} lastError - 最近一次保存错误
 */

/** @type {TabState[]} */
let openTabs = [];

/** @type {string|null} 当前活动标签的文件路径 */
let activeTabPath = null;
/** @type {string|null} 当前活动标签的窗口 owner */
let activeTabOwnerChatId = null;
/** 文件面板当前投影的窗口 owner；标签不在窗口间混用。 */
let filePanelOwnerChatId = "";
const activeTabPathByOwner = new Map();
/** 每个窗口自己的文件树投影；后端 workspaceRoots 仍是根路径权威。 */
const fileWorkspaceStateByOwner = new Map();
let filePanelWindowListenerBound = false;
let filePanelActivationEpoch = 0;

function cloneFileWorkspaceState(state) {
  if (!state) return null;
  return {
    rootPath: String(state.rootPath || ""),
    currentPath: String(state.currentPath || state.rootPath || "."),
    expandedDirs: new Set(state.expandedDirs || []),
  };
}

function rememberCurrentFileWorkspace(ownerChatId = filePanelOwnerChatId) {
  const owner = String(ownerChatId || "").trim();
  if (!owner) return;
  fileWorkspaceStateByOwner.set(owner, cloneFileWorkspaceState({ rootPath, currentPath, expandedDirs }));
}

function projectFileWorkspaceState(state) {
  const next = cloneFileWorkspaceState(state);
  if (!next) return false;
  rootPath = next.rootPath;
  currentPath = next.currentPath;
  expandedDirs = next.expandedDirs;
  return true;
}

async function activateFilePanelOwner(nextOwner) {
  nextOwner = freezeFileActionOriginChatId(nextOwner);
  if (nextOwner === filePanelOwnerChatId) return;

  const epoch = ++filePanelActivationEpoch;
  fileOpenCoordinator.invalidateIntents();
  saveActiveTabState();
  rememberCurrentFileWorkspace(filePanelOwnerChatId);
  document.querySelectorAll(".file-context-menu").forEach((menu) => menu.remove());

  // 先提交 owner 并撤下旧树，避免读取新根期间把 B 的目录当成 A 的界面继续操作。
  filePanelOwnerChatId = nextOwner;
  const nextPath = activeTabPathByOwner.get(nextOwner) || null;
  const nextTab = nextPath ? getTab(nextPath, nextOwner) : null;
  activeTabPath = nextTab?.path || null;
  activeTabOwnerChatId = nextTab?.ownerChatId || null;
  renderTabs();
  if (nextTab) renderEditor();
  else renderEmptyEditor();
  renderTreeLoading();

  let nextState = cloneFileWorkspaceState(fileWorkspaceStateByOwner.get(nextOwner));
  if (!nextState) {
    const config = await getFilesData({ originChatId: nextOwner });
    const backendRoot = String(config?.workspaceRoot || "").trim();
    nextState = backendRoot
      ? { rootPath: backendRoot, currentPath: backendRoot, expandedDirs: new Set([backendRoot]) }
      : null;
  }

  if (epoch !== filePanelActivationEpoch || filePanelOwnerChatId !== nextOwner) return;
  if (!nextState?.rootPath) {
    renderTreeEmpty();
    return;
  }

  fileWorkspaceStateByOwner.set(nextOwner, cloneFileWorkspaceState(nextState));
  projectFileWorkspaceState(nextState);
  await loadFileTree(nextState.rootPath, nextOwner);
}

function bindFilePanelWindowOwner() {
  if (filePanelWindowListenerBound) return;
  filePanelWindowListenerBound = true;
  window.addEventListener("beilu:window-switched", (event) => {
    const nextOwner = String(event?.detail?.chatid || "").trim();
    if (!nextOwner || nextOwner === filePanelOwnerChatId) return;
    void activateFilePanelOwner(nextOwner).catch((err) => {
      if (filePanelOwnerChatId !== nextOwner) return;
      const message = err?.message || String(err);
      console.warn("[fileExplorer] 切换窗口文件工作区失败:", message);
      renderTreeError(message);
      window._reportError?.(`[fileExplorer] 切换窗口文件工作区失败: ${message}`, err?.stack);
    });
  });
}

/**
 * 文件打开的并发协调器：同一路径复用一次真实读取，焦点只服从最后一次用户意图。
 * 读取 Promise 无论成功或失败都会从 Map 移除，因此网络波动后下一次点击能真实重试。
 */
export function createFileOpenCoordinator() {
  const inFlightByPath = new Map();
  let latestIntentId = 0;

  return Object.freeze({
    beginIntent(path) {
      return Object.freeze({ id: ++latestIntentId, path });
    },
    isLatest(intent) {
      return intent?.id === latestIntentId;
    },
    invalidateIntents() {
      latestIntentId += 1;
    },
    getOrCreate(path, factory) {
      const existing = inFlightByPath.get(path);
      if (existing) return existing;

      let request;
      request = Promise.resolve()
        .then(factory)
        .finally(() => {
          if (inFlightByPath.get(path) === request) inFlightByPath.delete(path);
        });
      inFlightByPath.set(path, request);
      return request;
    },
    isInFlight(path) {
      return inFlightByPath.has(path);
    },
  });
}

const fileOpenCoordinator = createFileOpenCoordinator();

/**
 * 真实保存请求按文件路径隔离。不同标签可以并行保存；同一路径仍拒绝重复提交，
 * 避免一个标签的慢写入让另一个标签的自动保存被全局忙锁直接丢弃。
 */
const saveInFlightPaths = new Set();
const queuedSaveByPath = new Map();

function tabIdentity(path, ownerChatId) {
  return `${String(ownerChatId || "")}\0${String(path || "")}`;
}

function isTabSaveInFlight(tab) {
  return !!tab?.path && !!tab?.ownerChatId
    && saveInFlightPaths.has(tabIdentity(tab.path, tab.ownerChatId));
}

/** 标签栏 DOM 容器 */
let tabBarContainer = null;

/**
 * 从标签的注册表能力与真实请求状态计算保存能力，不写 UI。
 * 显式 tab 保存（含后台自动保存）与当前工具栏投影共用这一判断。
 * @param {TabState|undefined|null} tab
 * @param {boolean} isSaveInFlight
 * @returns {{ canSave: boolean, reason: string, busy: boolean }}
 */
function getFileSaveCapability(tab, isSaveInFlight) {
  const busy = isSaveInFlight === true;
  const fileType = tab ? (tab.fileType || getFileType(tab.path)) : null;
  let canSave = false;
  let reason = "";

  if (!tab) {
    reason = "未打开文件，无法保存";
  } else if (fileType?.detectionPending === true) {
    reason = "文件类型尚未检测，无法保存";
  } else if (fileType?.editable !== true) {
    const fileName = tab.path?.split("/").pop() || "当前文件";
    const typeLabel = fileType?.languageLabel || "未知文件类型";
    reason = `“${fileName}”（${typeLabel}）仅支持只读预览，无法保存`;
  } else if (busy) {
    reason = "文件正在保存，请稍候";
  } else {
    canSave = true;
  }

  return { canSave, reason, busy };
}

/**
 * 将当前活动标签的保存能力投影到工具栏和菜单。
 * fileTypeRegistry 仍是 editable 的唯一事实源；这里不重新判断扩展名。
 * @param {TabState|undefined|null} tab
 * @param {boolean} isSaveInFlight
 * @returns {{ canSave: boolean, reason: string, busy: boolean }}
 */
function projectFileToolbarState(tab, isSaveInFlight) {
  const state = getFileSaveCapability(tab, isSaveInFlight);
  const { canSave, reason, busy } = state;

  const title = canSave ? "保存 (Ctrl+S)" : `保存不可用：${reason}`;
  const saveButton = document.getElementById("file-save-btn");
  if (saveButton) {
    saveButton.disabled = !canSave;
    saveButton.title = title;
    saveButton.setAttribute("aria-label", title);
    saveButton.setAttribute("aria-busy", String(busy));
  }

  const saveMenuAction = document.querySelector('.ide-menu-action[data-action="save"]');
  if (saveMenuAction) {
    saveMenuAction.setAttribute("aria-disabled", String(!canSave));
    saveMenuAction.title = title;
    saveMenuAction.classList.toggle("ide-menu-action-disabled", !canSave);
    if (canSave) delete saveMenuAction.dataset.disabledReason;
    else saveMenuAction.dataset.disabledReason = reason;
  }

  return state;
}

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化文件浏览器
 * @param {HTMLElement} treeEl - 左栏文件树容器
 * @param {HTMLElement} editorEl - 中栏编辑器容器
 */
export async function initFileExplorer(treeEl, editorEl) {
  treeContainer = treeEl;
  editorContainer = editorEl;
  if (!treeContainer || !editorContainer) return;
  const originChatId = freezeFileActionOriginChatId();
  filePanelOwnerChatId = originChatId;
  filePanelActivationEpoch += 1;
  bindFilePanelWindowOwner();

  // 获取标签栏容器
  tabBarContainer = document.getElementById("ide-editor-tabs");

  // localStorage 只作旧版缓存后备；窗口根的权威读点是后端 workspaceRoots[chatId]。
  let legacySavedRoot = null;
  try {
    const saved = storage.get(KEYS.BEILU_FILE_ROOT);
    if (saved) legacySavedRoot = saved;
    // 恢复上次的文件排序模式（why: 用户切了mtime/size排序后刷新/重开应保持,不回name默认）
    //   key 与写侧(排序切换 storage.set)保持一致,单源不分叉; 非法值回退 name
    const savedSort = storage.get(KEYS.BEILU_FILE_SORT || "beilu_file_sort");
    if (savedSort === "mtime" || savedSort === "size" || savedSort === "name") {
      sortMode = savedSort;
    }
  } catch {
    /* localStorage 不可用时回退默认路径 */
  }

  // 绑定编辑器事件
  bindEditorEvents();

  // 首次进入文件面板时建立无标签状态；之后所有保存 UI 都只由同一投影函数写入。
  projectFileToolbarState(getActiveTab(), isTabSaveInFlight(getActiveTab()));
  updateStatusBar(null);

  // 渲染初始标签栏（空）
  renderTabs();

  // 任务A防护（凛倾 2026-07-09「没有就创建/用相对空间/删了别出bug」）：每次面板初始化都先 ensure——
  //   后端幂等 mkdir 默认「ai玩耍空间」并返回其【相对】路径（值单源在后端，前端不硬编码）。
  //   用户手动删掉玩耍空间 → 下次初始化在这里自动重建，不落 listDir NotFound。
  let _defaultRoot = null;
  try {
    const _dw = await setFilesData({ _action: "ensureDefaultWorkspace" }, { originChatId });
    _defaultRoot = _dw?._result?.path || null;
    if (!_defaultRoot && _dw?._result?.error) console.warn("[fileExplorer] 默认工作区创建失败:", _dw._result.error);
  } catch (err) {
    console.warn("[fileExplorer] 默认工作区初始化失败:", err?.message);
  }

  let backendRoot = null;
  try {
    const config = await getFilesData({ originChatId });
    backendRoot = config?.workspaceRoot || null;
  } catch (err) {
    console.warn("[fileExplorer] 读取当前窗口工作区根失败:", err?.message);
  }
  const targetRoot = (backendRoot && backendRoot !== ".")
    ? backendRoot
    : ((legacySavedRoot && legacySavedRoot !== ".") ? legacySavedRoot : _defaultRoot);
  if (targetRoot) {
    try {
      await setFileExplorerRoot(targetRoot, originChatId);
      if (!backendRoot && targetRoot === _defaultRoot) {
        showFileActionToast(originChatId, "已打开默认工作区「AI 玩耍空间」", "success");
      }
    } catch (err) {
      console.warn("[fileExplorer] 初始工作区打开失败:", err?.message);
      renderTreeEmpty();
    }
  } else {
    fileWorkspaceStateByOwner.set(originChatId, {
      rootPath: "",
      currentPath: ".",
      expandedDirs: new Set(["."]),
    });
    renderTreeEmpty();
  }

  // 启动文件操作错误轮询（接入后端 pendingErrors 队列，否则失败静默丢失）
  startErrorPolling();
}

/**
 * 外部调用：设置文件树根路径并刷新
 * @param {string} path
 * @param {string|null} originChatId 本次动作冻结的发起窗口归属
 */
export async function setFileExplorerRoot(path, originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  diag.log("setFileExplorerRoot:", path);
  const requestedRoot = path || ".";
  const windowBinding = (() => {
    try { return window._beiluWinBindingForChat?.(originChatId) || null; }
    catch { return null; }
  })();
  let charName = String(windowBinding?.charName || "").trim();
  if (windowBinding && !charName) {
    throw new Error("发起窗口的角色绑定不完整，工作区未切换");
  }
  if (!windowBinding) {
    // 无多窗口登记时只允许“当前可见窗口 === 动作 owner”的原生回退。
    // 弹窗等待期间若已切窗，不能拿新窗口的全局角色与旧 chatId 拼接。
    const visibleOwner = freezeFileActionOriginChatId();
    if (visibleOwner !== originChatId) {
      throw new Error("发起窗口的角色绑定已不可用，工作区未切换");
    }
    charName = String(window._beiluGetCharName?.() || "").trim();
  }
  // 有角色时这次动作会写两个持久域。先取得后端当前真值作为补偿目标；不能只信
  // localStorage，因为它正是可能已经过期的缓存。拿不到补偿点时拒绝开始双写。
  let previousRoot = null;
  if (charName) {
    try {
      previousRoot = (await getFilesData({ originChatId }))?.workspaceRoot || null;
      if (!previousRoot) throw new Error("后端没有可用于回滚的当前工作区根");
    } catch (err) {
      const message = err?.message || String(err);
      console.warn("[fileExplorer] 读取当前工作区根失败:", message);
      showFileActionToast(originChatId, `无法切换工作区：${message}`, "error");
      throw err;
    }
  }

  // 后端是根路径接受、规范化和落盘的唯一权威。此前此处先写 localStorage/角色卡，
  // 再忽略 `_result.error`，导致被拒绝的旧路径仍持续传给 IDE、worker 和下次切卡。
  let workspaceResult;
  try {
    const response = await setFilesData(
      { _action: "setWorkspaceRoot", rootPath: requestedRoot },
      { originChatId },
    );
    workspaceResult = response?._result;
    if (!workspaceResult?.ok || !workspaceResult.effectiveRoot) {
      throw new Error(workspaceResult?.error || "工作区根未被后端确认");
    }
  } catch (err) {
    const message = err?.message || String(err);
    console.warn("[fileExplorer] 同步工作区根路径失败:", message);
    showFileActionToast(originChatId, `无法切换工作区：${message}`, "error");
    throw err;
  }

  const confirmedRoot = workspaceResult.effectiveRoot;

  // 一窗一线：角色卡根只接受已确认的 effectiveRoot。若第二存储写失败，尽力回滚
  // 后端根并明确报错；绝不把两个根不同步伪装成“文件夹已打开”。
  try {
    if (charName) {
      const cardResult = await sendAction({
        verb: "setCardWorkspaceRoot",
        target: "plugins:beilu-memory",
        source: "web",
        scope: { chatId: originChatId },
        payload: { charName, root: confirmedRoot },
      });
      if (cardResult?.success !== true) {
        throw new Error(cardResult?.error || "角色工作区根未能保存");
      }
    }
  } catch (err) {
    const message = err?.message || String(err);
    console.warn("[fileExplorer] per-卡项目根持久化异常:", message);
    if (previousRoot) {
      try {
        const rollback = await setFilesData(
          { _action: "setWorkspaceRoot", rootPath: previousRoot },
          { originChatId },
        );
        if (!rollback?._result?.ok) console.warn("[fileExplorer] 工作区根回滚被拒绝:", rollback?._result?.error);
      } catch (rollbackError) {
        console.warn("[fileExplorer] 工作区根回滚异常:", rollbackError?.message || rollbackError);
      }
    }
    showFileActionToast(originChatId, `工作区未完成切换：${message}`, "error");
    throw err;
  }

  // 所有权威写入均确认后才提交对应窗口的投影。若用户等待期间已切窗，
  // 只更新原窗口缓存，不把旧动作的目录树覆盖到新窗口。
  const confirmedState = {
    rootPath: confirmedRoot,
    currentPath: confirmedRoot,
    expandedDirs: new Set([confirmedRoot]),
  };
  fileWorkspaceStateByOwner.set(originChatId, cloneFileWorkspaceState(confirmedState));
  if (filePanelOwnerChatId !== originChatId) return confirmedRoot;
  projectFileWorkspaceState(confirmedState);
  try {
    storage.set(KEYS.BEILU_FILE_ROOT, confirmedRoot);
  } catch {
    /* localStorage 只是缓存，失败不改变已确认的后端根 */
  }

  await loadFileTree(confirmedRoot, originChatId);
  return confirmedRoot;
}

// ============================================================
// 文件树
// ============================================================

function renderTreeLoading() {
  if (!treeContainer) return;
  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<h3 class="file-explorer-title font-bold text-sm flex items-center gap-2 mb-2">
				<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
				文件浏览
			</h3>
			<p class="file-tree-status text-xs text-center py-4" role="status">加载中...</p>
		</div>
	`;
}

// 0714 时序扫尾：渲染令牌（范式=conversationManager._renderSeq）。连续切目录时慢的旧 listDir
//   回来会无条件 renderFileTree 覆盖新目录树；await 后查令牌，被更新调用抢占则丢弃旧结果。
const _treeReqIdByOwner = new Map();
async function loadFileTree(path, originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  const myReq = (_treeReqIdByOwner.get(originChatId) || 0) + 1;
  _treeReqIdByOwner.set(originChatId, myReq);
  if (filePanelOwnerChatId === originChatId) treeContainer?.setAttribute("aria-busy", "true");
  try {
    const result = await setFilesData({ _action: "listDir", path }, { originChatId });
    if (myReq !== _treeReqIdByOwner.get(originChatId) || filePanelOwnerChatId !== originChatId) return;
    if (result?._result?.entries) {
      diag.debug("loadFileTree:", path, "entries:", result._result.entries.length);
      renderFileTree(path, result._result.entries, originChatId);
    } else if (result?._result?.error) {
      diag.warn("loadFileTree 后端返错:", path, result._result.error);
      renderTreeError(result._result.error);
    } else {
      diag.warn("loadFileTree 无效响应形状:", path, "keys:", result ? Object.keys(result).join(",") : "(null)");
      renderTreeError("服务器返回了无效响应");
    }
  } catch (err) {
    if (myReq !== _treeReqIdByOwner.get(originChatId) || filePanelOwnerChatId !== originChatId) return;
    diag.warn("loadFileTree 异常:", path, err?.message);
    renderTreeError(err.message);
  } finally {
    if (myReq === _treeReqIdByOwner.get(originChatId) && filePanelOwnerChatId === originChatId) {
      treeContainer?.setAttribute("aria-busy", "false");
    }
  }
}

/** 未设置工作区根时的空态引导 UI */
function renderTreeEmpty() {
  if (!treeContainer) return;
  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="file-explorer-title font-bold text-sm flex items-center gap-2">
					<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
					文件浏览
				</h3>
				<div class="flex items-center gap-0.5">
					<button id="file-tree-empty-folder" class="btn btn-xs btn-ghost btn-square" title="打开文件夹"><i data-ic="folder-open"></i></button>
					<button id="file-tree-empty-file" class="btn btn-xs btn-ghost btn-square" title="打开文件"><i data-ic="file"></i></button>
				</div>
			</div>
			<p class="text-xs text-base-content/50 text-center py-4">点击 <i data-ic="folder-open"></i> 选择一个工作区文件夹开始浏览</p>
		</div>
	`;
  treeContainer.querySelector("#file-tree-empty-folder")?.addEventListener("click", async () => {
    try {
      const originChatId = freezeFileActionOriginChatId();
      const picked = await showFolderPicker(".", originChatId, rootPath);
      if (picked) await setFileExplorerRoot(picked, originChatId);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
  treeContainer.querySelector("#file-tree-empty-file")?.addEventListener("click", async () => {
    try {
      const originChatId = freezeFileActionOriginChatId();
      const picked = await showFilePicker(".", originChatId, rootPath);
      if (picked) openFileInEditor(picked, originChatId);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
}

function renderTreeError(message) {
  if (!treeContainer) return;
  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="file-explorer-title font-bold text-sm flex items-center gap-2">
					<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
					文件浏览
				</h3>
				<div class="flex items-center gap-0.5">
					<button id="file-tree-err-folder" class="btn btn-xs btn-ghost btn-square" title="打开文件夹"><i data-ic="folder-open"></i></button>
					<button id="file-tree-err-file" class="btn btn-xs btn-ghost btn-square" title="打开文件"><i data-ic="file"></i></button>
				</div>
			</div>
			<p class="text-xs text-warning text-center py-2">${escapeHtml(message)}</p>
			<p class="text-xs text-base-content/50 text-center">请点击<i data-ic="folder-open"></i>选择一个可用的文件夹</p>
			<button class="btn btn-xs btn-block btn-outline" id="file-tree-retry"><i data-ic="refresh"></i> 重试当前路径</button>
		</div>
	`;
  treeContainer.querySelector("#file-tree-retry")?.addEventListener("click", () => loadFileTree(rootPath));
  treeContainer.querySelector("#file-tree-err-folder")?.addEventListener("click", async () => {
    try {
      const originChatId = freezeFileActionOriginChatId();
      const picked = await showFolderPicker(".", originChatId, rootPath);
      // 收口修（凛倾 2026-07-09「同一键多处散写/双键不同步」审计）：原 `rootPath = picked` 裸赋值
      //   绕过 setFileExplorerRoot → localStorage/后端沙箱根/per-卡 三键全不同步（前端浏览新目录、
      //   AI op 沙箱仍锚旧根、刷新即丢）。写根一律走唯一收口。
      if (picked) await setFileExplorerRoot(picked, originChatId);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
  treeContainer.querySelector("#file-tree-err-file")?.addEventListener("click", async () => {
    try {
      const originChatId = freezeFileActionOriginChatId();
      const picked = await showFilePicker(".", originChatId, rootPath);
      if (picked) openFileInEditor(picked, originChatId);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
}

async function renderFileTree(treePath, entries, originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  if (!treeContainer || filePanelOwnerChatId !== originChatId) return;

  const sortPresentation = {
    name: { label: "名称 A–Z", title: "按名称升序" },
    mtime: { label: "时间 新→旧", title: "按修改时间降序" },
    size: { label: "大小 大→小", title: "按文件大小降序" },
  }[sortMode];
  const breadcrumb = getPathBreadcrumbSegments(treePath)
    .map((segment, index, all) => {
      const isCurrent = index === all.length - 1;
      const action = segment.isComputer ? 'data-root-action="pick"' : `data-root-path="${escapeAttr(segment.path)}"`;
      return `<button type="button" class="file-root-crumb${isCurrent ? " current" : ""}" ${action} title="${escapeAttr(segment.path)}" ${isCurrent ? 'aria-current="location"' : ""}>${escapeHtml(segment.label)}</button>${isCurrent ? "" : '<span class="file-root-separator" aria-hidden="true">/</span>'}`;
    })
    .join("");

  treeContainer.innerHTML = `
		<div class="file-explorer-shell p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="file-explorer-title font-bold text-sm flex items-center gap-2">
					<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
					文件浏览
				</h3>
				<div class="flex items-center gap-0.5">
					<button id="file-tree-open-folder" class="btn btn-xs btn-ghost btn-square" title="打开文件夹"><i data-ic="folder-open"></i></button>
					<button id="file-tree-open-file" class="btn btn-xs btn-ghost btn-square" title="打开文件"><i data-ic="file"></i></button>
					<button id="file-tree-refresh" class="btn btn-xs btn-ghost btn-square" title="刷新"><i data-ic="refresh"></i></button>
					<button id="file-tree-sort" class="file-tree-sort btn btn-xs btn-ghost" title="${sortPresentation.title}" aria-label="${sortPresentation.title}"><i data-ic="filter" aria-hidden="true"></i><span>${sortPresentation.label}</span></button>
				</div>
			</div>

			<!-- 路径输入栏 -->
			<div class="flex items-center gap-1 mb-1">
				<input type="text" id="file-root-input"
					class="input input-xs input-bordered flex-1 font-mono text-xs"
					value="${escapeAttr(rootPath)}"
					placeholder="输入路径..." spellcheck="false" />
				<button id="file-root-go" class="btn btn-xs btn-ghost btn-square" title="前往">→</button>
			</div>

				<!-- 内容搜索栏（递归搜索当前根路径下文件内容，后端 searchFiles）-->
				<div class="flex items-center gap-1 mb-1">
					<input type="text" id="file-search-input"
						class="input input-xs input-bordered flex-1 text-xs"
						placeholder="搜索文件内容..." spellcheck="false" />
					<label class="file-search-option flex items-center gap-0.5 cursor-pointer" title="正则匹配">
						<input type="checkbox" id="file-search-regex" class="checkbox checkbox-xs" />.*
					</label>
					<button id="file-search-go" class="btn btn-xs btn-ghost btn-square" title="搜索"><i data-ic="search"></i></button>
				</div>
				<div id="file-search-results" class="text-xs"></div>

			<div class="file-root-breadcrumb" title="${escapeAttr(treePath)}" aria-label="工作区路径">
				<div class="file-root-crumbs"><i data-ic="folder-open" aria-hidden="true"></i>${breadcrumb}</div>
				<button type="button" id="file-root-copy" class="file-root-copy" title="复制完整路径" aria-label="复制完整路径"><i data-ic="clipboard" aria-hidden="true"></i></button>
			</div>

			<!-- 操作按钮 -->
			<div class="flex items-center gap-0.5 mb-1">
				<button id="file-tree-new-file" class="btn btn-xs btn-ghost" title="新建文件"><i data-ic="file"></i>+ 新文件</button>
				<button id="file-tree-new-dir" class="btn btn-xs btn-ghost" title="新建目录"><i data-ic="folder-open"></i>+ 新目录</button>
			</div>

			<div id="file-tree-entries" class="file-tree text-xs space-y-0.5" role="tree" aria-label="工作区文件">
				${renderEntries(entries, treePath)}
			</div>
			<div class="divider my-1 opacity-30"></div>
			<div id="file-pending-ops" class="text-xs"></div>
		</div>
	`;

  // 绑定树事件
  bindTreeEvents();

  // 递归加载所有已展开目录的子内容
  await loadExpandedDirs(originChatId);
  if (filePanelOwnerChatId !== originChatId) return;

  // 加载待审批操作
  loadPendingOps(originChatId);
  initPendingOpsAutoRefresh();
}

// 审批区事件驱动刷新：AI 回合结束可能新产生待审 op（对齐 IDE 侧 chat.mjs 的 generation_ended 一路；
// 原先只在树渲染+按钮回调后刷新，对话中新入队的 op 不出现）。容器不存在时 loadPendingOps 自身早退。
function initPendingOpsAutoRefresh() {
  if (initPendingOpsAutoRefresh._initialized) return;
  initPendingOpsAutoRefresh._initialized = true;
  const bus = window.__beiluEventBus;
  if (!bus) return;
  if (!bus._listeners) bus._listeners = new Map();
  if (!bus._listeners.has("generation_ended")) bus._listeners.set("generation_ended", []);
  bus._listeners.get("generation_ended").push(() => { loadPendingOps(); loadFileTree(rootPath); });
}

/** 拼接路径：正确处理 Windows 盘符根 (D:/) */
function joinPath(base, name) {
  // 去掉尾部斜杠，但盘符根 D:/ 保留
  const trimmed = base.replace(/\/+$/, "");
  // 如果去掉后变成盘符 (D:)，保留一个 /
  if (/^[a-zA-Z]:$/.test(trimmed)) return trimmed + "/" + name;
  return (trimmed || ".") + "/" + name;
}

function renderEntries(entries, parentPath) {
  if (!entries || entries.length === 0) {
    return '<p class="file-tree-empty-state text-center py-2" role="status">（空目录）</p>';
  }

  // 排序：目录在前，文件在后；支持按名称/修改时间/大小排序
  entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    if (sortMode === "mtime") {
      const ta = a.modified ? Date.parse(a.modified) : 0;
      const tb = b.modified ? Date.parse(b.modified) : 0;
      return tb - ta;
    }
    if (sortMode === "size") {
      return (b.size || 0) - (a.size || 0);
    }
    return (a.name || "").localeCompare(b.name || "");
  });

  let html = "";
  for (const entry of entries) {
    const fullPath = joinPath(parentPath, entry.name);
    const isOpen = entry.isDirectory && expandedDirs.has(fullPath);
    const isSelected = activeTabPath === fullPath;
    const tab = entry.isDirectory ? null : getTab(fullPath);
    const type = tab?.fileType || getFileType(entry.name, { isDirectory: entry.isDirectory, isOpen });
    const icon = getFileTypeIconMarkup(entry.name, { isDirectory: entry.isDirectory, isOpen, fileType: type });
    const isDirty = tab?.isDirty === true;
    const stateClasses = [isSelected ? "active" : "", isDirty ? "dirty" : "", type.binary ? "is-binary" : "", type.readonly === true ? "is-readonly" : "", type.detectionPending ? "is-detection-pending" : ""]
      .filter(Boolean)
      .join(" ");

    html += `
		<div class="file-tree-item ${entry.isDirectory ? "folder" : "file"} ${stateClasses}"
			data-path="${escapeAttr(fullPath)}" data-is-dir="${entry.isDirectory}" data-file-kind="${type.kind}"
			role="treeitem" tabindex="0" aria-selected="${isSelected}" ${entry.isDirectory ? `aria-expanded="${isOpen}"` : ""}
			title="${escapeAttr(fullPath)}">
			<span class="tree-toggle ${entry.isDirectory ? "cursor-pointer" : "invisible"}" aria-hidden="true"></span>
			<span class="tree-icon">${icon}</span>
			<span class="tree-label flex-1 truncate">${escapeHtml(entry.name)}</span>
			<span class="file-state-marker file-state-dirty" aria-label="未保存" ${isDirty ? "" : "hidden"}></span>
			<span class="file-state-badge file-state-pending" title="打开后自动检测文件类型" ${type.detectionPending ? "" : "hidden"}>AUTO</span>
			<span class="file-state-badge file-state-binary" title="二进制文件" ${type.binary ? "" : "hidden"}>BIN</span>
			<span class="file-state-badge file-state-readonly" title="只读预览" ${type.readonly === true ? "" : "hidden"}>RO</span>
			${entry.size != null && !entry.isDirectory ? `<span class="file-tree-size">${formatSize(entry.size)}</span>` : ""}
		</div>
		`;

    // 如果目录已展开，显示子内容占位
    if (entry.isDirectory && isOpen) {
      html += `<div class="file-tree-children pl-4" data-parent="${escapeAttr(fullPath)}">
				<p class="file-tree-loading-state py-1" role="status">加载中...</p>
			</div>`;
    }
  }

  return html;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  return (bytes / (1024 * 1024)).toFixed(1) + "M";
}

function bindTreeEvents() {
  if (!treeContainer) return;

  // 打开文件夹 — 弹窗浏览
  treeContainer
    .querySelector("#file-tree-open-folder")
    ?.addEventListener("click", async () => {
      try {
        const originChatId = freezeFileActionOriginChatId();
        const selected = await showFolderPicker(rootPath, originChatId);
        if (selected) {
          const effectiveRoot = await setFileExplorerRoot(selected, originChatId);
          showFileActionToast(originChatId, `已切换到: ${effectiveRoot}`, "success");
        }
      } catch (err) {
        console.error('[fileExplorer]', err);
        window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
      }
    });

  // 打开文件 — 弹窗浏览
  treeContainer
    .querySelector("#file-tree-open-file")
    ?.addEventListener("click", async () => {
      try {
        const originChatId = freezeFileActionOriginChatId();
        const selected = await showFilePicker(rootPath, originChatId);
        if (selected) {
          openFileInEditor(selected, originChatId);
        }
      } catch (err) {
        console.error('[fileExplorer]', err);
        window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
      }
    });

  // 路径输入框 — 手动导航（支持文件路径直接打开）
  const rootInput = treeContainer.querySelector("#file-root-input");
  const rootGoBtn = treeContainer.querySelector("#file-root-go");

  async function handleGoToPath(target) {
    if (!target) return;
    const originChatId = freezeFileActionOriginChatId();
    // 先尝试当作目录加载
    try {
      const result = await setFilesData({ _action: "listDir", path: target }, { originChatId });
      if (result?._result?.entries) {
        // 成功作为目录 → 设为根
        await setFileExplorerRoot(target, originChatId);
        return;
      }
    } catch (err) {
      console.error('[fileExplorer] 尝试作为目录打开失败:', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
    // 目录路线不成立后直接进入统一文件打开链。不再先用 readFile
    // 做文本探针，避免媒体/未知文件两次串行读取和假性失败。
    await openFileInEditor(target, originChatId);
  }

  rootGoBtn?.addEventListener("click", () => {
    const target = rootInput?.value?.trim();
    if (target) handleGoToPath(target);
  });

  rootInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const target = rootInput.value.trim();
      if (target) handleGoToPath(target);
    }
  });

  treeContainer.querySelectorAll(".file-root-crumb[data-root-path]").forEach((crumb) => {
    crumb.addEventListener("click", () => handleGoToPath(crumb.dataset.rootPath));
  });
  treeContainer.querySelector('.file-root-crumb[data-root-action="pick"]')?.addEventListener("click", async () => {
    const originChatId = freezeFileActionOriginChatId();
    const selected = await showFolderPicker("__drives__", originChatId, rootPath);
    if (selected) await setFileExplorerRoot(selected, originChatId);
  });
  treeContainer.querySelector("#file-root-copy")?.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("浏览器未提供剪贴板写入能力");
      await navigator.clipboard.writeText(rootPath);
      showToast("工作区路径已复制", "success");
    } catch (err) {
      showToast("复制路径失败: " + (err?.message || err), "error");
    }
  });

  // 刷新
  treeContainer
    .querySelector("#file-tree-refresh")
    ?.addEventListener("click", () => loadFileTree(rootPath));

  // 排序切换
  document.getElementById("file-tree-sort")?.addEventListener("click", () => {
    const modes = ["name", "mtime", "size"];
    const idx = (modes.indexOf(sortMode) + 1) % modes.length;
    sortMode = modes[idx];
    try { storage.set(KEYS.BEILU_FILE_SORT || "beilu_file_sort", sortMode); } catch {}
    loadFileTree(rootPath);
  });

  // 内容搜索 — 调用后端 searchFiles 递归搜当前根路径
  const searchInput = treeContainer.querySelector("#file-search-input");
  const searchBtn = treeContainer.querySelector("#file-search-go");
  const searchRegex = treeContainer.querySelector("#file-search-regex");
  const runSearch = () => {
    const q = searchInput?.value?.trim();
    if (!q) return;
    performSearch(q, !!searchRegex?.checked);
  };
  searchBtn?.addEventListener("click", runSearch);
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  // 新建文件
  treeContainer
    .querySelector("#file-tree-new-file")
    ?.addEventListener("click", async () => {
      const originChatId = freezeFileActionOriginChatId();
      const actionBasePath = currentPath;
      const actionRootPath = rootPath;
      const name = await beiluPrompt("新文件名:");
      if (!name?.trim()) return;
      const path = joinPath(actionBasePath, name.trim());
      try {
        const response = await setFilesData({ _action: "createFile", path, content: "" }, { originChatId });
        assertFileActionSuccess(response, "createFile");
        showToast(`文件 ${name} 已创建`, "success");
        await loadFileTree(actionRootPath, originChatId);
        openFileInEditor(path, originChatId);
      } catch (err) {
        showToast("创建失败: " + err.message, "error");
      }
    });

  // 新建目录
  treeContainer
    .querySelector("#file-tree-new-dir")
    ?.addEventListener("click", async () => {
      const originChatId = freezeFileActionOriginChatId();
      const actionBasePath = currentPath;
      const actionRootPath = rootPath;
      const name = await beiluPrompt("新目录名:");
      if (!name?.trim()) return;
      const path = joinPath(actionBasePath, name.trim());
      try {
        const response = await setFilesData({ _action: "createDir", path }, { originChatId });
        assertFileActionSuccess(response, "createDir");
        showToast(`目录 ${name} 已创建`, "success");
        await loadFileTree(actionRootPath, originChatId);
      } catch (err) {
        showToast("创建失败: " + err.message, "error");
      }
    });

  // 文件/目录点击 — 统一绑定（支持递归加载后的子节点）
  bindTreeItemEvents(treeContainer);
}

/**
 * 为容器内的所有 .file-tree-item 绑定点击事件
 * @param {HTMLElement} container - 要绑定事件的容器
 */
function bindTreeItemEvents(container) {
  if (!container) return;

  container.querySelectorAll(".file-tree-item").forEach((item) => {
    // 避免重复绑定
    if (item.dataset.bound) return;
    item.dataset.bound = "true";

    const activateItem = async () => {
      try {
        const originChatId = freezeFileActionOriginChatId();
        const path = item.dataset.path;
        const isDir = item.dataset.isDir === "true";

        if (isDir) {
          // 切换目录展开
          if (expandedDirs.has(path)) {
            expandedDirs.delete(path);
            // 移除子元素
            const children = treeContainer.querySelector(
              `.file-tree-children[data-parent="${CSS.escape(path)}"]`,
            );
            if (children) children.remove();
            item.setAttribute("aria-expanded", "false");
            const icon = item.querySelector(".tree-icon");
            if (icon) icon.innerHTML = getFileTypeIconMarkup(path, { isDirectory: true, isOpen: false });
          } else {
            expandedDirs.add(path);
            currentPath = path;
            // 加载子目录
            try {
              const result = await setFilesData({ _action: "listDir", path }, { originChatId });
              if (filePanelOwnerChatId !== originChatId) return;
              if (result?._result?.entries) {
                // 插入子节点
                const childHtml = `<div class="file-tree-children pl-4" data-parent="${escapeAttr(path)}">
								${renderEntries(result._result.entries, path)}
							</div>`;
                item.insertAdjacentHTML("afterend", childHtml);
                // 为新插入的子节点绑定事件（递归支持）
                const newChildren = item.nextElementSibling;
                if (newChildren) {
                  bindTreeItemEvents(newChildren);
                }
                item.setAttribute("aria-expanded", "true");
                const icon = item.querySelector(".tree-icon");
                if (icon) icon.innerHTML = getFileTypeIconMarkup(path, { isDirectory: true, isOpen: true });

                // 递归加载该子树中已展开的目录
                await loadExpandedDirsIn(newChildren, originChatId);
              }
            } catch (err) {
              showToast("加载目录失败: " + err.message, "error");
            }
          }
        } else {
          // 打开文件
          openFileInEditor(path, originChatId);
        }
      } catch (err) {
        console.error('[fileExplorer]', err);
        window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
      }
    };

    // 业务动作保持在 click/release 或键盘 activation；不在 pointerdown 提前执行。
    item.addEventListener("click", activateItem);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateItem();
      }
    });

    // 右键菜单
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log(
        "[fileExplorer] 右键菜单触发:",
        item.dataset.path,
        "isDir:",
        item.dataset.isDir,
      );
      showFileContextMenu(item.dataset.path, item.dataset.isDir === "true", e);
    });
  });
}

/**
 * 递归加载所有已展开目录的子内容（全树范围）
 */
async function loadExpandedDirs(originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  await loadExpandedDirsIn(treeContainer, originChatId);
}

/**
 * 递归加载指定容器中已展开目录的子内容
 * @param {HTMLElement} container
 */
async function loadExpandedDirsIn(container, originChatId = null) {
  if (!container) return;
  originChatId = freezeFileActionOriginChatId(originChatId);

  // 找到所有占位符为"加载中..."的已展开目录子容器
  const pendingChildren = container.querySelectorAll(".file-tree-children");
  for (const childEl of pendingChildren) {
    const parentPath = childEl.dataset.parent;
    if (!parentPath || !expandedDirs.has(parentPath)) continue;

    // 检查是否只有"加载中..."占位符
    const isPlaceholder =
      childEl.children.length === 1 &&
      childEl.querySelector("p")?.textContent?.includes("加载中");
    if (!isPlaceholder && childEl.children.length > 0) continue;

    // 加载内容
    try {
      const result = await setFilesData({
        _action: "listDir",
        path: parentPath,
      }, { originChatId });
      if (result?._result?.entries) {
        if (filePanelOwnerChatId !== originChatId) return;
        childEl.innerHTML = renderEntries(result._result.entries, parentPath);
        // 绑定事件
        bindTreeItemEvents(childEl);
        // 递归加载子树中已展开的目录
        await loadExpandedDirsIn(childEl, originChatId);
      }
    } catch {
      childEl.innerHTML = '<p class="text-[10px] text-error py-1">加载失败</p>';
    }
  }
}

// ============================================================
// 多标签管理
// ============================================================

/**
 * 获取指定路径的标签
 * @param {string} path
 * @returns {TabState|undefined}
 */
function getTab(path, ownerChatId = filePanelOwnerChatId || activeTabOwnerChatId) {
  if (!ownerChatId) return openTabs.find((t) => t.path === path);
  return openTabs.find((t) => t.path === path && t.ownerChatId === ownerChatId);
}

/**
 * 获取当前活动标签
 * @returns {TabState|undefined}
 */
function getActiveTab() {
  return activeTabPath && activeTabOwnerChatId
    ? getTab(activeTabPath, activeTabOwnerChatId)
    : undefined;
}

function isTabStillProjected(tab) {
  return !!tab
    && filePanelOwnerChatId === tab.ownerChatId
    && getActiveTab() === tab;
}

function syncFileTreeState() {
  treeContainer?.querySelectorAll(".file-tree-item.file").forEach((item) => {
    const tab = getTab(item.dataset.path);
    const fileType = tab?.fileType || getFileType(item.dataset.path);
    const isActive = item.dataset.path === activeTabPath;
    const isDirty = tab?.isDirty === true;
    item.classList.toggle("active", isActive);
    item.classList.toggle("dirty", isDirty);
    item.classList.toggle("is-binary", fileType.binary === true);
    item.classList.toggle("is-readonly", fileType.readonly === true);
    item.classList.toggle("is-detection-pending", fileType.detectionPending === true);
    item.dataset.fileKind = fileType.kind;
    item.setAttribute("aria-selected", String(isActive));
    const icon = item.querySelector(".tree-icon");
    if (icon) icon.innerHTML = getFileTypeIconMarkup(item.dataset.path, { fileType });
    const marker = item.querySelector(".file-state-dirty");
    if (marker) marker.hidden = !isDirty;
    const pendingBadge = item.querySelector(".file-state-pending");
    const binaryBadge = item.querySelector(".file-state-binary");
    const readonlyBadge = item.querySelector(".file-state-readonly");
    if (pendingBadge) pendingBadge.hidden = fileType.detectionPending !== true;
    if (binaryBadge) binaryBadge.hidden = fileType.binary !== true;
    if (readonlyBadge) readonlyBadge.hidden = fileType.readonly !== true;
  });
}

/**
 * 在保存当前标签的编辑状态（滚动、光标、内容）后切换
 */
function saveActiveTabState() {
  if (!activeTabPath) return;
  const tab = getTab(activeTabPath, activeTabOwnerChatId);
  if (!tab) return;

  const textarea = editorContainer?.querySelector("#file-editor-textarea");
  if (textarea) {
    // textarea DOM 会把 CRLF 规范化成 LF；未发生 input 时保留后端原文，避免仅切 tab 就改写 EOL。
    if (tab.isDirty) tab.content = textarea.value;
    tab.scrollTop = textarea.scrollTop;
    tab.scrollLeft = textarea.scrollLeft;
    tab.selectionStart = textarea.selectionStart;
    tab.selectionEnd = textarea.selectionEnd;
  }
}

/**
 * 渲染标签栏
 */
function renderTabs() {
  if (!tabBarContainer) return;
  const visibleTabs = filePanelOwnerChatId
    ? openTabs.filter((tab) => tab.ownerChatId === filePanelOwnerChatId)
    : openTabs;

  if (visibleTabs.length === 0) {
    tabBarContainer.innerHTML =
      '<span class="ide-tabs-placeholder px-3">未打开文件</span>';
    syncFileTreeState();
    return;
  }

  let html = "";
  for (const tab of visibleTabs) {
    const fileName = tab.path.split("/").pop();
    const isActive = tab.path === activeTabPath && tab.ownerChatId === activeTabOwnerChatId;
    const fileType = tab.fileType || getFileType(fileName);
    const icon = getFileTypeIconMarkup(fileName, { fileType });

    html += `<div class="ide-editor-tab ${isActive ? "ide-tab-active" : ""}" data-tab-path="${escapeAttr(tab.path)}" data-tab-owner="${escapeAttr(tab.ownerChatId)}" data-file-kind="${fileType.kind}" data-file-readonly="${fileType.readonly === true}" title="${escapeAttr(tab.path)}" role="tab" tabindex="0" aria-selected="${isActive}">
			<span class="ide-tab-icon text-[0.7rem]">${icon}</span>
			<span class="ide-tab-name">${escapeHtml(fileName)}</span>
			${fileType.readonly === true ? '<span class="file-state-badge file-state-readonly" title="只读预览">RO</span>' : ""}
			${tab.isDirty ? '<span class="ide-tab-dirty" aria-label="未保存"></span>' : ""}
            <button type="button" class="ide-tab-close" data-close-path="${escapeAttr(tab.path)}" data-close-owner="${escapeAttr(tab.ownerChatId)}" title="关闭文件" aria-label="关闭文件">×</button>
		</div>`;
  }

  // 关闭全部按钮：多于1个标签才显示（why: 用户诉求一次性关闭所有打开文件）
  if (visibleTabs.length > 1) {
    html += `<button class="ide-tabs-close-all btn btn-xs btn-ghost" title="关闭全部文件">关闭全部</button>`;
  }

  tabBarContainer.innerHTML = html;

  // 绑定标签点击事件
  tabBarContainer.querySelectorAll(".ide-editor-tab").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 排除关闭按钮点击
      if (e.target.closest(".ide-tab-close")) return;
      const path = el.dataset.tabPath;
      const ownerChatId = el.dataset.tabOwner;
      if (path && ownerChatId && (path !== activeTabPath || ownerChatId !== activeTabOwnerChatId)) {
        switchToTab(path, ownerChatId);
      }
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const path = el.dataset.tabPath;
        const ownerChatId = el.dataset.tabOwner;
        if (path && ownerChatId && (path !== activeTabPath || ownerChatId !== activeTabOwnerChatId)) {
          switchToTab(path, ownerChatId);
        }
      }
    });

    // 中键关闭
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        const path = el.dataset.tabPath;
        const ownerChatId = el.dataset.tabOwner;
        if (path && ownerChatId) closeTab(path, ownerChatId);
      }
    });
  });

  // 绑定关闭按钮
  tabBarContainer.querySelectorAll(".ide-tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = btn.dataset.closePath;
      const ownerChatId = btn.dataset.closeOwner;
      if (path && ownerChatId) closeTab(path, ownerChatId);
    });
  });

  // 绑定"关闭全部"按钮（why: 用户诉求一次性关闭所有打开文件）
  tabBarContainer
    .querySelector(".ide-tabs-close-all")
    ?.addEventListener("click", () => closeAllTabs());

  syncFileTreeState();

  // 确保活动标签可见（滚动到视野内）
  requestAnimationFrame(() => {
    const activeEl = tabBarContainer.querySelector(".ide-tab-active");
    if (activeEl)
      activeEl.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
}

/**
 * 切换到指定标签
 * @param {string} path
 */
function switchToTab(path, ownerChatId) {
  const tab = getTab(path, ownerChatId);
  if (!tab || tab.ownerChatId !== filePanelOwnerChatId) return;
  // 切换既有标签也是新的用户焦点意图；使此前尚未完成的打开/刷新请求失效。
  fileOpenCoordinator.invalidateIntents();

  // 保存当前标签状态
  saveActiveTabState();

  // 切换
  activeTabPath = path;
  activeTabOwnerChatId = tab.ownerChatId;
  filePanelOwnerChatId = tab.ownerChatId;
  activeTabPathByOwner.set(tab.ownerChatId, path);

  // 渲染标签栏
  renderTabs();

  // 渲染编辑器内容
  renderEditor();

  // 恢复滚动和光标位置
  requestAnimationFrame(() => {
    if (!isTabStillProjected(tab)) return;
    const textarea = editorContainer?.querySelector("#file-editor-textarea");
    if (textarea) {
      textarea.scrollTop = tab.scrollTop || 0;
      textarea.scrollLeft = tab.scrollLeft || 0;
      textarea.selectionStart = tab.selectionStart || 0;
      textarea.selectionEnd = tab.selectionEnd || 0;
      updateCursorPos(
        textarea,
        editorContainer?.querySelector("#editor-cursor-pos"),
        editorContainer?.querySelector("#editor-line-numbers"),
        tab,
      );
    }
  });

  // 更新状态栏文件信息
  updateStatusBar(tab);
}

/**
 * 关闭标签
 * @param {string} path
 */
async function closeTab(path, ownerChatId = activeTabOwnerChatId) {
  const tab = getTab(path, ownerChatId);
  if (!tab) return;

  // 检查未保存
  if (tab.isDirty) {
    if (!await beiluConfirm(`文件 "${path.split("/").pop()}" 有未保存的更改，是否关闭？`))
      return;
  }

  const idx = openTabs.indexOf(tab);
  const ownerIdx = openTabs.filter((candidate) => candidate.ownerChatId === tab.ownerChatId).indexOf(tab);
  openTabs.splice(idx, 1);

  // 如果关闭的是当前活动标签，需要切换
  if (path === activeTabPath && tab.ownerChatId === activeTabOwnerChatId) {
    const ownerTabs = openTabs.filter((candidate) => candidate.ownerChatId === tab.ownerChatId);
    if (ownerTabs.length === 0) {
      activeTabPath = null;
      activeTabOwnerChatId = null;
      activeTabPathByOwner.delete(tab.ownerChatId);
      renderTabs();
      renderEmptyEditor();
    } else {
      // 只在同一窗口的标签内选后继，不把另一窗口的文件投影过来。
      const nextTab = ownerTabs[Math.min(ownerIdx, ownerTabs.length - 1)];
      activeTabPath = nextTab.path;
      activeTabOwnerChatId = nextTab.ownerChatId;
      activeTabPathByOwner.set(nextTab.ownerChatId, nextTab.path);
      renderTabs();
      renderEditor();
      // 恢复新活动标签的滚动位置
      const newTab = nextTab;
      requestAnimationFrame(() => {
        if (!isTabStillProjected(newTab)) return;
        const textarea = editorContainer?.querySelector(
          "#file-editor-textarea",
        );
        if (textarea) {
          textarea.scrollTop = newTab.scrollTop || 0;
          textarea.scrollLeft = newTab.scrollLeft || 0;
        }
      });
      updateStatusBar(newTab);
    }
  } else {
    // 关闭的不是当前标签，只需重新渲染标签栏
    renderTabs();
  }
}

/**
 * 一次性关闭所有打开的文件标签
 * why: 用户诉求"一次性把打开的文件关闭"——逐个点×太繁琐
 * 复用 closeTab 的 isDirty 检查语义，但合并成一次 confirm（不逐个弹）
 * 影响面: 纯前端 Additive，不动 closeTab；复用 renderTabs/renderEmptyEditor
 */
async function closeAllTabs() {
  const owner = filePanelOwnerChatId || activeTabOwnerChatId;
  const closingTabs = owner ? openTabs.filter((tab) => tab.ownerChatId === owner) : [...openTabs];
  const dirtyTabs = closingTabs.filter((t) => t.isDirty);
  if (dirtyTabs.length > 0) {
    const names = dirtyTabs.map((t) => t.path.split("/").pop()).join("、");
    if (
      !(await beiluConfirm(
        `有 ${dirtyTabs.length} 个文件未保存（${names}），确认全部关闭？`,
      ))
    )
      return;
  }
  if (filePanelOwnerChatId !== owner) return;
  openTabs = owner ? openTabs.filter((tab) => tab.ownerChatId !== owner) : [];
  if (owner) activeTabPathByOwner.delete(owner);
  else activeTabPathByOwner.clear();
  activeTabPath = null;
  activeTabOwnerChatId = null;
  renderTabs();
  renderEmptyEditor();
}

function ensureEditorBreadcrumb() {
  let breadcrumb = document.getElementById("ide-editor-breadcrumb");
  if (breadcrumb || !editorContainer?.parentElement) return breadcrumb;
  breadcrumb = document.createElement("nav");
  breadcrumb.id = "ide-editor-breadcrumb";
  breadcrumb.className = "ide-editor-breadcrumb";
  breadcrumb.setAttribute("aria-label", "当前文件路径");
  breadcrumb.hidden = true;
  editorContainer.parentElement.insertBefore(breadcrumb, editorContainer);
  return breadcrumb;
}

function updateEditorBreadcrumb(tab) {
  const breadcrumb = ensureEditorBreadcrumb();
  if (!breadcrumb) return;
  if (!tab) {
    breadcrumb.hidden = true;
    breadcrumb.replaceChildren();
    breadcrumb.removeAttribute("title");
    return;
  }

  const fileName = tab.path.split(/[\\/]/).pop() || tab.path;
  const fileType = tab.fileType || getFileType(fileName);
  const segments = getPathBreadcrumbSegments(tab.path);
  breadcrumb.hidden = false;
  breadcrumb.title = tab.path;
  breadcrumb.innerHTML = `<span class="ide-editor-breadcrumb-icon" aria-hidden="true">${getFileTypeIconMarkup(fileName, { fileType })}</span>${segments
    .map((segment, index) => {
      const current = index === segments.length - 1;
      return `${index ? '<span class="ide-editor-breadcrumb-separator" aria-hidden="true">›</span>' : ""}<span class="ide-editor-breadcrumb-segment${current ? " current" : ""}" title="${escapeAttr(segment.path)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(segment.label)}</span>`;
    })
    .join("")}<span class="ide-editor-breadcrumb-type">${escapeHtml(fileType.languageLabel)}</span>${fileType.readonly === true ? '<span class="file-state-badge file-state-readonly" title="只读预览">RO</span>' : ""}`;
  requestAnimationFrame(() => {
    breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  });
}

function ensureStatusItem(id) {
  let item = document.getElementById(id);
  if (item) return item;
  const statusLang = document.getElementById("ide-status-lang");
  const group = statusLang?.parentElement || document.getElementById("ide-statusbar");
  if (!group) return null;
  item = document.createElement("span");
  item.id = id;
  item.className = "ide-status-item";
  group.appendChild(item);
  return item;
}

/** 当前活动 TabState 到全局状态栏与动态 breadcrumb 的唯一投影。 */
function updateStatusBar(tab, selectionStart = tab?.selectionStart || 0, visibleContent = tab?.content || "") {
  const projection = createEditorTabProjection(tab, selectionStart, visibleContent);
  const statusFile = document.getElementById("ide-status-file");
  const statusLang = document.getElementById("ide-status-lang");
  const statusEncoding = document.getElementById("ide-status-encoding");
  const statusEol = ensureStatusItem("ide-status-eol");
  const statusIndent = ensureStatusItem("ide-status-indent");
  const statusPosition = ensureStatusItem("ide-status-position");
  const statusState = ensureStatusItem("ide-status-state");
  if (statusFile) {
    statusFile.textContent = projection.path || "就绪";
    statusFile.title = projection.path;
  }
  if (statusLang) statusLang.textContent = projection.language;
  if (statusEncoding) statusEncoding.textContent = tab ? projection.encoding : "";
  if (statusEol) statusEol.textContent = projection.eol;
  if (statusIndent) statusIndent.textContent = projection.indent;
  if (statusPosition) statusPosition.textContent = tab ? `行 ${projection.line}, 列 ${projection.column}` : "";
  if (statusState) {
    statusState.textContent = projection.stateLabel;
    statusState.title = projection.stateTitle;
    statusState.dataset.state = projection.state;
  }
  updateEditorBreadcrumb(tab);
  return projection;
}

function projectActiveEditorStatus(tab) {
  if (!tab || getActiveTab() !== tab) return null;
  const textarea = editorContainer?.querySelector("#file-editor-textarea");
  const projection = updateStatusBar(
    tab,
    textarea?.selectionStart ?? tab.selectionStart,
    textarea?.value ?? tab.content,
  );
  const cursor = editorContainer?.querySelector("#editor-cursor-pos");
  if (cursor && textarea) cursor.textContent = `行 ${projection.line}, 列 ${projection.column}`;
  const stateBadge = editorContainer?.querySelector("#editor-dirty-indicator");
  if (stateBadge) {
    stateBadge.textContent = projection.stateLabel;
    stateBadge.title = projection.stateTitle;
    stateBadge.dataset.state = projection.state;
    stateBadge.className = "file-editor-state-badge";
  }
  const localEncoding = editorContainer?.querySelector("#editor-status-encoding");
  const localEol = editorContainer?.querySelector("#editor-status-eol");
  const localIndent = editorContainer?.querySelector("#editor-status-indent");
  const localLanguage = editorContainer?.querySelector("#editor-status-language");
  if (localEncoding) localEncoding.textContent = projection.encoding;
  if (localEol) localEol.textContent = projection.eol;
  if (localIndent) localIndent.textContent = projection.indent;
  if (localLanguage) localLanguage.textContent = projection.language;
  const localStatus = editorContainer?.querySelector(".file-editor-statusbar");
  if (localStatus) localStatus.dataset.state = projection.state;
  return projection;
}

// ============================================================
// 文件编辑器
// ============================================================

function assertPreviewReadEnvelope(response, action) {
  const payload = response?._result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${action} 响应协议错误: 缺少有效 _result`);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "error")) {
    throw new Error(payload.error || `${action} 返回未知业务错误`);
  }
  if (typeof payload.size !== "number" || !Number.isSafeInteger(payload.size) || payload.size < 0) {
    throw new Error(`${action} 响应协议错误: size 无效`);
  }
  if (payload.warnings !== undefined && (
    !Array.isArray(payload.warnings) || payload.warnings.some((warning) => typeof warning !== "string")
  )) {
    throw new Error(`${action} 响应协议错误: warnings 无效`);
  }
  return Object.freeze({
    payload,
    warnings: payload.warnings ? [...payload.warnings] : [],
  });
}

async function loadFileTab(path, originChatId = null, { reuseExisting = true } = {}) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  // 任务B多类型预览：按种类分读取路——媒体（图/音/视频）走后端 readFileBase64 字节路（data URL），
  //   其余（含 svg：文本可编辑，看图由文本转 data URL 两全）走原 readFile 文本路。
  let _fileType = getFileType(path.split("/").pop() || "");

  let _content = "";
  let _dataUrl = null;
  let _mediaSize = 0;
  let _encoding = "UTF-8";
  let _warnings = [];
  if (_fileType.readMode === "base64") {
    const result = await setFilesData({ _action: "readFileBase64", path }, { originChatId });
    const { payload, warnings } = assertPreviewReadEnvelope(result, "readFileBase64");
    if (typeof payload.base64 !== "string" || typeof payload.mime !== "string" || payload.mime.length === 0) {
      throw new Error("readFileBase64 响应协议错误: base64/mime 缺失");
    }
    _dataUrl = `data:${payload.mime};base64,${payload.base64}`;
    _mediaSize = payload.size;
    _warnings = warnings;
  } else if (_fileType.readMode === "extract") {
    // 任务C office：提取文本作只读预览内容（xlsx=CSV+公式视图 / docx=正文 / pptx=逐页文本）
    const result = await setFilesData({ _action: "readFileExtract", path }, { originChatId });
    const { payload, warnings } = assertPreviewReadEnvelope(result, "readFileExtract");
    if (typeof payload.text !== "string") {
      throw new Error("readFileExtract 响应协议错误: text 缺失");
    }
    _content = payload.text;
    _mediaSize = payload.size;
    _warnings = warnings;
  } else if (_fileType.readMode === "auto") {
    const result = await setFilesData({ _action: "readFileAuto", path }, { originChatId });
    const { payload, warnings } = assertPreviewReadEnvelope(result, "readFileAuto");
    _fileType = getDetectedFileType(payload.kind);
    _warnings = warnings;
    if (payload.kind === "text") {
      if (typeof payload.content !== "string") {
        throw new Error("readFileAuto 响应协议错误: text content 缺失");
      }
      if (payload.encoding !== "UTF-8") {
        throw new Error("readFileAuto 响应协议错误: encoding 不受支持");
      }
      _content = payload.content;
      _encoding = payload.encoding;
    } else if (payload.kind === "binary") {
      if (typeof payload.base64 !== "string" || typeof payload.mime !== "string" || payload.mime.length === 0) {
        throw new Error("readFileAuto 响应协议错误: binary base64/mime 缺失");
      }
      _dataUrl = `data:${payload.mime};base64,${payload.base64}`;
    }
    _mediaSize = payload.size;
  } else {
    const result = await setFilesData({ _action: "readFile", path }, { originChatId });
    const { payload, warnings } = assertPreviewReadEnvelope(result, "readFile");
    if (typeof payload.content !== "string") {
      throw new Error("readFile 响应协议错误: content 缺失");
    }
    _warnings = warnings;
    _content = payload.content;
    _mediaSize = payload.size;
  }

  // 防御并发外部入口：若读取期间已有同路径标签，复用现有对象，不重复建 tab。
  const existingTab = getTab(path, originChatId);
  if (reuseExisting && existingTab) return Object.freeze({ tab: existingTab, warnings: _warnings });

  const newTab = {
    path,
    ownerChatId: originChatId,
    content: _content,
    originalContent: _content,
    isDirty: false,
    scrollTop: 0,
    scrollLeft: 0,
    selectionStart: 0,
    selectionEnd: 0,
    // 任务B：种类 + 当前视图模式 + 媒体数据（预览渲染用；不参与保存链——保存只走文本路 content）
    fileType: _fileType,
    kind: _fileType.previewKind,
    encoding: _encoding,
    lineEnding: detectLineEnding(_content),
    saveState: "saved",
    lastError: "",
    viewMode: _fileType.editable && _fileType.previewKind === "code" ? "edit" : "preview",
    dataUrl: _dataUrl,
    mediaSize: _mediaSize,
  };
  return Object.freeze({ tab: newTab, warnings: _warnings });
}

/**
 * 两阶段刷新：读取与警告确认都只产生候选快照；原标签直到最后一次意图校验通过才原位提交。
 * 读取失败、用户拒绝、切窗/切标签、标签被关闭或读取期间又有编辑时，原标签保持不变。
 */
async function reloadFileTab(tab) {
  if (!tab) return false;
  const path = tab.path;
  const ownerChatId = tab.ownerChatId;

  if (tab.isDirty && !await beiluConfirm("有未保存的更改，确定刷新吗？")) return false;
  if (filePanelOwnerChatId !== ownerChatId || getActiveTab() !== tab) return false;

  const intent = fileOpenCoordinator.beginIntent(path);
  const acceptedState = Object.freeze({
    content: tab.content,
    originalContent: tab.originalContent,
    isDirty: tab.isDirty,
  });
  const requestKey = `${ownerChatId}\0${path}\0reload`;
  let loaded;
  try {
    loaded = await fileOpenCoordinator.getOrCreate(
      requestKey,
      () => loadFileTab(path, ownerChatId, { reuseExisting: false }),
    );
  } catch (err) {
    if (fileOpenCoordinator.isLatest(intent)
        && filePanelOwnerChatId === ownerChatId
        && getTab(path, ownerChatId) === tab) {
      showFileActionToast(ownerChatId, "重新加载失败: " + (err?.message || err), "error");
    }
    return false;
  }

  if (!fileOpenCoordinator.isLatest(intent)) return false;
  if (loaded.warnings.length > 0) {
    const ok = await beiluConfirm(`⚠ ${loaded.warnings.join("；")}\n\n仍要重新加载此文件吗？`);
    if (!ok || !fileOpenCoordinator.isLatest(intent)) return false;
  }

  // 等待期间的任何界面归属、标签身份或编辑状态变化都使本次提交失效。
  if (filePanelOwnerChatId !== ownerChatId
      || getActiveTab() !== tab
      || getTab(path, ownerChatId) !== tab
      || tab.content !== acceptedState.content
      || tab.originalContent !== acceptedState.originalContent
      || tab.isDirty !== acceptedState.isDirty) return false;

  Object.assign(tab, loaded.tab);
  activeTabPathByOwner.set(ownerChatId, path);
  renderTabs();
  renderEditor();
  showFileActionToast(ownerChatId, "文件已重新加载", "info");
  return true;
}

async function openFileInEditor(path, originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  const intent = fileOpenCoordinator.beginIntent(path);

  // 如果已有此标签，直接切换
  const existingTab = getTab(path, originChatId);
  if (existingTab) {
    switchToTab(path, originChatId);
    return existingTab;
  }
  diag.debug("openFileInEditor:", path);

  const requestKey = `${originChatId}\0${path}`;
  const request = fileOpenCoordinator.getOrCreate(requestKey, () => loadFileTab(path, originChatId));
  let loaded;
  try {
    loaded = await request;
  } catch (err) {
    diag.warn("openFileInEditor 失败:", path, err?.message);
    if (fileOpenCoordinator.isLatest(intent)) {
      showToast("打开文件失败: " + err.message, "error");
    }
    return null;
  }

  // 警告属于一次用户打开意图，不属于按 path 共享的磁盘读取。只有精确的最新 intent
  // 可以弹确认；同路径重复点击也不能让旧 intent 借“路径相同”穿过门。
  if (loaded.warnings.length > 0) {
    if (!fileOpenCoordinator.isLatest(intent)) return null;
    const ok = await beiluConfirm(`⚠ ${loaded.warnings.join("；")}\n\n仍要打开此文件吗？`);
    if (!fileOpenCoordinator.isLatest(intent) || !ok) return null;
  }

  let tab = getTab(path, originChatId);
  if (!tab) {
    tab = loaded.tab;
    openTabs.push(tab);
  }

  if (fileOpenCoordinator.isLatest(intent) && filePanelOwnerChatId === originChatId) {
    switchToTab(path, originChatId);
  } else {
    // 旧慢响应只把已读取内容加入标签栏，不得覆盖用户后来选择的活动标签。
    renderTabs();
  }
  return tab;
}

function renderEditor() {
  if (!editorContainer) return;
  const tab = getActiveTab();
  if (!tab) {
    renderEmptyEditor();
    return;
  }

  const fileName = tab.path.split("/").pop() || "";

  // 旧 tab 对象没有 fileType 时也从同一注册表补齐，不在渲染层再分类。
  if (!tab.fileType) {
    tab.fileType = getFileType(fileName);
    tab.kind = tab.fileType.previewKind;
    if (!tab.viewMode) tab.viewMode = tab.fileType.editable && tab.kind === "code" ? "edit" : "preview";
  }
  if (typeof tab.originalContent !== "string") tab.originalContent = tab.content;
  const canEdit = tab.fileType.editable === true;
  const mode = canEdit ? (tab.viewMode === "preview" ? "preview" : "edit") : "preview";
  tab.viewMode = mode;
  const statusProjection = createEditorTabProjection(tab);
  projectFileToolbarState(tab, isTabSaveInFlight(tab));

  // 模式切换钮：仅同时可编辑+可预览的种类显示（html/md/svg/code）；预览钮文案按种类
  const _prevLabel = tab.kind === "html" ? "▶ 运行" : '<i data-ic="eye"></i> 预览';
  const _modebar = (canEdit && tab.kind !== "binary")
    ? `<div class="file-editor-modebar flex items-center justify-end gap-1 px-2 shrink-0">
				<button id="file-mode-preview" class="btn btn-xs ${mode === "preview" ? "btn-warning" : "btn-ghost"}" title="预览" aria-pressed="${mode === "preview"}">${_prevLabel}</button>
				<button id="file-mode-edit" class="btn btn-xs ${mode === "edit" ? "btn-warning" : "btn-ghost"}" title="编辑" aria-pressed="${mode === "edit"}"><i data-ic="edit"></i> 编辑</button>
			</div>`
    : "";

  const _isBinary = tab.kind === "binary";
  editorContainer.innerHTML = `
		<div class="file-editor-workspace flex flex-col h-full" data-file-kind="${tab.fileType.kind}" data-file-readonly="${tab.fileType.readonly}" role="region" aria-label="${escapeAttr(fileName)} 文件工作区">
			${_modebar}
			<!-- 编辑器内容 -->
			<div class="flex-1 overflow-auto relative">
				${
          _isBinary
            ? `
				<div class="file-editor-binary flex items-center justify-center h-full" role="status">
					<div class="text-center">
						<div class="file-editor-binary-icon mb-3">${getFileTypeIconMarkup(fileName, { fileType: tab.fileType })}</div>
						<p class="file-editor-binary-title">${escapeHtml(tab.fileType.languageLabel)}：只读预览</p>
						<p class="file-editor-binary-name mt-1">${escapeHtml(fileName)}</p>
					</div>
				</div>
				`
            : mode === "edit"
              ? `
				<div class="flex h-full">
					<!-- 行号 -->
					<div id="editor-line-numbers" class="text-right pr-2 pl-2 py-2 select-none shrink-0 overflow-hidden"></div>
					<!-- 编辑区 -->
					<textarea id="file-editor-textarea"
						class="flex-1 p-2 resize-none"
						aria-label="编辑 ${escapeAttr(fileName)}"
						spellcheck="false"
						wrap="off">${escapeHtml(tab.content)}</textarea>
				</div>
				`
              : `<div id="file-preview-pane" class="file-preview-pane h-full overflow-auto" role="region" aria-label="${escapeAttr(fileName)} 只读预览"><p class="file-preview-loading text-xs text-center py-6" role="status">预览加载中...</p></div>`
        }
			</div>
			<!-- 状态栏 -->
			<div class="file-editor-statusbar flex items-center justify-between px-3 shrink-0" data-state="${statusProjection.state}">
				<div class="file-editor-status-group">
					<span id="editor-dirty-indicator" class="file-editor-state-badge" data-state="${statusProjection.state}" title="${escapeAttr(statusProjection.stateTitle)}">${escapeHtml(statusProjection.stateLabel)}</span>
					<span id="editor-cursor-pos">${mode === "edit" ? `行 ${statusProjection.line}, 列 ${statusProjection.column}` : "预览模式"}</span>
				</div>
				<div class="file-editor-status-group file-editor-status-meta">
					<span id="editor-status-encoding">${escapeHtml(statusProjection.encoding)}</span>
					<span id="editor-status-eol">${escapeHtml(statusProjection.eol)}</span>
					<span id="editor-status-indent">${escapeHtml(statusProjection.indent)}</span>
					<span id="editor-status-language">${escapeHtml(statusProjection.language)}</span>
					<span id="editor-char-count">${tab.dataUrl ? formatSize(tab.mediaSize || 0) : tab.content.length + " 字符"}</span>
				</div>
			</div>
		</div>
	`;

  // 模式切换绑定：切走编辑前先保存 textarea 态（内容/滚动/光标），切回来恢复
  const _btnPrev = editorContainer.querySelector("#file-mode-preview");
  const _btnEdit = editorContainer.querySelector("#file-mode-edit");
  _btnPrev?.addEventListener("click", () => {
    if (tab.viewMode === "preview") return;
    saveActiveTabState();
    tab.viewMode = "preview";
    renderEditor();
  });
  _btnEdit?.addEventListener("click", () => {
    if (tab.viewMode === "edit") return;
    tab.viewMode = "edit";
    renderEditor();
    requestAnimationFrame(() => {
      if (!isTabStillProjected(tab) || tab.viewMode !== "edit") return;
      const _ta = editorContainer?.querySelector("#file-editor-textarea");
      if (_ta) {
        _ta.scrollTop = tab.scrollTop || 0;
        _ta.scrollLeft = tab.scrollLeft || 0;
        _ta.selectionStart = tab.selectionStart || 0;
        _ta.selectionEnd = tab.selectionEnd || 0;
        updateCursorPos(
          _ta,
          editorContainer?.querySelector("#editor-cursor-pos"),
          editorContainer?.querySelector("#editor-line-numbers"),
          tab,
        );
      }
    });
  });

  // 预览面异步填充（renderEditor 保持同步：调用点 switchToTab/closeTab 不改 async）
  if (mode === "preview" && !_isBinary) {
    const _pane = editorContainer.querySelector("#file-preview-pane");
    if (_pane) {
      _renderPreviewInto(_pane, tab).catch((err) => {
        _pane.innerHTML = `<p class="text-xs text-error text-center py-6">预览失败: ${escapeHtml(err?.message || String(err))}</p>`;
      });
    }
  }

  // 绑定编辑器交互
  const textarea = editorContainer.querySelector("#file-editor-textarea");
  const lineNumbers = editorContainer.querySelector("#editor-line-numbers");
  const cursorPos = editorContainer.querySelector("#editor-cursor-pos");
  const charCount = editorContainer.querySelector("#editor-char-count");

  // DOM 已装配后再投影，保证动态 breadcrumb、全局状态栏和局部状态使用同一个 TabState。
  projectActiveEditorStatus(tab);

  if (textarea && lineNumbers) {
    updateLineNumbers(textarea, lineNumbers);

    // 自动保存 debounce 定时器（闭包内，每次渲染编辑器重置）
    let autoSaveTimer = null;

    textarea.addEventListener("input", () => {
      // textarea 与创建它的 TabState 同属 renderEditor 闭包；切标签后不能重新猜 active owner。
      tab.content = textarea.value;
      tab.isDirty = tab.content !== tab.originalContent;
      tab.lineEnding = detectLineEnding(tab.content, tab.lineEnding);
      tab.saveState = tab.isDirty ? "dirty" : "saved";
      tab.lastError = "";
      if (charCount) charCount.textContent = textarea.value.length + " 字符";
      updateLineNumbers(textarea, lineNumbers);
      updateCursorPos(textarea, cursorPos, lineNumbers, tab); // [0723] 输入后刷新活动行高亮(行号div已重建,重新标当前行)
      // 更新标签栏 dirty 指示
      renderTabs();

      // 自动保存：读 storage 判断开关，debounce 1.5s
      if (storage.get(KEYS.BEILU_IDE_AUTO_SAVE) === "true") {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => {
          if (tab && tab.isDirty) {
            await saveTab(tab, { source: "auto" });
          }
        }, 1500);
      }
    });

    textarea.addEventListener("scroll", () => {
      if (lineNumbers) lineNumbers.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener("click", () =>
      updateCursorPos(textarea, cursorPos, lineNumbers, tab),
    );
    textarea.addEventListener("keyup", () =>
      updateCursorPos(textarea, cursorPos, lineNumbers, tab),
    );

    // Ctrl+S 保存
    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveCurrentFile();
      }
      // Ctrl+F 查找 / Ctrl+H 替换：委托菜单 action（idePanel handleMenuAction）
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "h")) {
        e.preventDefault();
        document.querySelector(`.ide-menu-action[data-action="${e.key === "f" ? "find" : "replace"}"]`)?.click();
      }
      // Tab 键插入制表符
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value =
          textarea.value.substring(0, start) +
          "\t" +
          textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        textarea.dispatchEvent(new Event("input"));
      }
      // [0723 代码美化] Enter 保持当前行缩进(why: 编辑代码时换行自动对齐上一行缩进,VSCode同款)
      if (e.key === "Enter") {
        const val = textarea.value;
        const lineStart = val.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
        const indent = val.substring(lineStart).match(/^([ \t]*)/)?.[1] || "";
        if (indent) {
          e.preventDefault();
          const pos = textarea.selectionStart;
          textarea.value = val.substring(0, pos) + "\n" + indent + val.substring(textarea.selectionEnd);
          textarea.selectionStart = textarea.selectionEnd = pos + 1 + indent.length;
          textarea.dispatchEvent(new Event("input"));
        }
      }
    });
  }

  // Reload 只取决于是否存在活动标签；保存能力由 projectFileToolbarState 单源投影。
  const reloadBtn = document.getElementById("file-reload-btn");
  if (reloadBtn) reloadBtn.disabled = false;
}

/**
 * 任务B多类型预览：按 tab.kind 把预览渲染进容器。
 * - html：sandbox iframe srcdoc（sandbox 只给 allow-scripts、不给 allow-same-origin——origin=null，
 *   触不到 beilu localStorage/登录态；与聊天美化消息 iframeRenderer 同权限档，不新开安全口子）
 * - md：renderMarkdownAsString（untrusted 默认走 rehype-sanitize；Shiki/KaTeX/Mermaid 同聊天管线）
 * - code：md fence 包裹 → 同管线 Shiki 只读高亮（零新依赖）
 * - svg：文本转 data URL 看图（编辑模式仍是文本）
 * - image/audio/video：openFileInEditor 已备好 dataUrl（后端 readFileBase64，20MB 上限）
 * @param {HTMLElement} pane
 * @param {TabState} tab
 */
async function _renderPreviewInto(pane, tab) {
  switch (tab.kind) {
    case "html": {
      pane.innerHTML = "";
      pane.classList.remove("overflow-auto");
      const _if = document.createElement("iframe");
      _if.sandbox = "allow-scripts";
      _if.className = "w-full h-full border-0 bg-white";
      _if.srcdoc = tab.content;
      pane.appendChild(_if);
      break;
    }
    case "md": {
      const _html = await renderMarkdownAsString(tab.content);
      pane.innerHTML = `<div class="p-4 file-md-preview file-md-preview-content">${_html}</div>`;
      break;
    }
    case "code": {
      const _ext = (tab.path.split(".").pop() || "").toLowerCase();
      const _fenced = "```" + _ext + "\n" + tab.content + "\n```";
      const _html = await renderMarkdownAsString(_fenced);
      pane.innerHTML = `<div class="p-2 file-md-preview file-md-preview-code">${_html}</div>`;
      break;
    }
    case "svg": {
      const _url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tab.content)}`;
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><img src="${_url}" class="max-w-full max-h-full" alt="${escapeAttr(tab.path)}" /></div>`;
      break;
    }
    case "image":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><img src="${tab.dataUrl}" class="file-preview-media max-w-full max-h-full" alt="${escapeAttr(tab.path)}" /></div>`;
      break;
    case "audio":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><audio controls src="${tab.dataUrl}"></audio></div>`;
      break;
    case "video":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-2"><video controls src="${tab.dataUrl}" class="max-w-full max-h-full"></video></div>`;
      break;
    case "doc":
      // office 提取文本只读预览（等宽保 CSV/幻灯片文本列对齐）
      pane.innerHTML = `<pre class="file-doc-preview p-3 whitespace-pre-wrap">${escapeHtml(tab.content)}</pre>`;
      break;
    case "pdf": {
      pane.innerHTML = "";
      pane.classList.remove("overflow-auto");
      const _pf = document.createElement("iframe");
      _pf.className = "w-full h-full border-0";
      _pf.src = tab.dataUrl; // data:application/pdf → 浏览器内置查看器
      pane.appendChild(_pf);
      break;
    }
    default:
      pane.innerHTML = `<p class="file-preview-unavailable text-center py-6">该类型暂无预览器</p>`;
  }
}

// [0723 代码美化] 行号 gutter 升级为结构化 div（why: 原 textContent 纯数字无法承载活动行高亮/缩进参考线）。
//   每行一个 div：行号文本 + data-indent(缩进层级,供 CSS 画缩进参考线) + data-line(行号,供活动行高亮定位)。
//   等宽 font-mono 保证行号 div 与 textarea 每行像素高度一致→scroll 同步(scrollTop 按像素)仍对齐。
//   单源收口：行号 gutter 唯一生成处,活动行/缩进线都挂此,不新造第二处行号逻辑。
function updateLineNumbers(textarea, lineNumbers) {
  if (!textarea || !lineNumbers) return;
  const lines = textarea.value.split("\n");
  let html = "";
  for (let i = 0; i < lines.length; i++) {
    // 缩进层级：前导空白宽度/2(2空格=1级)，tab 记 1 级；封顶 6 级防超宽
    const lead = lines[i].match(/^([ \t]*)/)?.[1] || "";
    const indent = Math.min(6, Math.floor((lead.replace(/\t/g, "  ").length) / 2));
    html += `<div class="ide-ln" data-line="${i + 1}" data-indent="${indent}">${i + 1}</div>`;
  }
  lineNumbers.innerHTML = html;
}

// [0723 代码美化] 光标位置 + 活动行高亮：updateCursorPos 兼职触发活动行高亮(光标所在行号 div 加 .ide-ln-active)。
//   why: 光标移动(click/keyup/input)时同步高亮当前行,VSCode 同款视觉。lineNumbers 参数可选(不传则跳过高亮)。
function updateCursorPos(textarea, cursorPos, lineNumbers, tab) {
  if (!textarea || !cursorPos) return;
  const value = textarea.value.substring(0, textarea.selectionStart);
  const line = value.split("\n").length;
  const col = value.split("\n").pop().length + 1;
  cursorPos.textContent = `行 ${line}, 列 ${col}`;
  if (tab) {
    tab.selectionStart = textarea.selectionStart;
    tab.selectionEnd = textarea.selectionEnd;
    projectActiveEditorStatus(tab);
  }
  // 活动行高亮：清旧 + 标当前行
  if (lineNumbers) {
    const prev = lineNumbers.querySelector(".ide-ln-active");
    if (prev) prev.classList.remove("ide-ln-active");
    const cur = lineNumbers.querySelector(`.ide-ln[data-line="${line}"]`);
    if (cur) cur.classList.add("ide-ln-active");
  }
}

function bindEditorEvents() {
  // 顶部工具栏按钮
  const saveBtn = document.getElementById("file-save-btn");
  const reloadBtn = document.getElementById("file-reload-btn");

  saveBtn?.addEventListener("click", saveCurrentFile);
  reloadBtn?.addEventListener("click", async () => {
    try {
      const tab = getActiveTab();
      if (tab) await reloadFileTab(tab);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });

  // 全局 Ctrl+S 拦截（当焦点不在 textarea 时也能保存）
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      // textarea 的局部 handler 已处理并 preventDefault；避免同一次按键冒泡后重复进入保存。
      if (e.defaultPrevented) return;
      // 只在文件主模式可见时接管浏览器保存；即使无 tab 也进入同一 capability reason。
      const filesPanel = document.getElementById("center-tab-files");
      if (!filesPanel || filesPanel.hidden || filesPanel.classList.contains("hidden") || filesPanel.style.display === "none") return;
      e.preventDefault();
      saveCurrentFile();
    }
  });
}

async function saveCurrentFile() {
  const tab = getActiveTab();
  // 手动保存的唯一额外职责：把当前可见 textarea 同步回当前 tab，再委托显式 owner。
  const textarea = editorContainer?.querySelector("#file-editor-textarea");
  // textarea 会把 CRLF 规范化为 LF；没有发生 input 时必须保留 TabState 原文，
  // 否则一次无改动 Ctrl+S 就会静默改写整份文件的换行符。
  if (tab && textarea && tab.isDirty) tab.content = textarea.value;
  return saveTab(tab);
}

/**
 * 保存一个显式 TabState。手动保存和自动保存必须共用本 owner，避免异步到期后重猜活动标签。
 * @param {TabState|undefined|null} tab
 * @param {{source?: "manual"|"auto"}} options
 */
async function saveTab(tab, { source = "manual" } = {}) {
  const saveCapability = getFileSaveCapability(tab, isTabSaveInFlight(tab));
  if (!saveCapability.canSave) {
    // 同一标签在真实写入期间又产生了新内容：记录一次后继保存，当前写入成功后再串行提交
    // 最新 TabState。Set/Map 按路径去重，持续输入不会堆积无界请求。
    if (saveCapability.busy && tab?.path && tab.isDirty) {
      const saveKey = tabIdentity(tab.path, tab.ownerChatId);
      const queued = queuedSaveByPath.get(saveKey);
      queuedSaveByPath.set(saveKey, {
        tab,
        source: source === "manual" ? "manual" : (queued?.source || "auto"),
      });
      tab.saveState = "saving";
      projectActiveEditorStatus(tab);
      if (source === "manual") showToast("当前写入完成后将继续保存最新内容", "info");
      return;
    }
    // 只读/二进制/未知类型在请求前明确拒绝；toast 与菜单 data reason 同源。
    showToast(saveCapability.reason, "warning");
    return;
  }

  const saveKey = tabIdentity(tab.path, tab.ownerChatId);
  saveInFlightPaths.add(saveKey);
  tab.saveState = "saving";
  tab.lastError = "";
  // 后台可能保存非活动 tab；UI 始终只投影此刻的活动标签。
  projectFileToolbarState(getActiveTab(), isTabSaveInFlight(getActiveTab()));
  projectActiveEditorStatus(tab);
  let writeSucceeded = false;
  try {
    diag.debug("saveTab:", tab.path, "len:", tab.content?.length ?? 0);
    await persistTabContent(tab, setFilesData);
    writeSucceeded = true;

    tab.saveState = tab.isDirty ? "dirty" : source === "auto" ? "auto-saved" : "saved";
    // 只有后端 success:true 后才更新保存基线；保存期间的新输入继续显示 dirty。
    renderTabs();
    projectActiveEditorStatus(tab);
    showFileActionToast(tab.ownerChatId, tab.isDirty ? "已保存请求时的内容，仍有新更改" : "文件已保存", tab.isDirty ? "warning" : "success");
  } catch (err) {
    tab.saveState = "error";
    tab.lastError = err?.message || String(err);
    projectActiveEditorStatus(tab);
    wbDetect("ide", "saveTab", false, err?.message);
    diag.warn("saveTab 失败:", tab.path, err?.message);
    showFileActionToast(tab.ownerChatId, "保存失败: " + err.message, "error");
  } finally {
    saveInFlightPaths.delete(saveKey);
    const queued = queuedSaveByPath.get(saveKey);
    queuedSaveByPath.delete(saveKey);
    // 保存期间可能切换标签；结束时必须读取当前活动标签，不能恢复旧 tab 的能力。
    projectFileToolbarState(getActiveTab(), isTabSaveInFlight(getActiveTab()));
    projectActiveEditorStatus(getActiveTab());
    if (writeSucceeded && queued && openTabs.includes(queued.tab) && queued.tab.isDirty) {
      queueMicrotask(() => { void saveTab(queued.tab, { source: queued.source }); });
    }
  }
}

// ============================================================
// 右键菜单
// ============================================================

function showFileContextMenu(path, isDir, event) {
  const menuOwnerChatId = freezeFileActionOriginChatId();
  const menuRootPath = rootPath;
  // 移除已有菜单
  document.querySelectorAll(".file-context-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "file-context-menu";
  menu.setAttribute("role", "menu");
  console.log(
    "[fileExplorer] 创建右键菜单:",
    path,
    "position:",
    event.clientX,
    event.clientY,
  );

  const fileName = path.split("/").pop();
  const items = [];

  if (!isDir) {
    items.push({ label: '<i data-ic="file"></i> 打开', action: "open" });
  }
  if (isDir) {
    items.push({ label: '<i data-ic="folder-open"></i> 在此打开', action: "setRoot" });
    items.push({ label: '<i data-ic="file"></i> 新建文件', action: "newFile" });
    items.push({ label: '<i data-ic="folder-open"></i> 新建子目录', action: "newDir" });
  }
  items.push({ label: "—", action: "divider" });
  items.push({ label: '<i data-ic="clipboard"></i> 复制路径', action: "copyPath" });
  // D4（凛倾 06-16「注入的话是直接复制路径到对话框」）：右键补「插入路径到对话框」，
  //   加选项不替换剪贴板功能。插入格式=超链接式 `[文件:名](路径) `，
  //   插入 #message-input 光标处让 AI 据此读整份文件（file:isDir 才有意义，仅非目录显示）。
  if (!isDir) items.push({ label: '<i data-ic="clipboard"></i> 插入路径到对话框', action: "insertPath" });
  items.push({ label: '<i data-ic="edit"></i> 重命名', action: "rename" });
  items.push({ label: "—", action: "divider" });
  items.push({ label: '<i data-ic="trash"></i> 删除', action: "delete", danger: true });

  for (const item of items) {
    if (item.action === "divider") {
      const divider = document.createElement("div");
      divider.className = "divider my-0.5 mx-2";
      menu.appendChild(divider);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = `file-context-action${item.danger ? " danger" : ""}`;
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    // 右键菜单 label 含 data-ic 图标标签（本文件 + 前置 pass 注入的 clipboard/trash），
    //   全部为内部常量串无用户数据（无 XSS），故用 innerHTML 让图标真正渲染（原 textContent 会把 <i> 当字面文本）。
    btn.innerHTML = item.label;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.remove();
      try {
        const originChatId = menuOwnerChatId;
        switch (item.action) {
          case "open":
            await openFileInEditor(path, originChatId);
            break;
          case "setRoot":
            {
              const effectiveRoot = await setFileExplorerRoot(path, originChatId);
              showFileActionToast(originChatId, `已切换到: ${effectiveRoot}`, "success");
            }
            break;
          case "newFile": {
            const name = await beiluPrompt("新文件名:");
            if (!name?.trim()) return;
            const newPath = path.replace(/\/$/, "") + "/" + name.trim();
            try {
              const response = await setFilesData({
                _action: "createFile",
                path: newPath,
                content: "",
              }, { originChatId });
              assertFileActionSuccess(response, "createFile");
              showToast("文件已创建", "success");
              await loadFileTree(menuRootPath, originChatId);
            } catch (err) {
              showToast("创建失败: " + err.message, "error");
            }
            break;
          }
          case "newDir": {
            const name = await beiluPrompt("新目录名:");
            if (!name?.trim()) return;
            const newPath = path.replace(/\/$/, "") + "/" + name.trim();
            try {
              const response = await setFilesData({ _action: "createDir", path: newPath }, { originChatId });
              assertFileActionSuccess(response, "createDir");
              showToast("目录已创建", "success");
              await loadFileTree(menuRootPath, originChatId);
            } catch (err) {
              showToast("创建失败: " + err.message, "error");
            }
            break;
          }
          case "copyPath":
            navigator.clipboard
              ?.writeText(path)
              .then(() => showToast("路径已复制", "success"))
              .catch((err) => {
                console.error('[fileExplorer] 复制路径失败:', err);
                window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
              });
            break;
          case "insertPath": {
            // D4：复制路径直通对话框。insertLink 范式（源 skillPicker 已 0723 删，此处自包含）——
            //   取 #message-input 光标 selectionStart/End，拼超链接式 `[文件:名](路径) ` 插入，
            //   focus+setSelectionRange 定位到插入尾，dispatch input 事件触发既有联动（草稿保存/高度自适应）。
            const input = document.getElementById("message-input");
            if (!input) { showToast("找不到对话框输入框", "error"); break; }
            const link = `[文件:${fileName}](${path}) `;
            const a = input.selectionStart ?? input.value.length;
            const b = input.selectionEnd ?? input.value.length;
            input.value = input.value.slice(0, a) + link + input.value.slice(b);
            input.focus();
            try { input.setSelectionRange(a + link.length, a + link.length); } catch { /* noop */ }
            input.dispatchEvent(new Event("input", { bubbles: true }));
            showToast(`已插入路径「${fileName}」到对话框`, "success");
            break;
          }
          case "rename": {
            const newName = await beiluPrompt("新名称:", fileName);
            if (!newName?.trim() || newName === fileName) return;
            try {
              const res = await setFilesData(
                { _action: "rename", path, newName: newName.trim() },
                { originChatId },
              );
              // setFilesData 仅 HTTP 非2xx 抛错；逻辑失败走 _result.error（200），须显式判，否则假成功
              if (res?._result?.error) { showToast("重命名失败: " + res._result.error, "error"); return; }
              // [0723 问题1.1] 改名已执行完(后端 move 先改名后返 warnings),用 warning toast 事后告知不用 confirm
              //   (confirm 拦不住已执行的改名;readFile 是打开前 confirm 可拦,时序不同)。002原话「给提醒不禁止」。
              const _rnWarns = res?._result?.warnings;
              if (Array.isArray(_rnWarns) && _rnWarns.length > 0) {
                showToast(`已重命名，注意：${_rnWarns.join("；")}`, "warning");
              } else {
                showToast(`已重命名为 ${newName.trim()}`, "success");
              }
              // 路径已变：旧路径若有打开标签则关闭（避免指向不存在文件）
              const rnTab = getTab(path, originChatId);
              if (rnTab) { rnTab.isDirty = false; await closeTab(path, originChatId); }
              await loadFileTree(menuRootPath, originChatId);
            } catch (err) {
              showToast("重命名失败: " + err.message, "error");
            }
            break;
          }
          case "delete":
            // T026: 后端 deleteFile 已改 safeTrash 进系统回收站（凛倾原话「文件级别的删除是进电脑的回收站」），文案同步
            if (!await beiluConfirm(`确定删除 "${fileName}" 吗？将移入系统回收站，可从回收站找回。`)) return;
            try {
              const _delRes = await setFilesData(
                { _action: "deleteFile", path },
                { originChatId },
              );
              // setFilesData 仅 HTTP 非2xx 抛错；逻辑失败走 _result.error（200），须显式判（同 rename 模式）
              if (_delRes?._result?.error) { showToast("删除失败: " + _delRes._result.error, "error"); return; }
              showToast(`${fileName} 已移入回收站`, "success");
              // 如果该文件有标签，关闭它（不提示保存）
              const delTab = getTab(path, originChatId);
              if (delTab) {
                delTab.isDirty = false; // 文件已删除，无需提示保存
                await closeTab(path, originChatId);
              }
              await loadFileTree(menuRootPath, originChatId);
            } catch (err) {
              showToast("删除失败: " + err.message, "error");
            }
            break;
        }
      } catch (err) {
        console.error('[fileExplorer]', err);
        window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
      }
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  positionContextMenu(menu, event.clientX, event.clientY);
  bindClickOutsideClose(menu, () => menu.remove());
}

// ============================================================
// 待审批操作
// ============================================================

/** 审批动作后踢续轮（传导链修，凛倾 2026-07-09）：批准/拒绝的结果已由后端回注 pendingOpResults，
 *  但续轮只在「生成结束时」由后端 peek 驱动——审批发生在生成之外，无人触发下一轮生成 →
 *  AI 拿不到结果挂等到用户下次说话。此处审批回调统一踢 trigger-reply（500ms 防抖合并连点）。 */
const _kickReplyTimers = new Map();
function _kickReplyAfterApproval(originChatId) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  clearTimeout(_kickReplyTimers.get(originChatId));
  const timer = setTimeout(async () => {
    try {
      await sendAction({ verb: "triggerReply", target: "shells:chat", source: "web", scope: { chatId: originChatId }, payload: {} });
    } catch (err) {
      // 触发失败不吞：结果仍在池中，下次任意生成的 GetPrompt 会注入（降级为旧行为）
      console.warn("[fileExplorer] 审批后触发续轮失败:", err?.message);
    } finally {
      if (_kickReplyTimers.get(originChatId) === timer) _kickReplyTimers.delete(originChatId);
    }
  }, 500);
  _kickReplyTimers.set(originChatId, timer);
}

async function loadPendingOps(originChatId = null) {
  originChatId = freezeFileActionOriginChatId(originChatId);
  const container = treeContainer?.querySelector("#file-pending-ops");
  if (!container) return;

  try {
    const data = await getFilesData({ originChatId });
    // renderFileTree(B) 可能在递归目录 await 期间切到 A；旧调用捕获到的新 A 容器后，
    // 不能再把 B 的待审批列表写进 A。owner 与 DOM 身份都必须仍匹配。
    if (filePanelOwnerChatId !== originChatId
        || !container.isConnected
        || container !== treeContainer?.querySelector("#file-pending-ops")) return;
    // 多窗口隔离：只显示本次冻结归属的待审 op 与后端明确标记为无归属的旧条目。
    //   审批动作沿同一 scope.chatId 进入服务端 facade，前端不另造 payload.chatid 双源。
    const _allPending = data?.pendingOperations || [];
    const pending = _allPending.filter((op) => op._cid === originChatId || !op._cid);
    // N46：always 规则与待审队列同区渲染（规则存在时即使队列空也可见可删）
    const alwaysRules = Array.isArray(data?.approvalAlwaysRules)
      ? data.approvalAlwaysRules
      : [];

    if (pending.length === 0 && alwaysRules.length === 0) {
      container.innerHTML = "";
      return;
    }
    diag.throttled("pendingOps", 10, "待审批:", pending.length, "always规则:", alwaysRules.length);

    container.innerHTML = pending.length === 0 ? "" : `
			<div class="bg-warning/10 border border-warning/30 rounded-lg p-2 space-y-1">
				<div class="flex items-center justify-between">
					<span class="text-xs font-bold text-warning"><i data-ic="warning"></i> ${pending.length} 个操作待审批</span>
					<div class="flex gap-0.5">
						<button class="btn btn-xs btn-success" id="file-approve-all">✓ 全部批准</button>
						<button class="btn btn-xs btn-error btn-outline" id="file-reject-all">✗ 全拒</button>
					</div>
				</div>
				${pending
          .map(
            (op) => `
					<div class="flex items-center gap-1 text-[10px]">
						<span class="badge badge-xs">${escapeHtml(op.type)}</span>
						<span class="flex-1 truncate font-mono">${escapeHtml(op.path || op.command || "")}</span>
						<button class="btn btn-xs btn-ghost text-success approve-op" data-id="${escapeHtml(op.id)}" title="允许一次">✓</button>
						<button class="btn btn-xs btn-ghost text-error reject-op" data-id="${escapeHtml(op.id)}" title="拒绝">✗</button>
						${op.type === "exec" ? "" : `<button class="btn btn-xs btn-ghost approve-op-always" data-id="${escapeHtml(op.id)}" title="本条执行，且以后这类操作（同类型+目录前缀）不再询问"><i data-ic="star"></i></button>`}
					</div>
				`,
          )
          .join("")}
			</div>
		`;

    container
      .querySelector("#file-approve-all")
      ?.addEventListener("click", async () => {
        try {
          const response = await setFilesData({ _action: "approveAll" }, { originChatId });
          const result = assertApprovalActionHandled(response, "approveAll");
          const problems = Number(result.failed || 0) + Number(result.rejected || 0);
          showFileActionToast(
            originChatId,
            problems > 0
              ? `已处理 ${result.handled || 0} 项：成功 ${result.completed || 0}，失败/拒绝 ${problems}`
              : `已批准并执行 ${result.completed || 0} 项`,
            problems > 0 ? "warning" : "success",
          );
          _kickReplyAfterApproval(originChatId);
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });

    container
      .querySelector("#file-reject-all")
      ?.addEventListener("click", async () => {
        try {
          const response = await setFilesData({ _action: "rejectAll" }, { originChatId });
          const result = assertApprovalActionHandled(response, "rejectAll");
          showFileActionToast(originChatId, `已拒绝 ${result.rejected || 0} 项`, "info");
          _kickReplyAfterApproval(originChatId);
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });

    container.querySelectorAll(".approve-op").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const response = await setFilesData({ _action: "approveOp", opId: btn.dataset.id }, { originChatId });
          const result = assertApprovalActionHandled(response, "approveOp");
          if (!result.executed) showFileActionToast(originChatId, `操作未执行：${result.error || result.status || "已拒绝"}`, "warning");
          _kickReplyAfterApproval(originChatId);
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });

    container.querySelectorAll(".reject-op").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const response = await setFilesData({ _action: "rejectOp", opId: btn.dataset.id }, { originChatId });
          assertFileActionSuccess(response, "rejectOp");
          _kickReplyAfterApproval(originChatId);
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });

    // N46 always 规则小列表（可删）
    if (alwaysRules.length > 0) {
      container.insertAdjacentHTML(
        "beforeend",
        `<div class="bg-base-200/50 border border-base-300/50 rounded-lg p-2 mt-1 space-y-0.5">
					<div class="text-[10px] font-bold opacity-70"><i data-ic="star"></i> 总是允许规则</div>
					${alwaysRules
            .map(
              (r) => `
					<div class="flex items-center gap-1 text-[10px]">
						<span class="badge badge-xs">${escapeHtml(r.type || "")}</span>
						<span class="flex-1 truncate font-mono opacity-70" title="${escapeHtml(r.pathPrefix || "")}">${escapeHtml(r.pathPrefix || "")}</span>
						<button class="btn btn-xs btn-ghost text-error remove-always-rule" data-type="${escapeHtml(r.type || "")}" data-prefix="${escapeHtml(r.pathPrefix || "")}" title="删除此规则">×</button>
					</div>`,
            )
            .join("")}
				</div>`,
      );
    }

    // N46 ⭐总是允许：本条执行 + 落规则（exec 不展示该钮）
    container.querySelectorAll(".approve-op-always").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const response = await setFilesData({
            _action: "approveOp",
            opId: btn.dataset.id,
            policy: "always",
          }, { originChatId });
          const result = assertApprovalActionHandled(response, "approveOp");
          if (result.executed && result.ruleActive) {
            showFileActionToast(originChatId, result.ruleAdded ? "已执行，并加入总是允许" : "已执行，总是允许规则已生效", "success");
          } else if (result.executed) {
            showFileActionToast(originChatId, `已执行，但总是允许规则未保存：${result.rulePersistence?.error || "持久化失败"}`, "warning");
          } else {
            showFileActionToast(originChatId, `操作未执行${result.ruleActive ? "，规则已保存" : ""}：${result.error || result.status || "已拒绝"}`, "warning");
          }
          _kickReplyAfterApproval(originChatId);
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });

    container.querySelectorAll(".remove-always-rule").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await setFilesData({
            _action: "removeApprovalAlwaysRule",
            type: btn.dataset.type,
            pathPrefix: btn.dataset.prefix,
          }, { originChatId });
          await loadPendingOps(originChatId);
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });
  } catch (err) {
    wbDetect("ide", "loadPendingOps", false, err?.message);
    if (filePanelOwnerChatId === originChatId
        && container.isConnected
        && container === treeContainer?.querySelector("#file-pending-ops")) {
      container.innerHTML = "";
    }
  }
}

function renderEmptyEditor() {
  if (!editorContainer) return;

  activeTabPath = null;
  activeTabOwnerChatId = null;

  // 空态也走保存能力单源；Reload 继续只按有无活动标签控制。
  projectFileToolbarState(null, false);
  const reloadBtn = document.getElementById("file-reload-btn");
  if (reloadBtn) reloadBtn.disabled = true;

  // 更新状态栏
  updateStatusBar(null);

  editorContainer.innerHTML = `
		<div class="file-editor-empty flex items-center justify-center h-full" role="status">
			<div class="file-editor-empty-content text-center">
				<i data-ic="folder-open" class="file-editor-empty-icon mx-auto mb-4" aria-hidden="true"></i>
				<p class="file-editor-empty-title">从左侧文件树选择文件</p>
				<p class="file-editor-empty-help mt-1">或使用 <i data-ic="folder-open" aria-hidden="true"></i> 打开文件夹 / <i data-ic="file" aria-hidden="true"></i> 打开文件</p>
			</div>
		</div>
	`;

  // 更新标签栏
  renderTabs();
}

// ============================================================
// 内容搜索（后端 searchFiles）
// ============================================================

/**
 * 调用后端 searchFiles 递归搜索 rootPath 下文件内容并渲染结果
 * @param {string} query - 搜索词
 * @param {boolean} isRegex - 是否按正则匹配
 */
async function performSearch(query, isRegex) {
  const originChatId = freezeFileActionOriginChatId();
  const searchRoot = rootPath;
  const results = treeContainer?.querySelector("#file-search-results");
  if (!results) return;
  const searchButton = treeContainer?.querySelector("#file-search-go");
  results.setAttribute("role", "status");
  results.setAttribute("aria-live", "polite");
  results.setAttribute("aria-busy", "true");
  if (searchButton) searchButton.disabled = true;
  results.innerHTML =
    `<p class="file-search-progress">正在搜索「${escapeHtml(query)}」·${isRegex ? "正则" : "普通文本"}</p>`;
  try {
    // 后端 searchFiles 返回 { _result: { matches, totalFiles, searchedFiles, truncated, error? } }
    const res = await setFilesData({
      _action: "searchFiles",
      path: searchRoot,
      query,
      isRegex,
      maxResults: 50,
    }, { originChatId });
    if (filePanelOwnerChatId !== originChatId
        || !results.isConnected
        || results !== treeContainer?.querySelector("#file-search-results")) return;
    const r = res?._result;
    if (!r || r.error) {
      results.innerHTML = `<p class="text-[10px] text-error py-1">搜索失败: ${escapeHtml(r?.error || "无返回")}</p>`;
      return;
    }
    renderSearchResults(r, query, isRegex, originChatId, results);
  } catch (err) {
    if (filePanelOwnerChatId === originChatId
        && results.isConnected
        && results === treeContainer?.querySelector("#file-search-results")) {
      results.innerHTML = `<p class="file-search-error">搜索「${escapeHtml(query)}」失败: ${escapeHtml(err.message)}</p>`;
    }
  } finally {
    if (filePanelOwnerChatId === originChatId && results.isConnected) {
      results.setAttribute("aria-busy", "false");
      if (searchButton?.isConnected) searchButton.disabled = false;
    }
  }
}

/**
 * 渲染搜索结果列表，点击结果项在编辑器打开对应文件
 * @param {{matches:Array, searchedFiles:number, truncated:boolean}} r
 */
function renderSearchResults(r, query, isRegex, originChatId, results) {
  if (!results
      || filePanelOwnerChatId !== originChatId
      || !results.isConnected
      || results !== treeContainer?.querySelector("#file-search-results")) return;
  const matches = r.matches || [];
  if (matches.length === 0) {
    results.innerHTML =
      `<p class="file-search-summary">「${escapeHtml(query)}」·${isRegex ? "正则" : "普通文本"}：无匹配（已搜 ${r.searchedFiles || 0} 个文件）</p>`;
    return;
  }
  const header = `<div class="flex items-center justify-between mb-0.5">
      <span class="file-search-summary">「${escapeHtml(query)}」·${isRegex ? "正则" : "普通文本"}：${matches.length} 处匹配，已搜 ${r.searchedFiles || 0} 个文件${r.truncated ? "，结果已截断" : ""}</span>
      <button id="file-search-clear" class="btn btn-xs btn-ghost" title="清除结果">清除</button>
    </div>`;
  const list = matches
    .map(
      (m) => `
      <div class="file-search-hit cursor-pointer rounded px-1" data-path="${escapeAttr(m.file)}" role="button" tabindex="0" title="${escapeAttr(m.file)}">
        <div class="flex items-center gap-1">
          <span class="file-search-hit-icon">${getFileTypeIconMarkup(m.file)}</span>
          <span class="file-search-hit-path font-mono truncate flex-1">${escapeHtml(m.file)}</span>
          <span class="file-search-hit-line">:${m.line}</span>
        </div>
        <div class="file-search-hit-content font-mono truncate">${escapeHtml(m.content || "")}</div>
      </div>`,
    )
    .join("");
  results.innerHTML = `<div class="file-search-results-panel rounded-lg p-1 space-y-0.5 max-h-60 overflow-auto">${header}${list}</div>`;
  results
    .querySelector("#file-search-clear")
    ?.addEventListener("click", () => {
      results.innerHTML = "";
    });
  results.querySelectorAll(".file-search-hit").forEach((el) => {
    const openHit = () => {
      const path = el.dataset.path;
      if (path) openFileInEditor(path, originChatId);
    };
    el.addEventListener("click", openHit);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openHit();
      }
    });
  });
}

// ============================================================
// 文件操作错误轮询（后端 getPendingErrors / consumePendingErrors）
// ============================================================

/** @type {number|null} 错误轮询定时器，防止重复启动 */
let errorPollTimer = null;

/**
 * 启动文件操作错误轮询：后端将失败操作排入 pendingErrors 队列，
 * 前端此前从不拉取导致错误静默丢失。这里定时 getPendingErrors，
 * 有错则 consumePendingErrors 取出并 toast，避免重复弹出。
 */
function startErrorPolling() {
  if (errorPollTimer !== null) return; // 已在轮询
  const tick = async () => {
    try {
      const originChatId = freezeFileActionOriginChatId();
      // getPendingErrors 返回 { hasErrors, count, errors }（非 _result 包裹）
      const probe = await setFilesData({ _action: "getPendingErrors" }, { originChatId });
      if (!probe?.hasErrors || !probe.count) return;
      const consumed = await setFilesData({ _action: "consumePendingErrors" }, { originChatId });
      const errs = consumed?.errors || [];
      const toast = window._beiluToast || showToast;
      const visibleOwner = (() => {
        try { return String(window._beiluCurWinChatId?.() || "").trim(); } catch { return ""; }
      })();
      const ownerPrefix = visibleOwner && visibleOwner !== originChatId
        ? `后台对话 ${originChatId.slice(0, 8)}…：`
        : "";
      if (errs.length <= 2) {
        // 少量错误逐条弹
        for (const e of errs) {
          const detail = e?.error || e?.message || e?.path || JSON.stringify(e);
          toast(`${ownerPrefix}文件操作失败: ${detail}`, "error");
        }
      } else {
        // 多条错误合并弹出，避免批量红色 toast 轰炸
        const first = errs[0]?.error || errs[0]?.message || errs[0]?.path || "";
        toast(`${ownerPrefix}${errs.length} 个文件操作失败（首条: ${first}）`, "error");
      }
    } catch (err) {
      // 网络波动允许下周期重试，但不能吞掉持续失败的诊断线索。
      diag.throttled("errorPollingFailed", 30, "文件错误轮询失败:", err?.message || err);
    }
  };
  errorPollTimer = setInterval(tick, 5000);
  tick(); // 立即跑一次，捕获已积压的错误

  // [F4 管线归位 2026-07-19] 轮询生命周期挂 tab 激活：错误 toast 面向 files 场景，
  //   原首次进 files 后永久 5s 轮询。切出 files 停止、切回重启（重启即 tick 一次，
  //   离开期间积压的错误在回来时补弹，后端 pendingErrors 队列持有不丢）。
  //   listener 只绑一次（startErrorPolling 有 errorPollTimer 防重入，本函数可重入）。
  if (!_errPollTabBound) {
    _errPollTabBound = true;
    window.addEventListener("beilu:tab-activated", (e) => {
      if (e.detail === "files") startErrorPolling();
      else if (errorPollTimer !== null) {
        clearInterval(errorPollTimer);
        errorPollTimer = null;
      }
    });
  }
}
/** tab-activated 监听是否已绑（startErrorPolling 可被重复调用，事件只挂一次） */
let _errPollTabBound = false;

// ============================================================
// 工具函数
// ============================================================

function escapeAttr(str) {
  return escapeHtml(str);
}

// [D1 收口 0713] 纯桥壳：window._beiluToast（index.mjs main 启动挂载，先于任何用户交互）→
//   airp/utils.showToast → scripts/toast.mjs 单源。原"桥优先+本地手绘 DOM 降级"的降级分支
//   运行期不可达=死代码+第二套 toast UI（top-4 右上与权威右下位置分叉），纯删除。
function showToast(message, type = "info") {
  window._beiluToast?.(message, type);
}
