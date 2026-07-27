/**
 * fileExplorer.mjs — 文件浏览器 + 多标签编辑器
 *
 * 功能链：
 *   initFileExplorer → 渲染文件树（rootPath 下目录列表）→ 点目录展开/折叠 → 点文件
 *     → openFileTab → GET beilu-files getdata {_action:"readFile", path} → textarea 展示内容
 *   Ctrl+S / 点「保存」→ POST beilu-files setdata {_action:"writeFile", path, content, chatid}
 *     → 后端 workspaceRoots per-chatId 隔离写文件
 *   点「打开文件夹」→ showFolderPicker → 用户选目录 → rootPath 更新 → 刷新文件树
 *   右键文件/目录 → 上下文菜单（新建/重命名/删除）→ 对应 setdata action
 *   AI 审批队列：file_op pending 条目 → 点「允许/拒绝」→ approveAll/rejectAll → 后端执行/丢弃
 *
 * why（多窗口会话隔离）：
 *   setFilesData 统一注入 chatid（endpoints.currentChatId ES live binding，切卡自动更新），
 *   后端按 per-chatId workspaceRoots Map 隔离工作区根，防止多窗口互串文件操作。
 *
 * 关联链：
 *   → filePicker.mjs showFolderPicker / showFilePicker（打开文件夹/文件弹窗）
 *   → shared/transport/api-client.mjs apiFetch（beilu-files 所有 REST 调用统一出口）
 *   → shared/transport/endpoints.mjs currentChatId（chatid 来源）
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

import { showFilePicker, showFolderPicker } from "./filePicker.mjs";
import { escapeHtml, positionContextMenu, bindClickOutsideClose } from "../../shared/state/utils.mjs"; // [合并批 0714·二] 点外关闭收口单源
// 多窗口会话隔离：file_op 审批按本窗口 chatid 收口（与 ideToolCall dock 一致）。
// currentChatId 是 endpoints.mjs 的 ES live binding，切卡自动更新。
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
    try {
      // 传导链核修：后端前端 case 的相对路径锚 CWD（resolveWorkspacePath）而非工作区根——裸文件名会
      //   落 app 根且被沙箱闸拒。必须显式拼工作区根：rootPath 有则用；无（用户没开过文件面板）则
      //   ensureDefaultWorkspace 幂等拿默认根（=ai玩耍空间，与任务A同源）。
      let _base = rootPath;
      if (!_base) {
        const _dw = await setFilesData({ _action: "ensureDefaultWorkspace" });
        _base = _dw?._result?.path || null;
      }
      if (!_base) throw new Error("无可用工作区根");
      const _savePath = joinPath(_base, name);
      const _res = await setFilesData({ _action: "createFile", path: _savePath, content: code });
      if (_res?._result?.error) throw new Error(_res._result.error);
      showToast(`已保存到工作区: ${name}`, "success");
      if (treeContainer) await loadFileTree(rootPath || _base);
    } catch (err) {
      showToast("保存失败: " + (err?.message || err), "error");
    }
  });
}

// ============================================================
// API 通信
// ============================================================

async function getFilesData() {
  // 门面 getData（GET getdata）：返回后端配置对象（含 pendingOperations 等），形状与原 REST 等价。
  return sendAction({ verb: "getData", target: "plugins:beilu-files", source: "web" });
}

async function setFilesData(data) {
  // 多窗口会话隔离:唯一 POST 出口统一注入本窗口 chatid → 后端 getWorkspaceRoot(_cid) 按窗口根隔离,
  //   不再所有 file_op 落全局根(多窗互相看到/操作对方工作区)。后端已支持 per-chatid(workspaceRoots Map);
  //   已显式带 chatid 的(审批类 approveAll/rejectAll)不覆盖。currentChatId=endpoints ES live binding,切卡自动更新。
  // T6b：verb=data._action（真动作）→ beilu-files 通配路由组装 {_action:verb, ...payload}；chatid 作为 payload 字段注入。
  const { _action, ...rest } = (data && typeof data === "object") ? data : {};
  const _payload = (data && typeof data === "object" && data.chatid === undefined && currentChatId)
    ? { ...rest, chatid: currentChatId }
    : rest;
  return sendAction({ verb: _action, target: "plugins:beilu-files", source: "web", payload: _payload });
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
 * @property {string} content - 文件内容
 * @property {boolean} isDirty - 是否有未保存修改
 * @property {number} scrollTop - textarea 滚动位置
 * @property {number} scrollLeft - textarea 水平滚动位置
 * @property {number} selectionStart - 光标起始位置
 * @property {number} selectionEnd - 光标结束位置
 */

/** @type {TabState[]} */
let openTabs = [];

/** @type {string|null} 当前活动标签的文件路径 */
let activeTabPath = null;

/** 标签栏 DOM 容器 */
let tabBarContainer = null;

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

  // 获取标签栏容器
  tabBarContainer = document.getElementById("ide-editor-tabs");

  // Phase2 修复：恢复上次打开的文件夹路径（问题F: IDE文件夹历史记忆）
  try {
    const saved = storage.get(KEYS.BEILU_FILE_ROOT);
    if (saved) {
      rootPath = saved;
      console.log("[fileExplorer] 恢复上次文件夹路径:", saved);
    }
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

  // 渲染初始标签栏（空）
  renderTabs();

  // 任务A防护（凛倾 2026-07-09「没有就创建/用相对空间/删了别出bug」）：每次面板初始化都先 ensure——
  //   后端幂等 mkdir 默认「ai玩耍空间」并返回其【相对】路径（值单源在后端，前端不硬编码）。
  //   用户手动删掉玩耍空间 → 下次初始化在这里自动重建，不落 listDir NotFound。
  let _defaultRoot = null;
  try {
    const _dw = await setFilesData({ _action: "ensureDefaultWorkspace" });
    _defaultRoot = _dw?._result?.path || null;
    if (!_defaultRoot && _dw?._result?.error) console.warn("[fileExplorer] 默认工作区创建失败:", _dw._result.error);
  } catch (err) {
    console.warn("[fileExplorer] 默认工作区初始化失败:", err?.message);
  }

  if (rootPath) {
    // 有已保存的工作区根 → 正常加载（用户开过别的目录就恢复那个，不回默认——记忆第一层 localStorage）
    // 同步初始工作区根路径到后端
    try {
      await setFilesData({ _action: "setWorkspaceRoot", rootPath });
    } catch (err) {
      console.warn("[fileExplorer] 同步初始工作区根路径失败:", err.message);
    }
    renderTreeLoading();
    await loadFileTree(rootPath);
  } else {
    // 无本地记录 ≠ 首次使用：可能是换浏览器/清缓存（localStorage 没了）。记忆第二层 = 后端持久化根
    //   （beilu-files-settings.json _global.workspaceRoot，setWorkspaceRoot 每次都落盘）——它是用户真选过的
    //   目录就恢复它并回写本地记录，防「一清缓存就被打回默认」；两层都空才落默认玩耍空间（真·首次）。
    //   "." 是旧版默认值不算用户选择，一并升级为玩耍空间（防护收口）。
    let _backendRoot = null;
    try {
      const _cfg = await getFilesData();
      _backendRoot = _cfg?.workspaceRoot || null;
    } catch (err) {
      console.warn("[fileExplorer] 读取后端工作区根失败:", err?.message);
    }
    const _target =
      (_backendRoot && _backendRoot !== "." && _backendRoot !== _defaultRoot) ? _backendRoot : _defaultRoot;
    if (_target) {
      try {
        await setFileExplorerRoot(_target);
        if (_target === _defaultRoot) showToast("已打开默认工作区「AI 玩耍空间」", "success");
      } catch (err) {
        console.warn("[fileExplorer] 初始工作区打开失败:", err?.message);
        renderTreeEmpty();
      }
    } else {
      // ensure 失败且后端无记录 → 回落原空态引导（错误已在上方 warn/后端 pendingErrors 可见），不吞不装饰
      renderTreeEmpty();
    }
  }

  // 启动文件操作错误轮询（接入后端 pendingErrors 队列，否则失败静默丢失）
  startErrorPolling();
}

/**
 * 外部调用：设置文件树根路径并刷新
 * @param {string} path
 */
export async function setFileExplorerRoot(path) {
  diag.log("setFileExplorerRoot:", path);
  rootPath = path || ".";
  expandedDirs = new Set([rootPath]);
  currentPath = rootPath;

  try {
    storage.set(KEYS.BEILU_FILE_ROOT, rootPath);
  } catch {
    /* ignore */
  }

  // 同步工作区根路径到后端（AI沙箱范围 = IDE当前打开的文件夹）
  try {
    await setFilesData({ _action: "setWorkspaceRoot", rootPath });
  } catch (err) {
    console.warn("[fileExplorer] 同步工作区根路径失败:", err.message);
  }

  // 一窗一线：把当前卡的项目根也持久化到卡 _config（per-卡 worker 用各自根）。
  //   复用同一个"打开文件夹"动作，不新增设置入口（防重复功能）。
  try {
    const _char = window._beiluGetCharName?.();
    if (_char) {
      // verb=setCardWorkspaceRoot → memory 通配路由组装 {_action, charName, root}；!ok 由 apiFetch 抛错走 catch（出信号）。
      await sendAction({ verb: "setCardWorkspaceRoot", target: "plugins:beilu-memory", source: "web", payload: { charName: _char, root: rootPath } });
    }
  } catch (err) {
    // 持久化失败不阻断打开文件夹，但要出信号（否则 per-卡 worker 解析根静默退回默认）
    console.warn("[fileExplorer] per-卡项目根持久化异常:", err?.message);
  }

  await loadFileTree(rootPath);
}

// ============================================================
// 文件树
// ============================================================

function renderTreeLoading() {
  if (!treeContainer) return;
  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<h3 class="font-bold text-sm flex items-center gap-2 mb-2" style="color:var(--beilu-amber)">
				<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
				文件浏览
			</h3>
			<p class="text-xs text-base-content/40 text-center py-4">加载中...</p>
		</div>
	`;
}

// 0714 时序扫尾：渲染令牌（范式=conversationManager._renderSeq）。连续切目录时慢的旧 listDir
//   回来会无条件 renderFileTree 覆盖新目录树；await 后查令牌，被更新调用抢占则丢弃旧结果。
let _treeReqId = 0;
async function loadFileTree(path) {
  const myReq = ++_treeReqId;
  try {
    const result = await setFilesData({ _action: "listDir", path });
    if (myReq !== _treeReqId) return; // 已被更新的目录加载取代，丢弃过期结果
    if (result?._result?.entries) {
      diag.debug("loadFileTree:", path, "entries:", result._result.entries.length);
      renderFileTree(path, result._result.entries);
    } else if (result?._result?.error) {
      diag.warn("loadFileTree 后端返错:", path, result._result.error);
      renderTreeError(result._result.error);
    } else {
      diag.warn("loadFileTree 无效响应形状:", path, "keys:", result ? Object.keys(result).join(",") : "(null)");
      renderTreeError("服务器返回了无效响应");
    }
  } catch (err) {
    if (myReq !== _treeReqId) return;
    diag.warn("loadFileTree 异常:", path, err?.message);
    renderTreeError(err.message);
  }
}

/** 未设置工作区根时的空态引导 UI */
function renderTreeEmpty() {
  if (!treeContainer) return;
  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="font-bold text-sm flex items-center gap-2" style="color:var(--beilu-amber)">
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
      const picked = await showFolderPicker();
      if (picked) await setFileExplorerRoot(picked);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
  treeContainer.querySelector("#file-tree-empty-file")?.addEventListener("click", async () => {
    try {
      const picked = await showFilePicker();
      if (picked) openFileInEditor(picked);
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
				<h3 class="font-bold text-sm flex items-center gap-2" style="color:var(--beilu-amber)">
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
      const picked = await showFolderPicker();
      // 收口修（凛倾 2026-07-09「同一键多处散写/双键不同步」审计）：原 `rootPath = picked` 裸赋值
      //   绕过 setFileExplorerRoot → localStorage/后端沙箱根/per-卡 三键全不同步（前端浏览新目录、
      //   AI op 沙箱仍锚旧根、刷新即丢）。写根一律走唯一收口。
      if (picked) await setFileExplorerRoot(picked);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
  treeContainer.querySelector("#file-tree-err-file")?.addEventListener("click", async () => {
    try {
      const picked = await showFilePicker();
      if (picked) openFileInEditor(picked);
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });
}

async function renderFileTree(treePath, entries) {
  if (!treeContainer) return;

  const displayPath =
    treePath === "." ? "项目根目录" : treePath.replace(/\\/g, "/");

  treeContainer.innerHTML = `
		<div class="p-3 space-y-1">
			<div class="flex items-center justify-between mb-1">
				<h3 class="font-bold text-sm flex items-center gap-2" style="color:var(--beilu-amber)">
					<img src="/parts/shells:beilu-chat/icons/mdi__folder-outline.svg" class="w-4 h-4 icon" />
					文件浏览
				</h3>
				<div class="flex items-center gap-0.5">
					<button id="file-tree-open-folder" class="btn btn-xs btn-ghost btn-square" title="打开文件夹"><i data-ic="folder-open"></i></button>
					<button id="file-tree-open-file" class="btn btn-xs btn-ghost btn-square" title="打开文件"><i data-ic="file"></i></button>
					<button id="file-tree-refresh" class="btn btn-xs btn-ghost btn-square" title="刷新"><i data-ic="refresh"></i></button>
					<button id="file-tree-sort" class="btn btn-xs btn-ghost btn-square" title="排序: ${sortMode === 'mtime' ? '时间' : sortMode === 'size' ? '大小' : '名称'}">⇅</button>
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
					<label class="flex items-center gap-0.5 text-[10px] text-base-content/50 cursor-pointer" title="正则匹配">
						<input type="checkbox" id="file-search-regex" class="checkbox checkbox-xs" />.*
					</label>
					<button id="file-search-go" class="btn btn-xs btn-ghost btn-square" title="搜索"><i data-ic="search"></i></button>
				</div>
				<div id="file-search-results" class="text-xs"></div>

			<div class="text-xs text-base-content/40 mb-1 font-mono truncate" title="${escapeHtml(treePath)}">
				<i data-ic="folder-open"></i> ${escapeHtml(displayPath)}
			</div>

			<!-- 操作按钮 -->
			<div class="flex items-center gap-0.5 mb-1">
				<button id="file-tree-new-file" class="btn btn-xs btn-ghost" title="新建文件"><i data-ic="file"></i>+ 新文件</button>
				<button id="file-tree-new-dir" class="btn btn-xs btn-ghost" title="新建目录"><i data-ic="folder-open"></i>+ 新目录</button>
			</div>

			<div id="file-tree-entries" class="file-tree text-xs space-y-0.5">
				${renderEntries(entries, treePath)}
			</div>
			<div class="divider my-1 opacity-30"></div>
			<div id="file-pending-ops" class="text-xs"></div>
		</div>
	`;

  // 绑定树事件
  bindTreeEvents();

  // 递归加载所有已展开目录的子内容
  await loadExpandedDirs();

  // 加载待审批操作
  loadPendingOps();
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
    return '<p class="text-base-content/50 text-center py-2 text-[10px]">(空目录)</p>';
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
    const icon = entry.isDirectory ? '<i data-ic="folder-open"></i>' : getFileIcon(entry.name);
    const isOpen = entry.isDirectory && expandedDirs.has(fullPath);
    const isSelected = activeTabPath === fullPath;

    html += `
		<div class="file-tree-item ${entry.isDirectory ? "folder" : "file"} ${isSelected ? "active" : ""}"
			data-path="${escapeAttr(fullPath)}" data-is-dir="${entry.isDirectory}">
			<span class="tree-toggle ${entry.isDirectory ? "cursor-pointer" : "invisible"}">${entry.isDirectory ? (isOpen ? "▾" : "▸") : ""}</span>
			<span class="tree-icon">${icon}</span>
			<span class="tree-label flex-1 truncate">${escapeHtml(entry.name)}</span>
			${entry.size != null && !entry.isDirectory ? `<span class="text-[10px] text-base-content/50 ml-1">${formatSize(entry.size)}</span>` : ""}
		</div>
		`;

    // 如果目录已展开，显示子内容占位
    if (entry.isDirectory && isOpen) {
      html += `<div class="file-tree-children pl-4" data-parent="${escapeAttr(fullPath)}">
				<p class="text-[10px] text-base-content/50 py-1">加载中...</p>
			</div>`;
    }
  }

  return html;
}

function getFileIcon(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  const icons = {
    js: '<i data-ic="script"></i>',
    mjs: '<i data-ic="script"></i>',
    ts: '<i data-ic="book"></i>',
    json: "{ }",
    css: '<i data-ic="palette"></i>',
    html: '<i data-ic="earth"></i>',
    md: "≡",
    txt: '<i data-ic="file"></i>',
    py: '<i data-ic="python"></i>',
    sh: '<i data-ic="zap"></i>',
    bat: '<i data-ic="zap"></i>',
    png: '<i data-ic="image"></i>',
    jpg: '<i data-ic="image"></i>',
    jpeg: '<i data-ic="image"></i>',
    gif: '<i data-ic="image"></i>',
    svg: '<i data-ic="image"></i>',
  };
  return icons[ext] || '<i data-ic="file"></i>';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  return (bytes / (1024 * 1024)).toFixed(1) + "M";
}

// ============================================================
// 任务B多类型预览：文件种类判定（决定读取路 + 预览器 + 默认模式）
//   凛倾核心场景=「AI 做了美化(HTML)，用户直接打开运行看看」→ html/md/媒体默认预览。
//   格式集对齐 VSCode media-preview（jpg/png/bmp/gif/ico/webp + mp3/wav/ogg + mp4/webm）。
// ============================================================
const EDITABLE_EXTS = new Set([
  "js", "mjs", "ts", "json", "css", "html", "htm", "md", "txt", "py", "sh",
  "bat", "yml", "yaml", "toml", "ini", "cfg", "xml", "svg",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga"]);
const VIDEO_EXTS = new Set(["mp4", "webm"]);

/**
 * @param {string} name 文件名
 * @returns {{kind:"html"|"md"|"image"|"audio"|"video"|"code"|"binary", ext:string, defaultMode:"preview"|"edit"}}
 *   kind 决定读取路（媒体走 readFileBase64 字节路，其余走 readFile 文本路）与预览器；
 *   svg 双身份：可文本编辑（EDITABLE）也可看图——归 image（默认看图），编辑模式仍可用（文本已随 readFile 读回? 否——
 *   媒体走字节路无文本），故 svg 特判：走文本路 + image 预览（data URL 由文本转，可编辑可看图两全）。
 */
function classifyFile(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "html" || ext === "htm") return { kind: "html", ext, defaultMode: "preview" };
  if (ext === "md") return { kind: "md", ext, defaultMode: "preview" };
  if (ext === "svg") return { kind: "svg", ext, defaultMode: "preview" };
  if (IMAGE_EXTS.has(ext)) return { kind: "image", ext, defaultMode: "preview" };
  if (AUDIO_EXTS.has(ext)) return { kind: "audio", ext, defaultMode: "preview" };
  if (VIDEO_EXTS.has(ext)) return { kind: "video", ext, defaultMode: "preview" };
  // 任务C office（凛倾「还有ppt,xlsx等等」）：提取文本预览（后端 readFileExtract，与 AI read 同解析单源）
  if (ext === "xlsx" || ext === "docx" || ext === "pptx") return { kind: "doc", ext, defaultMode: "preview" };
  // pdf：base64 → iframe data URL，浏览器内置 PDF 查看器（翻页/缩放/搜索全套白捡）
  if (ext === "pdf") return { kind: "pdf", ext, defaultMode: "preview" };
  if (EDITABLE_EXTS.has(ext)) return { kind: "code", ext, defaultMode: "edit" };
  return { kind: "binary", ext, defaultMode: "preview" };
}

function bindTreeEvents() {
  if (!treeContainer) return;

  // 打开文件夹 — 弹窗浏览
  treeContainer
    .querySelector("#file-tree-open-folder")
    ?.addEventListener("click", async () => {
      try {
        const selected = await showFolderPicker(rootPath);
        if (selected) {
          await setFileExplorerRoot(selected);
          showToast(`已切换到: ${selected}`, "success");
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
        const selected = await showFilePicker(rootPath);
        if (selected) {
          openFileInEditor(selected);
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
    // 先尝试当作目录加载
    try {
      const result = await setFilesData({ _action: "listDir", path: target });
      if (result?._result?.entries) {
        // 成功作为目录 → 设为根
        await setFileExplorerRoot(target);
        return;
      }
    } catch (err) {
      console.error('[fileExplorer] 尝试作为目录打开失败:', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
    // 尝试当作文件打开
    try {
      const result = await setFilesData({ _action: "readFile", path: target });
      if (result?._result?.content !== undefined) {
        openFileInEditor(target);
        return;
      }
    } catch (err) {
      console.error('[fileExplorer] 尝试作为文件打开失败:', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
    showToast("路径无效: " + target, "error");
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

  // 刷新
  treeContainer
    .querySelector("#file-tree-refresh")
    ?.addEventListener("click", () => loadFileTree(rootPath));

  // 排序切换
  document.getElementById("file-tree-sort")?.addEventListener("click", () => {
    const modes = ["name", "mtime", "size"];
    const labels = { name: "名称", mtime: "时间", size: "大小" };
    const idx = (modes.indexOf(sortMode) + 1) % modes.length;
    sortMode = modes[idx];
    try { storage.set(KEYS.BEILU_FILE_SORT || "beilu_file_sort", sortMode); } catch {}
    const btn = document.getElementById("file-tree-sort");
    if (btn) btn.title = "排序: " + labels[sortMode];
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
      const name = await beiluPrompt("新文件名:");
      if (!name?.trim()) return;
      const path = joinPath(currentPath, name.trim());
      try {
        await setFilesData({ _action: "createFile", path, content: "" });
        showToast(`文件 ${name} 已创建`, "success");
        await loadFileTree(rootPath);
        openFileInEditor(path);
      } catch (err) {
        showToast("创建失败: " + err.message, "error");
      }
    });

  // 新建目录
  treeContainer
    .querySelector("#file-tree-new-dir")
    ?.addEventListener("click", async () => {
      const name = await beiluPrompt("新目录名:");
      if (!name?.trim()) return;
      const path = joinPath(currentPath, name.trim());
      try {
        await setFilesData({ _action: "createDir", path });
        showToast(`目录 ${name} 已创建`, "success");
        await loadFileTree(rootPath);
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

    item.addEventListener("click", async () => {
      try {
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
            // 更新图标
            const toggle = item.querySelector(".tree-toggle");
            if (toggle) toggle.textContent = "▸";
          } else {
            expandedDirs.add(path);
            currentPath = path;
            // 加载子目录
            try {
              const result = await setFilesData({ _action: "listDir", path });
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
                // 更新图标
                const toggle = item.querySelector(".tree-toggle");
                if (toggle) toggle.textContent = "▾";

                // 递归加载该子树中已展开的目录
                await loadExpandedDirsIn(newChildren);
              }
            } catch (err) {
              showToast("加载目录失败: " + err.message, "error");
            }
          }
        } else {
          // 打开文件
          openFileInEditor(path);
        }
      } catch (err) {
        console.error('[fileExplorer]', err);
        window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
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
async function loadExpandedDirs() {
  await loadExpandedDirsIn(treeContainer);
}

/**
 * 递归加载指定容器中已展开目录的子内容
 * @param {HTMLElement} container
 */
async function loadExpandedDirsIn(container) {
  if (!container) return;

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
      });
      if (result?._result?.entries) {
        childEl.innerHTML = renderEntries(result._result.entries, parentPath);
        // 绑定事件
        bindTreeItemEvents(childEl);
        // 递归加载子树中已展开的目录
        await loadExpandedDirsIn(childEl);
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
function getTab(path) {
  return openTabs.find((t) => t.path === path);
}

/**
 * 获取当前活动标签
 * @returns {TabState|undefined}
 */
function getActiveTab() {
  return activeTabPath ? getTab(activeTabPath) : undefined;
}

/**
 * 在保存当前标签的编辑状态（滚动、光标、内容）后切换
 */
function saveActiveTabState() {
  if (!activeTabPath) return;
  const tab = getTab(activeTabPath);
  if (!tab) return;

  const textarea = editorContainer?.querySelector("#file-editor-textarea");
  if (textarea) {
    tab.content = textarea.value;
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

  if (openTabs.length === 0) {
    tabBarContainer.innerHTML =
      '<span class="ide-tabs-placeholder text-xs text-base-content/50 px-3">未打开文件</span>';
    return;
  }

  let html = "";
  for (const tab of openTabs) {
    const fileName = tab.path.split("/").pop();
    const isActive = tab.path === activeTabPath;
    const icon = getFileIcon(fileName);

    html += `<div class="ide-editor-tab ${isActive ? "ide-tab-active" : ""}" data-tab-path="${escapeAttr(tab.path)}" title="${escapeAttr(tab.path)}">
			<span class="ide-tab-icon text-[0.7rem]">${icon}</span>
			<span class="ide-tab-name">${escapeHtml(fileName)}</span>
			${tab.isDirty ? '<span class="ide-tab-dirty">●</span>' : ""}
			<button class="ide-tab-close" data-close-path="${escapeAttr(tab.path)}" title="关闭">×</button>
		</div>`;
  }

  // 关闭全部按钮：多于1个标签才显示（why: 用户诉求一次性关闭所有打开文件）
  if (openTabs.length > 1) {
    html += `<button class="ide-tabs-close-all btn btn-xs btn-ghost" title="关闭全部文件" style="margin-left:auto;white-space:nowrap;flex-shrink:0;">×全部</button>`;
  }

  tabBarContainer.innerHTML = html;

  // 绑定标签点击事件
  tabBarContainer.querySelectorAll(".ide-editor-tab").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 排除关闭按钮点击
      if (e.target.classList.contains("ide-tab-close")) return;
      const path = el.dataset.tabPath;
      if (path && path !== activeTabPath) {
        switchToTab(path);
      }
    });

    // 中键关闭
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        const path = el.dataset.tabPath;
        if (path) closeTab(path);
      }
    });
  });

  // 绑定关闭按钮
  tabBarContainer.querySelectorAll(".ide-tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = btn.dataset.closePath;
      if (path) closeTab(path);
    });
  });

  // 绑定"关闭全部"按钮（why: 用户诉求一次性关闭所有打开文件）
  tabBarContainer
    .querySelector(".ide-tabs-close-all")
    ?.addEventListener("click", () => closeAllTabs());

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
function switchToTab(path) {
  const tab = getTab(path);
  if (!tab) return;

  // 保存当前标签状态
  saveActiveTabState();

  // 切换
  activeTabPath = path;

  // 渲染标签栏
  renderTabs();

  // 渲染编辑器内容
  renderEditor();

  // 恢复滚动和光标位置
  requestAnimationFrame(() => {
    const textarea = editorContainer?.querySelector("#file-editor-textarea");
    if (textarea) {
      textarea.scrollTop = tab.scrollTop || 0;
      textarea.scrollLeft = tab.scrollLeft || 0;
      textarea.selectionStart = tab.selectionStart || 0;
      textarea.selectionEnd = tab.selectionEnd || 0;
    }
  });

  // 更新文件树选中状态
  treeContainer?.querySelectorAll(".file-tree-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.path === path);
  });

  // 更新状态栏文件信息
  updateStatusBar(tab);
}

/**
 * 关闭标签
 * @param {string} path
 */
async function closeTab(path) {
  const tab = getTab(path);
  if (!tab) return;

  // 检查未保存
  if (tab.isDirty) {
    if (!await beiluConfirm(`文件 "${path.split("/").pop()}" 有未保存的更改，是否关闭？`))
      return;
  }

  const idx = openTabs.indexOf(tab);
  openTabs.splice(idx, 1);

  // 如果关闭的是当前活动标签，需要切换
  if (path === activeTabPath) {
    if (openTabs.length === 0) {
      activeTabPath = null;
      renderTabs();
      renderEmptyEditor();
    } else {
      // 优先选择右侧邻居，无则左侧
      const nextIdx = Math.min(idx, openTabs.length - 1);
      activeTabPath = openTabs[nextIdx].path;
      renderTabs();
      renderEditor();
      // 恢复新活动标签的滚动位置
      const newTab = openTabs[nextIdx];
      requestAnimationFrame(() => {
        const textarea = editorContainer?.querySelector(
          "#file-editor-textarea",
        );
        if (textarea) {
          textarea.scrollTop = newTab.scrollTop || 0;
          textarea.scrollLeft = newTab.scrollLeft || 0;
        }
      });
      // 更新文件树选中
      treeContainer?.querySelectorAll(".file-tree-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.path === activeTabPath);
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
  const dirtyTabs = openTabs.filter((t) => t.isDirty);
  if (dirtyTabs.length > 0) {
    const names = dirtyTabs.map((t) => t.path.split("/").pop()).join("、");
    if (
      !(await beiluConfirm(
        `有 ${dirtyTabs.length} 个文件未保存（${names}），确认全部关闭？`,
      ))
    )
      return;
  }
  openTabs = [];
  activeTabPath = null;
  renderTabs();
  renderEmptyEditor();
  // 清除文件树选中态
  treeContainer
    ?.querySelectorAll(".file-tree-item.active")
    .forEach((item) => item.classList.remove("active"));
}

/**
 * 更新 IDE 状态栏
 * @param {TabState} tab
 */
function updateStatusBar(tab) {
  const statusFile = document.getElementById("ide-status-file");
  const statusLang = document.getElementById("ide-status-lang");
  if (statusFile) statusFile.textContent = tab ? tab.path : "就绪";
  if (statusLang && tab) {
    const ext = tab.path.split(".").pop()?.toUpperCase() || "";
    statusLang.textContent = ext;
  }
}

// ============================================================
// 文件编辑器
// ============================================================

async function openFileInEditor(path) {
  // 如果已有此标签，直接切换
  if (getTab(path)) {
    switchToTab(path);
    return;
  }
  diag.debug("openFileInEditor:", path);

  try {
    // 任务B多类型预览：按种类分读取路——媒体（图/音/视频）走后端 readFileBase64 字节路（data URL），
    //   其余（含 svg：文本可编辑，看图由文本转 data URL 两全）走原 readFile 文本路。
    const _cls = classifyFile(path.split("/").pop() || "");
    const _isMedia = _cls.kind === "image" || _cls.kind === "audio" || _cls.kind === "video" || _cls.kind === "pdf";

    let _content = "";
    let _dataUrl = null;
    let _mediaSize = 0;
    if (_isMedia) {
      const result = await setFilesData({ _action: "readFileBase64", path });
      if (result?._result?.error) {
        showToast("读取失败: " + result._result.error, "error");
        return;
      }
      _dataUrl = `data:${result._result.mime};base64,${result._result.base64}`;
      _mediaSize = result._result.size || 0;
    } else if (_cls.kind === "doc") {
      // 任务C office：提取文本作只读预览内容（xlsx=CSV+公式视图 / docx=正文 / pptx=逐页文本）
      const result = await setFilesData({ _action: "readFileExtract", path });
      if (result?._result?.error) {
        showToast("读取失败: " + result._result.error, "error");
        return;
      }
      _content = result._result.text || "";
    } else {
      const result = await setFilesData({ _action: "readFile", path });
      if (result?._result?.error) {
        showToast("读取失败: " + result._result.error, "error");
        return;
      }
      // [0723 问题1.1] 文件名含敏感词→后端放行但带 warnings,前端弹 confirm 提醒(不禁止打开,002原话「给个提醒」)
      const _warns = result._result.warnings;
      if (Array.isArray(_warns) && _warns.length > 0) {
        const _ok = await beiluConfirm(`⚠ ${_warns.join("；")}\n\n仍要打开此文件吗？`);
        if (!_ok) return;
      }
      _content = result._result.content || "";
    }

    // 保存当前标签状态
    saveActiveTabState();

    // 创建新标签
    const newTab = {
      path,
      content: _content,
      isDirty: false,
      scrollTop: 0,
      scrollLeft: 0,
      selectionStart: 0,
      selectionEnd: 0,
      // 任务B：种类 + 当前视图模式 + 媒体数据（预览渲染用；不参与保存链——保存只走文本路 content）
      kind: _cls.kind,
      viewMode: _cls.defaultMode,
      dataUrl: _dataUrl,
      mediaSize: _mediaSize,
    };
    openTabs.push(newTab);
    activeTabPath = path;

    // 渲染
    renderTabs();
    renderEditor();

    // 更新文件树选中状态
    treeContainer?.querySelectorAll(".file-tree-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === path);
    });

    updateStatusBar(newTab);
  } catch (err) {
    diag.warn("openFileInEditor 失败:", path, err?.message);
    showToast("打开文件失败: " + err.message, "error");
  }
}

function renderEditor() {
  if (!editorContainer) return;
  const tab = getActiveTab();
  if (!tab) {
    renderEmptyEditor();
    return;
  }

  const fileName = tab.path.split("/").pop() || "";
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  // 任务B多类型预览：旧 tab（本次改动前打开的）无 kind 字段 → 补分类，行为向后兼容
  if (!tab.kind) {
    const _c = classifyFile(fileName);
    tab.kind = _c.kind;
    if (!tab.viewMode) tab.viewMode = _c.defaultMode;
  }
  // 可编辑=文本路种类（媒体字节路不可编辑；svg 走文本路可编辑）；可预览=binary 之外全部（code=高亮预览）
  const canEdit = tab.kind === "code" || tab.kind === "html" || tab.kind === "md" || tab.kind === "svg";
  const mode = canEdit ? (tab.viewMode === "preview" ? "preview" : "edit") : "preview";
  tab.viewMode = mode;

  // 模式切换钮：仅同时可编辑+可预览的种类显示（html/md/svg/code）；预览钮文案按种类
  const _prevLabel = tab.kind === "html" ? "▶ 运行" : '<i data-ic="eye"></i> 预览';
  const _modebar = (canEdit && tab.kind !== "binary")
    ? `<div class="flex items-center justify-end gap-1 px-2 py-0.5 bg-base-300/20 border-b border-base-300/40 shrink-0">
				<button id="file-mode-preview" class="btn btn-xs ${mode === "preview" ? "btn-warning" : "btn-ghost"}" title="预览">${_prevLabel}</button>
				<button id="file-mode-edit" class="btn btn-xs ${mode === "edit" ? "btn-warning" : "btn-ghost"}" title="编辑"><i data-ic="edit"></i> 编辑</button>
			</div>`
    : "";

  const _isBinary = tab.kind === "binary";
  editorContainer.innerHTML = `
		<div class="flex flex-col h-full">
			${_modebar}
			<!-- 编辑器内容 -->
			<div class="flex-1 overflow-auto relative">
				${
          _isBinary
            ? `
				<div class="flex items-center justify-center h-full text-base-content/50">
					<div class="text-center">
						<div class="text-4xl mb-3">${getFileIcon(fileName)}</div>
						<p class="text-sm">二进制或不可编辑文件</p>
						<p class="text-xs mt-1">${escapeHtml(fileName)}</p>
					</div>
				</div>
				`
            : mode === "edit"
              ? `
				<div class="flex h-full">
					<!-- 行号 -->
					<div id="editor-line-numbers" class="text-right pr-2 pl-2 py-2 text-[11px] font-mono text-base-content/25 bg-base-300/20 select-none shrink-0 overflow-hidden"></div>
					<!-- 编辑区 -->
					<textarea id="file-editor-textarea"
						class="flex-1 p-2 font-mono text-xs bg-transparent border-none resize-none focus:outline-none leading-[1.4em]"
						spellcheck="false"
						wrap="off">${escapeHtml(tab.content)}</textarea>
				</div>
				`
              : `<div id="file-preview-pane" class="h-full overflow-auto"><p class="text-xs text-base-content/40 text-center py-6">预览加载中...</p></div>`
        }
			</div>
			<!-- 状态栏 -->
			<div class="flex items-center justify-between px-3 py-1 bg-base-300/30 text-[10px] text-base-content/50 border-t border-base-300/50 shrink-0">
				<div class="flex items-center gap-2">
					<span id="editor-dirty-indicator" class="${tab.isDirty ? "text-warning" : ""}">${tab.isDirty ? "● 未保存" : "✓ 已保存"}</span>
					<span id="editor-cursor-pos">${mode === "edit" ? "行 1, 列 1" : "预览模式"}</span>
				</div>
				<div class="flex items-center gap-2">
					<span>${ext.toUpperCase() || "TEXT"}</span>
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
      const _ta = editorContainer?.querySelector("#file-editor-textarea");
      if (_ta) {
        _ta.scrollTop = tab.scrollTop || 0;
        _ta.scrollLeft = tab.scrollLeft || 0;
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
  const dirtyIndicator = editorContainer.querySelector(
    "#editor-dirty-indicator",
  );
  const charCount = editorContainer.querySelector("#editor-char-count");

  if (textarea && lineNumbers) {
    updateLineNumbers(textarea, lineNumbers);

    // 自动保存 debounce 定时器（闭包内，每次渲染编辑器重置）
    let autoSaveTimer = null;

    textarea.addEventListener("input", () => {
      const currentTab = getActiveTab();
      if (currentTab) {
        currentTab.isDirty = true;
        currentTab.content = textarea.value;
      }
      if (dirtyIndicator) {
        dirtyIndicator.textContent = "● 未保存";
        dirtyIndicator.className = "text-warning";
      }
      if (charCount) charCount.textContent = textarea.value.length + " 字符";
      updateLineNumbers(textarea, lineNumbers);
      updateCursorPos(textarea, cursorPos, lineNumbers); // [0723] 输入后刷新活动行高亮(行号div已重建,重新标当前行)
      // 更新标签栏 dirty 指示
      renderTabs();

      // 自动保存：读 storage 判断开关，debounce 1.5s
      if (storage.get(KEYS.BEILU_IDE_AUTO_SAVE) === "true") {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(async () => {
          const tab = getActiveTab();
          if (tab && tab.isDirty) {
            await saveCurrentFile();
            if (dirtyIndicator && !tab.isDirty) {
              dirtyIndicator.textContent = "✓ 已自动保存";
              dirtyIndicator.className = "";
            }
          }
        }, 1500);
      }
    });

    textarea.addEventListener("scroll", () => {
      if (lineNumbers) lineNumbers.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener("click", () =>
      updateCursorPos(textarea, cursorPos, lineNumbers),
    );
    textarea.addEventListener("keyup", () =>
      updateCursorPos(textarea, cursorPos, lineNumbers),
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

  // 启用顶部工具栏按钮
  const saveBtn = document.getElementById("file-save-btn");
  const reloadBtn = document.getElementById("file-reload-btn");
  if (saveBtn) saveBtn.disabled = false;
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
      pane.innerHTML = `<div class="p-4 text-sm file-md-preview">${_html}</div>`;
      break;
    }
    case "code": {
      const _ext = (tab.path.split(".").pop() || "").toLowerCase();
      const _fenced = "```" + _ext + "\n" + tab.content + "\n```";
      const _html = await renderMarkdownAsString(_fenced);
      pane.innerHTML = `<div class="p-2 text-xs file-md-preview">${_html}</div>`;
      break;
    }
    case "svg": {
      const _url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tab.content)}`;
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><img src="${_url}" class="max-w-full max-h-full" alt="${escapeAttr(tab.path)}" /></div>`;
      break;
    }
    case "image":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><img src="${tab.dataUrl}" class="max-w-full max-h-full" style="object-fit:contain" alt="${escapeAttr(tab.path)}" /></div>`;
      break;
    case "audio":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-4"><audio controls src="${tab.dataUrl}"></audio></div>`;
      break;
    case "video":
      pane.innerHTML = `<div class="flex items-center justify-center h-full p-2"><video controls src="${tab.dataUrl}" class="max-w-full max-h-full"></video></div>`;
      break;
    case "doc":
      // office 提取文本只读预览（等宽保 CSV/幻灯片文本列对齐）
      pane.innerHTML = `<pre class="p-3 text-xs font-mono whitespace-pre-wrap">${escapeHtml(tab.content)}</pre>`;
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
      pane.innerHTML = `<p class="text-xs text-base-content/40 text-center py-6">该类型暂无预览器</p>`;
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
function updateCursorPos(textarea, cursorPos, lineNumbers) {
  if (!textarea || !cursorPos) return;
  const value = textarea.value.substring(0, textarea.selectionStart);
  const line = value.split("\n").length;
  const col = value.split("\n").pop().length + 1;
  cursorPos.textContent = `行 ${line}, 列 ${col}`;
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
      if (tab) {
        if (tab.isDirty && !await beiluConfirm("有未保存的更改，确定刷新吗？")) return;
        // 强制重新加载：删除标签后重新打开
        const path = tab.path;
        const idx = openTabs.indexOf(tab);
        openTabs.splice(idx, 1);
        activeTabPath = null;
        // 重新打开（会走网络请求）
        await openFileInEditor(path);
        showToast("文件已重新加载", "info");
      }
    } catch (err) {
      console.error('[fileExplorer]', err);
      window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
    }
  });

  // 全局 Ctrl+S 拦截（当焦点不在 textarea 时也能保存）
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      if (activeTabPath && getActiveTab()) {
        e.preventDefault();
        saveCurrentFile();
      }
    }
  });
}

async function saveCurrentFile() {
  const tab = getActiveTab();
  if (!tab) return;
  // 任务B/C卫：非文本编辑 tab 禁走文本保存——否则 Ctrl+S 会把图片/音视频/office 原文件写坏
  //   （media=content 恒空写成空文件；doc=content 是提取文本非源格式，写回即毁 xlsx/docx/pptx）
  if (tab.kind === "image" || tab.kind === "audio" || tab.kind === "video" || tab.kind === "binary" || tab.kind === "doc" || tab.kind === "pdf") return;

  // 先同步 textarea 内容到 tab
  const textarea = editorContainer?.querySelector("#file-editor-textarea");
  if (textarea) {
    tab.content = textarea.value;
  }

  try {
    diag.debug("saveCurrentFile:", tab.path, "len:", tab.content?.length ?? 0);
    await setFilesData({
      _action: "writeFile",
      path: tab.path,
      content: tab.content,
    });
    tab.isDirty = false;

    const dirtyIndicator = editorContainer?.querySelector(
      "#editor-dirty-indicator",
    );
    if (dirtyIndicator) {
      dirtyIndicator.textContent = "✓ 已保存";
      dirtyIndicator.className = "";
    }
    // 更新标签栏（移除 dirty 指示）
    renderTabs();
    showToast("文件已保存", "success");
  } catch (err) {
    wbDetect("ide", "saveCurrentFile", false, err?.message);
    diag.warn("saveCurrentFile 失败:", tab.path, err?.message);
    showToast("保存失败: " + err.message, "error");
  }
}

// ============================================================
// 右键菜单
// ============================================================

function showFileContextMenu(path, isDir, event) {
  // 移除已有菜单
  document.querySelectorAll(".file-context-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className =
    "file-context-menu fixed bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 text-xs min-w-[140px]";
  menu.style.zIndex = "var(--z-popup)";
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
  //   加选项不替换剪贴板功能。插入格式=超链接式 `[📄名](路径) `（范式源 skillPicker 已 0723 随说明书库删，此处为现存唯一实现），
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
    btn.className = `block w-full text-left px-3 py-1 hover:bg-base-300/50 ${item.danger ? "text-error" : ""}`;
    // 右键菜单 label 含 data-ic 图标标签（本文件 + 前置 pass 注入的 clipboard/trash），
    //   全部为内部常量串无用户数据（无 XSS），故用 innerHTML 让图标真正渲染（原 textContent 会把 <i> 当字面文本）。
    btn.innerHTML = item.label;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.remove();
      try {
        switch (item.action) {
          case "open":
            await openFileInEditor(path);
            break;
          case "setRoot":
            await setFileExplorerRoot(path);
            showToast(`已切换到: ${path}`, "success");
            break;
          case "newFile": {
            const name = await beiluPrompt("新文件名:");
            if (!name?.trim()) return;
            const newPath = path.replace(/\/$/, "") + "/" + name.trim();
            try {
              await setFilesData({
                _action: "createFile",
                path: newPath,
                content: "",
              });
              showToast("文件已创建", "success");
              await loadFileTree(rootPath);
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
              await setFilesData({ _action: "createDir", path: newPath });
              showToast("目录已创建", "success");
              await loadFileTree(rootPath);
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
            //   取 #message-input 光标 selectionStart/End，拼超链接式 `[📄名](路径) ` 插入，
            //   focus+setSelectionRange 定位到插入尾，dispatch input 事件触发既有联动（草稿保存/高度自适应）。
            const input = document.getElementById("message-input");
            if (!input) { showToast("找不到对话框输入框", "error"); break; }
            const link = `[📄${fileName}](${path}) `;
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
              const res = await setFilesData({ _action: "rename", path, newName: newName.trim() });
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
              const rnTab = getTab(path);
              if (rnTab) { rnTab.isDirty = false; closeTab(path); }
              await loadFileTree(rootPath);
            } catch (err) {
              showToast("重命名失败: " + err.message, "error");
            }
            break;
          }
          case "delete":
            // T026: 后端 deleteFile 已改 safeTrash 进系统回收站（凛倾原话「文件级别的删除是进电脑的回收站」），文案同步
            if (!await beiluConfirm(`确定删除 "${fileName}" 吗？将移入系统回收站，可从回收站找回。`)) return;
            try {
              const _delRes = await setFilesData({ _action: "deleteFile", path });
              // setFilesData 仅 HTTP 非2xx 抛错；逻辑失败走 _result.error（200），须显式判（同 rename 模式）
              if (_delRes?._result?.error) { showToast("删除失败: " + _delRes._result.error, "error"); return; }
              showToast(`${fileName} 已移入回收站`, "success");
              // 如果该文件有标签，关闭它（不提示保存）
              const delTab = getTab(path);
              if (delTab) {
                delTab.isDirty = false; // 文件已删除，无需提示保存
                closeTab(path);
              }
              await loadFileTree(rootPath);
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
let _kickReplyTimer = null;
function _kickReplyAfterApproval() {
  clearTimeout(_kickReplyTimer);
  _kickReplyTimer = setTimeout(async () => {
    try {
      if (!currentChatId) return;
      await sendAction({ verb: "triggerReply", target: "shells:chat", source: "web", scope: { chatId: currentChatId }, payload: {} });
    } catch (err) {
      // 触发失败不吞：结果仍在池中，下次任意生成的 GetPrompt 会注入（降级为旧行为）
      console.warn("[fileExplorer] 审批后触发续轮失败:", err?.message);
    }
  }, 500);
}

async function loadPendingOps() {
  const container = treeContainer?.querySelector("#file-pending-ops");
  if (!container) return;

  try {
    const data = await getFilesData();
    // 多窗口隔离：只显示本会话(op._cid===currentChatId)+无归属的待审 op；无 chatid 时回退全量。
    //   与下方 approveAll/rejectAll 传 chatid 收口一致（显示几条 = 全部批准会处理几条）。
    const _allPending = data?.pendingOperations || [];
    const pending = currentChatId
      ? _allPending.filter((op) => op._cid === currentChatId || !op._cid)
      : _allPending;
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
          await setFilesData({ _action: "approveAll", chatid: currentChatId });
          showToast("所有操作已批准", "success");
          _kickReplyAfterApproval();
          await loadPendingOps();
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });

    container
      .querySelector("#file-reject-all")
      ?.addEventListener("click", async () => {
        try {
          await setFilesData({ _action: "rejectAll", chatid: currentChatId });
          showToast("所有操作已拒绝", "info");
          _kickReplyAfterApproval();
          await loadPendingOps();
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });

    container.querySelectorAll(".approve-op").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await setFilesData({ _action: "approveOp", opId: btn.dataset.id });
          _kickReplyAfterApproval();
          await loadPendingOps();
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });

    container.querySelectorAll(".reject-op").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await setFilesData({ _action: "rejectOp", opId: btn.dataset.id });
          _kickReplyAfterApproval();
          await loadPendingOps();
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
          await setFilesData({
            _action: "approveOp",
            opId: btn.dataset.id,
            policy: "always",
          });
          showToast("已执行，并加入总是允许", "success");
          _kickReplyAfterApproval();
          await loadPendingOps();
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
          });
          await loadPendingOps();
        } catch (err) {
          console.error('[fileExplorer]', err);
          window._reportError?.(`[fileExplorer] ${err.message}`, err.stack);
        }
      });
    });
  } catch (err) {
    wbDetect("ide", "loadPendingOps", false, err?.message);
    container.innerHTML = "";
  }
}

function renderEmptyEditor() {
  if (!editorContainer) return;

  activeTabPath = null;

  // 禁用顶部工具栏按钮
  const saveBtn = document.getElementById("file-save-btn");
  const reloadBtn = document.getElementById("file-reload-btn");
  if (saveBtn) saveBtn.disabled = true;
  if (reloadBtn) reloadBtn.disabled = true;

  // 更新状态栏
  updateStatusBar(null);

  editorContainer.innerHTML = `
		<div class="flex items-center justify-center h-full text-base-content/50">
			<div class="text-center">
				<img src="/parts/shells:beilu-chat/icons/mdi__folder-open-outline.svg" class="w-16 h-16 mx-auto mb-4 opacity-20 icon" />
				<p class="text-sm">从左侧文件树选择文件</p>
				<p class="text-xs mt-1 text-base-content/50">或使用 <i data-ic="folder-open"></i> 打开文件夹 / <i data-ic="file"></i> 打开文件</p>
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
  const results = treeContainer?.querySelector("#file-search-results");
  if (!results) return;
  results.innerHTML =
    '<p class="text-[10px] text-base-content/40 py-1">搜索中...</p>';
  try {
    // 后端 searchFiles 返回 { _result: { matches, totalFiles, searchedFiles, truncated, error? } }
    const res = await setFilesData({
      _action: "searchFiles",
      path: rootPath,
      query,
      isRegex,
      maxResults: 50,
    });
    const r = res?._result;
    if (!r || r.error) {
      results.innerHTML = `<p class="text-[10px] text-error py-1">搜索失败: ${escapeHtml(r?.error || "无返回")}</p>`;
      return;
    }
    renderSearchResults(r);
  } catch (err) {
    results.innerHTML = `<p class="text-[10px] text-error py-1">搜索失败: ${escapeHtml(err.message)}</p>`;
  }
}

/**
 * 渲染搜索结果列表，点击结果项在编辑器打开对应文件
 * @param {{matches:Array, searchedFiles:number, truncated:boolean}} r
 */
function renderSearchResults(r) {
  const results = treeContainer?.querySelector("#file-search-results");
  if (!results) return;
  const matches = r.matches || [];
  if (matches.length === 0) {
    results.innerHTML =
      `<p class="text-[10px] text-base-content/40 py-1">无匹配 (已搜 ${r.searchedFiles || 0} 文件)</p>`;
    return;
  }
  const header = `<div class="flex items-center justify-between mb-0.5">
      <span class="text-[10px] text-base-content/50">${matches.length} 处匹配${r.truncated ? " (已截断)" : ""}</span>
      <button id="file-search-clear" class="btn btn-xs btn-ghost btn-square" title="清除结果">✗</button>
    </div>`;
  const list = matches
    .map(
      (m) => `
      <div class="file-search-hit cursor-pointer hover:bg-base-300/40 rounded px-1 py-0.5" data-path="${escapeAttr(m.file)}">
        <div class="flex items-center gap-1">
          <span class="text-[10px] font-mono truncate flex-1" style="color:var(--beilu-amber)">${escapeHtml(m.file)}</span>
          <span class="text-[10px] text-base-content/40">:${m.line}</span>
        </div>
        <div class="text-[10px] font-mono text-base-content/60 truncate">${escapeHtml(m.content || "")}</div>
      </div>`,
    )
    .join("");
  results.innerHTML = `<div class="bg-base-200/40 border border-base-300/40 rounded-lg p-1 space-y-0.5 max-h-60 overflow-auto">${header}${list}</div>`;
  results
    .querySelector("#file-search-clear")
    ?.addEventListener("click", () => {
      results.innerHTML = "";
    });
  results.querySelectorAll(".file-search-hit").forEach((el) => {
    el.addEventListener("click", () => {
      const path = el.dataset.path;
      if (path) openFileInEditor(path);
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
      // getPendingErrors 返回 { hasErrors, count, errors }（非 _result 包裹）
      const probe = await setFilesData({ _action: "getPendingErrors" });
      if (!probe?.hasErrors || !probe.count) return;
      const consumed = await setFilesData({ _action: "consumePendingErrors" });
      const errs = consumed?.errors || [];
      const toast = window._beiluToast || showToast;
      if (errs.length <= 2) {
        // 少量错误逐条弹
        for (const e of errs) {
          const detail = e?.error || e?.message || e?.path || JSON.stringify(e);
          toast(`文件操作失败: ${detail}`, "error");
        }
      } else {
        // 多条错误合并弹出，避免批量红色 toast 轰炸
        const first = errs[0]?.error || errs[0]?.message || errs[0]?.path || "";
        toast(`${errs.length} 个文件操作失败（首条: ${first}）`, "error");
      }
    } catch {
      /* 轮询失败静默，下个周期重试 */
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
