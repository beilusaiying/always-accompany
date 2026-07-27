/**
 * @file live.mjs — 直播接入（beilu-live 插件）面板 cluster
 *
 * 【位置惯例】插件前端独立成 panels/<tab>/<name>.mjs（同 eye.mjs），不塞进宿主 companion.mjs。
 *   配套样式独立成 css/live.css（同 airp.css），由 index.html <link> 挂载。
 *
 * 【功能链】
 *   切到 companion tab → companion.mjs initCompanionActivityBar 调 initCompanionLiveSettings()
 *   → getData 一次拉全 {enabled, config, capabilities, rules, platforms}
 *   → 平台下拉/凭据框按 platforms[] 动态渲染；min/max 按 capabilities 填；当前值按 config+rules 回填
 *   → 用户改动 → _livePost 差异层写入 → 后端 SetData → _deepMerge 落 per-user config.json
 *   → 点「开始接入」→ startLive → 后端 runtime 建 WS 连接 + 定时器轮
 *   → 3s 轮询 getStatus → 连接态灯 + 五格统计 + 拦截原因明细
 *
 * 【why 独立文件】
 *   companion.mjs 是桌宠形象/动态参数/图片包编辑器的宿主（2000 行），直播接入与它零业务耦合：
 *   不共享状态、不共享 DOM、不共享后端端点。塞进去只会让宿主继续膨胀，
 *   且模块级状态（_liveInited/_liveData/_liveStatusTimer）混在桌宠状态里难分辨归属。
 *
 * 【关联链】
 *   ← companion.mjs（import initCompanionLiveSettings，在 initCompanionActivityBar 内调用，
 *      调用处带 try + ?.catch() 双重捕获——本函数是 async，同步 try 挡不住 await 之后的异常）
 *   → shared/transport/sendAction.mjs（五条精确注册：getData/setData/startLive/stopLive/getStatus）
 *   → shared/state/utils.mjs（escapeHtml，动态渲染 option/label 时转义）
 *   → 后端 functions/live/{main,runtime,capabilities,registry,filter,pool}.mjs
 *   → index.html #comp-seg-live 段（33 个 comp-live-* id）+ css/live.css（语义类）
 *
 * 【零默认值副本】本文件不留任何数值/平台名/选项字面量——
 *   min/max/选项/平台/凭据控件全部来自后端 getData。写死一处 = 改了后端出厂值前端还显示旧的。
 * 【单一写点】所有配置写入只经 _livePost（散写 sendAction = 绕过收口）。
 * 【差异层写入】_livePost 只发改动的字段，禁把 getData 的响应整包回传——
 *   响应里的 capabilities 是【出厂默认】，整包回传会把它写进 per-user 差异层，
 *   日后改出厂默认会被用户文件里的旧值盖住（反向回灌，同 live/capabilities.mjs 同款警告）。
 * 【样式走语义类】状态灯/统计格/承载对话行用 live.css 的 .live-* 类，不用裸 daisyUI 工具类——
 *   工具类在项目自定义主题下未必映射到项目配色（--beilu-* 才是项目语义变量）。
 */
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs"; // 转义收口到唯一权威实现（同 companion.mjs:21 来源）

// ============================================================
// 模块级状态（随本模块隔离，不与桌宠状态混放）
// ============================================================

let _liveInited = false;
let _liveData = null;      // 最近一次 getData 结果 {enabled, config, capabilities, rules, platforms}
let _liveStatusTimer = null;

// ============================================================
// 工具
// ============================================================

/**
 * 段可见性门控：只在 companion tab 且 live 段都可见时轮询
 * （照 companionChat._visible 范式，避免切走后仍每 3 秒打后端）。
 */
function _liveVisible() {
  const tab = document.getElementById("center-tab-companion");
  const seg = document.getElementById("comp-seg-live");
  return !!(tab && !tab.classList.contains("hidden") && seg && !seg.classList.contains("hidden"));
}

/** 状态消息行。错误态走 live.css 的 .live-msg-error（红字经 --beilu-error，不硬编码色值）。 */
function _liveMsg(text, isErr) {
  const el = document.getElementById("comp-live-status-msg");
  if (el) { el.textContent = text || ""; el.className = "live-msg" + (isErr ? " live-msg-error" : ""); }
}

/** 唯一写点：差异层 patch → 后端 SetData → _deepMerge 落 per-user config.json */
async function _livePost(patch) {
  try {
    await sendAction({ verb: "setData", target: "plugins:beilu-live", source: "web", payload: patch });
    _liveMsg("已保存");
  } catch (e) {
    _liveMsg("保存失败: " + (e?.message || e), true);
  }
}

/** 配置字段写入（config 下的键）。与顶层 enabled 分开——后端 SetData 收 {enabled?, config?} 两个平级字段。 */
const _liveCfgPost = (kv) => _livePost({ config: kv });

// ============================================================
// 动态渲染（平台 / 凭据 / 参数值域）
// ============================================================

/**
 * 平台下拉 + 凭据控件：按 platforms[] 动态渲染。
 * 逐平台手写区块 = 硬编码（禁；registry.mjs listPlatformsForUI 注释承诺"加平台前端零改动"）。
 */
function _liveRenderPlatforms(platforms, cfg) {
  const sel = document.getElementById("comp-live-platform");
  if (!sel || !Array.isArray(platforms)) return;
  sel.innerHTML = platforms.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label || p.id)}</option>`).join("");
  if (cfg && cfg.platform) sel.value = cfg.platform;
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  _liveRenderCreds(platforms, sel.value, cfg);
}

/** 凭据输入框：按选中平台的 credentials[] 声明渲染（key/label/desc/type 全来自后端）。 */
function _liveRenderCreds(platforms, platformId, cfg) {
  const box = document.getElementById("comp-live-creds");
  if (!box) return;
  const entry = (platforms || []).find(p => p.id === platformId);
  const creds = (entry && Array.isArray(entry.credentials)) ? entry.credentials : [];
  const cur = (cfg && cfg.credentials && typeof cfg.credentials === "object") ? cfg.credentials : {};
  box.innerHTML = creds.map(c =>
    `<label class="form-control"><span class="label-text text-xs mb-1">${escapeHtml(c.label || c.key)} <span class="opacity-50">${escapeHtml(c.desc || "")}</span></span>` +
    `<input type="${c.type === "password" ? "password" : "text"}" data-live-cred="${escapeHtml(c.key)}" class="input input-xs input-bordered" placeholder="${escapeHtml(c.placeholder || "")}" /></label>`).join("");
  // 回填已存值（password 型也回填——用户要能看到自己填过；不显示=以为没填会重复填。这是配置面板不是登录框）
  box.querySelectorAll("[data-live-cred]").forEach(inp => {
    const k = inp.dataset.liveCred;
    if (cur[k]) inp.value = cur[k];
    inp.addEventListener("change", () => {
      // 只发变动的这一个键；后端 _deepMerge 会与既有 credentials 合并，不覆盖兄弟键
      _liveCfgPost({ credentials: { [inp.dataset.liveCred]: inp.value } });
    });
  });
  const help = entry && entry.credentialHelp;
  const hb = document.getElementById("comp-live-credhelp-box");
  const hp = document.getElementById("comp-live-credhelp");
  if (hb && hp) { hb.classList.toggle("hidden", !help); if (help) hp.textContent = help; }
}

/**
 * 从 capabilities 填 min/max，从 config/rules 填当前值。
 * 值缺失=不填（留 placeholder），不编造假数——离线拿兜底值渲染=假数字回灌。
 */
function _liveFillParams(caps, rules) {
  const bind = (id, spec, val) => {
    const el = document.getElementById(id);
    if (!el || !spec) return;
    if (Number.isFinite(spec.min)) el.min = spec.min;
    if (Number.isFinite(spec.max)) el.max = spec.max;
    if (Number.isFinite(spec.min) && Number.isFinite(spec.max)) el.placeholder = `${spec.min}-${spec.max}`;
    if (val != null) el.value = val;
  };
  const f = caps?.filter || {}, s = caps?.selector || {}, p = caps?.pacing || {};
  const rf = rules?.filter || {}, rs = rules?.selector || {}, rp = rules?.pacing || {};
  bind("comp-live-minlen", f.minLength, rf.minLength);
  bind("comp-live-maxlen", f.maxLength, rf.maxLength);
  bind("comp-live-cooldown", f.userCooldownSec, rf.userCooldownSec);
  bind("comp-live-dedup", f.dedupWindowSec, rf.dedupWindowSec);
  bind("comp-live-recentn", s.recentUserCount, rs.recentUserCount);
  // 轮间隔：后端存毫秒，面板显示秒（单位换算只在此一处，写回时反向换算）
  const iv = document.getElementById("comp-live-interval");
  if (iv && p.minRoundIntervalMs) {
    if (Number.isFinite(p.minRoundIntervalMs.min)) iv.min = Math.round(p.minRoundIntervalMs.min / 1000);
    if (Number.isFinite(p.minRoundIntervalMs.max)) iv.max = Math.round(p.minRoundIntervalMs.max / 1000);
    if (rp.minRoundIntervalMs != null) iv.value = Math.round(rp.minRoundIntervalMs / 1000);
  }
  const g = id => document.getElementById(id);
  if (g("comp-live-lastreplied")) g("comp-live-lastreplied").checked = rs.includeLastReplied !== false;
  if (g("comp-live-giftweight")) g("comp-live-giftweight").checked = rs.weightByGift !== false;
  if (g("comp-live-idleskip")) g("comp-live-idleskip").checked = rp.idleSkip !== false;
  if (g("comp-live-blacklist-on")) g("comp-live-blacklist-on").checked = rf.blacklistEnabled !== false;
}

// ============================================================
// 状态轮询渲染
// ============================================================

/**
 * 连接态灯 + 五格统计 + 拦截原因明细。
 * 状态灯用 live.css 的 .live-dot / .live-dot-<state> 语义类（配色走 --beilu-* 变量）。
 */
async function _liveRefreshStatus() {
  if (!_liveVisible()) return;
  let st = null;
  try { st = await sendAction({ verb: "getStatus", target: "plugins:beilu-live", source: "web" }); }
  catch { return; /* 轮询读路：注册时 notify:"report" 已进报错中心，此处不再打扰 */ }
  const g = id => document.getElementById(id);
  const dot = g("comp-live-dot"), stx = g("comp-live-state"), det = g("comp-live-detail");
  // connState 由 adapter onState 推送：connecting/authed/retrying/closed
  const LABELS = { authed: "已连接", connecting: "连接中", retrying: "重连中", closed: "已断开" };
  if (dot) dot.className = "live-dot" + (st?.running && st.connState ? ` live-dot-${st.connState}` : "");
  if (stx) stx.textContent = st?.running ? (LABELS[st.connState] || st.connState || "运行中") : "未运行";
  // poolSize 缺失显示"—"而非 0：0 在此有真实语义（池是空的），用 0 表示"读不到"会被误读成"没弹幕"
  if (det) det.textContent = st?.running ? `${st.platform || ""}/${st.roomId || ""} · 池 ${st.poolSize == null ? "—" : st.poolSize} 条 · ${st.connDetail || ""}` : "";
  const s = st?.stats || {};
  // 未运行/读不到时显示"—"并加 .live-stat-idle（颜色降档，避免把占位符误读为真实数据）
  const put = (id, v) => {
    const el = g(id);
    if (!el) return;
    const idle = (v == null);
    el.textContent = idle ? "—" : v;
    el.className = "live-stat-num" + (idle ? " live-stat-idle" : "");
  };
  put("comp-live-st-recv", st?.running ? s.received : null);
  put("comp-live-st-pass", st?.running ? s.passed : null);
  put("comp-live-st-block", st?.running ? s.blocked : null);
  put("comp-live-st-inject", st?.running ? s.injected : null);
  put("comp-live-st-rounds", st?.running ? s.rounds : null);
  // 拦截原因明细：键来自后端 SCREEN_REASONS，前端只维护显示名映射，不复制原因清单
  //   （后端新增拦截原因会自动出现；映射缺失时显示原始键名，不静默丢弃）
  const rsEl = g("comp-live-reasons");
  if (rsEl) {
    const byR = s.byReason || {};
    const REASON_CN = { too_short: "太短", too_long: "太长", blacklist: "黑名单", keyword_miss: "无关键词", keyword_hit: "命中排除词", user_cooldown: "同人冷却", duplicate: "重复", empty: "无内容" };
    const parts = Object.entries(byR).filter(([, v]) => v > 0).map(([k, v]) => `${REASON_CN[k] || k} ${v}`);
    rsEl.textContent = parts.length ? ("拦截明细：" + parts.join(" · ")) : "";
  }
}

// ============================================================
// 接线入口
// ============================================================

/**
 * 直播接入段接线（仅首次生效）。
 * ⚠ 本函数是 async：调用方（companion.mjs）必须同时挂同步 try 与 ?.catch()——
 *   同步 try 只挡得住第一个 await 之前的异常，await 之后抛出的会变成 unhandled rejection。
 */
async function initCompanionLiveSettings() {
  if (_liveInited) return; // 仅首次接线（防重复监听）
  _liveInited = true;
  const g = id => document.getElementById(id);
  if (!g("comp-seg-live")) return; // 段不存在（HTML 未部署）：静默退出，不报错

  // ── 拉配置包：五字段一次到位，前端零默认副本 ──
  try {
    _liveData = await sendAction({ verb: "getData", target: "plugins:beilu-live", source: "web" });
  } catch (e) {
    _liveMsg("读取直播配置失败(需 beilu 后端运行): " + (e?.message || e), true);
    return; // 拉不到就不回填：留 HTML 空壳，不编造默认值
  }
  const { enabled, config = {}, capabilities = {}, rules = {}, platforms = [] } = _liveData || {};

  if (g("comp-live-enabled")) g("comp-live-enabled").checked = !!enabled;
  if (g("comp-live-roomid")) g("comp-live-roomid").value = config.roomId || "";
  _liveRenderPlatforms(platforms, config);
  _liveFillParams(capabilities, rules);
  // 黑名单回填（名单住 per-user config.filter.blacklist，非 capabilities——谱管开关，名单管内容）
  const bl = config.filter?.blacklist || {};
  if (g("comp-live-bl-words")) g("comp-live-bl-words").value = Array.isArray(bl.words) ? bl.words.join("\n") : "";
  if (g("comp-live-bl-users")) g("comp-live-bl-users").value = Array.isArray(bl.users) ? bl.users.join("\n") : "";
  // 承载对话回填。未绑定时加 .live-chatid-unbound（警示色，走 --beilu-warning）——
  //   没绑对话启动会被后端拒绝，这里先给出可见提示而不是等点了才报错。
  const _showChatid = (cid) => {
    const el = g("comp-live-chatid");
    if (!el) return;
    el.textContent = cid || "(未绑定)";
    el.title = cid || "未绑定承载对话，启动时会被拒绝";
    el.className = "live-chatid" + (cid ? "" : " live-chatid-unbound");
  };
  _showChatid(config.chatid);

  // ── 绑定：每个控件只写自己那一个键（差异层） ──
  g("comp-live-enabled")?.addEventListener("change", e => _livePost({ enabled: e.target.checked }));
  g("comp-live-roomid")?.addEventListener("change", e => _liveCfgPost({ roomId: e.target.value.trim() }));
  g("comp-live-platform")?.addEventListener("change", e => {
    _liveCfgPost({ platform: e.target.value });
    _liveRenderCreds(platforms, e.target.value, config); // 换平台=换凭据控件
  });
  // 承载对话：点按钮把当前对话 id 写进配置（单源=配置；启动时后端只读它，前端不另传一份）
  g("comp-live-bind-cur")?.addEventListener("click", () => {
    const cid = (typeof window._beiluGetChatId === "function" ? window._beiluGetChatId() : "") || "";
    if (!cid) { _liveMsg("当前没有打开的对话，请先打开一条对话再绑定", true); return; }
    config.chatid = cid; _showChatid(cid); _liveCfgPost({ chatid: cid });
  });
  g("comp-live-unbind")?.addEventListener("click", () => { config.chatid = ""; _showChatid(""); _liveCfgPost({ chatid: "" }); });

  // 数值参数：change 即写（单位换算只在轮间隔一处）
  const numBind = (id, key, group) => g(id)?.addEventListener("change", e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return; // 空/非数：不写（避免把 NaN 落盘）
    _liveCfgPost({ [group]: { [key]: v } });
  });
  numBind("comp-live-minlen", "minLength", "filter");
  numBind("comp-live-maxlen", "maxLength", "filter");
  numBind("comp-live-cooldown", "userCooldownSec", "filter");
  numBind("comp-live-dedup", "dedupWindowSec", "filter");
  numBind("comp-live-recentn", "recentUserCount", "selector");
  g("comp-live-interval")?.addEventListener("change", e => {
    const sec = Number(e.target.value);
    if (Number.isFinite(sec)) _liveCfgPost({ pacing: { minRoundIntervalMs: Math.round(sec * 1000) } });
  });
  const boolBind = (id, key, group) => g(id)?.addEventListener("change", e => _liveCfgPost({ [group]: { [key]: e.target.checked } }));
  boolBind("comp-live-lastreplied", "includeLastReplied", "selector");
  boolBind("comp-live-giftweight", "weightByGift", "selector");
  boolBind("comp-live-idleskip", "idleSkip", "pacing");
  boolBind("comp-live-blacklist-on", "blacklistEnabled", "filter");
  // 黑名单：整表写回（它本就是一个列表字段，非多键合并）
  const blBind = (id, key) => g(id)?.addEventListener("change", e => {
    const arr = e.target.value.split("\n").map(x => x.trim()).filter(Boolean);
    _liveCfgPost({ filter: { blacklist: { [key]: arr } } });
  });
  blBind("comp-live-bl-words", "words");
  blBind("comp-live-bl-users", "users");

  // ── 启停 ──
  g("comp-live-start")?.addEventListener("click", async () => {
    _liveMsg("正在连接…");
    try {
      // body 空：平台/房间/承载对话全走配置（单源）。后端 start 端点虽支持请求覆盖，前端不用那条路。
      const r = await sendAction({ verb: "startLive", target: "plugins:beilu-live", source: "web", payload: {} });
      if (r && r.success) { _liveMsg("已启动"); _liveRefreshStatus(); }
      else _liveMsg("启动失败: " + (r?.error || "未知原因"), true); // 后端诚实拒启的原因原样透出
    } catch (e) { _liveMsg("启动失败: " + (e?.message || e), true); }
  });
  g("comp-live-stop")?.addEventListener("click", async () => {
    try {
      const r = await sendAction({ verb: "stopLive", target: "plugins:beilu-live", source: "web" });
      _liveMsg(r && r.success ? "已停止" : ("停止失败: " + (r?.error || "")), !(r && r.success));
      _liveRefreshStatus();
    } catch (e) { _liveMsg("停止失败: " + (e?.message || e), true); }
  });

  // ── 状态轮询（3s，与陪伴对话面板同频；_liveVisible 门控，切走即空转） ──
  _liveRefreshStatus();
  if (!_liveStatusTimer) _liveStatusTimer = setInterval(_liveRefreshStatus, 3000);
}

export { initCompanionLiveSettings };