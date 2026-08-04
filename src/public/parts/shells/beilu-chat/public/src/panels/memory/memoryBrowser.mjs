/**
 * memoryBrowser.mjs — 记忆文件浏览器（侧边栏文件树 + 文件内容查看/编辑）
 *
 * 功能链：
 *   initMemoryBrowser(username, charId, treeEl, viewerEl)
 *     → POST beilu-memory setdata {_action:"listMemoryDir", username, charId, path}
 *     → 渲染 hot/warm/cold/code/work 分层目录树（带活跃/近期/已归档标签徽章）
 *     → 点目录 → 展开/折叠（_expandedPaths Set 记忆展开态）
 *     → 点文件 → POST {_action:"readMemoryFile"} → JSON 格式化显示内容 → 可编辑
 *     → 点「保存」→ POST {_action:"writeMemoryFile"} → 后端写盘
 *   以 _ 开头的配置文件和 .bak 备份文件默认隐藏（shouldHideFile）
 *
 * T053（code 专用管理操作）：
 *   现状=通用 listMemoryFiles/readMemoryFile 已能浏览+查看 code 层（⌨），但 code 专用 CRUD 前端零入口。
 *   本任务在 code 目录节点下注入 code 操作栏（正则内容搜索 + 建夹/导入/导出），
 *   并在 code/active 下文件节点补「删除/移动」操作按钮。全部走后端 code 专用 verb（作用域限 code/active，含越界守卫）：
 *     searchCodeFiles{query,useRegex} / deleteCodeFile{filePath} / moveCodeFile{sourceFile,targetFolder}
 *     / createCodeFolder{folderName} / exportCodeMemory{} / importCodeMemory{zipBase64}
 *   去重（与通用 verb 对盘）：浏览/列目录仍走通用 listMemoryFiles（不接 listCodeFiles，避免重复通道）；
 *     searchCodeFiles(正则内容搜索) / import-export(zip 打包) 是通用 verb 无的真差集；
 *     delete/move/mkdir 是通用 verb 无对应写操作的真差集。copyToCodeMemory(从外部路径复制入)
 *     无前端"源文件绝对路径"来源，前端暂不接（后端 verb 保留）。
 *   破坏性操作(删除/导入覆盖)前 beiluConfirm 二次确认，越界守卫在后端(:2689 等)，前端不放松。
 *
 * why（记忆分层可见性）：
 *   hot = 活跃记忆（会被检索注入对话）；warm = 近期（按需召回）；cold = 已归档（不主动注入）。
 *   分层标签让用户一眼看出哪些文件会影响 AI 行为，而非全部混排。
 *   _ 开头的配置文件（_config.json 等）隐藏，防止用户误编辑系统配置。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（beilu-memory 所有 REST 调用统一出口）
 *   → shared/widgets/whitebox.mjs wbDetect（读写失败时 whitebox 上报）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm（删除文件二次确认）
 *   ← memoryPresetChat.mjs（点「文件树」按钮时展开侧边栏调用 initMemoryBrowser）
 *   ← layout.mjs（记忆 Tab 初始化时挂载）
 *
 * 影响范围：
 *   #mem-tree-container（左栏文件树）、#mem-viewer-container（右栏内容查看/编辑区）；
 *   _expandedPaths 内存 Set（会话内记住展开态，刷新后重置）。
 *
 * 使用效果：
 *   点 hot/warm/cold 目录展开文件列表；点 JSON 文件 → 右栏格式化展示，可直接编辑后保存；
 *   标签徽章（活跃/近期/已归档）直观说明该层记忆的注入行为。
 */

import { escapeHtml, downloadUrl } from "../../shared/state/utils.mjs"; // 0716 下载基元收口
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b批7：出向统一门面（verb=真动作），beilu-memory setdata 文件树/归档收口（失败可见由门面 _report 承担，原 wbDetect 读写上报去除）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { getUsername } from "../../shared/state/sharedState.mjs"; // [合并批 0714] username 读点单源（非 authority，仅本地重绑去重键）
// [D6 §1 2026-08-04] 会话身份代际：所有异步树/文件结果写 UI 前过 epoch 守卫（同 origin 换用户时
//   旧用户在飞响应不渲染进新用户界面，白盒动线 B）；身份权威=服务端 /api/whoami，前端零 username 生产。
import { ensureSessionIdentity, getSessionEpoch, isEpochCurrent } from "../../shared/state/sessionIdentity.mjs";

// ===== 状态 =====
let _username = "";
let _charId = "";
let _treeContainer = null;
let _viewerContainer = null;
let _expandedPaths = new Set();
let _selectedFilePath = "";

// [D6 §1] 换用户即清 user-scoped 易失 UI 态（树/选中/展开），不清设备级偏好。
//   首次建立身份（previousUsername===null 且非失效）不清——那是同一用户的初始化，清了会打断首屏渲染。
window.addEventListener("beilu:session-epoch-changed", (e) => {
  const d = e?.detail || {};
  if (d.previousUsername == null && d.username != null) return; // 首次建立，非换用户
  _charId = "";
  _username = "";
  _selectedFilePath = "";
  _expandedPaths.clear();
  if (_treeContainer) {
    _treeContainer.innerHTML = '<div class="mb-empty-dir" style="padding:1rem;">等待角色卡绑定...</div>';
  }
  if (_viewerContainer) _viewerContainer.innerHTML = "";
});

// ===== 图标映射 =====
// getFileIcon 三处消费(721/822/974)均 innerHTML → 可放 <i>；语义色用 class 保住原 emoji 颜色暗示
const LAYER_ICONS = {
  hot: '<i data-ic="fire" class="text-error"></i>',
  warm: '<i data-ic="weather"></i>',
  cold: '<i data-ic="snowflake" class="text-info"></i>',
  code: "⌨", // 键盘符号，无映射保留
  work: "☰", // 三横符号，无映射保留
};

const FILE_ICONS = {
  "tables.json": '<i data-ic="chart"></i>',
  "code_tables.json": '<i data-ic="chart"></i>',
  "_config.json": '<i data-ic="settings"></i>',
  "_code_config.json": '<i data-ic="settings"></i>',
  "_memory_presets.json": '<i data-ic="puzzle"></i>',
  "forever.json": '<i data-ic="star"></i>',
  "appointments.json": '<i data-ic="calendar"></i>',
  "user_profile.json": '<i data-ic="person"></i>',
  "items_archive.json": '<i data-ic="backpack"></i>',
  "warm_monthly_index.json": '<i data-ic="card"></i>',
  "cold_yearly_index.json": '<i data-ic="card"></i>',
  "_index.md": '<i data-ic="clipboard"></i>',
};

/**
 * 判断文件是否应该在文件树中隐藏
 * 隐藏规则：以 _ 开头的配置文件、.bak 备份文件
 */
function shouldHideFile(name) {
  return name.startsWith("_") || name.endsWith(".bak");
}

/**
 * T037：格式化文件字节数为人类可读（B/KB/MB）。原树节点/查看器各自内联同一表达式，抽出统一。
 */
function formatSize(size) {
  if (typeof size !== "number" || size < 0) return "";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  if (size > 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${size}B`;
}

/**
 * T037：把后端返回的 ISO mtime 格式化为相对时间（刚刚/N分钟前/N小时前/昨天/N天前/绝对日期）。
 * why：记忆文件"更新时间"是凛倾"记忆文件查看"诉求的元信息之一（大小/更新时间/属于哪层）；
 *   相对时间比裸 ISO 串更易读，超 7 天回退到 本地日期 YYYY-MM-DD，避免"3000天前"这类噪声。
 * @param {string} iso - stat.mtime.toISOString()，可能缺省（后端 stat 失败返 null）
 * @returns {string} 空串表示无时间信息（调用方据此不渲染时间节点）
 */
function formatMtime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "昨天";
  if (diffDay < 7) return `${diffDay}天前`;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getFileIcon(name, isDir) {
  if (isDir) {
    if (LAYER_ICONS[name]) return LAYER_ICONS[name];
    return '<i data-ic="folder-open"></i>';
  }
  if (FILE_ICONS[name]) return FILE_ICONS[name];
  if (name.endsWith(".json")) return '<i data-ic="file"></i>';
  if (name.endsWith(".bak")) return '<i data-ic="save"></i>';
  return '<i data-ic="edit"></i>';
}

function getLayerBadge(dirPath) {
  // R5 认知清晰（合并 v4）：hot/warm/cold 用人话 + hover 说明，让用户看懂"哪些会注入对话"
  if (dirPath === "hot") return '<span class="mb-badge mb-badge-hot" title="活跃记忆 · 会被检索注入对话">活跃</span>';
  if (dirPath === "warm")
    return '<span class="mb-badge mb-badge-warm" title="近期记忆 · 按需召回">近期</span>';
  if (dirPath === "cold")
    return '<span class="mb-badge mb-badge-cold" title="已归档 · 不主动注入，可检索">已归档</span>';
  if (dirPath === "code")
    return '<span class="mb-badge mb-badge-code">编程</span>';
  if (dirPath === "work")
    return '<span class="mb-badge mb-badge-work">工作</span>';
  return "";
}

// ===== API 调用 =====

// T6b批7：4 处 beilu-memory setdata 由 raw fetch（手检 res.ok + 自 .json()）→ sendAction 门面。
//   verb=真动作，payload 平铺（username/charName/…）由 beilu-memory#* 通配组装 {_action:verb,...payload}。
//   原 URL 上的 ?username=&char_id= query 与 body 内的 username/charName 冗余——后端 setDataActions
//   `charName = data.charName || args?.char_id`（handler/setDataActions.mjs:711）以 body 为先，
//   门面无 query 时后端从 body 取到同值，行为等价。!ok 由门面统一抛错（替代原 `if(!res.ok) throw`）。

async function listFiles(subPath = "") {
  return sendAction({
    verb: "listMemoryFiles",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, subPath },
  });
}

async function readFile(filePath) {
  return sendAction({
    verb: "readMemoryFile",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, filePath },
  });
}

async function writeFile(filePath, content) {
  return sendAction({
    verb: "writeMemoryFile",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, filePath, content },
  });
}

/**
 * 调用归档类动作（setdata，走门面 beilu-memory#* 通配）
 * @param {string} action - _action 名（archiveTempMemory / endDay / ...）
 * @param {object} extra - 额外 body 字段
 */
async function callArchiveAction(action, extra = {}) {
  return sendAction({
    verb: action,
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, ...extra },
  });
}

// ===== T053：code 专用管理 verb 调用（走同一 beilu-memory#* 通配桥；payload 镜像 listFiles 结构）=====
// 后端 handler：setDataActions.mjs switch(data._action)，charName=data.charName||args.char_id、
//   username 由桥 session 盖章（args.username 覆盖 data.username，SEC-T1）——与 listMemoryFiles 同链。
//   作用域限 memory/code/active（listCodeFiles 除外，均 path.resolve().startsWith 越界守卫）。

/** 正则/关键词搜索 code/active 下 .md 内容 → {success, results:[{file, matches:[{match,line,position}]}], query} */
async function codeSearch(query, useRegex = false) {
  return sendAction({
    verb: "searchCodeFiles",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, query, useRegex },
  });
}

/** 删除 code/active 下文件/空目录（后端 safeUnlink 带回收）→ {success} */
async function codeDelete(filePath) {
  return sendAction({
    verb: "deleteCodeFile",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, filePath },
  });
}

/** 移动 code/active 下文件到子目录（targetFolder 空=移回根 active）→ {success} */
async function codeMove(sourceFile, targetFolder) {
  return sendAction({
    verb: "moveCodeFile",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, sourceFile, targetFolder },
  });
}

/** 在 code/active 下建子目录（后端非法字符会替换为 _）→ {success, folderName} */
async function codeMkdir(folderName) {
  return sendAction({
    verb: "createCodeFolder",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, folderName },
  });
}

/** 导出整个 code 目录为 zip → {success, zipBase64, fileName, fileCount} */
async function codeExport() {
  return sendAction({
    verb: "exportCodeMemory",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId },
  });
}

/** 导入 zip 到记忆目录（后端对已存在文件先 .import_bak 备份，非静默覆盖）→ {success, imported, skipped, errors?} */
async function codeImport(zipBase64) {
  return sendAction({
    verb: "importCodeMemory",
    target: "plugins:beilu-memory",
    source: "web",
    payload: { charName: _charId, zipBase64 },
  });
}

// ===== Toast 提示 =====
// [D1 收口 0713] 纯桥壳：window._beiluToast（index.mjs main 启动挂载，先于任何用户交互）→
//   scripts/toast.mjs 单源。原本地手绘 DOM 降级分支运行期不可达=死代码+第二套 toast UI，纯删除。
// [0716 参数序修复] 权威签名 showToast(type, message, duration)（toast.mjs:144），D1 收口时转发
//   写成 (message, type)=类型串被当消息显示、消息文本被当类型。本地签名保持 (message, type) 兼容
//   本文件全部调用点，仅转发按权威序对齐。
function showToast(message, type = "info") {
  window._beiluToast?.(type, message);
}

// ===== 归档操作配置（按钮元数据，统一渲染 + 统一处理） =====

const ARCHIVE_ACTIONS = [
  {
    action: "archiveTempMemory",
    label: "📦 归档临时记忆",
    confirm: "确定要归档临时记忆吗？",
  },
  {
    action: "endDay",
    label: "🌙 结束当天(归档)",
    confirm: "确定要结束当天并触发当日归档吗？",
  },
  {
    action: "archiveHotToWarm",
    label: "🔥→🌤 Hot 转 Warm",
    confirm: "确定要把 Hot 层记忆归档到 Warm 层吗？",
    successMsg: (r) =>
      `Hot→Warm 完成：remember ${r?.remember_archived ?? 0} 条，forever ${r?.forever_archived ?? 0} 条`,
  },
  {
    action: "archiveWarmToCold",
    label: "🌤→❄ Warm 转 Cold",
    confirm: "确定要把 Warm 层记忆归档到 Cold 层吗？",
  },
  {
    action: "archiveCompletedTasks",
    label: "✅ 归档已完成任务",
    confirm: "确定要归档已完成任务吗？",
    // 不传 rowIndices：触发后端自判（扫 table3 行内 ✅/已完成 等完成标记）。
    successMsg: (r) =>
      r?.archived > 0
        ? `已归档 ${r.archived} 个已完成任务`
        : `未发现已完成任务（扫描 ${r?.scanned ?? 0} 行；请先在任务表中用 ✅/已完成 标记完成项）`,
  },
];

/**
 * 执行一个归档动作：confirm → 调用 → toast → 刷新文件树
 * @param {object} cfg - ARCHIVE_ACTIONS 元素
 * @param {HTMLButtonElement} btn
 */
async function runArchiveAction(cfg, btn) {
  if (!_charId) {
    showToast("未绑定角色卡，无法归档", "warning");
    return;
  }
  if (!await beiluConfirm(cfg.confirm)) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "处理中...";
  try {
    const result = await callArchiveAction(cfg.action, cfg.extra || {});
    if (!result.success) throw new Error(result.error || "归档失败");

    const msg = cfg.successMsg
      ? cfg.successMsg(result)
      : `${cfg.label} 完成`;
    showToast(msg, "success");

    // 刷新文件树
    await renderFileTree();
  } catch (err) {
    console.error(`[memoryBrowser] 归档动作 ${cfg.action} 失败:`, err);
    showToast(`${cfg.label} 失败: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/**
 * 渲染「归档操作」工具栏（一组按钮）
 */
function createArchiveToolbar() {
  const bar = document.createElement("div");
  bar.className = "mb-archive-toolbar";
  bar.style.cssText =
    "display:flex;flex-wrap:wrap;gap:0.25rem;padding:0.4rem 0.25rem;border-bottom:1px solid var(--mb-border,rgba(128,128,128,0.2));";

  const title = document.createElement("div");
  title.textContent = "归档操作";
  title.style.cssText =
    "width:100%;font-size:0.7rem;opacity:0.6;margin-bottom:0.2rem;";
  bar.appendChild(title);

  for (const cfg of ARCHIVE_ACTIONS) {
    const btn = document.createElement("button");
    btn.className = "dt-btn dt-btn-sm";
    btn.textContent = cfg.label;
    btn.title = cfg.confirm;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      runArchiveAction(cfg, btn);
    });
    bar.appendChild(btn);
  }

  return bar;
}

// ===== T053：code 层专用操作栏（搜索 + 建夹/导入/导出）=====

const CODE_ACTIVE_PREFIX = "code/active/";

/**
 * 剥掉 code/active/ 前缀，得到后端 code verb 期望的相对路径（相对 code/active）。
 * memoryBrowser 树的 filePath 相对 memDir（如 code/active/foo.md），后端 deleteCodeFile/moveCodeFile
 * 的 filePath/sourceFile 相对 code/active（setDataActions deleteCodeFile:_fullPath=path.join(_activeDir,filePath)）。
 * @returns {string|null} 相对 active 的路径；非 code/active 下返回 null（不该出现 code 操作按钮）
 */
function toActiveRelPath(filePath) {
  if (typeof filePath !== "string") return null;
  if (filePath === "code/active") return "";
  if (filePath.startsWith(CODE_ACTIVE_PREFIX)) return filePath.slice(CODE_ACTIVE_PREFIX.length);
  return null;
}

/**
 * 触发浏览器下载一个 base64 内容的文件（导出 zip 用）。
 * why：exportCodeMemory 返回 zipBase64，前端无文件系统写权限，用 data URL + a[download] 让用户存盘。
 */
// 0716 轮子收口：下载基元 → utils.downloadUrl 单源（本地签名保留，调用点零改）
function downloadBase64(base64, fileName, mime = "application/zip") {
  downloadUrl(`data:${mime};base64,${base64}`, fileName || "download.zip");
}

/**
 * 读取用户选中的 .zip 文件为 base64（去掉 data URL 头）。
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 渲染搜索结果列表（点击结果=定位并打开该文件）。
 * @param {HTMLElement} resultEl - 结果容器
 * @param {Array} results - searchCodeFiles 返回的 results（[{file, matches:[{match,line,position}]}]）
 */
function renderCodeSearchResults(resultEl, results) {
  resultEl.innerHTML = "";
  if (!results || results.length === 0) {
    resultEl.innerHTML = '<div style="font-size:0.7rem;opacity:0.55;padding:0.3rem 0.25rem;">无匹配</div>';
    return;
  }
  for (const r of results) {
    const item = document.createElement("div");
    item.style.cssText = "padding:0.25rem;border-bottom:1px solid var(--mb-border,rgba(128,128,128,0.15));cursor:pointer;";
    const matchLines = (r.matches || [])
      .map((m) => `<div style="opacity:0.7;font-size:0.68rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.line || m.match || "")}</div>`)
      .join("");
    item.innerHTML = `<div style="font-size:0.72rem;font-weight:600;"><i data-ic="edit"></i> ${escapeHtml(r.file)}</div>${matchLines}`;
    // 点结果 → 定位到 code/active 下该文件并打开查看器（filePath 相对 memDir）
    item.addEventListener("click", () => {
      const fullPath = CODE_ACTIVE_PREFIX + r.file;
      selectFile(fullPath, _treeContainer.querySelector(`[data-path="${fullPath}"]`));
    });
    resultEl.appendChild(item);
  }
}

/**
 * 渲染 code 层专用操作栏：内容搜索框（searchCodeFiles）+ 建夹/导入/导出按钮。
 * 挂在 code 目录节点展开区顶部（createDirNode dirPath==="code" 时插入）。
 * @param {Function} refresh - 操作成功后刷新树的回调
 */
function createCodeToolbar(refresh) {
  const bar = document.createElement("div");
  bar.className = "mb-code-toolbar";
  bar.style.cssText =
    "padding:0.35rem 0.25rem;border-bottom:1px solid var(--mb-border,rgba(128,128,128,0.2));";
  // 点工具栏内部不冒泡到 code 目录 header（避免误折叠）
  bar.addEventListener("click", (e) => e.stopPropagation());

  const title = document.createElement("div");
  title.textContent = "编程记忆操作";
  title.style.cssText = "font-size:0.7rem;opacity:0.6;margin-bottom:0.25rem;";
  bar.appendChild(title);

  // --- 搜索行 ---
  const searchRow = document.createElement("div");
  searchRow.style.cssText = "display:flex;gap:0.25rem;align-items:center;margin-bottom:0.25rem;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "搜索 code 内容…";
  input.className = "input input-xs";
  input.style.cssText = "flex:1;min-width:0;font-size:0.72rem;";
  const regexLabel = document.createElement("label");
  regexLabel.style.cssText = "display:flex;align-items:center;gap:0.15rem;font-size:0.68rem;opacity:0.75;white-space:nowrap;";
  const regexBox = document.createElement("input");
  regexBox.type = "checkbox";
  regexBox.style.cssText = "width:0.8rem;height:0.8rem;";
  regexLabel.appendChild(regexBox);
  regexLabel.appendChild(document.createTextNode("正则"));
  const searchBtn = document.createElement("button");
  searchBtn.className = "dt-btn dt-btn-sm";
  searchBtn.innerHTML = '<i data-ic="search"></i>';
  searchBtn.title = "搜索 code/active 下 .md 内容";
  searchRow.appendChild(input);
  searchRow.appendChild(regexLabel);
  searchRow.appendChild(searchBtn);
  bar.appendChild(searchRow);

  const resultEl = document.createElement("div");
  resultEl.className = "mb-code-search-results";
  resultEl.style.cssText = "max-height:180px;overflow-y:auto;margin-bottom:0.3rem;";
  bar.appendChild(resultEl);

  async function runSearch() {
    if (searchBtn.disabled) return; // 0714 时序扫尾：Enter 路径原绕过按钮 disabled 锁=搜索中可并发重入
    const query = input.value.trim();
    if (!query) {
      resultEl.innerHTML = "";
      return;
    }
    resultEl.innerHTML = '<div style="font-size:0.7rem;opacity:0.55;padding:0.3rem 0.25rem;">搜索中…</div>';
    searchBtn.disabled = true;
    try {
      const res = await codeSearch(query, regexBox.checked);
      if (!res.success) throw new Error(res.error || "搜索失败");
      renderCodeSearchResults(resultEl, res.results);
    } catch (err) {
      resultEl.innerHTML = `<div style="font-size:0.7rem;color:var(--beilu-error);padding:0.3rem 0.25rem;"><i data-ic="cross"></i> ${escapeHtml(err.message)}</div>`;
    } finally {
      searchBtn.disabled = false;
    }
  }
  searchBtn.addEventListener("click", runSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });

  // --- 操作按钮行 ---
  const actionRow = document.createElement("div");
  actionRow.style.cssText = "display:flex;flex-wrap:wrap;gap:0.25rem;";

  // 建子目录
  const mkdirBtn = document.createElement("button");
  mkdirBtn.className = "dt-btn dt-btn-sm";
  mkdirBtn.innerHTML = '<i data-ic="folder"></i> 新建目录';
  mkdirBtn.addEventListener("click", async () => {
    const name = await beiluPrompt("新建 code 子目录名（会归档到 code/active 下）", "");
    if (name === null) return;
    const trimmed = String(name).trim();
    if (!trimmed) return;
    mkdirBtn.disabled = true;
    try {
      const r = await codeMkdir(trimmed);
      if (!r.success) throw new Error(r.error || "建目录失败");
      showToast(`已创建目录 ${r.folderName}`, "success");
      await refresh();
    } catch (err) {
      showToast(`建目录失败: ${err.message}`, "error");
    } finally {
      mkdirBtn.disabled = false;
    }
  });

  // 导出
  const exportBtn = document.createElement("button");
  exportBtn.className = "dt-btn dt-btn-sm";
  exportBtn.textContent = "⬇ 导出";
  exportBtn.title = "导出整个 code 记忆为 zip";
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    const orig = exportBtn.textContent;
    exportBtn.textContent = "导出中…";
    try {
      const r = await codeExport();
      if (!r.success) throw new Error(r.error || "导出失败");
      downloadBase64(r.zipBase64, r.fileName);
      showToast(`已导出 ${r.fileCount} 个文件`, "success");
    } catch (err) {
      showToast(`导出失败: ${err.message}`, "error");
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = orig;
    }
  });

  // 导入（隐藏 file input 触发）
  const importBtn = document.createElement("button");
  importBtn.className = "dt-btn dt-btn-sm";
  importBtn.textContent = "⬆ 导入";
  importBtn.title = "从 zip 导入 code 记忆（同名文件后端自动 .import_bak 备份）";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".zip";
  fileInput.style.display = "none";
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ""; // 允许重复选同一文件
    if (!file) return;
    // 破坏性提示：导入会写入记忆目录，同名文件后端备份为 .import_bak（不静默盖），此处明示
    if (!await beiluConfirm(`导入「${file.name}」到 code 记忆？同名文件会被覆盖（后端自动备份为 .import_bak）。`)) return;
    importBtn.disabled = true;
    try {
      const base64 = await readFileAsBase64(file);
      const r = await codeImport(base64);
      if (!r.success) throw new Error(r.error || "导入失败");
      const errNote = r.errors && r.errors.length ? `，${r.skipped} 项跳过` : "";
      showToast(`已导入 ${r.imported} 个文件${errNote}`, r.errors && r.errors.length ? "warning" : "success");
      await refresh();
    } catch (err) {
      showToast(`导入失败: ${err.message}`, "error");
    } finally {
      importBtn.disabled = false;
    }
  });

  actionRow.appendChild(mkdirBtn);
  actionRow.appendChild(exportBtn);
  actionRow.appendChild(importBtn);
  actionRow.appendChild(fileInput);
  bar.appendChild(actionRow);

  return bar;
}

// ===== 文件树渲染 =====

/**
 * 渲染文件树根节点
 */
async function renderFileTree() {
  if (!_treeContainer || !_charId) return;

  _treeContainer.innerHTML = `
		<div class="mb-loading">
			<span class="mb-spinner"></span> 加载中...
		</div>
	`;

  try {
    // [D6 §1] 先确立会话身份代际再发树请求；await 回来后 epoch 不匹配=期间换过用户，
    //   本次结果整体丢弃（listener 已清树，不能再往新用户界面里画旧用户的目录）。
    const _epoch = (await ensureSessionIdentity()).epoch;
    const data = await listFiles("");
    if (!isEpochCurrent(_epoch)) return;
    if (!data.success) throw new Error(data.error || "加载失败");

    _treeContainer.innerHTML = "";

    // 根节点
    const rootEl = document.createElement("div");
    rootEl.className = "mb-tree-root";

    // 根目录标题
    const rootHeader = document.createElement("div");
    rootHeader.className = "mb-tree-item mb-tree-root-header";
    rootHeader.innerHTML = `
			<span class="mb-tree-icon"><i data-ic="brain"></i></span>
			<span class="mb-tree-label">${escapeHtml(_charId)}</span>
			<button class="mb-refresh-btn" title="刷新"><i data-ic="refresh"></i></button>
		`;
    rootHeader
      .querySelector(".mb-refresh-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        renderFileTree();
      });
    rootEl.appendChild(rootHeader);

    // R5 认知图例（合并 v4）：一句话讲清三层含义，配合徽章人话，让用户看懂"哪些会注入对话"。
    // 纯 JS + 内联 style，不碰 index.css 巨石；复用 getLayerBadge 同款徽章。
    const legendEl = document.createElement("div");
    legendEl.style.cssText = "font-size:11px;opacity:.65;padding:5px 10px 8px;line-height:1.9;";
    legendEl.innerHTML = `${getLayerBadge("hot")}会注入对话　${getLayerBadge("warm")}按需召回　${getLayerBadge("cold")}不主动注入`;
    rootEl.appendChild(legendEl);

    // 归档操作工具栏（手动归档按钮组）
    rootEl.appendChild(createArchiveToolbar());

    // 子目录 + 文件
    const childrenEl = document.createElement("div");
    childrenEl.className = "mb-tree-children";

    // 先渲染目录（按 hot > warm > cold > code > 其他 排序）
    const sortedDirs = [...data.dirs].sort((a, b) => {
      const order = { hot: 0, warm: 1, cold: 2, code: 3, work: 4 };
      return (order[a.name] ?? 99) - (order[b.name] ?? 99);
    });

    for (const dir of sortedDirs) {
      const dirEl = await createDirNode(dir.name, dir.path);
      childrenEl.appendChild(dirEl);
    }

    // 渲染根目录文件（过滤掉配置文件和备份文件）
    for (const file of data.files) {
      if (shouldHideFile(file.name)) continue;
      const fileEl = createFileNode(file.name, file.path, file.size, file.mtime);
      childrenEl.appendChild(fileEl);
    }

    rootEl.appendChild(childrenEl);
    _treeContainer.appendChild(rootEl);
  } catch (err) {
    console.error("[memoryBrowser] 加载文件树失败:", err);
    _treeContainer.innerHTML = `
			<div class="mb-error">
				<span>❌ ${err.message}</span>
				<button class="mb-retry-btn">重试</button>
			</div>
		`;
    _treeContainer.querySelector(".mb-retry-btn")?.addEventListener("click", () => renderFileTree());
  }
}

/**
 * 创建目录节点
 */
async function createDirNode(name, dirPath) {
  const el = document.createElement("div");
  el.className = "mb-tree-dir";

  const header = document.createElement("div");
  header.className = "mb-tree-item mb-tree-dir-header";
  header.dataset.path = dirPath;

  const isExpanded = _expandedPaths.has(dirPath);
  const icon = getFileIcon(name, true);
  const badge = getLayerBadge(name);

  header.innerHTML = `
		<span class="mb-tree-arrow ${isExpanded ? "mb-expanded" : ""}">▶</span>
		<span class="mb-tree-icon">${icon}</span>
		<span class="mb-tree-label">${escapeHtml(name)}/</span>
		${badge}
	`;

  const childrenEl = document.createElement("div");
  childrenEl.className = "mb-tree-children";
  childrenEl.style.display = isExpanded ? "" : "none";

  header.addEventListener("click", async () => {
    const wasExpanded = _expandedPaths.has(dirPath);
    if (wasExpanded) {
      _expandedPaths.delete(dirPath);
      childrenEl.style.display = "none";
      header.querySelector(".mb-tree-arrow").classList.remove("mb-expanded");
    } else {
      _expandedPaths.add(dirPath);
      childrenEl.style.display = "";
      header.querySelector(".mb-tree-arrow").classList.add("mb-expanded");

      // 懒加载子目录内容
      if (childrenEl.children.length === 0) {
        childrenEl.innerHTML = '<div class="mb-loading-sm">加载中...</div>';
        try {
          const _epoch = getSessionEpoch(); // [D6 §1] 在飞结果 epoch 守卫
          const data = await listFiles(dirPath);
          if (!isEpochCurrent(_epoch)) return;
          childrenEl.innerHTML = "";

          // T053：code 层展开时先挂 code 专用操作栏（搜索/建夹/导入/导出），即使 code 下暂空也可导入/建夹。
          if (dirPath === "code") {
            childrenEl.appendChild(createCodeToolbar(renderFileTree));
          }

          if (data.dirs.length === 0 && data.files.length === 0) {
            if (dirPath !== "code") {
              childrenEl.innerHTML = '<div class="mb-empty-dir">(空目录)</div>';
            } else {
              const emptyEl = document.createElement("div");
              emptyEl.className = "mb-empty-dir";
              emptyEl.textContent = "(空目录)";
              childrenEl.appendChild(emptyEl);
            }
            return;
          }

          for (const subDir of data.dirs) {
            const subDirEl = await createDirNode(subDir.name, subDir.path);
            childrenEl.appendChild(subDirEl);
          }
          for (const file of data.files) {
            if (shouldHideFile(file.name)) continue;
            const fileEl = createFileNode(file.name, file.path, file.size, file.mtime);
            childrenEl.appendChild(fileEl);
          }
        } catch (err) {
          childrenEl.innerHTML = `<div class="mb-error-sm"><i data-ic="cross"></i> ${err.message}</div>`;
        }
      }
    }
  });

  el.appendChild(header);
  el.appendChild(childrenEl);

  // 如果已展开，立即加载内容
  if (isExpanded) {
    try {
      const _epoch = getSessionEpoch(); // [D6 §1] 在飞结果 epoch 守卫
      const data = await listFiles(dirPath);
      if (!isEpochCurrent(_epoch)) return el;
      // T053：code 层默认展开时同样先挂 code 专用操作栏（与懒加载分支一致）。
      if (dirPath === "code") {
        childrenEl.appendChild(createCodeToolbar(renderFileTree));
      }
      for (const subDir of data.dirs) {
        const subDirEl = await createDirNode(subDir.name, subDir.path);
        childrenEl.appendChild(subDirEl);
      }
      for (const file of data.files) {
        if (shouldHideFile(file.name)) continue;
        const fileEl = createFileNode(file.name, file.path, file.size, file.mtime);
        childrenEl.appendChild(fileEl);
      }
    } catch {
      /* ignore */
    }
  }

  return el;
}

/**
 * 创建文件节点
 */
function createFileNode(name, filePath, size, mtime) {
  const el = document.createElement("div");
  el.className = "mb-tree-item mb-tree-file";
  el.dataset.path = filePath;

  const icon = getFileIcon(name, false);
  const sizeStr = formatSize(size);
  // T037：树节点右侧补「更新时间」相对串（后端 listMemoryFiles:1434 已返 mtime；缺省则不渲染时间节点，不占位）。
  const mtimeStr = formatMtime(mtime);

  el.innerHTML = `
		<span class="mb-tree-icon">${icon}</span>
		<span class="mb-tree-label">${escapeHtml(name)}</span>
		${mtimeStr ? `<span class="mb-tree-mtime" title="更新时间">${escapeHtml(mtimeStr)}</span>` : ""}
		<span class="mb-tree-size">${sizeStr}</span>
	`;

  if (_selectedFilePath === filePath) {
    el.classList.add("mb-tree-selected");
  }

  el.addEventListener("click", () => selectFile(filePath, el));

  // T053：code/active 下的文件节点补「移动/删除」操作按钮（真差集，通用 verb 无对应写操作）。
  //   toActiveRelPath 得到相对 code/active 的路径（后端 deleteCodeFile/moveCodeFile 期望该形状）。
  const activeRel = toActiveRelPath(filePath);
  if (activeRel !== null && activeRel !== "") {
    el.appendChild(createCodeFileActions(activeRel, name));
  }

  return el;
}

/**
 * T053：为 code/active 下文件生成「移动/删除」小操作按钮组。
 * @param {string} activeRel - 相对 code/active 的文件路径（deleteCodeFile.filePath / moveCodeFile.sourceFile）
 * @param {string} name - 文件名（用于确认文案）
 */
function createCodeFileActions(activeRel, name) {
  const wrap = document.createElement("span");
  wrap.className = "mb-code-file-actions";
  wrap.style.cssText = "margin-left:auto;display:inline-flex;gap:0.15rem;";

  // 移动到子目录
  const moveBtn = document.createElement("button");
  moveBtn.className = "dt-btn dt-btn-sm";
  moveBtn.textContent = "↔";
  moveBtn.title = "移动到 code 子目录";
  moveBtn.style.cssText = "padding:0 0.3rem;font-size:0.7rem;";
  moveBtn.addEventListener("click", async (e) => {
    e.stopPropagation(); // 不触发文件节点的 selectFile
    const folder = await beiluPrompt(
      `把「${name}」移动到 code/active 下哪个子目录？（留空=移回根目录）`,
      "",
    );
    if (folder === null) return; // 取消
    moveBtn.disabled = true;
    try {
      const r = await codeMove(activeRel, String(folder).trim());
      if (!r.success) throw new Error(r.error || "移动失败");
      showToast("已移动", "success");
      await renderFileTree();
    } catch (err) {
      showToast(`移动失败: ${err.message}`, "error");
    } finally {
      moveBtn.disabled = false;
    }
  });

  // 删除（二次确认；后端 safeUnlink 带回收）
  const delBtn = document.createElement("button");
  delBtn.className = "dt-btn dt-btn-sm";
  delBtn.innerHTML = '<i data-ic="trash"></i>';
  delBtn.title = "删除该 code 文件";
  delBtn.style.cssText = "padding:0 0.3rem;font-size:0.7rem;";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!await beiluConfirm(`确定删除 code 文件「${name}」？（后端带回收）`)) return;
    delBtn.disabled = true;
    try {
      const r = await codeDelete(activeRel);
      if (!r.success) throw new Error(r.error || "删除失败");
      showToast("已删除", "success");
      await renderFileTree();
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    } finally {
      delBtn.disabled = false;
    }
  });

  wrap.appendChild(moveBtn);
  wrap.appendChild(delBtn);
  return wrap;
}

// ===== 文件内容查看 =====

/**
 * 选中文件并显示内容
 */
async function selectFile(filePath, treeEl) {
  _selectedFilePath = filePath;

  // 更新文件树选中状态
  _treeContainer.querySelectorAll(".mb-tree-selected").forEach((el) => {
    el.classList.remove("mb-tree-selected");
  });
  treeEl?.classList.add("mb-tree-selected");

  if (!_viewerContainer) return;

  _viewerContainer.style.display = "";

  _viewerContainer.innerHTML = `
		<div class="mb-viewer-loading">
			<span class="mb-spinner"></span> 读取中...
		</div>
	`;

  try {
    const _epoch = getSessionEpoch(); // [D6 §1] 在飞结果 epoch 守卫
    const data = await readFile(filePath);
    if (!isEpochCurrent(_epoch)) return;
    if (!data.success) throw new Error(data.error || "读取失败");

    renderFileViewer(filePath, data);
  } catch (err) {
    _viewerContainer.innerHTML = `
			<div class="mb-viewer-error">
				<span><i data-ic="cross"></i> 读取失败: ${err.message}</span>
			</div>
		`;
  }
}

/**
 * 渲染文件内容查看器
 */
function renderFileViewer(filePath, data) {
  const fileName = filePath.split("/").pop();
  const sizeStr = formatSize(data.size);
  // T037：右栏查看器补「更新时间」元信息（后端 readMemoryFile 与 listMemoryFiles 对称返 mtime）。缺省不渲染时间节点。
  const mtimeStr = formatMtime(data.mtime);

  let contentHtml = "";
  if (data.isJson && data.parsed !== null) {
    // JSON 文件 — 格式化展示
    contentHtml = `<pre class="mb-json-content">${escapeHtml(JSON.stringify(data.parsed, null, 2))}</pre>`;
  } else {
    // 纯文本
    contentHtml = `<pre class="mb-text-content">${escapeHtml(data.content)}</pre>`;
  }

  _viewerContainer.innerHTML = `
		<div class="mb-viewer">
			<!-- 文件头 -->
			<div class="mb-viewer-header">
				<div class="mb-viewer-path">
					<span class="mb-viewer-icon">${getFileIcon(fileName, false)}</span>
					<span class="mb-viewer-filepath">${escapeHtml(filePath)}</span>
					${mtimeStr ? `<span class="mb-viewer-mtime" title="更新时间"><i data-ic="clock"></i> ${escapeHtml(mtimeStr)}</span>` : ""}
					<span class="mb-viewer-size">${sizeStr}</span>
				</div>
				<div class="mb-viewer-actions">
					<button class="dt-btn dt-btn-sm" id="mb-edit-btn"><i data-ic="edit"></i> 编辑</button>
					<button class="dt-btn dt-btn-sm" id="mb-copy-btn">复制</button>
				</div>
			</div>
			<!-- 文件内容 -->
			<div class="mb-viewer-body">
				${contentHtml}
			</div>
			<!-- 编辑区（默认隐藏） -->
			<div class="mb-editor-area" style="display:none;">
				<textarea class="mb-editor-textarea" id="mb-editor-textarea">${escapeHtml(data.isJson ? JSON.stringify(data.parsed, null, "\t") : data.content)}</textarea>
				<div class="mb-editor-footer">
					<button class="dt-btn dt-btn-sm dt-btn-primary" id="mb-save-btn"><i data-ic="save"></i> 保存</button>
					<button class="dt-btn dt-btn-sm" id="mb-cancel-btn">取消</button>
				</div>
			</div>
		</div>
	`;

  // 绑定事件
  const editBtn = _viewerContainer.querySelector("#mb-edit-btn");
  const copyBtn = _viewerContainer.querySelector("#mb-copy-btn");
  const saveBtn = _viewerContainer.querySelector("#mb-save-btn");
  const cancelBtn = _viewerContainer.querySelector("#mb-cancel-btn");
  const editorArea = _viewerContainer.querySelector(".mb-editor-area");
  const viewerBody = _viewerContainer.querySelector(".mb-viewer-body");
  const textarea = _viewerContainer.querySelector("#mb-editor-textarea");

  editBtn?.addEventListener("click", () => {
    viewerBody.style.display = "none";
    editorArea.style.display = "";
    editBtn.style.display = "none";
    textarea.focus();
  });

  copyBtn?.addEventListener("click", () => {
    const text = data.isJson
      ? JSON.stringify(data.parsed, null, 2)
      : data.content;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        copyBtn.innerHTML = '<i data-ic="check"></i> 已复制';
        setTimeout(() => {
          copyBtn.textContent = "复制";
        }, 1500);
      })
      .catch(() => {
        copyBtn.innerHTML = '<i data-ic="cross"></i> 失败';
        setTimeout(() => {
          copyBtn.textContent = "复制";
        }, 1500);
      });
  });

  cancelBtn?.addEventListener("click", () => {
    editorArea.style.display = "none";
    viewerBody.style.display = "";
    editBtn.style.display = "";
    // 恢复原始内容
    textarea.value = data.isJson
      ? JSON.stringify(data.parsed, null, "\t")
      : data.content;
  });

  saveBtn?.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中...";

    try {
      let content = textarea.value;
      // 尝试 JSON 解析（如果是 JSON 文件）
      if (data.isJson) {
        try {
          content = JSON.parse(content);
        } catch {
          // 不是合法 JSON，作为字符串保存
        }
      }

      const _epoch = getSessionEpoch(); // [D6 §1] 写回执 epoch 守卫（写已到后端，只拦 UI 回渲染）
      const result = await writeFile(filePath, content);
      if (!isEpochCurrent(_epoch)) return;
      if (!result.success) throw new Error(result.error);

      // 重新加载文件内容
      await selectFile(
        filePath,
        _treeContainer.querySelector(`[data-path="${filePath}"]`),
      );
    } catch (err) {
      saveBtn.textContent = `❌ ${err.message}`;
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i data-ic="save"></i> 保存';
      }, 2000);
    }
  });
}

// ===== 工具函数 =====

// ===== 公开接口 =====

/**
 * 初始化记忆文件浏览器
 * @param {HTMLElement} treeContainer - 文件树渲染容器
 * @param {HTMLElement} viewerContainer - 文件内容查看器容器（可选，默认用 dataTable 区域）
 * @param {object} options - { charId, username }
 */
export async function initMemoryBrowser(
  treeContainer,
  viewerContainer,
  options = {},
) {
  if (!treeContainer) return;

  _treeContainer = treeContainer;
  _viewerContainer = viewerContainer;

  if (options.charId) {
    _charId = options.charId;
    // [0804 身份单源] 原 `options.username || "_default"`：前端无 username 生产者（getUsername 的
    //   meta/window 源不存在）→ 恒冻结 "_default" 进 payload → 后端 E_IDENTITY_MISMATCH 确定性拒绝
    //   （E 现场「payload username 与认证身份不一致」实证）。现 payload 已零身份字段（10 处删除），
    //   服务端一律用认证 context.user；本地 _username 只作重绑去重键，空即空不再兜底伪身份。
    _username = options.username || "";
    await renderFileTree();
  } else {
    treeContainer.innerHTML =
      '<div class="mb-empty-dir" style="padding:1rem;">等待角色卡绑定...</div>';
  }

  console.log(
    "[memoryBrowser] 初始化完成",
    options.charId ? `(${options.charId})` : "",
  );
}

/**
 * 绑定到新角色卡并刷新文件树
 * @param {string} charId
 * @param {string} [username]
 */
export async function bindMemoryBrowserToChar(charId, username) {
  if (!_treeContainer) return;
  const resolvedUser = username || getUsername() || ""; // [0804 身份单源] "_default" 兜底删除（伪身份源）；此值仅作本地重绑去重键，不进 payload——服务端一律用认证身份
  if (charId === _charId && resolvedUser === _username) return;

  try {
    _charId = charId;
    _username = resolvedUser;
    _selectedFilePath = "";
    _expandedPaths.clear();

    // 默认展开 hot 目录
    _expandedPaths.add("hot");

    await renderFileTree();
  } catch (err) {
    console.error("[memoryBrowser] bindMemoryBrowserToChar 失败:", err);
    if (_treeContainer) {
      _treeContainer.innerHTML = `<div class="mb-error"><span>绑定失败: ${err.message}</span></div>`;
    }
  }
}
