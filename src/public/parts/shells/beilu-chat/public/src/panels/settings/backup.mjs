/**
 * backup.mjs — 备份管理面板 cluster
 *
 * 功能链：打开设置弹窗「备份」Tab → _initBackupPanel() 调用 _fetchConfig() 从 beilu-files 插件拉取配置
 *   → _renderPanel() 渲染三块区域：
 *     1. 对话备份（消息加载数配置，存 localStorage BEILU_MSG_LOAD_LIMIT）
 *     2. 文件版本历史（监控文件夹列表/备份策略/保留版本数，读写 beilu-files/config）
 *     3. GitHub 同步（仓库/分支/Token 配置，对话历史自动推送 GitHub）
 *   → 用户修改配置后 _setData() POST 到 /api/parts/plugins:beilu-files/config/setdata 持久化
 * why：备份功能横跨对话备份（前端 localStorage）和文件版本历史（后端 beilu-files 插件）两个层，
 *   集中在此 cluster 提供统一的配置 UI，不直接修改后端文件
 * 关联链：被 settings.mjs import（_initBackupPanel 在切到「备份」Tab 时调用）；
 *   import api-client.mjs（beilu-files 配置读写）、storage.mjs（消息加载数本地存储）、beiluDialog.mjs（输入/确认框）
 * 影响范围：改动影响对话消息加载数上限、文件监控目录管理、备份策略（自动/手动）、GitHub 同步配置
 * 使用效果：用户在「备份」Tab 添加监控文件夹后，AI 修改该目录文件前会自动保存历史版本；
 *   配置 GitHub Token 后对话历史可自动同步到指定仓库
 */
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作；beilu-files action 走 _action 通配）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { storage, KEYS } from "../../shared/state/storage.mjs";
import { DEFAULTS } from "../../config/defaults.mjs"; // P2：消息加载数缺省单源（原字面 "100" 副本）
import { setMsgLoadLimit } from "../feature/featureControls.mjs"; // T5：消息加载数唯一写点直连（含0-1000归一化），删 else 无校验直写双写点
import { currentChatId } from "../../shared/transport/endpoints.mjs";
import { getPartList } from "../../../../../../scripts/parts.mjs"; // S4(T054): 角色卡列表单源（与 sidebar/settingsSlots 同源），供数据域同步选源/目标角色
import { escapeHtml } from "../../shared/state/utils.mjs"; // T7b：escapeHtml 统一二期——收口到壳权威版（原 _esc 4 字符自实现缺单引号，S06 病）

const _esc = escapeHtml; // alias 保调用点名不变，实现走权威版（5 字符全转义含单引号）

let _initialized = false;
let _filesConfig = null;

async function _fetchConfig() {
  try {
    // 原 raw GET + resp.ok 手检；门面非 raw 直接返回解析体（!ok 由门面抛错走 catch，语义等价：失败保留旧 _filesConfig）
    _filesConfig = await sendAction({ verb: "getData", target: "plugins:beilu-files", source: "web" });
  } catch (e) { _toast("备份设置加载失败: " + (e?.message || e), "error"); /* T021 弹出：面板据旧值渲染，用户须知非最新 */ }
  return _filesConfig;
}

async function _setData(action, data = {}) {
  try {
    // 原 POST setdata {_action:action,...data} → beilu-files 通配路由 verb=action 组装 _action；门面返回解析体
    const j = await sendAction({ verb: action, target: "plugins:beilu-files", source: "web", payload: data }) || {};
    return j._result || j;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function _toast(msg, kind) {
  try { window._beiluToast?.(msg, kind || "info"); } catch { /* ignore */ }
}

function _renderPanel(slot) {
  const fh = _filesConfig?.fileHistory || {};
  const gh = _filesConfig?.github || {};
  // T6-C5: config 损坏时后端回包 fileHistory={error:...}（main.mjs GetData 兜底），如实呈现不编造 20。
  if (fh.error) _toast("备份配置读取失败(config 损坏): " + fh.error, "error");

  slot.innerHTML = `
    <!-- 对话备份 -->
    <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
      <div class="flex items-center gap-2 font-semibold text-sm">
        <i data-ic="save"></i> 对话备份
        <span class="tooltip tooltip-right" data-tip="每次保存对话时自动创建备份副本，可从备份恢复误删的对话">
          <span class="text-xs opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>
      <p class="text-xs text-base-content/50">对话保存时自动 throttle 备份，存储在 data/_chat_backups/。已内置启用，无需配置。</p>
      <div class="flex items-center gap-3 text-xs">
        <span>消息加载数:</span>
        <input type="number" id="bk-msg-load-limit" class="input input-xs input-bordered w-20 font-mono"
          min="0" max="1000" step="10" value="${parseInt(storage.get(KEYS.BEILU_MSG_LOAD_LIMIT) || String(DEFAULTS.messages.loadLimit))}" />
        <span class="tooltip tooltip-right" data-tip="初始只加载最后 N 条消息，向上滚动自动加载更多。0 = 全部加载（大对话可能卡顿）">
          <span class="opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
        <span class="text-base-content/40">(0 = 全部)</span>
      </div>
      <div class="flex items-center gap-2 text-xs mt-1">
        <button id="bk-chat-restore-btn" class="btn btn-xs btn-outline btn-warning">查看对话备份</button>
        <span class="text-base-content/40">从自动备份或删消息快照恢复</span>
      </div>
      <div id="bk-chat-restore-list" class="hidden mt-2 space-y-1 max-h-48 overflow-auto"></div>
    </div>

    <!-- 文件版本历史 -->
    <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
      <div class="flex items-center gap-2 font-semibold text-sm">
        <i data-ic="folder"></i> 文件版本历史
        <span class="tooltip tooltip-right" data-tip="AI 修改监控文件夹中的文件前，自动保存一份副本。可随时回滚到任意历史版本。">
          <span class="text-xs opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>

      <div class="text-xs space-y-1">
        <div class="font-medium">监控文件夹:</div>
        <div id="bk-watch-list" class="space-y-1">
          ${(fh.watchFolders || []).map((f, i) => `
            <div class="flex items-center gap-2 bg-base-300/40 rounded px-2 py-1">
              <span class="flex-1 font-mono text-[11px] truncate" title="${_esc(f)}">${_esc(f)}</span>
              <button class="btn btn-ghost btn-xs text-error bk-watch-del" data-idx="${i}" title="移除">✕</button>
            </div>
          `).join("") || '<span class="text-base-content/40">（未配置）</span>'}
        </div>
        <button id="bk-watch-add" class="btn btn-xs btn-ghost">+ 添加文件夹</button>
      </div>

      <div class="flex items-center gap-3 text-xs">
        <span>备份策略:</span>
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="radio" name="bk-strategy" value="auto" class="radio radio-xs radio-warning" ${fh.strategy !== "manual" ? "checked" : ""} /> AI 操作前自动
        </label>
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="radio" name="bk-strategy" value="manual" class="radio radio-xs radio-warning" ${fh.strategy === "manual" ? "checked" : ""} /> 仅手动
        </label>
        <span class="tooltip tooltip-right" data-tip="自动模式：AI 每次写文件前自动保存副本。手动模式：仅点击「立即备份」时才备份。">
          <span class="opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>

      <div class="flex items-center gap-3 text-xs">
        <span>保留版本数:</span>
        <input type="number" id="bk-max-versions" class="input input-xs input-bordered w-16 font-mono"
          min="1" max="100" step="1" placeholder="后端默认" value="${fh.maxVersions ?? ''}"
          title="每个文件保留的历史版本数；留空=config 损坏未读到，请检查后端配置" />
        <span class="tooltip tooltip-right" data-tip="每个文件保留的历史版本数。超过此数自动删除最旧版本。">
          <span class="opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>

      <button id="bk-manual-backup" class="btn btn-xs btn-primary"><i data-ic="package"></i> 立即备份全部</button>
    </div>

    <!-- GitHub 集成 -->
    <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
      <div class="flex items-center gap-2 font-semibold text-sm">
        <i data-ic="link"></i> GitHub 集成
        <span class="tooltip tooltip-right" data-tip="关联 GitHub 仓库后，可将文件变更自动推送到远程仓库，实现云端备份和版本管理。">
          <span class="text-xs opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>
      <div id="bk-github-slot">
        ${gh.linked ? `
          <div class="text-xs space-y-2">
            <div class="flex items-center gap-2">
              <span class="text-success font-semibold"><i data-ic="check"></i> 已关联</span>
              <span class="font-mono">${_esc(gh.login)} / ${_esc(gh.repo)} @ ${_esc(gh.branch)}</span>
            </div>
            ${gh.lastPush ? `<div class="text-base-content/40">上次同步: ${new Date(gh.lastPush).toLocaleString("zh-CN")}</div>` : ""}
            <div class="flex gap-2">
              <button id="bk-gh-sync" class="btn btn-xs btn-primary"><i data-ic="refresh"></i> 立即同步</button>
              <button id="bk-gh-test" class="btn btn-xs btn-ghost">测试连接</button>
              <button id="bk-gh-unlink" class="btn btn-xs btn-error btn-ghost">✕ 取消关联</button>
            </div>
          </div>
        ` : `
          <button id="bk-gh-link" class="btn btn-xs btn-primary"><i data-ic="link"></i> 关联 GitHub 账号</button>
          <p class="text-xs text-base-content/40 mt-1">需要 GitHub Personal Access Token（repo 权限）</p>
        `}
      </div>
    </div>

    <!-- 文件版本浏览 -->
    <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
      <div class="flex items-center gap-2 font-semibold text-sm">
        <i data-ic="clipboard"></i> 文件版本浏览
        <span class="tooltip tooltip-right" data-tip="查看受监控文件的历史版本，可对比差异或回滚到任意版本。">
          <span class="text-xs opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <input type="text" id="bk-version-path" class="input input-xs input-bordered flex-1 font-mono" placeholder="输入文件绝对路径..." />
        <button id="bk-version-load" class="btn btn-xs btn-ghost">查看版本</button>
      </div>
      <div id="bk-version-list" class="space-y-1"></div>
    </div>

    <!-- 角色卡数据域同步（S4/T054）：破坏性整域覆盖，后端先备份目标域到备份目录再覆盖（备份根=env BEILU_C2_BACKUP_DIR / data/_c2_backup，P0-2 已去 D:\ 硬编码，真实路径由后端 backupDir 返回并在结果处展示）-->
    <div class="bg-base-200/50 rounded-lg p-3 space-y-2">
      <div class="flex items-center gap-2 font-semibold text-sm">
        <i data-ic="shuffle"></i> 角色卡数据域同步
        <span class="tooltip tooltip-right" data-tip="把源角色卡的选定数据域（记忆/世界书等）整域覆盖到目标角色卡。覆盖前后端会先把目标域备份到备份目录，绝不静默丢数据。">
          <span class="text-xs opacity-40 cursor-help"><i data-ic="info"></i></span>
        </span>
      </div>
      <p class="text-xs text-warning/80"><i data-ic="warning"></i> 破坏性操作：目标角色卡选定域会被源角色卡整体覆盖（非合并）。执行前后端自动备份目标域到备份目录。</p>
      <div class="flex items-center gap-2 text-xs">
        <label class="opacity-60 w-10">源</label>
        <select id="cs-source" class="select select-xs select-bordered flex-1"><option value="">加载中…</option></select>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <label class="opacity-60 w-10">目标</label>
        <select id="cs-target" class="select select-xs select-bordered flex-1"><option value="">加载中…</option></select>
      </div>
      <div class="flex items-center gap-2">
        <button id="cs-list-domains" class="btn btn-xs btn-outline">列出可同步数据域</button>
        <span class="text-[10px] opacity-40">先选源/目标，再列域勾选</span>
      </div>
      <div id="cs-domains" class="space-y-1"></div>
      <button id="cs-sync" class="btn btn-xs btn-error btn-outline hidden"><i data-ic="shuffle"></i> 执行同步（覆盖目标）</button>
      <div id="cs-result" class="text-[11px] space-y-0.5"></div>
    </div>
  `;

  _bindEvents(slot);
  _bindCharSync(slot);
}

function _bindEvents(slot) {
  slot.querySelector("#bk-msg-load-limit")?.addEventListener("change", (e) => {
    // T5：唯一写点直连 featureControls.setMsgLoadLimit（归一化 0..1000+同步兄弟入口）。
    //   删原 else storage.set 直写原始串无校验=病2散写点；featureControls 已由核心链静态加载恒可用。
    setMsgLoadLimit(e.target.value);
    _toast("消息加载数已更新，下次加载对话时生效", "success");
  });

  slot.querySelector("#bk-chat-restore-btn")?.addEventListener("click", async () => {
    const listEl = slot.querySelector("#bk-chat-restore-list");
    if (!listEl) return;
    if (!currentChatId) { _toast("请先打开一个对话", "warning"); return; }
    listEl.classList.remove("hidden");
    listEl.innerHTML = '<span class="text-xs opacity-50">加载中...</span>';
    const r = await _setData("listChatBackups", { chatid: currentChatId });
    if (!r.success || !r.snapshots?.length) {
      listEl.innerHTML = '<span class="text-xs opacity-50">当前对话暂无可用备份</span>';
      return;
    }
    listEl.innerHTML = r.snapshots.map(s => {
      const d = new Date(s.mtime).toLocaleString();
      const kb = (s.size / 1024).toFixed(1);
      const reason = s.source === "auto" ? "自动备份" : s.file.includes("deleteMessage") ? "删消息" : s.file.includes("deleteRange") ? "批量删" : "快照";
      return `<div class="flex items-center gap-2 bg-base-300/40 rounded px-2 py-1 text-[11px]">
        <span class="flex-1 font-mono truncate" title="${_esc(s.file)}">${d} <span class="opacity-50">(${reason}, ${kb}KB)</span></span>
        <button class="btn btn-ghost btn-xs text-warning bk-chat-restore" data-file="${_esc(s.file)}" data-source="${s.source || "undo"}">恢复</button>
      </div>`;
    }).join("");
    listEl.querySelectorAll(".bk-chat-restore").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!await beiluConfirm("确定从此备份恢复对话？\\n当前对话会先自动快照再替换。")) return;
        const res = await _setData("restoreChatBackup", { chatid: currentChatId, file: btn.dataset.file, source: btn.dataset.source });
        if (res.success) {
          _toast(`已恢复 ${res.messageCount || "?"} 条消息，2秒后刷新`, "success");
          setTimeout(() => window.location.reload(), 2000);
        } else {
          _toast("恢复失败: " + (res.error || ""), "error");
        }
      });
    });
  });

  slot.querySelectorAll(".bk-watch-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx);
      const cfg = _filesConfig?.fileHistory || {};
      const folders = [...(cfg.watchFolders || [])];
      folders.splice(idx, 1);
      // T3：查 success（同文件 restoreChatBackup :239 范式）。失败不改后端却报成功=假成功；
      //   _renderPanel 用未变的 _filesConfig 重渲染即回滚显示态（folders 是本地副本，未写回）。
      const res = await _setData("setFileHistoryConfig", { watchFolders: folders });
      if (!res.success) { _renderPanel(slot); _toast("移除监控文件夹失败: " + (res.error || ""), "error"); return; }
      await _fetchConfig();
      _renderPanel(slot);
      _toast("已移除监控文件夹", "success");
    });
  });

  slot.querySelector("#bk-watch-add")?.addEventListener("click", async () => {
    const folder = await beiluPrompt("输入要监控的文件夹绝对路径：");
    if (!folder) return;
    const cfg = _filesConfig?.fileHistory || {};
    const folders = [...(cfg.watchFolders || []), folder.trim()];
    // T3：查 success；失败用未变的 _filesConfig 重渲染回滚显示态 + 错误可见。
    const res = await _setData("setFileHistoryConfig", { watchFolders: folders });
    if (!res.success) { _renderPanel(slot); _toast("添加监控文件夹失败: " + (res.error || ""), "error"); return; }
    await _fetchConfig();
    _renderPanel(slot);
    _toast("已添加监控文件夹", "success");
  });

  slot.querySelectorAll('input[name="bk-strategy"]').forEach(radio => {
    radio.addEventListener("change", async () => {
      // T3：查 success；失败重渲染回滚 radio 选中态（按未变的 _filesConfig.strategy 恢复）+ 错误可见。
      const res = await _setData("setFileHistoryConfig", { strategy: radio.value });
      if (!res.success) { _renderPanel(slot); _toast("备份策略切换失败: " + (res.error || ""), "error"); return; }
      _toast(`备份策略已切换为: ${radio.value === "auto" ? "AI 操作前自动" : "仅手动"}`, "success");
    });
  });

  slot.querySelector("#bk-max-versions")?.addEventListener("change", async (e) => {
    // T6-C5: 删编造副本 20。空/非法输入不提交(后端保留原值)，不写假默认。
    const val = parseInt(e.target.value, 10);
    if (!Number.isFinite(val)) { _toast("保留版本数无效，未保存", "error"); return; }
    // T3：查 success；失败重渲染回滚输入框值（按未变的 _filesConfig.maxVersions 恢复）+ 错误可见。
    const res = await _setData("setFileHistoryConfig", { maxVersions: val });
    if (!res.success) { _renderPanel(slot); _toast("保留版本数保存失败: " + (res.error || ""), "error"); return; }
    _toast(`保留版本数已更新为 ${val}`, "success");
  });

  slot.querySelector("#bk-manual-backup")?.addEventListener("click", async () => {
    _toast("正在备份...");
    const r = await _setData("manualBackup", {});
    if (r.success) _toast(`备份完成: ${r.backed || 0} 个文件`, "success");
    else _toast("备份失败: " + (r.error || "未知错误"), "error");
  });

  slot.querySelector("#bk-gh-link")?.addEventListener("click", _handleGitHubLink);

  slot.querySelector("#bk-gh-sync")?.addEventListener("click", async () => {
    _toast("正在同步到 GitHub...");
    const r = await _setData("syncToGitHub", {});
    if (r.success) {
      _toast(r.skipped ? "无变更可提交" : "已同步到 GitHub", "success");
      await _fetchConfig();
      _renderPanel(slot);
    } else _toast("同步失败: " + (r.error || ""), "error");
  });

  slot.querySelector("#bk-gh-test")?.addEventListener("click", async () => {
    const r = await _setData("testGitHubConnection", {});
    _toast(r.success ? `连接正常: ${r.login}` : "连接失败: " + (r.error || ""), r.success ? "success" : "error");
  });

  slot.querySelector("#bk-gh-unlink")?.addEventListener("click", async () => {
    if (!await beiluConfirm("确定取消 GitHub 关联？不会删除远程仓库数据。")) return;
    await _setData("unlinkGitHub", {});
    await _fetchConfig();
    _renderPanel(slot);
    _toast("已取消 GitHub 关联", "success");
  });

  slot.querySelector("#bk-version-load")?.addEventListener("click", async () => {
    const filePath = slot.querySelector("#bk-version-path")?.value?.trim();
    if (!filePath) { _toast("请输入文件路径", "error"); return; }
    const r = await _setData("getFileVersions", { path: filePath });
    _renderVersionList(slot.querySelector("#bk-version-list"), r, filePath);
  });
}

async function _handleGitHubLink() {
  const token = await beiluPrompt("输入 GitHub Personal Access Token:\n（在 GitHub → Settings → Developer settings → Personal access tokens 生成，需要 repo 权限）");
  if (!token) return;

  _toast("验证 Token...");
  const verify = await _setData("verifyGitHubToken", { token });
  if (!verify.success) { _toast("Token 验证失败: " + (verify.error || ""), "error"); return; }

  _toast(`验证成功: ${verify.login}`);
  const repos = await _setData("listGitHubRepos", { token });
  const repoOptions = repos.success && repos.repos?.length
    ? repos.repos.map(r => `${r.full_name}${r.private ? " 🔒" : ""}`).join("\n")
    : "(无法获取仓库列表)";

  const repo = await beiluPrompt(`选择仓库（输入 owner/repo 格式）:\n\n可用仓库:\n${repoOptions}`);
  if (!repo) return;

  const branch = await beiluPrompt("分支名（默认 main）:") || "main";

  _toast("正在关联...");
  const r = await _setData("linkGitHub", { token, repo: repo.replace(/ 🔒$/, "").trim(), branch: branch.trim() });
  if (r.success) {
    _toast(`已关联: ${r.login} / ${r.repo} @ ${r.branch}`, "success");
    await _fetchConfig();
    const slot = document.getElementById("settings-backup-slot");
    if (slot) _renderPanel(slot);
  } else _toast("关联失败: " + (r.error || ""), "error");
}

function _renderVersionList(container, data, filePath) {
  if (!container) return;
  if (!data?.versions?.length) {
    container.innerHTML = '<p class="text-xs text-base-content/40 py-2">该文件无历史版本</p>';
    return;
  }
  container.innerHTML = data.versions.map((v, i) => {
    const src = v.source === "manual" ? "手动" : v.source ? `AI(${v.source.slice(0, 8)})` : "手动";
    return `<div class="flex items-center gap-2 text-xs bg-base-300/30 rounded px-2 py-1">
      <span class="font-mono text-[11px] text-base-content/60">${new Date(v.timestamp).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" })}</span>
      <span class="text-warning">${_esc(v.tool || "")}</span>
      <span class="text-info text-[10px]">${src}</span>
      <span class="text-base-content/40">${v.size ? (v.size / 1024).toFixed(1) + "KB" : ""}</span>
      <span class="flex-1"></span>
      <button class="btn btn-ghost btn-xs bk-v-diff" data-ts="${_esc(v.timestamp)}" data-chatid="${_esc(v.source === "manual" ? "" : (v.source || ""))}" title="与当前版本对比">对比</button>
      <button class="btn btn-ghost btn-xs text-warning bk-v-revert" data-ts="${_esc(v.timestamp)}" data-chatid="${_esc(v.source === "manual" ? "" : (v.source || ""))}" title="回滚到此版本">↩ 回滚</button>
    </div>`;
  }).join("");

  container.querySelectorAll(".bk-v-diff").forEach(btn => {
    btn.addEventListener("click", async () => {
      const r = await _setData("getFileDiff", { path: filePath, ts1: btn.dataset.ts, ts2: "current", chatid: btn.dataset.chatid || undefined });
      if (r.success) {
        const diffHtml = r.diff.map(d =>
          `<span style="color:${d.type === "add" ? "var(--beilu-success)" : d.type === "del" ? "var(--beilu-error)" : "inherit"};display:block;">${d.type === "add" ? "+" : d.type === "del" ? "-" : " "}${_esc(d.content)}</span>`
        ).join("");
        container.insertAdjacentHTML("beforeend",
          `<div class="bg-base-300/60 rounded p-2 mt-1 font-mono text-[11px] max-h-48 overflow-auto whitespace-pre">${diffHtml || "(无差异)"}</div>`
        );
      } else _toast("对比失败: " + (r.error || ""), "error");
    });
  });

  container.querySelectorAll(".bk-v-revert").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!await beiluConfirm("确定回滚到此版本？\n当前文件会先自动备份。")) return;
      const r = await _setData("revertFileVersion", { path: filePath, timestamp: btn.dataset.ts, chatid: btn.dataset.chatid || undefined });
      if (r.success) _toast("已回滚到 " + btn.dataset.ts, "success");
      else _toast("回滚失败: " + (r.error || ""), "error");
    });
  });
}

// ============================================================
// S4(T054) 角色卡数据域同步 —— 走 beilu-memory（listSyncDomains/syncCharDomains），
//   非本面板的 _setData（那是 beilu-files）。username 由桥 session 盖章（后端 :1635/:1665 读 data.username），
//   前端不传 username。破坏性：执行前 beiluConfirm 二次确认，成功后显示后端返回的真实备份路径（backupDir，非 D 盘硬编码）。
// ============================================================
async function _memAction(verb, payload = {}) {
  try {
    return await sendAction({ verb, target: "plugins:beilu-memory", source: "web", payload }) || {};
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

function _bindCharSync(slot) {
  const srcSel = slot.querySelector("#cs-source");
  const tgtSel = slot.querySelector("#cs-target");
  const domainsBox = slot.querySelector("#cs-domains");
  const syncBtn = slot.querySelector("#cs-sync");
  const resultBox = slot.querySelector("#cs-result");
  if (!srcSel || !tgtSel) return;

  // 填充角色卡下拉（getPartList 单源，排除 _global——后端不允许 _global 作角色同步）
  (async () => {
    try {
      const chars = (await getPartList("chars")) || [];
      const opts = ['<option value="">（选择角色卡）</option>']
        .concat(chars.filter((c) => c && c !== "_global").map((c) => `<option value="${_esc(c)}">${_esc(c)}</option>`))
        .join("");
      srcSel.innerHTML = opts;
      tgtSel.innerHTML = opts;
    } catch (e) {
      srcSel.innerHTML = tgtSel.innerHTML = '<option value="">加载失败</option>';
      _toast("角色卡列表加载失败: " + (e?.message || e), "error");
    }
  })();

  // 列出可同步数据域（listSyncDomains 返回 domains + 源/目标存在性探测）
  slot.querySelector("#cs-list-domains")?.addEventListener("click", async () => {
    const source = srcSel.value, target = tgtSel.value;
    if (!source || !target) { _toast("请先选择源和目标角色卡", "warning"); return; }
    if (source === target) { _toast("源与目标不能相同", "warning"); return; }
    domainsBox.innerHTML = '<span class="text-xs opacity-50">加载数据域…</span>';
    syncBtn.classList.add("hidden");
    resultBox.innerHTML = "";
    const r = await _memAction("listSyncDomains", { sourceChar: source, targetChar: target });
    if (!r.success || !Array.isArray(r.domains)) {
      domainsBox.innerHTML = `<span class="text-xs text-error">列域失败${r.error ? "：" + _esc(r.error) : ""}</span>`;
      return;
    }
    const sp = r.sourcePresence || {}, tp = r.targetPresence || {};
    domainsBox.innerHTML = r.domains.map((d) => {
      const srcHas = sp[d.key] ? "✓源有" : "✗源无";
      const tgtHas = tp[d.key] ? '<i data-ic="warning"></i>目标有(将被覆盖)' : "目标空";
      const srcCls = sp[d.key] ? "text-success" : "text-error";
      return `<label class="flex items-center gap-2 text-[11px] cursor-pointer">
        <input type="checkbox" class="checkbox checkbox-xs checkbox-warning cs-dom" data-key="${_esc(d.key)}" ${sp[d.key] ? "" : "disabled"} />
        <span class="flex-1">${_esc(d.label || d.key)} <span class="opacity-40 font-mono">${_esc(d.type || "")}</span></span>
        <span class="${srcCls}">${srcHas}</span>
        <span class="text-warning/70">${tgtHas}</span>
      </label>`;
    }).join("");
    // 至少一个源存在的域才显示同步按钮
    if (r.domains.some((d) => sp[d.key])) syncBtn.classList.remove("hidden");
    else domainsBox.insertAdjacentHTML("beforeend", '<div class="text-[11px] text-error mt-1">源角色卡无任何可同步数据域</div>');
  });

  // 执行同步（破坏性，二次确认 + 显示后端返回的真实备份路径 backupDir）
  syncBtn?.addEventListener("click", async () => {
    const source = srcSel.value, target = tgtSel.value;
    const domains = Array.from(domainsBox.querySelectorAll(".cs-dom:checked")).map((cb) => cb.dataset.key);
    if (!source || !target) { _toast("请先选择源和目标角色卡", "warning"); return; }
    if (domains.length === 0) { _toast("请勾选至少一个数据域", "warning"); return; }
    if (!await beiluConfirm(
      `确定把角色卡「${source}」的 ${domains.length} 个数据域整域覆盖到「${target}」？\n\n` +
      `目标角色卡这些域的现有内容将被覆盖（非合并）。执行前后端会先把目标域备份到备份目录。`
    )) return;
    syncBtn.disabled = true;
    resultBox.innerHTML = '<span class="text-xs opacity-50">同步中…</span>';
    const r = await _memAction("syncCharDomains", { sourceChar: source, targetChar: target, domains });
    syncBtn.disabled = false;
    if (!r.success) {
      resultBox.innerHTML = `<span class="text-xs text-error">同步失败${r.error ? "：" + _esc(r.error) : ""}</span>`;
      return;
    }
    const rows = (r.results || []).map((res) => {
      const ok = res.success ? '<span class="text-success">✓</span>' : '<span class="text-error">✗</span>';
      const bk = res.backupDir ? `<span class="opacity-50 font-mono text-[10px]" title="${_esc(res.backupDir)}">已备份→${_esc(res.backupDir)}</span>` : '<span class="opacity-40">（目标域空，无需备份）</span>';
      const err = res.error ? `<span class="text-error">${_esc(res.error)}</span>` : "";
      return `<div class="flex items-center gap-2">${ok}<span>${_esc(res.domain)}</span><span class="opacity-50">copied:${res.copied ?? 0}</span>${bk}${err}</div>`;
    }).join("");
    resultBox.innerHTML = `<div class="text-success text-xs mb-1">${_esc(r.message || "同步完成")}</div>${rows}`;
    _toast(r.message || "同步完成", "success");
  });
}

export async function _initBackupPanel() {
  const slot = document.getElementById("settings-backup-slot");
  if (!slot) return;

  await _fetchConfig();
  if (!_initialized) {
    _initialized = true;
    _renderPanel(slot);
  } else {
    _renderPanel(slot);
  }
}
