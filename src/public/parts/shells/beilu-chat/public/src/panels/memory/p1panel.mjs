/**
 * [p1panel.mjs] — P1 自驱动召回前端 3 面板（2026-07-31 002后期任务"画圈的地方增加前端3个"）
 *
 * 功能链：
 *   mem-activity-bar 按钮(data-mem-panel=p1run/p1vocab/p1p9) → memtool._lazyLoadMemTool 分支
 *     → 本文件 loadP1RunPanel / loadP1VocabPanel / loadP1P9Panel
 *     → sendAction(plugins:beilu-p1-selfdriven 通配) → shells:p1 薄壳代理 → Python 服务
 *       p1_server.py 同名路由（0731 P1 独立服务化：旧 Deno 插件已退役，见 sendAction.mjs:171-180）
 *   参数控件全部由服务 getData.meta 单源下发渲染（0722 禁前端硬编码：min/max/desc 权威在后端）。
 *   快速测试直调服务 runP1（recallOnly 管线，不经宿主对话流、不注入、不触发主 AI）。
 *
 * why：P1 此前只有后端，运行状态/参数/词库全部黑盒。002 指令做运行展示+
 *   参数微调+快速测试+词库管理+P9 维护三模块，收口在记忆 Tab 活动栏（截图红圈位置）。
 *
 * 影响范围：仅新增面板；不改对话流/注入链。服务未启用时快速测试如实显示"未启用"，不静默。
 * 关联链：← memtool.mjs(_lazyLoadMemTool) ← index.html(#mem-activity-bar 三新钮 + 三 .mem-tool-view)
 *   → sendAction.mjs(plugins:beilu-p1-selfdriven 通配+getData 注册段)
 *   → shells/p1/service/p1_server.py（runP1/updateConfig/getStats/listVocabs/atSearch/*UserVocab/
 *     *P9Prompts/getRunLogInfo/getRunLog）
 *   → 用户插拔词库消费方 = 服务 pipeline/p1_pool.py mode:user 子路由（热更新）
 *
 * [0731 真机验收二次返工·002骂点] "子模式是什么你照着搬运一下就行啊,预设那边也可以搬运过来" +
 *   "做个复制按钮会死啊" + "抄代码做个放大功能会死啊" + "点击不了,查了不了" + 三次返工终版
 *   "把这两个恶心的垃圾给我删除...仿照code的子模式做前端,也就是完整的编辑前端"：
 *   P9 面板=就地完整编辑区（loadP1P9Panel）：①子模式实体区照 companion.mjs 陪伴单实体范式
 *   （getSubModes/saveSubModes 单源，参数只写 model_params 蛇形键=getPromptHandler 每轮生效载体；
 *   绑定/解绑当前对话走 setActiveSubMode active_sub_modes_map 链）；②提示词区就地编辑绑定预设条目
 *   （getDataForPreset / updatePresetConfig update_entry 等，与预设面板 settings/panels.mjs 同一契约），
 *   零跳转；放大编辑复用全局 expandEditor.mjs（data-expandable/expand-btn 挂法，MutationObserver
 *   自动接管，零额外接线）；复制按钮写剪贴板（clipboard 写法同 companion.mjs:514-517）。
 *   预设本体入默认预设（beilu-preset/defaults/P9词库维护.json + registry bucket:"p9" 独立分类，
 *   惰性播种同步新用户；提示词正文=用户域，默认件留白）。
 *   词库表格行加可点击浏览（atBrowse 只读路由，复用 atSearch 同款 mtime 缓存）。
 *   运行记录卡片（0731 002"每次输出都需要进行文件记录"）：服务 p1_server.py _append_run_log
 *   按天落盘 JSONL（打字联想轻量路不记），前端 getRunLogInfo/getRunLog 展示记录文件位置+点击打开分页浏览。
 */
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { applyParamSchemaToInputs, setParamSchema, setEnumSchema } from "../../shared/state/paramSchemaCache.mjs"; // 限值/枚举后端单源（同 companion/subModePanel 范式）
import { getPartList } from "../../../../../../scripts/parts.mjs"; // 快速测试角色卡下拉单源（同 lineManager/backup.mjs 范式，0731 002"这个需要绑定角色卡啊,不去切换角色卡怎么测试?"）

const _P1 = "plugins:beilu-p1-selfdriven";

// [0801] P1 服务进程探测: GET /health 无鉴权无数据,只判在不在——在了才加载面板数据,不在显示离线态不爆红
async function _p1ProbeService() {
  try {
    const r = await fetch("/api/parts/shells:p1/health", { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}
const _esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ═══════════════════ 面板1：运行 / 测试 ═══════════════════

export async function loadP1RunPanel(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3" id="p1run-root">
    <div class="card bg-base-200/40 p-3" id="p1run-status"><span class="opacity-50">状态加载中...</span></div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🚦 各模式 P1 开关 <span class="opacity-50 font-normal">（自驱动=本地召回管线；AI P1=大模型检索降级路。写入用户覆盖层，下一轮对话生效；与上方"启用 P1 召回"是两层：这里是模式级路由，上面是插件级总闸）</span></div>
      <div id="p1run-modeov" class="text-[11px]"><span class="opacity-50">加载中...</span></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">⚡ 快速测试 <span class="opacity-50 font-normal">（直调召回管线，不注入对话）</span></div>
      <div class="flex gap-2 items-center mb-2 flex-wrap">
        <select id="p1run-test-mode" class="select select-xs select-bordered" title="召回模式"><option>chat</option><option>code</option><option>work</option><option>airp</option></select>
        <select id="p1run-test-char" class="select select-xs select-bordered max-w-40" title="记忆按角色卡隔离：选哪张卡就测哪张卡的记忆池"><option value="">（加载角色卡...）</option></select>
        <select id="p1run-test-chat" class="select select-xs select-bordered max-w-48" title="可选：带上某个对话文件的最近消息作为上下文（更接近真实召回场景）"><option value="">不带对话历史</option></select>
        <input id="p1run-test-input" type="text" class="input input-xs input-bordered flex-1 min-w-40" placeholder="输入一句话，立即查看 P1 召回结果" />
        <button id="p1run-test-btn" class="btn btn-xs btn-primary">运行召回</button>
      </div>
      <div id="p1run-test-out" class="text-[11px] leading-relaxed"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📝 运行记录 <span class="opacity-50 font-normal">（每次召回输出自动落盘 JSONL；打字联想不记录）</span></div>
      <div id="p1run-log-info" class="text-[11px] mb-1 flex flex-wrap gap-1 items-center"><span class="opacity-50">加载中...</span></div>
      <div id="p1run-log-files" class="flex flex-wrap gap-1 mb-1"></div>
      <div id="p1run-log-entries" class="text-[11px]"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🎛️ 参数微调 <span class="opacity-50 font-normal">（meta 单源下发；保存即写盘，下次召回生效）</span></div>
      <div id="p1run-params" class="grid grid-cols-2 md:grid-cols-3 gap-2"><span class="opacity-50">加载中...</span></div>
      <div class="mt-2 flex gap-2"><button id="p1run-save" class="btn btn-xs btn-primary">保存参数</button><span id="p1run-save-msg" class="opacity-60"></span></div>
    </div>
  </div>`;
  container.querySelector("#p1run-test-btn").addEventListener("click", () => _p1QuickTest(container));
  container.querySelector("#p1run-test-input").addEventListener("keydown", (e) => { if (e.key === "Enter") _p1QuickTest(container); });
  container.querySelector("#p1run-save").addEventListener("click", () => _p1SaveParams(container));
  container.querySelector("#p1run-test-char").addEventListener("change", () => _p1FillChatSelect(container));
  _p1FillTestSelectors(container); // 角色卡/对话文件下拉填充（异步不阻塞面板首屏）
  // [0801] 先探测 P1 服务进程是否在线再加载数据（凛倾："检测进程，而不是按时间提醒"）
  // 服务没起时 getData/getRunLogInfo 必爆红；探测 health 只需 GET 无鉴权无数据，失败=离线态显示，不爆红
  const _online = await _p1ProbeService();
  if (_online) {
    _p1RefreshRunLog(container);
    await _p1RefreshRun(container);
  } else {
    const box = container.querySelector("#p1run-status");
    if (box) box.innerHTML = `<span class="opacity-50">P1 召回服务未运行</span> <button class="btn btn-xs btn-ghost" id="p1run-probe-retry">检测服务</button>`;
    box?.querySelector("#p1run-probe-retry")?.addEventListener("click", async () => {
      box.innerHTML = '<span class="opacity-50">检测中...</span>';
      if (await _p1ProbeService()) { _p1RefreshRunLog(container); await _p1RefreshRun(container); }
      else box.innerHTML = '<span class="opacity-50">P1 服务仍未运行（手动启动后点击重试）</span> <button class="btn btn-xs btn-ghost" onclick="this.parentElement.querySelector(\'#p1run-probe-retry\')?.click()">重试</button>';
    });
    const _offMsg = '<span class="opacity-40">服务未运行，启动后点击上方「检测服务」</span>';
    const _modeOv = container.querySelector("#p1run-modeov"); if (_modeOv) _modeOv.innerHTML = _offMsg;
    const _logInfo = container.querySelector("#p1run-log-info"); if (_logInfo) _logInfo.innerHTML = _offMsg;
    const _params = container.querySelector("#p1run-params"); if (_params) _params.innerHTML = _offMsg;
  }
}

// ── 运行记录卡片（0731 002"每次输出都需要进行文件记录...前端加上记录文件位置,点击打开"）──
// 记录文件位置由后端 getRunLogInfo 单源下发（前端禁硬编码路径）；点击路径=打开最新记录文件，
// 点击文件名=打开该文件（卡片内分页浏览，最新在前，getRunLog 尾页读取）；复制按钮写剪贴板。
async function _p1RefreshRunLog(container) {
  const info = container.querySelector("#p1run-log-info");
  const filesBox = container.querySelector("#p1run-log-files");
  if (!info || !filesBox) return;
  try {
    const r = await sendAction({ verb: "getRunLogInfo", target: _P1, source: "web" });
    if (!r?.success) { _p1RunLogError(container, info, r?.error || "读取失败"); return; }
    const latest = r.files?.[0]?.file || "";
    info.innerHTML = `
      <span class="opacity-60">记录位置:</span>
      <a class="link link-hover break-all cursor-pointer" id="p1run-log-path" title="${latest ? "点击打开最新记录文件" : "暂无记录文件"}">${_esc(r.dir)}</a>
      <button class="btn btn-xs btn-ghost" id="p1run-log-copy" title="复制记录目录路径">复制</button>
      <span class="badge badge-sm ${r.enabled ? "badge-success" : "badge-ghost"}">${r.enabled ? "记录中" : "已关闭"}</span>
      <span class="opacity-50">保留 ${Number(r.keepDays) === 0 ? "永久" : `${r.keepDays} 天`}</span>`;
    info.querySelector("#p1run-log-copy")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(r.dir); window._beiluToast?.("记录路径已复制", "success"); }
      catch (e) { window._beiluToast?.(`复制失败: ${e?.message || e}`, "error"); }
    });
    info.querySelector("#p1run-log-path")?.addEventListener("click", () => { if (latest) _p1OpenRunLog(container, latest, 0); });
    filesBox.innerHTML = (r.files || []).map((f) =>
      `<button class="btn btn-xs btn-ghost" data-runlogfile="${_esc(f.file)}" title="${_esc(f.file)}">${_esc(f.file.slice(8, 18))} <span class="opacity-50">(${(f.size / 1024).toFixed(1)}KB)</span></button>`).join("")
      || '<span class="opacity-50">暂无记录文件（有召回运行后自动生成）</span>';
    filesBox.querySelectorAll("[data-runlogfile]").forEach((btn) => btn.addEventListener("click", () => _p1OpenRunLog(container, btn.dataset.runlogfile, 0)));
  } catch (e) { _p1RunLogError(container, info, e?.message || e); }
}

// 失败态带重试按钮：P1 服务是独立进程+薄壳自愈拉起（shells/p1 main.mjs ensureServiceRunning），
// 首次访问常撞冷启动窗口（503 后几秒服务就绪）——重试一下就通，不该逼用户整页刷新。
function _p1RunLogError(container, info, msg) {
  info.innerHTML = `<span class="text-error">运行记录读取失败: ${_esc(msg)}</span> <button class="btn btn-xs btn-ghost" id="p1run-log-retry">重试</button>`;
  info.querySelector("#p1run-log-retry")?.addEventListener("click", () => _p1RefreshRunLog(container));
}

async function _p1OpenRunLog(container, file, offset) {
  const box = container.querySelector("#p1run-log-entries");
  if (!box) return;
  box.innerHTML = '<span class="opacity-50">加载记录中...</span>';
  try {
    const r = await sendAction({ verb: "getRunLog", target: _P1, source: "web", payload: { file, offset } });
    if (!r?.success) { box.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    const srcLabel = { bridge: "对话", "panel-test": "面板测试" };
    box.innerHTML = `<div class="font-bold mb-1">${_esc(file)} <span class="opacity-50 font-normal">（共 ${r.total} 条，最新在前，第 ${r.total ? r.offset + 1 : 0}-${Math.min(r.offset + r.limit, r.total)} 条）</span></div>` +
      (r.entries.map((en) => en.broken
        ? `<div class="bg-base-100/60 rounded px-2 py-1 mb-1 text-warning">损坏行: ${_esc(en.raw)}</div>`
        : `<div class="bg-base-100/60 rounded px-2 py-1 mb-1">
            <div class="flex flex-wrap gap-1">
              <span class="badge badge-xs badge-ghost">${_esc(en.at ? new Date(en.at).toLocaleString() : "?")}</span>
              <span class="badge badge-xs badge-ghost">${_esc(srcLabel[en.source] || en.source || "?")}</span>
              <span class="badge badge-xs badge-ghost">${_esc(en.mode || "?")}</span>
              ${en.char ? `<span class="badge badge-xs badge-ghost">${_esc(en.char)}</span>` : ""}
              <span class="badge badge-xs badge-ghost">${_esc(en.ms)}ms</span>
              ${en.success ? "" : '<span class="badge badge-xs badge-error">失败</span>'}
            </div>
            <div class="opacity-70 mt-0.5">输入: ${_esc(String(en.input || "").slice(0, 120)) || "—"}</div>
            ${en.success
              ? `<div class="mt-0.5"><b>方向词:</b> ${_esc((en.p1_act || []).slice(0, 30).join(" · ")) || "—"}</div>` +
                ((en.recalledRecords || []).length
                  ? `<div class="mt-0.5"><b>召回记忆 ${en.recalledRecords.length} 条:</b></div>` +
                    en.recalledRecords.map((rr) => `<div class="opacity-70 pl-2">· [${_esc(rr.layer || "?")}] ${_esc(String(rr.content || "").slice(0, 120))}</div>`).join("")
                  : "")
              : `<div class="text-warning mt-0.5">${_esc(en.error || "无输出")}</div>`}
          </div>`).join("") || '<span class="opacity-50">该文件暂无记录</span>') +
      `<div class="flex gap-2 mt-1">
        <button class="btn btn-xs" data-runlogpage="newer" ${r.offset <= 0 ? "disabled" : ""}>较新一页</button>
        <button class="btn btn-xs" data-runlogpage="older" ${r.offset + r.limit >= r.total ? "disabled" : ""}>更早一页</button>
        <button class="btn btn-xs btn-ghost" data-runlogpage="close">收起</button>
      </div>`;
    box.querySelector('[data-runlogpage="newer"]')?.addEventListener("click", () => _p1OpenRunLog(container, file, Math.max(0, offset - r.limit)));
    box.querySelector('[data-runlogpage="older"]')?.addEventListener("click", () => _p1OpenRunLog(container, file, offset + r.limit));
    box.querySelector('[data-runlogpage="close"]')?.addEventListener("click", () => { box.innerHTML = ""; });
  } catch (e) { box.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

// ── 快速测试角色卡+对话文件选择（0731 002："这个需要绑定角色卡啊,不去切换角色卡怎么测试?"+"还要可以选择对话文件"）──
// 角色卡=getPartList('chars') 全量单源（同 lineManager openLinePicker：不用 charList——那是"当前对话里的角色"）；
// 对话文件=getChatList 按所选角色过滤（item.chars 含该角色），选中后运行时拉该对话尾部消息作 chatHistory。
let _p1ChatListCache = null;
async function _p1FillTestSelectors(container) {
  const charSel = container.querySelector("#p1run-test-char");
  if (!charSel) return;
  try {
    const chars = (await getPartList("chars")).filter((c) => c !== "_global");
    const active = window._beiluGetCharName?.() || "";
    charSel.innerHTML = '<option value="">（无角色·仅锚点链）</option>' +
      chars.map((c) => `<option value="${_esc(c)}" ${c === active ? "selected" : ""}>${_esc(c)}</option>`).join("");
  } catch (e) {
    charSel.innerHTML = '<option value="">（角色列表加载失败）</option>';
    console.warn("[p1panel] 角色卡列表加载失败:", e?.message || e);
  }
  await _p1FillChatSelect(container);
}

async function _p1FillChatSelect(container) {
  const chatSel = container.querySelector("#p1run-test-chat");
  const char = container.querySelector("#p1run-test-char")?.value || "";
  if (!chatSel) return;
  if (!char) { chatSel.innerHTML = '<option value="">不带对话历史</option>'; return; }
  try {
    if (!_p1ChatListCache) _p1ChatListCache = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
    const chats = (Array.isArray(_p1ChatListCache) ? _p1ChatListCache : [])
      .filter((c) => (Array.isArray(c?.chars) ? c.chars : [c?.chars]).includes(char));
    chatSel.innerHTML = '<option value="">不带对话历史</option>' +
      chats.map((c) => {
        const label = (c.lastMessageContent || c.chatid || "").toString().slice(0, 24) || c.chatid;
        return `<option value="${_esc(c.chatid)}">${_esc(label)}</option>`;
      }).join("");
  } catch (e) { console.warn("[p1panel] 对话列表加载失败:", e?.message || e); }
}

// 按 chatid 拉对话尾部消息作 chatHistory（服务端既有端点 GET /:chatid/log，start 负数=尾部 slice）
async function _p1FetchChatTail(chatid, n) {
  try {
    const res = await fetch(`/api/parts/shells:chat/${encodeURIComponent(chatid)}/log?start=-${n}`);
    if (!res.ok) return [];
    const log = await res.json();
    return (Array.isArray(log) ? log : [])
      .map((m) => ({ role: m.role || (m.name ? "assistant" : "user"), content: String(m.content ?? m.text ?? "") }))
      .filter((m) => m.content);
  } catch (e) {
    console.warn("[p1panel] 对话历史拉取失败（改为不带历史继续）:", e?.message || e);
    return [];
  }
}

let _p1Meta = [];
let _p1Config = {}; // getData 平铺配置快照（快速测试等按配置驱动，禁前端硬编码条数/上限）
async function _p1RefreshRun(container) {
  try {
    const d = await sendAction({ verb: "getData", target: _P1, source: "web" });
    _p1Meta = Array.isArray(d?.meta) ? d.meta : [];
    _p1Config = d && typeof d === "object" ? d : {};
    const st = d?.stats || {};
    const box = container.querySelector("#p1run-status");
    if (box) box.innerHTML = `
      <div class="flex flex-wrap gap-2 items-center">
        <label class="flex items-center gap-1"><input type="checkbox" id="p1run-enabled" class="toggle toggle-xs" ${d.enabled ? "checked" : ""}/><b>启用 P1 召回</b></label>
        <span class="badge badge-sm ${st.pipelineLoaded ? "badge-success" : "badge-ghost"}">管线${st.pipelineLoaded ? "已加载" : "未加载"}</span>
        <span class="badge badge-sm badge-ghost">最近 ${st.lastRunMs != null ? st.lastRunMs + "ms" : "—"}</span>
        <span class="badge badge-sm badge-ghost">运行中 ${st.activeRuns ?? 0}</span>
        <span class="badge badge-sm badge-ghost">空闲卸载 ${st.idleUnloadMinutes ?? "—"}min</span>
        <label class="flex items-center gap-1" title="输入框打字停顿时用 P1 轻量召回展示联想词（不扫记忆 data，不影响正式召回）"><input type="checkbox" id="p1run-typing" class="toggle toggle-xs" ${(() => { try { return localStorage.getItem("beilu-typing-suggest-enabled") === "true" ? "checked" : ""; } catch { return ""; } })()}/><span>打字联想</span></label>
        <button id="p1run-once" class="btn btn-xs" title="INJ-p1 条目被关闭时：排队让下一条消息单次注入 P1 结果（仅该轮）">单次注入下轮</button>
        <button id="p1run-clear" class="btn btn-xs">清缓存</button>
        <button id="p1run-refresh" class="btn btn-xs btn-ghost">刷新</button>
      </div>`;
    box?.querySelector("#p1run-typing")?.addEventListener("change", (e) => {
      try { localStorage.setItem("beilu-typing-suggest-enabled", e.target.checked ? "true" : "false"); } catch { /* 私隐模式等存储失败静默 */ }
    });
    // 单次注入（0731 002）：P1 条目被用户在 INJ 面板关闭时，此按钮把两条 INJ-p1-* 排进下一次发送
    // 的 single_inject_ids（走注入坞同一条队列/发送链，但条目不进坞候选——凛倾0726域边界）。
    box?.querySelector("#p1run-once")?.addEventListener("click", async () => {
      try {
        const m = await import("../../shared/chat-core/injectDock.mjs");
        const ok = m.queueOnceInject("INJ-p1-retrieval-data") && m.queueOnceInject("INJ-p1-act-data");
        const el = box.querySelector("#p1run-once");
        if (el) el.textContent = ok ? "已排队（下条消息生效一次）" : "排队失败";
      } catch (e) { console.warn("[p1panel] 单次注入排队失败:", e?.message || e); }
    });
    box?.querySelector("#p1run-clear")?.addEventListener("click", async () => {
      try { await sendAction({ verb: "unloadCaches", target: _P1, source: "web" }); await _p1RefreshRun(container); } catch { /* sendAction 已统一报错 */ }
    });
    box?.querySelector("#p1run-refresh")?.addEventListener("click", () => { _p1RefreshRun(container); _p1RefreshRunLog(container); }); // 刷新=全面板（含运行记录卡片：P1 服务冷启动期首拉失败后由此恢复）
    box?.querySelector("#p1run-enabled")?.addEventListener("change", async (e) => {
      try { await sendAction({ verb: "updateConfig", target: _P1, source: "web", payload: { enabled: e.target.checked } }); } catch { /* 已报错 */ }
    });
    // 参数区：按 meta.group 分组渲染（跳过 enabled——状态条已有）
    const pWrap = container.querySelector("#p1run-params");
    if (pWrap) {
      const groups = new Map();
      for (const m of _p1Meta) {
        if (m.key === "enabled") continue;
        if (!groups.has(m.group)) groups.set(m.group, []);
        groups.get(m.group).push(m);
      }
      let html = "";
      for (const [g, items] of groups) {
        html += `<div class="col-span-full text-[10px] opacity-50 border-b border-base-300/40 pb-0.5 mt-1">${_esc(g)}</div>`;
        for (const m of items) {
          const v = d[m.key];
          html += m.type === "toggle"
            ? `<label class="flex items-center justify-between gap-1 bg-base-100/60 rounded px-2 py-1" title="${_esc(m.desc)}"><span>${_esc(m.label)}</span><input type="checkbox" class="toggle toggle-xs" data-p1key="${_esc(m.key)}" ${v ? "checked" : ""}/></label>`
            : `<label class="flex items-center justify-between gap-1 bg-base-100/60 rounded px-2 py-1" title="${_esc(m.desc)}"><span>${_esc(m.label)}</span><input type="number" class="input input-xs input-bordered w-20" data-p1key="${_esc(m.key)}" value="${_esc(v)}" ${m.min != null ? `min="${m.min}"` : ""} ${m.max != null ? `max="${m.max}"` : ""} ${m.step != null ? `step="${m.step}"` : ""}/></label>`;
        }
      }
      pWrap.innerHTML = html || '<span class="opacity-50">插件未返回 meta</span>';
    }
  } catch (e) {
    const box = container.querySelector("#p1run-status");
    if (box) box.innerHTML = `<span class="text-error">状态加载失败: ${_esc(e?.message || e)}</span>`;
  }
  _p1RefreshModeOverrides(container);
}

// per-mode P1 开关（0731 T2）：读写 beilu-memory 的 mode_feature_overrides 用户覆盖层。
// 注意 target 是 plugins:beilu-memory（mode 级路由门在 memory 侧），不是本插件（插件 enabled 是另一层总闸）。
// 生效值由后端单源下发（声明默认 ⊕ 用户覆盖），前端纯渲染零硬编码。
async function _p1RefreshModeOverrides(container) {
  const box = container.querySelector("#p1run-modeov");
  if (!box) return;
  try {
    const r = await sendAction({ verb: "getModeFeatureOverrides", target: "plugins:beilu-memory", source: "web" });
    const effAll = r?.effective || {};
    box.innerHTML = `<table class="table table-xs"><thead><tr><th>模式</th><th>自驱动召回</th><th>AI P1</th></tr></thead><tbody>${
      Object.keys(effAll).map((m) => {
        const eff = effAll[m] || {};
        return `<tr><td>${_esc(m)}</td>
          <td><input type="checkbox" class="toggle toggle-xs" data-mfov="${_esc(m)}:selfDriven" ${eff.selfDriven ? "checked" : ""}/></td>
          <td><input type="checkbox" class="toggle toggle-xs" data-mfov="${_esc(m)}:aiP1" ${eff.aiP1 ? "checked" : ""}/></td></tr>`;
      }).join("")}</tbody></table>`;
    box.querySelectorAll("[data-mfov]").forEach((el) => el.addEventListener("change", async (e) => {
      const [mode, key] = el.dataset.mfov.split(":");
      try {
        await sendAction({ verb: "saveModeFeatureOverride", target: "plugins:beilu-memory", source: "web", payload: { mode, lib: "p1", [key]: e.target.checked } });
      } catch { /* sendAction 已统一报错；失败时刷新回真值 */ _p1RefreshModeOverrides(container); }
    }));
  } catch (e) {
    box.innerHTML = `<span class="text-error">开关读取失败: ${_esc(e?.message || e)}</span>`;
  }
}

async function _p1SaveParams(container) {
  const patch = {};
  container.querySelectorAll("[data-p1key]").forEach((el) => {
    patch[el.dataset.p1key] = el.type === "checkbox" ? el.checked : Number(el.value);
  });
  const msg = container.querySelector("#p1run-save-msg");
  try {
    await sendAction({ verb: "updateConfig", target: _P1, source: "web", payload: patch });
    if (msg) msg.textContent = "已保存（写盘生效）";
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

async function _p1QuickTest(container) {
  const input = container.querySelector("#p1run-test-input")?.value?.trim();
  const mode = container.querySelector("#p1run-test-mode")?.value || "chat";
  const out = container.querySelector("#p1run-test-out");
  if (!input) { if (out) out.textContent = "请输入测试文本"; return; }
  if (out) out.innerHTML = '<span class="opacity-50">召回中...</span>';
  const t0 = Date.now();
  try {
    // 角色卡级隔离（底部功能层.txt）：角色卡从下拉取（0731 002 骂点修复——不再绑死当前对话活跃卡）；
    // 对话文件选中时带该对话尾部消息作 chatHistory（contextMessages 上限 5，多拉两条给过滤余量）。
    const charName = container.querySelector("#p1run-test-char")?.value || "";
    const chatid = container.querySelector("#p1run-test-chat")?.value || "";
    // 尾巴条数=2×contextMessages（后端配置单源；×2=一问一答交替下保证凑足 N 条 user 消息，管线自会截取）
    const _ctxN = Number(_p1Config.contextMessages) || 5;
    const chatHistory = chatid ? await _p1FetchChatTail(chatid, _ctxN * 2) : [];
    // source:"panel-test"=运行记录来源标注（服务端 _append_run_log 记档用；生产线 p1Bridge 不带=bridge）
    const r = await sendAction({ verb: "runP1", target: _P1, source: "web", payload: { inputText: input, chatHistory, mode, charName, source: "panel-test" } });
    const ms = Date.now() - t0;
    if (!r?.success) { if (out) out.innerHTML = `<span class="text-warning">${_esc(r?.error || "召回失败（插件未启用？）")}</span>`; return; }
    const rec = r.trace?.recall || {};
    const words = rec.inputWords || [];
    const pool = rec.swowPool || [];
    const scored = rec.scoredPool || [];
    const anchors = rec.anchors || [];
    const records = r.recalledRecords || [];
    const mechs = rec.mechanisms || [];
    const sp2 = rec.secondPassRemoved || [];
    const blqD = rec.blqDropped || [];
    const nbD = rec.nbDropped || [];
    const wnD = rec.wnDropped || [];
    const fr = rec.filterByReason || {};
    const frStr = Object.entries(fr).map(([k,v]) => `${k}:${v}`).join(' ');
    if (out) out.innerHTML = `
      <div class="flex flex-wrap gap-1 mb-1">
        <span class="badge badge-sm badge-ghost">${ms}ms</span>
        <span class="badge badge-sm badge-ghost">角色 ${_esc(charName || "—")}</span>
        <span class="badge badge-sm badge-ghost">模式 ${_esc(mode)}</span>
        <span class="badge badge-sm badge-ghost">记忆 ${records.length}</span>
      </div>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">① 分词 (${rec.totalTokens || 0}→保留${words.length}, 过滤${rec.filteredCount || 0})</summary>
        <div class="pl-2 text-[11px] opacity-80">过滤分布: ${frStr || '无'}</div>
        <div class="pl-2">${_esc(words.join(" · ")) || "—"}</div>
      </details>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">② 发散 原始池${rec.rawPoolCount || pool.length} → 二次过滤去${sp2.length} → 池${pool.length}</summary>
        <div class="pl-2 text-[11px] opacity-80">机制: ${mechs.map(m => `${m.name}:${m.produced}${m.note ? '⚠'+m.note : ''}`).join(' | ') || '—'}</div>
        ${sp2.length ? `<div class="pl-2 text-[11px] text-error">二次过滤: ${sp2.slice(0,20).map(x => x.word+'('+x.reason+')').join(' ')}</div>` : ''}
        <div class="pl-2">${pool.length ? pool.slice(0, 50).map((w) => `<span class="badge badge-xs ${typeof w === 'object' && w?.resonance >= 2 ? 'badge-warning' : 'badge-ghost'} mr-0.5 mb-0.5" title="${typeof w === 'object' ? `来源:${(w.sources||[]).join('+')} str:${w.strength} via:${(w.via||[]).join(',')}` : ''}">${_esc(typeof w === 'object' ? w.word : w)}</span>`).join("") + (pool.length > 50 ? `<span class="opacity-50">…+${pool.length - 50}</span>` : "") : '—'}</div>
      </details>
      <details class="mt-1"><summary class="cursor-pointer font-bold text-xs">③ 审查 池${pool.length} → BLQ预筛去${blqD.filter(d=>d.reason==='blq_pre').length} → NB去${nbD.length} → WN去${wnD.length} → BLQ终筛去${blqD.filter(d=>d.reason==='blq_final').length} → 存活${scored.length} ${rec.nbAvailable ? '' : '⚠NB离线'}</summary>
        ${blqD.length ? `<div class="pl-2 text-[11px] text-error">BLQ淘汰(${blqD.length}): ${blqD.slice(0,15).map(d => d.word+'='+d.score).join(' ')}</div>` : ''}
        ${nbD.length ? `<div class="pl-2 text-[11px] text-error">NB丢弃(${nbD.length}): ${nbD.slice(0,15).map(d => d.word+'(cos='+d.cos+')').join(' ')}</div>` : ''}
        ${wnD.length ? `<div class="pl-2 text-[11px] text-error">WN丢弃(${wnD.length}): ${wnD.slice(0,15).map(d => d.word+'(cos='+d.cos+',wn='+d.wn+')').join(' ')}</div>` : ''}
        <div class="pl-2">${scored.length ? scored.slice(0, 30).map(s => `<span class="badge badge-xs ${s.resonance >= 2 ? 'badge-warning' : 'badge-success'} mr-0.5 mb-0.5" title="score:${s.score} cos:${s.cos??'-'} gold:${s.gold} [${(s.sources||[]).join('+')}]">${_esc(s.word)}</span>`).join("") + (scored.length > 30 ? `<span class="opacity-50">…+${scored.length - 30}</span>` : "") : '<span class="opacity-50">全部被过滤</span>'}</div>
      </details>
      <div class="mt-1"><b>④ 锚点:</b> ${_esc(anchors.map((a) => (typeof a === "string" ? a : a?.word || "")).filter(Boolean).join(" · ")) || "—"}</div>
      <details open class="mt-1"><summary class="cursor-pointer font-bold text-xs">⑤ 召回记忆 (${records.length}) — 匹配${rec.rankedCount || 0}条</summary>
      ${records.map((x) => `<div class="bg-base-100/60 rounded px-2 py-1 mt-1"><span class="badge badge-xs badge-ghost mr-1">${_esc(x.layer || "?")}</span><span class="opacity-60">[${_esc((x.matchedTerms || []).slice(0, 6).join(","))}]</span> ${_esc(String(x.content || "").slice(0, 160))}</div>`).join("") || '<span class="opacity-50">无</span>'}
      </details>`;
    _p1RefreshRunLog(container); // 本次测试已落一条运行记录：卡片跟随刷新（文件列表/最新文件）
  } catch (e) { if (out) out.innerHTML = `<span class="text-error">召回异常: ${_esc(e?.message || e)}</span>`; }
}

// ═══════════════════ 面板2：词库管理 ═══════════════════

export async function loadP1VocabPanel(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3">
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📚 AT 自更新词库 <span class="opacity-50 font-normal">（管线自学习写入；此处只读查询）</span></div>
      <div id="p1vocab-at" class="mb-2"><span class="opacity-50">加载中...</span></div>
      <div class="flex gap-2 items-center">
        <select id="p1vocab-at-mode" class="select select-xs select-bordered"><option>chat</option><option>code</option><option>work</option><option>airp</option></select>
        <input id="p1vocab-at-q" type="text" class="input input-xs input-bordered flex-1" placeholder="搜索术语（包含匹配，最多50条）" />
        <button id="p1vocab-at-search" class="btn btn-xs">搜索</button>
      </div>
      <div id="p1vocab-at-hits" class="mt-1 text-[11px]"></div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">🔌 用户插拔词库 <span class="opacity-50 font-normal">（启停即插拔；召回池 30s 内热更新生效）</span></div>
      <div id="p1vocab-user"><span class="opacity-50">加载中...</span></div>
      <div class="mt-2"><button id="p1vocab-new" class="btn btn-xs btn-primary">＋ 新建 / 编辑词库</button></div>
      <div id="p1vocab-editor" class="mt-2 hidden">
        <div class="flex gap-2 items-center mb-1">
          <input id="p1vocab-ed-file" type="text" class="input input-xs input-bordered w-52" placeholder="文件名，如 我的领域词库.json" />
          <button id="p1vocab-ed-save" class="btn btn-xs btn-primary">保存</button>
          <span class="opacity-50">格式: {"_meta":{"name":"...","modes":["all"],"enabled":true},"entries":{"词":["关联词1","关联词2"]}}</span>
        </div>
        <div class="relative expandable-container">
          <textarea id="p1vocab-ed-content" class="textarea textarea-bordered w-full font-mono text-[11px]" rows="8" data-expandable data-expand-title="用户插拔词库编辑">{
  "_meta": { "name": "我的词库", "modes": ["all"], "enabled": true },
  "entries": { "示例词": ["关联词1", "关联词2"] }
}</textarea>
          <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
        </div>
        <div id="p1vocab-ed-msg" class="opacity-60"></div>
      </div>
    </div>
  </div>`;
  container.querySelector("#p1vocab-at-search").addEventListener("click", () => _p1AtSearch(container));
  container.querySelector("#p1vocab-at-q").addEventListener("keydown", (e) => { if (e.key === "Enter") _p1AtSearch(container); });
  container.querySelector("#p1vocab-new").addEventListener("click", () => container.querySelector("#p1vocab-editor").classList.toggle("hidden"));
  container.querySelector("#p1vocab-ed-save").addEventListener("click", () => _p1SaveVocab(container));
  await _p1RefreshVocabs(container);
}

async function _p1RefreshVocabs(container) {
  try {
    const r = await sendAction({ verb: "listVocabs", target: _P1, source: "web" });
    // AT 词库行可点击浏览（0731 002骂点"点击不了,查了不了"）：点行→展开该模式维度列表（atBrowse 无 dim）
    // →点维度→分页词条（atBrowse 带 dim，每页50，复用 atSearch 同款 mtime 缓存，见插件 main.mjs atBrowse action）。
    const atBox = container.querySelector("#p1vocab-at");
    if (atBox) atBox.innerHTML = `<table class="table table-xs"><thead><tr><th>模式</th><th>文件</th><th>大小</th><th>更新时间</th></tr></thead><tbody>${(r?.at || []).map((a) => `
      <tr class="cursor-pointer hover:bg-base-100/60" data-atrow="${_esc(a.mode)}" title="点击浏览该模式词库维度/词条"><td>${_esc(a.mode)}</td><td class="opacity-60">${_esc(a.file)}</td><td>${a.missing ? '<span class="text-warning">缺失</span>' : (a.size / 1048576).toFixed(1) + "MB"}</td><td>${a.mtime ? new Date(a.mtime).toLocaleString() : "—"}</td></tr>
      <tr class="hidden" data-atdetail="${_esc(a.mode)}"><td colspan="4"><div class="p-2 bg-base-100/40 rounded text-[11px]" data-atbody></div></td></tr>`).join("")}</tbody></table>`;
    atBox?.querySelectorAll("[data-atrow]").forEach((tr) => tr.addEventListener("click", () => _p1AtToggleRow(container, tr.dataset.atrow)));
    const uBox = container.querySelector("#p1vocab-user");
    const users = r?.user || [];
    if (uBox) uBox.innerHTML = users.length
      ? `<table class="table table-xs"><thead><tr><th>词库</th><th>模式</th><th>词条</th><th>启用</th><th></th></tr></thead><tbody>${users.map((u) => u.broken
          ? `<tr><td>${_esc(u.file)}</td><td colspan="3" class="text-error">文件损坏（JSON 解析失败）</td><td><button class="btn btn-xs btn-ghost text-error" data-vdel="${_esc(u.file)}">删除</button></td></tr>`
          : `<tr><td title="${_esc(u.file)}">${_esc(u.name)}</td><td>${_esc((u.modes || []).join(","))}</td><td>${u.entryCount}</td><td><input type="checkbox" class="toggle toggle-xs" data-vtoggle="${_esc(u.file)}" ${u.enabled ? "checked" : ""}/></td><td><button class="btn btn-xs btn-ghost" data-vedit="${_esc(u.file)}">编辑</button><button class="btn btn-xs btn-ghost text-error" data-vdel="${_esc(u.file)}">删除</button></td></tr>`).join("")}</tbody></table>`
      : '<span class="opacity-50">暂无用户词库。新建后启用，召回池自动多一路 mode:user 扩展。</span>';
    uBox?.querySelectorAll("[data-vtoggle]").forEach((el) => el.addEventListener("change", async (e) => {
      try { await sendAction({ verb: "toggleUserVocab", target: _P1, source: "web", payload: { file: el.dataset.vtoggle, enabled: e.target.checked } }); } catch { /* 已报错 */ }
    }));
    uBox?.querySelectorAll("[data-vdel]").forEach((el) => el.addEventListener("click", async () => {
      if (!confirm(`删除词库 ${el.dataset.vdel}？`)) return;
      try { await sendAction({ verb: "deleteUserVocab", target: _P1, source: "web", payload: { file: el.dataset.vdel } }); await _p1RefreshVocabs(container); } catch { /* 已报错 */ }
    }));
    uBox?.querySelectorAll("[data-vedit]").forEach((el) => el.addEventListener("click", async () => {
      try {
        const g = await sendAction({ verb: "getUserVocab", target: _P1, source: "web", payload: { file: el.dataset.vedit } });
        if (!g?.success) return;
        container.querySelector("#p1vocab-editor").classList.remove("hidden");
        container.querySelector("#p1vocab-ed-file").value = g.file;
        container.querySelector("#p1vocab-ed-content").value = JSON.stringify(g.content, null, 2);
      } catch { /* 已报错 */ }
    }));
  } catch (e) {
    const b = container.querySelector("#p1vocab-user");
    if (b) b.innerHTML = `<span class="text-error">词库列表加载失败: ${_esc(e?.message || e)}</span>`;
  }
}

// 行展开/收起（手风琴：同一时刻只开一行）→ 拉该模式维度列表（atBrowse 不带 dim）
async function _p1AtToggleRow(container, mode) {
  const detailRow = container.querySelector(`[data-atdetail="${mode}"]`);
  if (!detailRow) return;
  const wasHidden = detailRow.classList.contains("hidden");
  container.querySelectorAll("[data-atdetail]").forEach((el) => el.classList.add("hidden"));
  if (!wasHidden) return; // 点已展开的行=收起，不重新加载
  detailRow.classList.remove("hidden");
  const body = detailRow.querySelector("[data-atbody]");
  if (body) body.innerHTML = '<span class="opacity-50">加载维度中（首次需解析词库文件）...</span>';
  try {
    const r = await sendAction({ verb: "atBrowse", target: _P1, source: "web", payload: { mode } });
    if (!r?.success) { if (body) body.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    if (body) body.innerHTML = `<div class="opacity-50 mb-1">共 ${r.dims.length} 个维度，点击浏览词条：</div>
      <div class="flex flex-wrap gap-1 max-h-32 overflow-y-auto">${r.dims.map((d) => `<button class="btn btn-xs btn-ghost" data-atdim="${_esc(d.dim)}">${_esc(d.dim)} <span class="opacity-50">(${d.count})</span></button>`).join("")}</div>
      <div data-atterms class="mt-2"></div>`;
    body.querySelectorAll("[data-atdim]").forEach((btn) => btn.addEventListener("click", () => _p1AtLoadDim(container, mode, btn.dataset.atdim, 0)));
  } catch (e) { if (body) body.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

// 维度下词条分页浏览（atBrowse 带 dim，每页50，offset 翻页）
async function _p1AtLoadDim(container, mode, dim, offset) {
  const detailRow = container.querySelector(`[data-atdetail="${mode}"]`);
  const termsBox = detailRow?.querySelector("[data-atterms]");
  if (!termsBox) return;
  termsBox.innerHTML = '<span class="opacity-50">加载词条中...</span>';
  try {
    // limit 单源=后端 atBrowseLimitDefault（getData 平铺配置，_p1Config 快照）；未拉到时用同值兜底，零行为变化
    const _limit = Number(_p1Config.atBrowseLimitDefault) || 50;
    const r = await sendAction({ verb: "atBrowse", target: _P1, source: "web", payload: { mode, dim, offset, limit: _limit } });
    if (!r?.success) { termsBox.innerHTML = `<span class="text-error">${_esc(r?.error || "加载失败")}</span>`; return; }
    const { entries, total, limit } = r;
    termsBox.innerHTML = `<div class="font-bold mb-1">${_esc(dim)}（共 ${total} 词，第 ${offset + 1}-${Math.min(offset + limit, total)} 条）</div>` +
      (entries.map((en) => `<div class="bg-base-200/40 rounded px-2 py-1 mb-1"><b>${_esc(en.term)}</b> <span class="opacity-60">${_esc((en.concepts || []).slice(0, 8).join(" · "))}</span></div>`).join("") || '<span class="opacity-50">该维度无词条</span>') +
      `<div class="flex gap-2 mt-1">
        <button class="btn btn-xs" data-atpage="prev" ${offset <= 0 ? "disabled" : ""}>上一页</button>
        <button class="btn btn-xs" data-atpage="next" ${offset + limit >= total ? "disabled" : ""}>下一页</button>
      </div>`;
    termsBox.querySelector('[data-atpage="prev"]')?.addEventListener("click", () => _p1AtLoadDim(container, mode, dim, Math.max(0, offset - limit)));
    termsBox.querySelector('[data-atpage="next"]')?.addEventListener("click", () => _p1AtLoadDim(container, mode, dim, offset + limit));
  } catch (e) { termsBox.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

async function _p1AtSearch(container) {
  const q = container.querySelector("#p1vocab-at-q")?.value?.trim();
  const mode = container.querySelector("#p1vocab-at-mode")?.value || "chat";
  const box = container.querySelector("#p1vocab-at-hits");
  if (!q) { if (box) box.innerHTML = '<span class="opacity-50">请输入搜索词</span>'; return; }
  if (box) box.innerHTML = '<span class="opacity-50">搜索中（首次需解析词库文件）...</span>';
  try {
    const r = await sendAction({ verb: "atSearch", target: _P1, source: "web", payload: { mode, q } });
    if (box) box.innerHTML = r?.success
      ? (r.hits.length ? r.hits.map((h) => `<span class="badge badge-sm badge-ghost mr-1 mb-1" title="维度: ${_esc(h.dim)}">${_esc(h.term)}</span>`).join("") + (r.truncated ? '<span class="opacity-50">（已截断50条）</span>' : "")
        : '<span class="opacity-50">无匹配术语</span>')
      : `<span class="text-error">${_esc(r?.error)}</span>`;
  } catch (e) { if (box) box.innerHTML = `<span class="text-error">${_esc(e?.message || e)}</span>`; }
}

async function _p1SaveVocab(container) {
  const file = container.querySelector("#p1vocab-ed-file")?.value?.trim();
  const msg = container.querySelector("#p1vocab-ed-msg");
  let content;
  try { content = JSON.parse(container.querySelector("#p1vocab-ed-content").value); }
  catch (e) { if (msg) msg.textContent = `JSON 格式错误: ${e.message}`; return; }
  try {
    const r = await sendAction({ verb: "saveUserVocab", target: _P1, source: "web", payload: { file, content } });
    if (msg) msg.textContent = r?.success ? `已保存（${r.entryCount} 词条；30s 内召回生效）` : `保存失败: ${r?.error}`;
    if (r?.success) await _p1RefreshVocabs(container);
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

// ═══════════════════ 面板3：P9 词库维护（就地完整编辑区） ═══════════════════
//
// [0731 002 终版] "把这两个恶心的垃圾给我删除...仿照code的子模式做前端,也就是完整的编辑前端.
//   把那两个垃圾给我替换"：原绿条"已注册"横幅 + "使用与编辑"跳转指路块删除（旧死代码
//   _p1P9EnsureSubMode 一并清），改为完整编辑前端，两块就地编辑、零跳转：
//   ① 子模式实体区（照 companion.mjs 单实体范式 :1614-1718）：缺失即注册（append→saveSubModes，
//      后端 _ensureSubModePresetsFor 幂等补建同名预设；默认预设已随播种存在时跳过）；参数只写
//      model_params 蛇形键（getPromptHandler:299-336 每轮生效载体，空=删键不覆盖、0 合法）；
//      绑定=setActiveSubMode{id,chatId} 写 active_sub_modes_map[当前对话]（chat 组子模式刻意
//      不进 code/work 选择器——subModePanel:940-944 组过滤，本面板即其唯一管理 UI）。
//   ② 提示词区：就地编辑绑定预设条目，与预设面板同一数据契约（getDataForPreset 读 /
//      updatePresetConfig{_target_preset, update_entry|toggle_entry|add_entry|delete_entry|
//      reorder_entries} 写，settings/panels.mjs:296-513 同源）；marker 条目内容锁定（运行时
//      从模块提取）。放大=data-expandable（expandEditor 自动接管）；复制按钮写剪贴板。
//   提示词正文=用户域（铁律：代码禁产生进对话的文本）——本面板与默认件均不写正文。

const _P9_SM_ID = "P9词库维护";
// ST 8 marker 位（与预设面板 MARKERS 同集合）：内容运行时从对应模块提取，编辑器只放行名称/角色/启用/顺序
const _P9_MARKERS = ["personaDescription", "worldInfoBefore", "charDescription", "charPersonality", "scenario", "worldInfoAfter", "dialogueExamples", "chatHistory"];
const _P9_NUM_FIELDS = [ // [model_params 蛇形键=param_schema 键, DOM id]
  ["temperature", "p9-sm-temperature"], ["max_tokens", "p9-sm-max-tokens"],
  ["max_context", "p9-sm-max-context"], ["top_p", "p9-sm-top-p"],
  ["top_k", "p9-sm-top-k"], ["min_p", "p9-sm-min-p"],
];
let _p9All = [];      // getSubModes 全表引用（saveSubModes 整表覆盖语义：必须持全量写回）
let _p9Entity = null; // P9 实体（_p9All 内成员引用）
let _p9EnumSchema = null;
let _p9ApiSources = null;
let _p9ModelReq = 0;  // 模型下拉竞态票据（同 companion._soModelReq）
let _p9Entries = [];  // 绑定预设条目工作副本
let _p9EntrySel = null;

export async function loadP1P9Panel(container) {
  if (container._loaded) return;
  container._loaded = true;
  container.innerHTML = `<div class="p-3 text-xs space-y-3" id="p1p9-root">
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">⚙️ P9 子模式配置 <span class="opacity-50 font-normal">（聊天组子模式；参数每轮生效，预设在绑定对话时应用）</span></div>
      <div id="p9-sm-status" class="mb-2 text-[11px]"><span class="opacity-50">加载中...</span></div>
      <div id="p9-sm-form" class="grid grid-cols-2 md:grid-cols-3 gap-2 hidden">
        <label class="flex flex-col gap-0.5"><span class="opacity-60">描述</span><input id="p9-sm-desc" type="text" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">绑定预设</span><input id="p9-sm-preset" type="text" list="p9-sm-preset-list" class="input input-xs input-bordered" placeholder="${_P9_SM_ID}" /><datalist id="p9-sm-preset-list"></datalist></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">API 源（空=不覆盖）</span><select id="p9-sm-api" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">绑定模型（空=源默认）</span><select id="p9-sm-model" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">提示词后处理</span><select id="p9-sm-pp" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">尾部预填充模式</span><select id="p9-sm-prefill-mode" class="select select-xs select-bordered"><option value="">（不覆盖）</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">预填充启用</span><select id="p9-sm-prefill-enabled" class="select select-xs select-bordered"><option value="">（不覆盖）</option><option value="on">开</option><option value="off">关</option></select></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">温度</span><input id="p9-sm-temperature" type="number" min="0" max="2" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">最大上下文</span><input id="p9-sm-max-context" type="number" min="0" step="1024" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">最大输出</span><input id="p9-sm-max-tokens" type="number" min="0" step="256" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Top-P</span><input id="p9-sm-top-p" type="number" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Top-K</span><input id="p9-sm-top-k" type="number" min="0" max="500" step="1" placeholder="默认" class="input input-xs input-bordered" /></label>
        <label class="flex flex-col gap-0.5"><span class="opacity-60">Min-P</span><input id="p9-sm-min-p" type="number" min="0" max="1" step="0.01" placeholder="默认" class="input input-xs input-bordered" /></label>
      </div>
      <div class="mt-2 flex gap-2 items-center flex-wrap">
        <button id="p9-sm-save" class="btn btn-xs btn-primary">保存配置</button>
        <button id="p9-sm-bind" class="btn btn-xs">绑定当前对话</button>
        <button id="p9-sm-unbind" class="btn btn-xs btn-ghost">解绑</button>
        <span id="p9-sm-msg" class="opacity-60"></span>
      </div>
    </div>
    <div class="card bg-base-200/40 p-3">
      <div class="font-bold mb-2">📝 提示词编辑 <span class="opacity-50 font-normal">（就地编辑绑定预设条目，与预设面板同一数据源）</span></div>
      <div class="flex border border-base-300/40 rounded" style="min-height:200px;max-height:440px;">
        <div id="p9-pr-list" class="w-44 shrink-0 border-r border-base-300/30 overflow-y-auto"></div>
        <div id="p9-pr-editor" class="flex-1 overflow-y-auto p-2 min-w-0"><div class="text-center opacity-40 py-8">未选择条目。从左侧列表选择后在此编辑</div></div>
      </div>
      <div class="mt-2 flex gap-2 items-center"><button id="p9-pr-add" class="btn btn-xs btn-outline">＋ 添加条目</button><button id="p9-pr-refresh" class="btn btn-xs btn-ghost">刷新</button><button id="p9-pr-restore" class="btn btn-xs btn-warning btn-outline">恢复默认预设</button><span id="p9-pr-msg" class="opacity-60"></span></div>
    </div>
  </div>`;
  container.querySelector("#p9-sm-save").addEventListener("click", () => _p9SaveEntity(container));
  container.querySelector("#p9-sm-bind").addEventListener("click", () => _p9Bind(container, true));
  container.querySelector("#p9-sm-unbind").addEventListener("click", () => _p9Bind(container, false));
  container.querySelector("#p9-sm-api").addEventListener("change", (e) => _p9FillModels(container, e.target.value, ""));
  container.querySelector("#p9-pr-add").addEventListener("click", () => _p9AddEntry(container));
  container.querySelector("#p9-pr-refresh").addEventListener("click", () => _p9LoadEntries(container));
  container.querySelector("#p9-pr-restore")?.addEventListener("click", async () => {
    const msg = container.querySelector("#p9-pr-msg");
    try {
      const check = await sendAction({ verb: "setData", target: "plugins:beilu-p1-selfdriven", source: "web", payload: { _action: "resetP9Prompts" } });
      if (check?.action === "confirm_required") {
        if (!check.hasUserCopy) { if (msg) msg.textContent = check.message; return; }
        if (!confirm(check.message)) return;
        const result = await sendAction({ verb: "setData", target: "plugins:beilu-p1-selfdriven", source: "web", payload: { _action: "resetP9Prompts", confirm: true } });
        if (result?.restored) {
          window._beiluToast?.("P9 预设已从核心默认件恢复", "success");
          await _p9LoadEntries(container);
        } else { if (msg) msg.textContent = result?.message || "恢复失败"; }
      }
    } catch (e) { if (msg) msg.textContent = `恢复失败: ${e?.message || e}`; }
  });
  const ok = await _p9EnsureEntity(container);
  if (!ok) return; // 后端不可达：状态行已显示错误，不渲染半态表单
  await _p9FillForm(container);
  _p9RefreshBindStatus(container);
  _p9LoadEntries(container);
}

// 实体确保（幂等；照 companion._soEnsureEntity 序列）：缺失=append→saveSubModes 落盘，
// 后端写入路径同步补建同名预设（_ensureSubModePresetsFor；默认预设播种在先时命中跳过）。
async function _p9EnsureEntity(container) {
  const st = container.querySelector("#p9-sm-status");
  try {
    const d = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" });
    _p9All = Array.isArray(d?.sub_modes) ? d.sub_modes : [];
    if (d?.enum_schema) { _p9EnumSchema = d.enum_schema; setEnumSchema(d.enum_schema); }
    if (d?.param_schema) setParamSchema(d.param_schema); // 数值控件限值后端单源（共享缓存）
    _p9Entity = _p9All.find((m) => m && m.id === _P9_SM_ID) || null;
    if (!_p9Entity) {
      _p9Entity = { id: _P9_SM_ID, label: "P9 词库维护", desc: "根据最近对话与记忆维护 P1 插拔词库", modeGroup: "chat", presetName: _P9_SM_ID, model_params: {} };
      _p9All = [..._p9All, _p9Entity];
      const saved = await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _p9All } });
      if (saved?.success === false) throw new Error(saved?.error || "子模式注册失败");
    }
    return true;
  } catch (e) {
    if (st) st.innerHTML = `<span class="text-error">P9 子模式加载失败: ${_esc(e?.message || e)}</span>`;
    return false;
  }
}

function _p9FillEnumSel(container, elId, key) {
  const el = container.querySelector(`#${elId}`);
  if (!el) return;
  const keep = el.value;
  el.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
  const opts = Array.isArray(_p9EnumSchema?.[key]?.options) ? _p9EnumSchema[key].options : [];
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label || opt.value;
    if (opt.title) o.title = opt.title;
    el.appendChild(o);
  }
  el.value = keep;
}

// 模型候选跟随所选 API 源实时拉（force+竞态票据丢弃，同 companion._soFillModelSel/memtool._populatePseriesModels）
async function _p9FillModels(container, apiSource, currentModel) {
  const sel = container.querySelector("#p9-sm-model");
  if (!sel) return;
  sel.querySelectorAll("option:not([value=''])").forEach((o) => o.remove());
  const cur = currentModel || "";
  if (cur) { const o = document.createElement("option"); o.value = cur; o.textContent = `${cur}（已绑定）`; sel.appendChild(o); }
  sel.value = cur;
  if (!apiSource) return; // 未绑源：无从拉列表，仅保留已绑定项
  const req = ++_p9ModelReq;
  let models = [];
  try { models = window._beiluGetModelList ? await window._beiluGetModelList(apiSource, { force: true }) : []; } catch { /* 拉取失败：仅保留已绑定项 */ }
  if (req !== _p9ModelReq) return;
  if (!(models || []).length) {
    const warn = document.createElement("option");
    warn.disabled = true;
    warn.textContent = "⚠ 未获取到模型列表（检查该 API 源的 URL/Key）";
    sel.appendChild(warn);
    return;
  }
  for (const id of models) {
    if (!id || id === cur) continue;
    const o = document.createElement("option"); o.value = id; o.textContent = id; sel.appendChild(o);
  }
  sel.value = cur;
}

async function _p9FillForm(container) {
  const form = container.querySelector("#p9-sm-form");
  const sm = _p9Entity;
  if (!form || !sm) return;
  form.classList.remove("hidden");
  const mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : {};
  const descEl = container.querySelector("#p9-sm-desc"); if (descEl) descEl.value = sm.desc || "";
  const pEl = container.querySelector("#p9-sm-preset"); if (pEl) pEl.value = sm.presetName || "";
  // 预设候选 datalist（同 companion._soFillPresetList 单源；失败=手输退化）
  try {
    const d = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
    const dl = container.querySelector("#p9-sm-preset-list");
    if (dl && Array.isArray(d?.preset_list)) dl.innerHTML = d.preset_list.map((n) => `<option value="${_esc(String(n))}"></option>`).join("");
  } catch { /* 候选空，手输仍可用 */ }
  // API 源下拉（getAISources 面板生命周期单次缓存；存储值不在列表也保留可选=诚实显示）
  const srcSel = container.querySelector("#p9-sm-api");
  if (srcSel) {
    if (!Array.isArray(_p9ApiSources)) {
      try {
        const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
        _p9ApiSources = Array.isArray(list) ? list.map((s) => (typeof s === "string" ? s : s.name || s.id || String(s))) : [];
      } catch { _p9ApiSources = []; }
    }
    const names = [..._p9ApiSources];
    if (mp.api_source && !names.includes(mp.api_source)) names.unshift(mp.api_source);
    srcSel.innerHTML = '<option value="">（不覆盖）</option>' + names.map((n) => `<option value="${_esc(n)}" ${n === mp.api_source ? "selected" : ""}>${_esc(n)}</option>`).join("");
  }
  _p9FillModels(container, mp.api_source || "", mp.model || "");
  for (const [key, elId] of _P9_NUM_FIELDS) {
    const el = container.querySelector(`#${elId}`);
    if (el) el.value = (mp[key] !== undefined && mp[key] !== null) ? mp[key] : "";
  }
  _p9FillEnumSel(container, "p9-sm-pp", "prompt_post_processing");
  _p9FillEnumSel(container, "p9-sm-prefill-mode", "claude_prefill_mode");
  const ppEl = container.querySelector("#p9-sm-pp"); if (ppEl) ppEl.value = mp.prompt_post_processing ?? "";
  const pmEl = container.querySelector("#p9-sm-prefill-mode"); if (pmEl) pmEl.value = mp.claude_prefill_mode ?? "";
  const peEl = container.querySelector("#p9-sm-prefill-enabled"); if (peEl) peEl.value = (mp.prefill_enabled === true) ? "on" : (mp.prefill_enabled === false) ? "off" : "";
  applyParamSchemaToInputs(_P9_NUM_FIELDS.map(([key, elId]) => [key, elId]));
}

// 保存实体：参数只写 model_params 蛇形键；空=删键不覆盖、显式值（含 0）原样存（companion :1701-1710 同语义）
async function _p9SaveEntity(container) {
  const sm = _p9Entity;
  const msg = container.querySelector("#p9-sm-msg");
  if (!sm) return;
  const descV = container.querySelector("#p9-sm-desc")?.value?.trim() ?? "";
  if (descV) sm.desc = descV;
  const pv = container.querySelector("#p9-sm-preset")?.value?.trim() || "";
  if (pv) sm.presetName = pv; else delete sm.presetName;
  if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
  const mp = sm.model_params;
  const modelV = container.querySelector("#p9-sm-model")?.value?.trim() || "";
  if (modelV) mp.model = modelV; else delete mp.model;
  const srcV = container.querySelector("#p9-sm-api")?.value || "";
  if (srcV) mp.api_source = srcV; else delete mp.api_source;
  for (const [key, elId] of _P9_NUM_FIELDS) {
    const raw = container.querySelector(`#${elId}`)?.value;
    if (raw === "" || raw === undefined || raw === null) delete mp[key];
    else { const n = Number(raw); if (Number.isFinite(n)) mp[key] = n; else delete mp[key]; }
  }
  const ppV = container.querySelector("#p9-sm-pp")?.value || ""; if (ppV) mp.prompt_post_processing = ppV; else delete mp.prompt_post_processing;
  const pmV = container.querySelector("#p9-sm-prefill-mode")?.value || ""; if (pmV) mp.claude_prefill_mode = pmV; else delete mp.claude_prefill_mode;
  const peV = container.querySelector("#p9-sm-prefill-enabled")?.value || "";
  if (peV === "on") mp.prefill_enabled = true; else if (peV === "off") mp.prefill_enabled = false; else delete mp.prefill_enabled;
  try {
    const saved = await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _p9All } });
    if (saved?.success === false) throw new Error(saved?.error || "保存失败");
    if (msg) msg.textContent = "已保存（参数下轮生效；预设在绑定对话时应用）";
    _p9LoadEntries(container); // presetName 可能改了：提示词区跟随新绑定预设
  } catch (e) { if (msg) msg.textContent = `保存失败: ${e?.message || e}`; }
}

// 绑定状态回显：读 active_sub_modes_map[当前对话]（setActiveSubMode 空 payload=纯读，companion :1632 同法）
async function _p9RefreshBindStatus(container) {
  const st = container.querySelector("#p9-sm-status");
  if (!st) return;
  const cid = (typeof window._beiluCurWinChatId === "function" ? window._beiluCurWinChatId() : "") || "";
  if (!cid) { st.innerHTML = '<span class="opacity-60">当前无对话窗口——先打开对话再绑定（绑定后该对话生成走 P9 预设与参数）</span>'; return; }
  try {
    const r = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: {} });
    const act = r?.active_sub_modes_map?.[cid] || "";
    st.innerHTML = act === _P9_SM_ID
      ? '<span class="badge badge-sm badge-success">已绑定当前对话</span> <span class="opacity-60">该对话生成使用 P9 预设与参数</span>'
      : (act
        ? `<span class="opacity-60">当前对话绑定的是「${_esc(act)}」——点「绑定当前对话」改绑 P9</span>`
        : '<span class="opacity-60">当前对话未绑定子模式——点「绑定当前对话」启用 P9</span>');
  } catch (e) { st.innerHTML = `<span class="text-error">绑定状态读取失败: ${_esc(e?.message || e)}</span>`; }
}

// 绑定/解绑当前对话（companion._soSyncActivation 同链）：解绑只清自己的 id，不动他方写入（防越权覆盖）
async function _p9Bind(container, on) {
  const msg = container.querySelector("#p9-sm-msg");
  const cid = (typeof window._beiluCurWinChatId === "function" ? window._beiluCurWinChatId() : "") || "";
  if (!cid) { if (msg) msg.textContent = "无当前对话窗口，无法绑定"; return; }
  try {
    if (on) {
      await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: _P9_SM_ID, chatId: cid } });
      if (msg) msg.textContent = "已绑定（预设即刻应用，参数每轮生效）";
    } else {
      const r = await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: {} });
      const act = r?.active_sub_modes_map?.[cid] || "";
      if (act !== _P9_SM_ID) { if (msg) msg.textContent = act ? `当前对话绑定的是「${act}」，不动他方绑定` : "当前对话本就未绑定"; _p9RefreshBindStatus(container); return; }
      await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { clear: true, chatId: cid } });
      if (msg) msg.textContent = "已解绑（回该对话原预设）";
    }
  } catch (e) { if (msg) msg.textContent = `绑定操作失败: ${e?.message || e}`; }
  _p9RefreshBindStatus(container);
}

// ── 提示词区：绑定预设条目就地编辑（与预设面板 settings/panels.mjs 同一契约） ──

function _p9PresetName() { return _p9Entity?.presetName || _P9_SM_ID; }

async function _p9LoadEntries(container) {
  const list = container.querySelector("#p9-pr-list");
  if (!list) return;
  list.innerHTML = '<div class="p-2 opacity-50">加载中...</div>';
  try {
    const d = await sendAction({ verb: "getDataForPreset", target: "plugins:beilu-preset", source: "web", payload: { preset: _p9PresetName() } });
    if (d?.error) { list.innerHTML = `<div class="p-2 text-error">${_esc(d.error)}</div>`; return; }
    _p9Entries = Array.isArray(d?.entries) ? d.entries : [];
    _p9EntrySel = null;
    const ed = container.querySelector("#p9-pr-editor");
    if (ed) ed.innerHTML = '<div class="text-center opacity-40 py-8">未选择条目。从左侧列表选择后在此编辑</div>';
    _p9RenderEntryList(container);
  } catch (e) { list.innerHTML = `<div class="p-2 text-error">${_esc(e?.message || e)}</div>`; }
}

function _p9RenderEntryList(container) {
  const list = container.querySelector("#p9-pr-list");
  if (!list) return;
  list.innerHTML = _p9Entries.map((en, i) => {
    const id = en.identifier || en.name || `entry_${i}`;
    const enabled = en.enabled !== false;
    const isMarker = _P9_MARKERS.includes(id);
    const roleBadge = en.role === "user" ? "U" : en.role === "assistant" ? "A" : "S";
    return `<div class="flex items-center gap-1 px-2 py-1 text-[11px] cursor-pointer hover:bg-base-200/50 border-b border-base-300/30 ${i === _p9EntrySel ? "bg-warning/15" : ""} ${enabled ? "" : "opacity-40"}" data-p9idx="${i}">
      <span class="badge badge-xs badge-ghost" title="身份: ${_esc(en.role || "system")}">${roleBadge}</span>
      <span class="flex-1 truncate" title="${_esc(en.name || id)}">${_esc(en.name || id)}</span>
      ${isMarker ? '<span class="badge badge-xs badge-ghost" title="位置标记：内容运行时从模块提取，顺序参与组装">标记</span>' : ""}
      <span class="flex flex-col leading-none shrink-0">
        <button class="opacity-40 hover:opacity-100" data-p9move="${i}:-1" title="上移（顺序=组装顺序）">▲</button>
        <button class="opacity-40 hover:opacity-100" data-p9move="${i}:1" title="下移">▼</button>
      </span>
    </div>`;
  }).join("") || '<div class="p-2 opacity-40">无条目（绑定预设不存在或为空）</div>';
  list.querySelectorAll("[data-p9idx]").forEach((el) => el.addEventListener("click", () => {
    _p9EntrySel = Number(el.dataset.p9idx);
    _p9RenderEntryList(container);
    _p9RenderEntryEditor(container);
  }));
  list.querySelectorAll("[data-p9move]").forEach((btn) => btn.addEventListener("click", (ev) => {
    ev.stopPropagation(); // 别触发行选中
    const [i, d] = btn.dataset.p9move.split(":").map(Number);
    _p9MoveEntry(container, i, d);
  }));
}

// 上/下移=整表 reorder_entries 提交（marker 同样可移动：位置决定组装顺序，同预设面板语义）
async function _p9MoveEntry(container, i, delta) {
  const j = i + delta;
  if (i < 0 || i >= _p9Entries.length || j < 0 || j >= _p9Entries.length) return;
  const sel = _p9EntrySel != null ? _p9Entries[_p9EntrySel] : null;
  [_p9Entries[i], _p9Entries[j]] = [_p9Entries[j], _p9Entries[i]];
  if (sel) _p9EntrySel = _p9Entries.indexOf(sel);
  _p9RenderEntryList(container);
  try {
    await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), reorder_entries: { order: _p9Entries.map((x) => x.identifier || x.name) } } });
  } catch (e) {
    const m = container.querySelector("#p9-pr-msg");
    if (m) m.textContent = `排序保存失败: ${e?.message || e}`;
    _p9LoadEntries(container); // 失败回读真值，防 UI 与盘不一致
  }
}

function _p9RenderEntryEditor(container) {
  const host = container.querySelector("#p9-pr-editor");
  const en = _p9Entries[_p9EntrySel];
  if (!host || !en) return;
  const id = en.identifier || en.name || `entry_${_p9EntrySel}`;
  const isMarker = _P9_MARKERS.includes(id);
  const isInj = !!en.injection_position;
  host.innerHTML = `<div class="space-y-2 text-xs">
    <div class="flex items-center justify-between">
      <span class="font-bold">${isMarker ? "位置标记（内容运行时从模块提取）" : "条目编辑"}</span>
      <span class="flex gap-1">
        ${isMarker ? "" : '<button id="p9-pr-copy" class="btn btn-xs btn-ghost" title="复制条目内容">复制</button><button id="p9-pr-del" class="btn btn-xs btn-ghost text-error" title="删除条目">删除</button>'}
      </span>
    </div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">名称</label><input id="p9-pr-name" type="text" class="input input-xs input-bordered flex-1" value="${_esc(en.name || id)}" /></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">启用</label><input id="p9-pr-enabled" type="checkbox" class="toggle toggle-xs" ${en.enabled !== false ? "checked" : ""} /></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">角色</label><select id="p9-pr-role" class="select select-xs select-bordered flex-1">
      <option value="system" ${en.role === "system" || !en.role ? "selected" : ""}>system</option>
      <option value="user" ${en.role === "user" ? "selected" : ""}>user</option>
      <option value="assistant" ${en.role === "assistant" ? "selected" : ""}>assistant</option>
    </select></div>
    <div class="flex items-center gap-2"><label class="opacity-60 w-10 shrink-0">类型</label><select id="p9-pr-type" class="select select-xs select-bordered flex-1" ${isMarker ? 'disabled title="位置标记按列表顺序参与组装，类型不可改"' : ""}>
      <option value="system_prompt" ${!isInj ? "selected" : ""}>系统提示词</option>
      <option value="injection" ${isInj ? "selected" : ""}>注入 (Injection)</option>
    </select></div>
    <div id="p9-pr-depth-row" class="flex items-center gap-2 ${isInj ? "" : "hidden"}"><label class="opacity-60 w-10 shrink-0">深度</label><input id="p9-pr-depth" type="number" min="0" max="999" class="input input-xs input-bordered w-20" value="${en.depth || 0}" ${isMarker ? "disabled" : ""} /></div>
    ${isMarker ? '<div class="p-2 rounded border border-base-300/40 bg-base-200/30 text-[10px] opacity-60">此条目内容运行时从对应模块提取，无法在此编辑；名称/启用/角色/顺序可改。</div>' : `<div class="relative expandable-container">
      <textarea id="p9-pr-content" class="textarea textarea-bordered w-full font-mono text-[11px]" rows="9" data-expandable data-expand-title="${_esc(en.name || id)}">${_esc(en.content ?? en.content_preview ?? "")}</textarea>
      <button class="expand-btn" title="放大编辑"><i data-ic="fullscreen"></i></button>
    </div>`}
    <button id="p9-pr-save" class="btn btn-xs btn-primary w-full">保存条目</button>
  </div>`;
  host.querySelector("#p9-pr-type")?.addEventListener("change", (ev) => {
    host.querySelector("#p9-pr-depth-row")?.classList.toggle("hidden", ev.target.value !== "injection");
  });
  host.querySelector("#p9-pr-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(host.querySelector("#p9-pr-content")?.value ?? "");
      window._beiluToast?.("条目内容已复制", "success");
    } catch (e) { window._beiluToast?.(`复制失败: ${e?.message || e}`, "error"); }
  });
  host.querySelector("#p9-pr-del")?.addEventListener("click", async () => {
    const isCore = id.startsWith("p9-");
    if (isCore) {
      const restore = confirm(`「${en.name || id}」是 P9 核心预设条目。\n\n删除后可能影响 P9 词库维护功能。\n确定删除？删除后可在面板底部点击「恢复默认预设」从核心恢复。`);
      if (!restore) return;
    } else {
      if (!confirm(`删除条目「${en.name || id}」？`)) return;
    }
    try {
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), delete_entry: { identifier: id } } });
      await _p9LoadEntries(container);
      if (isCore) window._beiluToast?.("核心条目已删除。如需恢复，点击面板底部「恢复默认预设」", "warning");
    } catch (e) { const m = container.querySelector("#p9-pr-msg"); if (m) m.textContent = `删除失败: ${e?.message || e}`; }
  });
  // 保存：enabled 走 toggle_entry（引擎真值在 prompt_order，禁塞进 props——settings/panels.mjs:483-501 同口径）
  host.querySelector("#p9-pr-save")?.addEventListener("click", async () => {
    const enabled = !!host.querySelector("#p9-pr-enabled")?.checked;
    const props = {
      name: host.querySelector("#p9-pr-name")?.value?.trim() || id,
      role: host.querySelector("#p9-pr-role")?.value || "system",
    };
    const updatePayload = { identifier: id, props };
    if (!isMarker) {
      const inj = host.querySelector("#p9-pr-type")?.value === "injection";
      updatePayload.content = host.querySelector("#p9-pr-content")?.value ?? "";
      props.system_prompt = !inj;
      props.injection_position = inj ? 1 : 0;
      props.injection_depth = inj ? (parseInt(host.querySelector("#p9-pr-depth")?.value) || 0) : 0;
    }
    const m = container.querySelector("#p9-pr-msg");
    try {
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), toggle_entry: { identifier: id, enabled } } });
      await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), update_entry: updatePayload } });
      if (m) m.textContent = "条目已保存";
      const keepSel = _p9EntrySel;
      await _p9LoadEntries(container);
      _p9EntrySel = keepSel != null && keepSel < _p9Entries.length ? keepSel : null;
      if (_p9EntrySel != null) { _p9RenderEntryList(container); _p9RenderEntryEditor(container); }
    } catch (e) { if (m) m.textContent = `保存失败: ${e?.message || e}`; }
  });
}

async function _p9AddEntry(container) {
  const m = container.querySelector("#p9-pr-msg");
  try {
    // identifier 生成同预设面板 add_entry 语义：唯一即可（时间戳足够，用户可改名称）
    const newId = `p9_entry_${Date.now()}`;
    await sendAction({ verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web", payload: { _target_preset: _p9PresetName(), add_entry: { identifier: newId, name: "新条目", role: "system", content: "", system_prompt: true, enabled: true } } });
    await _p9LoadEntries(container);
    const idx = _p9Entries.findIndex((x) => (x.identifier || x.name) === newId);
    if (idx >= 0) { _p9EntrySel = idx; _p9RenderEntryList(container); _p9RenderEntryEditor(container); }
  } catch (e) { if (m) m.textContent = `添加失败: ${e?.message || e}`; }
}
