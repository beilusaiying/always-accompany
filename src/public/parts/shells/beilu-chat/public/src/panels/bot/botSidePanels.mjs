/**
 * botSidePanels.mjs — Bot 模式侧边栏面板（日志 [L] / 监控 [O]）
 *
 * 功能链：
 *   renderBotLogPanel → GET /api/parts/shells:<shell>/bot-logs
 *     → 渲染 #bot-side-log 容器（时间戳 + 平台 + 消息级别彩色行）
 *   renderBotOverviewPanel → GET /api/parts/shells:<shell>/bot-status
 *     → 渲染 #bot-side-monitor 容器（在线状态 / 延迟 / 服务器数 / 频道数 + 最近错误）
 *   BR2 [O] 监控红点机制：
 *     后端各 bot 壳运行错误 → botErrorBroadcast.mjs → broadcast.mjs broadcastAllChatUi({type:"bot_error"})
 *     → websocket.mjs handleBroadcastEvent → window 事件 beilu:bot-error
 *     → 本模块监听 → _botErrorCount++ + _recentBotErrors 队列（最多 50 条）
 *     → _refreshBotErrorBadge → [O] 活动栏按钮右上角红点 + 计数
 *     → 点 [O] 打开监控面板 → renderBotOverviewPanel 展示最近错误 → 红点清零
 *
 * why（红点按需注入而非写 index.html）：
 *   Bot 错误红点 DOM 由本模块在运行时动态注入到 [O] 按钮上，
 *   与 FT-D10 [B] 绿点（layout.mjs .bot-run-badge）同型，但独立管理；
 *   不改 layout.mjs / index.html，避免非 Bot 模式渲染无用 DOM。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（日志/状态 REST 拉取）
 *   → shared/state/storage.mjs KEYS.BEILU_BOT_PLATFORM（当前平台 discord/telegram/...）
 *   → panels/bot/discordBotPanel.mjs platformToShell（平台名 → shell 名转换）
 *   ← layout.mjs（Bot 活动栏 [L] / [O] 按钮点击时调用对应 render 函数）
 *   ← discordBotPanel.mjs renderBotOverviewPanel（[B] 面板内"查看监控"入口）
 *   ← websocket.mjs（派发 beilu:bot-error 事件，本模块消费）
 *
 * 影响范围：
 *   #bot-side-log / #bot-side-monitor 容器 DOM；
 *   [data-bot-panel="monitor"] 按钮上的红点 .bot-error-badge 动态注入；
 *   _botErrorCount / _recentBotErrors 内存状态（刷新后重置）。
 *
 * 使用效果：
 *   Bot 运行出错 → [O] 按钮右上角立刻出现红点（N 条）；
 *   点 [O] → 监控面板展示在线状态 + 最近错误详情 → 红点清零；
 *   点 [L] → 日志面板实时拉取并展示最新运行日志。
 */

import { escapeHtml as escHtml } from "../../shared/state/utils.mjs";
import { platformToShell, PLATFORM_SCHEMA } from "./discordBotPanel.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（shells:_bot 动态壳，payload._shell=当前平台壳名，verb=真动作）
import { storage, KEYS } from "../../shared/state/storage.mjs"; // R2: localStorage 集中

/* ============================================================
 * BR2: [O] 监控错误红点 consumer
 *   producer 链：各 bot 壳 runBot/bot.catch → shells/botErrorBroadcast.mjs
 *     → broadcast.mjs broadcastAllChatUi({type:"bot_error"})
 *     → websocket.mjs handleBroadcastEvent → window 事件 beilu:bot-error
 *   本模块在活动栏 [O] 监控按钮（[data-bot-panel="monitor"]）上挂红点 + 计数，
 *   与 FT-D10 [B] 绿点（layout.mjs .bot-run-badge）同型；打开监控面板即清零。
 *   红点 DOM 由本模块按需注入（不改 layout.mjs / index.html）。
 * ========================================================== */

let _botErrorCount = 0;
const _recentBotErrors = []; // 最近若干条错误，供监控面板「运行状态」展示

/** 在 [O] 监控活动栏按钮上确保存在红点元素并刷新计数显示。 */
function _refreshBotErrorBadge() {
  const btn = document.querySelector('[data-bot-panel="monitor"]');
  if (!btn) return;
  btn.style.position = btn.style.position || "relative";
  let dot = btn.querySelector(".bot-error-badge");
  if (!dot) {
    dot = document.createElement("span");
    dot.className = "bot-error-badge hidden";
    dot.style.cssText =
      "position:absolute;top:0;right:0;min-width:14px;height:14px;line-height:14px;padding:0 3px;border-radius:7px;background:var(--beilu-error);color:#fff;font-size:9px;text-align:center;font-weight:600;";
    btn.appendChild(dot);
  }
  if (_botErrorCount > 0) {
    dot.textContent = _botErrorCount > 99 ? "99+" : String(_botErrorCount);
    dot.title = `Bot 错误 ${_botErrorCount} 条（点击 [O] 监控查看）`;
    dot.classList.remove("hidden");
  } else {
    dot.classList.add("hidden");
  }
}

// 模块加载即注册一次（botSidePanels 在 layout 初始化时被 import，监听器只绑一次）
if (typeof window !== "undefined" && !window.__beiluBotErrorBound) {
  window.__beiluBotErrorBound = true;
  window.addEventListener("beilu:bot-error", (e) => {
    const d = e?.detail || {};
    _botErrorCount++;
    _recentBotErrors.push({
      platform: d.platform || "",
      botname: d.botname || "",
      phase: d.phase || "",
      message: d.message || "",
      timestamp: d.timestamp || new Date().toISOString(),
    });
    if (_recentBotErrors.length > 50) _recentBotErrors.splice(0, _recentBotErrors.length - 50);
    _refreshBotErrorBadge();
  });
}

/** 当前 Bot 平台对应的 shell 名（与列表面板保持同步，默认 discord）。 */
function _curShell() {
	let p = "discord";
	try { p = storage.get(KEYS.BEILU_BOT_PLATFORM) || "discord"; } catch { /* ignore */ }
	return platformToShell(p);
}

// 当前平台显示名（icon+label 从 PLATFORM_SCHEMA 单源取，不再读 header 元素 textContent——
// icon 已改为 '<i data-ic="...">'，读 textContent 会得空串；schema 是平台图标/名的唯一真源。
// 返回值进 L356/397 的 innerHTML 模板，故 <i> 可正常渲染）
function _curPlatformLabel() {
	let p = "discord";
	try { p = storage.get(KEYS.BEILU_BOT_PLATFORM) || "discord"; } catch { /* ignore */ }
	const schema = PLATFORM_SCHEMA[p] || PLATFORM_SCHEMA.discord;
	return `${schema.icon} ${escHtml(schema.label)}`;
}

/* ============================================================
 * 内部工具
 * ========================================================== */

// 端点按当前选中平台的 shell 动态解析（10 壳端点同构），避免在非 Discord 平台拉到 Discord 数据。
// T6b：全走 sendAction 的 shells:_bot 动态壳路由，payload._shell=_curShell()；sendAction 直接返回解析体，!ok 抛错。
const BOT_API = {
	getBotList: () =>
		sendAction({ verb: "getBotList", target: "shells:_bot", source: "web", payload: { _shell: _curShell() } }),
	getRunningBotList: () =>
		sendAction({ verb: "getRunningBotList", target: "shells:_bot", source: "web", payload: { _shell: _curShell() } }),
	getMessageLog: (name, since) =>
		sendAction({ verb: "getMessageLog", target: "shells:_bot", source: "web", payload: { _shell: _curShell(), botname: name, since } }),
	getActiveChannels: (name) =>
		sendAction({ verb: "getActiveChannels", target: "shells:_bot", source: "web", payload: { _shell: _curShell(), botname: name } }),
};

/** 后端缺接口时的统一占位块 */
function pendingBackend(text) {
	return `<div class="text-[11px] border rounded px-2 py-1.5 flex items-start gap-1.5" style="color:var(--beilu-amber-70);background:var(--beilu-amber-5);border-color:var(--beilu-amber-20)">
		<span class="shrink-0"><i data-ic="hourglass"></i></span><span>${escHtml(text)}</span>
	</div>`;
}




/* ============================================================
 * [L] 日志面板 — 完整消息日志列表
 *   注意：bot-side-log 内已有 <div id="bot-side-log-content">。
 *   本渲染重建整个 bot-side-log 内容（含过滤栏 + 列表 + 统计 + 导出）。
 * ========================================================== */

let _logState = { bot: null, sinceTs: 0, timer: null, count: 0 };
const _logEntries = [];
const _logChannels = new Set();

function renderLogEntryHtml(entry) {
	const t = entry.type === "user" ? "user" : entry.type === "error" ? "error" : "ai";
	const icon = t === "user" ? '<i data-ic="person"></i>' : t === "error" ? '<i data-ic="warning"></i>' : '<i data-ic="bot"></i>';
	const color = t === "user" ? "border-info" : t === "error" ? "border-error" : "border-success";
	const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "";
	const content = (entry.content || "").slice(0, 300);
	const more = (entry.content || "").length > 300 ? "..." : "";
	return `<div class="p-1.5 rounded bg-base-300/40 border-l-2 ${color}">
		<div class="flex items-center gap-1 opacity-60 text-[10px] mb-0.5">
			<span>${icon}</span>
			<span class="font-semibold">${escHtml(entry.author || "")}</span>
			<span>${escHtml(entry.channelName || "")}</span>
			<span class="ml-auto">${escHtml(time)}</span>
		</div>
		<div class="whitespace-pre-wrap break-words text-[11px]">${escHtml(content)}${more}</div>
	</div>`;
}

async function pollLog() {
	const listEl = document.getElementById("bot-log-list");
	const emptyEl = document.getElementById("bot-log-empty");
	const statEl = document.getElementById("bot-log-stat");
	const statusEl = document.getElementById("bot-log-status");
	if (!listEl) return;
	if (!_logState.bot) {
		if (statusEl) statusEl.textContent = "未选择 Bot";
		return;
	}
	try {
		const running = (await BOT_API.getRunningBotList())?.includes?.(_logState.bot);
		if (statusEl) statusEl.textContent = running ? "运行中" : "未运行";
		const data = await BOT_API.getMessageLog(_logState.bot, _logState.sinceTs || undefined);
		const logs = data?.logs || [];
		if (logs.length) {
			if (emptyEl) emptyEl.classList.add("hidden");
			const channelSel = document.getElementById("bot-log-channel");
			for (const e of logs) {
				_logEntries.push(e);
				const html = renderLogEntryHtml(e);
				const wrapper = document.createElement("div");
				wrapper.innerHTML = html;
				const el = wrapper.firstElementChild;
				if (el) {
					el.dataset.channel = e.channelName || "";
					el.dataset.ts = String(e.timestamp || 0);
					listEl.appendChild(el);
				}
				_logState.count++;
				if (e.timestamp > _logState.sinceTs) _logState.sinceTs = e.timestamp;
				if (e.channelName && !_logChannels.has(e.channelName)) {
					_logChannels.add(e.channelName);
					if (channelSel) {
						const opt = document.createElement("option");
						opt.value = e.channelName;
						opt.textContent = e.channelName;
						channelSel.appendChild(opt);
					}
				}
			}
			listEl.scrollTop = listEl.scrollHeight;
			if (statEl) statEl.textContent = `本次会话已加载 ${_logState.count} 条`;
		}
	} catch {
		if (statusEl) statusEl.textContent = "拉取失败";
	}
}

function stopLogPolling() {
	if (_logState.timer) { clearInterval(_logState.timer); _logState.timer = null; }
}

export function renderBotLogPanel() {
	const container = document.getElementById("bot-side-log");
	if (!container) return;
	container.innerHTML = `
		<div class="flex flex-col h-full min-h-0 gap-1.5">
			<div class="flex items-center justify-between shrink-0">
				<h4 class="text-xs font-bold opacity-60"><i data-ic="clipboard"></i> 消息日志</h4>
				<span id="bot-log-status" class="text-[10px] opacity-40">未选择 Bot</span>
			</div>
			<div class="flex flex-wrap gap-1 shrink-0">
				<select id="bot-log-botsel" class="select select-xs select-bordered text-[11px] flex-1 min-w-0">
					<option value="">(全部 Bot)</option>
				</select>
				<select id="bot-log-channel" class="select select-xs select-bordered text-[11px]"><option value="">全部频道</option></select>
				<select id="bot-log-time" class="select select-xs select-bordered text-[11px]"><option value="">全部时间</option><option value="1h">最近1小时</option><option value="today">今天</option><option value="week">本周</option></select>
			</div>
			<div class="flex gap-1 shrink-0">
				<input id="bot-log-search" type="text" class="input input-xs input-bordered flex-1 text-[11px]" placeholder="搜索（前端过滤已加载项）" />
			</div>
			<div id="bot-log-list" class="flex-1 min-h-[120px] overflow-y-auto bg-base-200/40 rounded p-1.5 space-y-1 text-xs">
				<div id="bot-log-empty" class="text-center opacity-50 py-8">选择 Bot 后显示历史消息</div>
			</div>
			<div class="flex items-center justify-between shrink-0 text-[10px] opacity-60">
				<span id="bot-log-stat">本次会话已加载 0 条</span>
				<button id="bot-log-export" class="btn btn-xs btn-ghost"><i data-ic="upload"></i> 导出</button>
			</div>
		</div>`;

	const botSel = container.querySelector("#bot-log-botsel");
	const listEl = container.querySelector("#bot-log-list");
	const emptyEl = container.querySelector("#bot-log-empty");
	const searchEl = container.querySelector("#bot-log-search");

	// 填充 Bot 下拉（复用 getbotlist）
	BOT_API.getBotList()
		.then((data) => {
			const names = Array.isArray(data) ? data : (data?.list || data?.bots || []);
			for (const n of names) {
				const name = typeof n === "string" ? n : (n?.name || "");
				if (!name) continue;
				const opt = document.createElement("option");
				opt.value = name;
				opt.textContent = name;
				botSel?.appendChild(opt);
			}
		})
		.catch(() => { /* 静默：后端不可用时仅显示 全部 Bot */ });

	botSel?.addEventListener("change", () => {
		stopLogPolling();
		_logEntries.length = 0;
		_logChannels.clear();
		const channelSel = container.querySelector("#bot-log-channel");
		if (channelSel) { channelSel.innerHTML = '<option value="">全部频道</option>'; }
		_logState = { bot: botSel.value || null, sinceTs: 0, timer: null, count: 0 };
		if (listEl) listEl.innerHTML = `<div id="bot-log-empty" class="text-center opacity-50 py-8">${_logState.bot ? "加载中…" : "选择 Bot 后显示历史消息"}</div>`;
		if (_logState.bot) {
			pollLog();
			_logState.timer = setInterval(pollLog, 5000);
		}
	});

	const _applyFilters = () => {
		const q = (searchEl?.value || "").trim().toLowerCase();
		const ch = container.querySelector("#bot-log-channel")?.value || "";
		const timeVal = container.querySelector("#bot-log-time")?.value || "";
		let cutoff = 0;
		if (timeVal === "1h") cutoff = Date.now() - 3600000;
		else if (timeVal === "today") { const d = new Date(); d.setHours(0,0,0,0); cutoff = d.getTime(); }
		else if (timeVal === "week") cutoff = Date.now() - 7 * 86400000;
		Array.from(listEl?.children || []).forEach((el) => {
			if (el.id === "bot-log-empty") return;
			let show = true;
			if (q && !el.textContent.toLowerCase().includes(q)) show = false;
			if (ch && el.dataset.channel !== ch) show = false;
			if (cutoff && Number(el.dataset.ts || 0) < cutoff) show = false;
			el.classList.toggle("hidden", !show);
		});
	};

	searchEl?.addEventListener("input", _applyFilters);
	container.querySelector("#bot-log-channel")?.addEventListener("change", _applyFilters);
	container.querySelector("#bot-log-time")?.addEventListener("change", _applyFilters);

	container.querySelector("#bot-log-export")?.addEventListener("click", () => {
		if (!_logEntries.length) { window._beiluToast?.("无日志可导出", "warning"); return; }
		const text = _logEntries.map(e => `[${new Date(e.timestamp).toISOString()}] [${e.channelName || ""}] ${e.author || ""}: ${e.content || ""}`).join("\n");
		const blob = new Blob([text], { type: "text/plain" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `bot-log-${_logState.bot || "all"}-${Date.now()}.txt`;
		a.click();
		URL.revokeObjectURL(a.href);
	});
}

/** layout 在离开日志面板时可调用以停止轮询（可选） */
export function stopBotLogPanel() {
	stopLogPolling();
	_logEntries.length = 0;
	_logChannels.clear();
}

/* ============================================================
 * [O] 监控面板 — 运行状态 / 连接 / 跨模式（内 Tab）
 * ========================================================== */

const MONITOR_TABS = {
	status: async () => {
		let running = [];
		try { running = (await BOT_API.getRunningBotList()) || []; } catch { running = null; }
		if (running === null) {
			return `<div class="text-xs font-bold opacity-60 mb-1">运行状态</div>${pendingBackend("getrunningbotlist 拉取失败或后端未启动。")}`;
		}
		const rows = running.length
			? running
					.map(
						(b) =>
							`<div class="flex items-center gap-2 px-2 py-1 bg-base-300/40 rounded text-[11px]"><span class="w-2 h-2 rounded-full bg-success shrink-0"></span><span class="font-semibold">${escHtml(typeof b === "string" ? b : (b?.name || ""))}</span><span class="opacity-50 ml-auto">运行中</span></div>`,
					)
					.join("")
			: `<div class="text-center opacity-50 py-4 text-[11px]">当前无运行中的 Bot</div>`;
		// BR2: 近期 Bot 错误（producer=各 bot 壳 → bot_error 事件，本会话累积）
		const errHtml = _recentBotErrors.length
			? `<div class="text-xs font-bold opacity-60 mt-3 mb-1"><i data-ic="warning"></i> 近期错误 (${_botErrorCount})</div>
				<div class="space-y-1 text-[11px]">${_recentBotErrors
					.slice(-10)
					.reverse()
					.map((er) => {
						const t = er.timestamp ? new Date(er.timestamp).toLocaleTimeString() : "";
						const phaseLabel = er.phase === "start" ? "启动" : er.phase === "connect" ? "连接" : "运行时";
						return `<div class="px-2 py-1 bg-error/10 border-l-2 border-error rounded"><div class="flex items-center gap-1 opacity-60 text-[10px]"><span class="font-semibold">${escHtml(er.botname || "?")}</span><span>${escHtml(er.platform || "")}</span><span class="ml-auto">${escHtml(phaseLabel)} · ${escHtml(t)}</span></div><div class="whitespace-pre-wrap break-words text-error/90">${escHtml(er.message || "")}</div></div>`;
					})
					.join("")}</div>`
			: "";
		return `
			<div class="text-xs font-bold opacity-60 mb-1">${_curPlatformLabel()} 运行状态</div>
			<div class="space-y-1">${rows}</div>
			${errHtml}
			<div class="mt-2">${pendingBackend("每 Bot 的运行时长/频道数/今日条数/Token 等聚合统计等后端（设计 P2）。")}</div>`;
	},
	conn: async () => {
		let running = [];
		try { running = (await BOT_API.getRunningBotList()) || []; } catch { running = null; }
		const dc = running === null
			? `<span class="text-error">拉取失败</span>`
			: running.length
				? `<span class="text-success"><span class="status status-success"></span> 有运行中 Bot (${running.length})</span>`
				: `<span class="opacity-50"><span class="status" style="opacity:.4"></span> 无运行中 Bot</span>`;

		// 活跃频道：对每个运行中 Bot 拉 activechannels（[{channelId, messageCount}]）
		let channelHtml = "";
		if (Array.isArray(running) && running.length) {
			const names = running.map((b) => (typeof b === "string" ? b : (b?.name || ""))).filter(Boolean);
			const perBot = await Promise.all(
				names.map(async (name) => {
					try {
						const chans = await BOT_API.getActiveChannels(name);
						const list = Array.isArray(chans) ? chans : (chans?.channels || []);
						if (!list.length) {
							return `<div class="px-2 py-1 bg-base-300/30 rounded"><span class="font-semibold">${escHtml(name)}</span><span class="opacity-40 ml-1">无活跃频道</span></div>`;
						}
						const rows = list
							.map((c) => `<div class="flex justify-between pl-3 opacity-70"><span class="font-mono truncate">${escHtml(String(c.channelId ?? c.id ?? ""))}</span><span class="opacity-60">${c.messageCount ?? 0} 条</span></div>`)
							.join("");
						return `<div class="px-2 py-1 bg-base-300/30 rounded"><div class="font-semibold">${escHtml(name)} <span class="opacity-40">(${list.length} 频道)</span></div>${rows}</div>`;
					} catch {
						return `<div class="px-2 py-1 bg-base-300/30 rounded"><span class="font-semibold">${escHtml(name)}</span><span class="text-error ml-1 text-[10px]">频道拉取失败</span></div>`;
					}
				}),
			);
			channelHtml = `<div class="text-xs font-bold opacity-60 mt-3 mb-1">活跃频道</div><div class="space-y-1 text-[11px]">${perBot.join("")}</div>`;
		}

		return `
			<div class="text-xs font-bold opacity-60 mb-1">连接状态</div>
			<div class="space-y-1 text-[11px]">
				<div class="flex items-center gap-2 px-2 py-1 bg-base-300/40 rounded">${_curPlatformLabel()} 连接: ${dc}</div>
			</div>
			${channelHtml}
			<div class="mt-2">${pendingBackend("Gateway 延迟 / 事件流时间线 / 多平台连接探活等后端（Probe 健康检查，设计 P2）。")}</div>`;
	},
	stats: async () => {
		let allBots = [], running = [], totalChannels = 0, totalMsgs = 0;
		try { allBots = (await BOT_API.getBotList()) || []; } catch {}
		try { running = (await BOT_API.getRunningBotList()) || []; } catch {}
		const botNames = (Array.isArray(allBots) ? allBots : (allBots?.list || allBots?.bots || [])).map(b => typeof b === "string" ? b : (b?.name || "")).filter(Boolean);
		const runNames = (Array.isArray(running) ? running : []).map(b => typeof b === "string" ? b : (b?.name || "")).filter(Boolean);
		for (const name of runNames) {
			try {
				const chans = await BOT_API.getActiveChannels(name);
				const list = Array.isArray(chans) ? chans : (chans?.channels || []);
				totalChannels += list.length;
				totalMsgs += list.reduce((s, c) => s + (c.messageCount || 0), 0);
			} catch {}
		}
		const sessionErrors = _recentBotErrors?.length || 0;
		return `
			<div class="text-xs font-bold opacity-60 mb-1">聚合统计</div>
			<div class="space-y-1 text-[11px]">
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>Bot 总数</span><span class="font-mono">${botNames.length}</span></div>
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>运行中</span><span class="font-mono text-success">${runNames.length}</span></div>
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>活跃频道</span><span class="font-mono">${totalChannels}</span></div>
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>缓冲区消息数</span><span class="font-mono">${totalMsgs}</span></div>
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>本次会话错误</span><span class="font-mono ${sessionErrors ? "text-error" : ""}">${sessionErrors}</span></div>
				<div class="flex justify-between px-2 py-1 bg-base-300/40 rounded"><span>已加载日志</span><span class="font-mono">${_logEntries.length}</span></div>
			</div>
			<div class="text-[10px] opacity-40 mt-2">数据来自现有接口聚合。运行时长/Token消耗需后端支持。</div>`;
	},
	cross: async () => {
		const errors = _recentBotErrors || [];
		const errRows = errors.length
			? errors.slice(-10).reverse().map(e => `<div class="px-2 py-1 bg-base-300/40 rounded border-l-2 border-error text-[11px]"><span class="opacity-50">${escHtml(new Date(e.timestamp || Date.now()).toLocaleTimeString())}</span> ${escHtml(e.botname || "")}：${escHtml(e.message || "")}</div>`).join("")
			: '<div class="px-2 py-1 bg-base-300/40 rounded opacity-50">无错误事件</div>';
		return `
			<div class="text-xs font-bold opacity-60 mb-1">跨模式事件</div>
			<div class="space-y-1 text-[11px]">
				<div class="px-2 py-1 bg-base-300/40 rounded">活跃委派：<span class="opacity-50">需P1跨模式集成架构</span></div>
				<div class="px-2 py-1 bg-base-300/40 rounded">记忆同步：<span class="opacity-50">需P1跨模式集成架构</span></div>
			</div>
			<div class="text-xs font-bold opacity-60 mt-3 mb-1">Bot 错误事件（本次会话）</div>
			<div class="space-y-1">${errRows}</div>`;
	},
};

export function renderBotMonitorPanel() {
	const container = document.getElementById("bot-side-monitor");
	if (!container) return;
	// BR2: 打开监控面板 = 已查看错误，红点计数清零（保留 _recentBotErrors 列表供展示）
	_botErrorCount = 0;
	_refreshBotErrorBadge();
	container.innerHTML = `
		<div class="flex flex-col h-full min-h-0 gap-1.5">
			<div class="flex items-center justify-between shrink-0">
				<h4 class="text-xs font-bold opacity-60"><i data-ic="chart"></i> 监控</h4>
				<button id="bot-mon-refresh" class="btn btn-xs btn-ghost" title="刷新"><i data-ic="refresh"></i> 刷新</button>
			</div>
			<div class="flex gap-0.5 text-[10px] shrink-0">
				<button class="bot-mon-tab flex-1 py-1 border rounded font-semibold" style="background:var(--beilu-amber-15);color:var(--beilu-amber-dark,#8b6914)" data-tab="status">运行状态</button>
				<button class="bot-mon-tab flex-1 py-1 border rounded opacity-70" data-tab="stats">统计</button>
				<button class="bot-mon-tab flex-1 py-1 border rounded opacity-70" data-tab="conn">连接</button>
				<button class="bot-mon-tab flex-1 py-1 border rounded opacity-70" data-tab="cross">跨模式</button>
			</div>
			<div id="bot-mon-body" class="flex-1 min-h-0 overflow-y-auto space-y-1.5"></div>
		</div>`;

	const tabBtns = Array.from(container.querySelectorAll(".bot-mon-tab"));
	const body = container.querySelector("#bot-mon-body");
	let _cur = "status";

	const show = async (tab) => {
		_cur = tab;
		if (body) body.innerHTML = `<div class="text-center opacity-50 py-4 text-[11px]">加载中…</div>`;
		const html = await (MONITOR_TABS[tab] || MONITOR_TABS.status)();
		if (body) body.innerHTML = html;
	};

	tabBtns.forEach((btn) => {
		btn.addEventListener("click", () => {
			tabBtns.forEach((b) => {
				b.classList.remove("font-semibold");
				b.classList.add("opacity-70");
				b.style.background = ""; b.style.color = "";
			});
			btn.classList.add("font-semibold");
			btn.classList.remove("opacity-70");
			btn.style.background = "var(--beilu-amber-15)"; btn.style.color = "var(--beilu-amber-dark,#8b6914)";
			show(btn.dataset.tab);
		});
	});

	container.querySelector("#bot-mon-refresh")?.addEventListener("click", () => show(_cur));
	show("status");
}

/* ============================================================
 * Bot 总览（设计：前端计划/Bot模式_界面设计.md §Bot总览面板）
 *   设计稿：没选 Bot 时主区域显示跨平台统计（运行中/已停止/今日统计/最近事件）。
 *   纯前端：聚合已有端点 getbotlist + getrunningbotlist + messagelog(今日)。
 *   非 Discord 平台后端未接入 → 只统计 Discord，跨平台聚合等后端时再扩。
 *
 *   宿主：追加到 #bot-side-list 末尾的 #bot-overview-card（DOM 注入，不改 index.html）。
 *   由 discordBotPanel.loadBotList() 在列表刷新后调用。
 * ========================================================== */

export async function renderBotOverviewPanel() {
	const host = document.getElementById("bot-side-list");
	if (!host) return;
	let card = document.getElementById("bot-overview-card");
	if (!card) {
		card = document.createElement("div");
		card.id = "bot-overview-card";
		card.className = "mt-3 pt-2 border-t border-base-300/40 space-y-1.5";
		host.appendChild(card);
	}
	card.innerHTML = `<div class="flex items-center justify-between"><h4 class="text-xs font-bold opacity-60"><i data-ic="chart"></i> Bot 总览</h4><span class="text-[10px] opacity-50">加载中…</span></div>`;

	let all = [];
	let running = [];
	try {
		const list = await BOT_API.getBotList();
		all = Array.isArray(list) ? list.map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean) : [];
	} catch { all = null; }
	try { running = (await BOT_API.getRunningBotList()) || []; } catch { running = []; }

	if (all === null) {
		card.innerHTML = `<div class="flex items-center justify-between"><h4 class="text-xs font-bold opacity-60"><i data-ic="chart"></i> Bot 总览</h4></div>${pendingBackend("getbotlist 拉取失败或后端未启动。")}`;
		return;
	}

	const runSet = new Set(running.map((x) => (typeof x === "string" ? x : x?.name)));
	const stopped = all.filter((n) => !runSet.has(n));

	// 今日消息聚合：对运行中的 Bot 各拉一次 messagelog（since=今日0点），失败的跳过
	const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
	let todayCount = 0;
	let logsAvailable = false;
	await Promise.all(
		[...runSet].map(async (name) => {
			try {
				const data = await BOT_API.getMessageLog(name, todayStart.getTime());
				const logs = data?.logs || [];
				todayCount += logs.length;
				logsAvailable = true;
			} catch { /* 跳过该 Bot */ }
		}),
	);

	const runRows = running.length
		? running
				.map((b) => {
					const name = typeof b === "string" ? b : (b?.name || "");
					return `<div class="flex items-center gap-1.5 px-2 py-1 bg-base-300/40 rounded text-[11px]"><span class="w-1.5 h-1.5 rounded-full bg-success shrink-0"></span><span class="font-semibold truncate">${escHtml(name)}</span><span class="opacity-40 ml-auto">运行中</span></div>`;
				})
				.join("")
		: `<div class="text-center opacity-50 py-1.5 text-[11px]">无运行中 Bot</div>`;

	const stopRows = stopped.length
		? stopped
				.map(
					(n) =>
						`<div class="flex items-center gap-1.5 px-2 py-1 bg-base-300/20 rounded text-[11px]"><span class="w-1.5 h-1.5 rounded-full bg-base-content/20 shrink-0"></span><span class="truncate opacity-60">${escHtml(n)}</span><span class="opacity-50 ml-auto">已停止</span></div>`,
				)
				.join("")
		: "";

	card.innerHTML = `
		<div class="flex items-center justify-between">
			<h4 class="text-xs font-bold opacity-60"><i data-ic="chart"></i> Bot 总览</h4>
			<button id="bot-overview-refresh" class="btn btn-xs btn-ghost" title="刷新"><i data-ic="refresh"></i></button>
		</div>
		<div class="grid grid-cols-3 gap-1 text-center text-[10px]">
			<div class="bg-base-300/40 rounded py-1"><div class="font-bold text-sm">${running.length}/${all.length}</div><div class="opacity-50">运行中</div></div>
			<div class="bg-base-300/40 rounded py-1"><div class="font-bold text-sm">${logsAvailable ? todayCount : "—"}</div><div class="opacity-50">今日消息</div></div>
			<div class="bg-base-300/40 rounded py-1"><div class="font-bold text-sm">${all.length}</div><div class="opacity-50">Bot 总数</div></div>
		</div>
		<div class="text-[10px] font-semibold opacity-50 mt-1">运行中</div>
		<div class="space-y-0.5">${runRows}</div>
		${stopRows ? `<div class="text-[10px] font-semibold opacity-50 mt-1">已停止</div><div class="space-y-0.5">${stopRows}</div>` : ""}
		${logsAvailable ? "" : `<div class="mt-1">${pendingBackend("今日消息数：仅运行中 Bot 可拉 messagelog；Token/错误数/跨平台聚合等后端（设计 P2）。")}</div>`}
	`;
	card.querySelector("#bot-overview-refresh")?.addEventListener("click", () => renderBotOverviewPanel());
}

/* ============================================================
 * 统一入口：按子面板 key 渲染对应面板
 *   layout.mjs 在切换 bot 活动栏时调用：
 *     renderBotSidePanel("log" | "monitor")
 * ========================================================== */

export function renderBotSidePanel(key) {
	switch (key) {
		case "log": return renderBotLogPanel();
		case "monitor": return renderBotMonitorPanel();
		default: return undefined;
	}
}
