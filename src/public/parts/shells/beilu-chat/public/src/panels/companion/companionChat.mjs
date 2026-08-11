/**
 * companionChat.mjs — 陪伴对话面板(AIRP 形态)
 *
 * 功能链:陪伴轮走主对话链(gameCompanion._executeRound→addUserReply→triggerCharReply→chats/{chatid}.json)
 *   → 本面板=承载对话的前端:_resolveChatid()(运行中=getGameCompanionStatus.chatid 后端真值;
 *     未运行=getGameCompanionConfig 独立绑定 bindChat,否则当前对话) → getLogLength+getLog 拉历史
 *     (shells:chat 门面,与 tempConversation.mjs:75 同范式) → AIRP 同款气泡渲染
 *     (.chat-message[data-role]/.chat-bubble/.message-content — index.css:231 起既有主题样式零副本)
 *   → 3s 增量轮询(长度变化/末条生成中才重拉) → 发送走 gameCompanionSay(触碰链,与桌宠触碰同执行体)。
 * why 轮询而非 WS:websocket.mjs:603 按 currentChatId 门控,非当前打开对话的 message_added/companion_message
 *   在 onmessage 层被丢弃——独立陪伴对话收不到 WS 事件,轮询=唯一可靠通路(桌宠 orb 同为轮询范式)。
 * 关联链:被 companion.mjs initCompanionActivityBar 调 initCompanionChat();
 *   消费 index.html #comp-chat-log/#comp-chat-target/#comp-say-input/#comp-say-send/#comp-preview-chat。
 * 影响范围:只读对话日志+经 gameCompanionSay 发言,不直接写对话文件。
 * 使用效果:陪伴消息=真对话记录(重启不丢),用户在面板里像 AIRP 一样看历史/对话。
 */
import { sendAction } from "../../shared/transport/sendAction.mjs";
import { escapeHtml } from "../../shared/state/utils.mjs";
import { handleFilesSelect } from "../../shared/chat-core/fileHandling.mjs"; // 0725 对话台上传:与主输入条同一条附件链(校验/base64/预览渲染单源)
import { ensureChatWebSocket } from "../../shared/transport/websocket.mjs";
import { createVisibilityPoller } from "../../shared/state/windowRuntime.mjs"; // [0808 机制] 前台/后台刷新分级单源

let _chatid = "";      // 面板当前承载对话
let _selFiles = [];    // 待发附件({name,mime_type,buffer(base64),description},形状=fileHandling 产出;发送即清)
let _lastLen = -1;     // 已渲染日志长度(增量判据)
let _lastGenerating = false; // 末条生成中=长度不变内容在变,下一轮强制重拉
let _timer = null;
let _loading = false;
let _streamListenerBound = false;

function _displayText(entry) {
  // 新消息消费后端持久化的陪伴纯正文；旧历史至少优先使用既有 content_for_show，避免回退 raw 操作标签。
  return String(entry?.extension?._companion_visible_text ?? entry?.content_for_show ?? entry?.content ?? "");
}

function _visible() {
  const tab = document.getElementById("center-tab-companion");
  const seg = document.getElementById("comp-seg-msg");
  return !!(tab && !tab.classList.contains("hidden") && seg && !seg.classList.contains("hidden"));
}

// 承载对话解析:运行中以后端 session.chatid 为唯一真值(与陪伴轮实际落盘对话恒一致,防前端自算分叉);
// 未运行时预览:bindChat(用户显式锁定) > companion 专门对话指针(peek,不创建)。
// [凛倾 0722 框架级] 当前对话不再参与——陪伴对话=独立专门文件,别影响其他窗口(与后端
// _resolveCompanionTarget 同路由语义,读写同源)。
async function _resolveChatid() {
  try {
    const st = await sendAction({ verb: "getGameCompanionStatus", target: "plugins:beilu-memory", source: "web" });
    if (st && st.running && st.chatid) return st.chatid;
  } catch { /* 离线:走下方预览解析 */ }
  try {
    const cfg = await sendAction({ verb: "getGameCompanionConfig", target: "plugins:beilu-memory", source: "web" });
    if (cfg && cfg.bindChat) return cfg.bindChat;
  } catch { /* 离线 */ }
  try {
    const charname = (typeof window._beiluGetCharName === "function" && window._beiluGetCharName()) || "";
    if (charname) {
      const j = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform: "companion", peek: true } });
      if (j?.chatid) return j.chatid;
    }
  } catch { /* 专门对话尚未创建:空态显示 */ }
  return "";
}

function _fmtTime(ts) {
  // time_stamp 经 toData(...this 铺开)+JSON 序列化后是 ISO 字符串(models.mjs:210),乐观回显传的是 ms 数字——两种都直接喂 Date
  const d = new Date(ts);
  return ts != null && Number.isFinite(d.getTime()) ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "";
}

// AIRP 同款骨架:.chat-message[data-role] > .message-header(.message-name/.message-timestamp) + .chat-bubble > .message-content
// (类与 data-role 对齐 messageList.mjs:846/1312 主聊天真实产出,index.css 分色/气泡样式直接生效,零样式副本)
function _row(entry) {
  const role = entry.role === "user" ? "user" : (entry.role || "char");
  const name = entry.role === "user" ? "我" : (entry.name || "AI");
  const time = _fmtTime(entry.time_stamp);
  const el = document.createElement("div");
  el.className = "chat-message mb-3";
  el.setAttribute("data-role", role);
  if (entry.id) el.setAttribute("data-companion-message-id", entry.id);
  const visibleText = _displayText(entry);
  const body = entry.is_generating && !visibleText.trim()
    ? '<span class="opacity-60 animate-pulse">正在输入…</span>'
    : escapeHtml(visibleText).replace(/\n/g, "<br>");
  // 附件标记:files 序列化后 buffer="file:hash"(models.mjs:225),本面板不渲图,给可见提示即可
  //   (0725 措辞泛化:对话台上传后 files 不只截图,也含用户附件)
  const fileTag = (Array.isArray(entry.files) && entry.files.length) ? `<span class="opacity-50">[附件×${entry.files.length}]</span>` : "";
  el.innerHTML =
    `<div class="message-header flex items-center gap-2 text-xs opacity-60 mb-0.5 ml-14">` +
    `<span class="message-name font-bold">${escapeHtml(name)}</span>` + fileTag +
    (entry.is_generating ? '<span class="animate-pulse">生成中</span>' : "") +
    `<span class="message-timestamp">${time}</span></div>` +
    `<div class="chat-bubble rounded-lg px-3 py-2"><div class="message-content text-sm">${body}</div></div>`;
  return el;
}

function _renderEntries(entries) {
  const log = document.getElementById("comp-chat-log");
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = "";
  // /log=原始 chatLog 切片(chatOps.mjs:771 GetChatLog 不过滤):_deleted(chatEntryUtils:53 软删标记,对人类不可见)
  // 必须滤掉;_hidden(仅对 AI 隐藏)在主聊天灰显,本小面板直接不显示。
  const shown = entries.filter((e) => e && e.role !== "system" && !(e.extension && (e.extension._hidden || e.extension._deleted)));
  if (!shown.length) {
    log.innerHTML = '<p class="text-center opacity-50 text-xs py-4">这条对话还没有消息,开始互动或直接发一句</p>';
  } else {
    for (const e of shown) log.appendChild(_row(e));
  }
  if (nearBottom || _lastLen < 0) log.scrollTop = log.scrollHeight;
  _lastGenerating = !!(shown.length && shown[shown.length - 1].is_generating);
  // 右侧预览列小回显:同一份数据尾 4 条(单源,不再独立事件流)
  const pc = document.getElementById("comp-preview-chat");
  if (pc) {
    const tail = shown.slice(-4);
    pc.innerHTML = tail.length
      ? tail.map((e) => `<div class="flex gap-1 items-start py-0.5 text-[11px]"><span class="shrink-0 opacity-50">[${e.role === "user" ? "我" : escapeHtml(e.name || "AI")}]</span><span class="flex-1 truncate">${escapeHtml(_displayText(e).slice(0, 60))}</span></div>`).join("")
      : '<p class="text-center opacity-50 text-[10px] py-4">开始互动后显示</p>';
  }
}

async function _refresh(force) {
  if (_loading || !_visible()) return;
  _loading = true;
  try {
    const cid = await _resolveChatid();
    const log = document.getElementById("comp-chat-log");
    const tgt = document.getElementById("comp-chat-target");
    if (!log) return;
    if (cid !== _chatid) { _chatid = cid; _lastLen = -1; _lastGenerating = false; }
    if (!cid) {
      // 0722 框架决策后当前对话不参与路由,旧文案"先打开一个对话"=失效指引(0725 对齐)
      log.innerHTML = '<p class="text-center opacity-50 text-xs py-4">暂无承载对话:开始互动后自动创建专门对话,或在启动绑定里锁定一条对话</p>';
      if (tgt) tgt.textContent = "";
      return;
    }
    if (tgt) tgt.textContent = "· 对话 " + cid.slice(0, 8);
    ensureChatWebSocket(cid);
    const len = Number(await sendAction({ verb: "getLogLength", target: "shells:chat", source: "web", scope: { chatId: cid } })) || 0;
    if (!force && len === _lastLen && !_lastGenerating) return; // 无新消息且末条已定稿:零重绘
    const start = Math.max(0, len - 60); // 尾 60 条(过滤 system 后有余量;更早历史在主聊天看)
    const entries = await sendAction({ verb: "getLog", target: "shells:chat", source: "web", scope: { chatId: cid }, payload: { start, end: len } });
    if (Array.isArray(entries)) { _renderEntries(entries); _lastLen = len; }
  } catch { /* 后端未起/离线:保持现状,下轮重试 */ }
  finally { _loading = false; }
}

function _applyCompanionStream(event) {
  const d = event?.detail || {};
  if (!d.chatid || d.chatid !== _chatid || !d.messageId) return;
  const log = document.getElementById("comp-chat-log");
  if (!log) return;
  let row = log.querySelector(`[data-companion-message-id="${CSS.escape(d.messageId)}"]`);
  if (!row) {
    const empty = log.querySelector(".text-center.opacity-50");
    if (empty) empty.remove();
    row = _row({ id: d.messageId, role: "char", name: d.charName || "AI", content: "", is_generating: true, time_stamp: d.timestamp || Date.now() });
    log.appendChild(row);
  }
  const body = row.querySelector(".message-content");
  if (body) body.innerHTML = d.text ? escapeHtml(String(d.text)).replace(/\n/g, "<br>") : '<span class="opacity-60 animate-pulse">正在输入…</span>';
  const generating = d.phase !== "final";
  let badge = row.querySelector(".message-header .animate-pulse");
  if (generating && !badge) {
    badge = document.createElement("span"); badge.className = "animate-pulse"; badge.textContent = "生成中";
    row.querySelector(".message-header")?.appendChild(badge);
  } else if (!generating && badge) badge.remove();
  log.scrollTop = log.scrollHeight;
  _lastGenerating = generating;
  if (!generating) setTimeout(() => _refresh(true), 100);
}

async function _send() {
  const ipt = document.getElementById("comp-say-input");
  const t = (ipt?.value || "").trim();
  const files = _selFiles.slice();
  if (!t && !files.length) return; // 纯附件可发(与主输入条语义一致)
  const injEl = document.getElementById("comp-say-inject");
  const inject = (injEl?.value || "").trim();
  ipt.value = "";
  // 乐观回显(轮询到真实落盘条目后整区重绘覆盖)
  const log = document.getElementById("comp-chat-log");
  if (log) {
    const ph = log.querySelector(".text-center.opacity-50");
    if (ph) ph.remove();
    log.appendChild(_row({ role: "user", content: t, files, time_stamp: Date.now() }));
    log.scrollTop = log.scrollHeight;
  }
  try {
    // 附件+单次注入随触碰轮透传(消费=后端 gameCompanionSay→_executeRound:addUserReply.files/
    // triggerCharReply.singleInject,与主对话链同消费点);buffer 即 fileHandling 产出的 base64
    const r = await sendAction({
      verb: "gameCompanionSay", target: "plugins:beilu-memory", source: "web",
      payload: {
        text: t,
        ...(files.length ? { files: files.map((f) => ({ name: f.name, mime_type: f.mime_type, dataBase64: f.buffer })) } : {}),
        ...(inject ? { singleInject: inject } : {}),
      },
    });
    if (r && r.success === false) throw new Error(r.error || "发送失败");
    // 发送成功即清:附件/预览/单次注入(单次语义=只对本次生成生效,同主输入条发后清空)
    _selFiles = [];
    const prev = document.getElementById("comp-say-attach"); if (prev) prev.innerHTML = "";
    if (inject && injEl) { injEl.value = ""; document.getElementById("comp-say-inject-row")?.classList.add("hidden"); }
    setTimeout(() => _refresh(true), 800); // 触碰轮 addUserReply 落盘后拉真实条目
  } catch (e) {
    window._beiluToast?.("发送失败: " + e.message, "error");
    _refresh(true); // 重绘回真实状态,乐观行不留假象
  }
}

// ── 语音输入(凛倾 0722 游戏陪伴+语音链):点麦克风后端录音(系统麦直采)→再点停止→
//    /record/transcribe(降噪+拾音管线按 beilu-stt-server-denoise)→文字填入→用户点发送走 _send 既有链。
//    键与 STT 插件面板同源(beilu-stt-*),读写同 localStorage。
let _vRecording = false;
let _vStarting = false; // 进行中守卫:record/start 挂起等服务冷启动期间(可达2分钟)防重复点击刷 409

// 录音钮双态=切换按钮内 mic/square 两个 SVG span(0725 emoji→UI:原 textContent 写 🎤/⏹;
// 图标 path 单源=companion.mjs _COMP_ICON_PATHS,HTML data-ic 占位注入,此处零 path 副本)。
// 直写内联 display 而非 toggle .hidden:注入器给可见图标写过内联 inline-flex,内联优先级
// 盖过 .hidden 类=类切换失效(层叠推演 0725);双 span 同以内联为准,类只作初始态。
function _micUI(recording) {
  const btn = document.getElementById("comp-say-mic");
  if (!btn) return;
  btn.classList.toggle("btn-error", recording);
  const mic = btn.querySelector('[data-ic="mic"]');
  const stop = btn.querySelector('[data-ic="square"]');
  if (mic) mic.style.display = recording ? "none" : "inline-flex";
  if (stop) stop.style.display = recording ? "inline-flex" : "none";
}

async function _voiceToggle() {
  const port = encodeURIComponent(localStorage.getItem("beilu-stt-port") || "7861");
  try {
    if (!_vRecording) {
      if (_vStarting) {
        // 已有一次启动在途:再点只提示,不再发 record/start(409 "already recording" 刷屏根因)
        window._beiluToast?.("正在连接 STT 服务,请稍候…", "info");
        return;
      }
      _vStarting = true;
      // 服务冷启动进度:record/start 会挂起等服务自动拉起+模型加载,期间轮询启动态给用户反馈
      const { startSttStartupNotifier } = await import("../../shared/chat-core/sttStartupNotice.mjs");
      const stopNotifier = startSttStartupNotifier(localStorage.getItem("beilu-stt-port") || "7861");
      try {
        const device = localStorage.getItem("beilu-stt-record-device") || "";
        const r = await fetch(`/api/parts/plugins:beilu-stt/record/start?port=${port}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device: device === "" ? null : Number(device) }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || (r.status === 404 ? "STT 服务/代理未就绪(启动服务或重启 beilu)" : "HTTP " + r.status));
        }
        _vRecording = true;
        _micUI(true);
        window._beiluToast?.("录音中…再点停止键结束并转文字", "info");
      } finally {
        _vStarting = false;
        stopNotifier();
      }
    } else {
      _vRecording = false;
      _micUI(false);
      const s = await fetch(`/api/parts/plugins:beilu-stt/record/stop?port=${port}`, { method: "POST" });
      if (!s.ok) { const e = await s.json().catch(() => ({})); throw new Error(e.error || "停止失败"); }
      window._beiluToast?.("转文字中…", "info");
      const t = await fetch(`/api/parts/plugins:beilu-stt/record/transcribe?port=${port}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: localStorage.getItem("beilu-stt-language") || "auto",
          hotwords: localStorage.getItem("beilu-stt-hotwords") || "",
          denoise: localStorage.getItem("beilu-stt-server-denoise") !== "false",
          max_new_tokens: 2048,
        }),
      });
      const j = await t.json().catch(() => ({}));
      if (!t.ok) throw new Error(j.error || "转录失败");
      const text = (j.segments || []).map((x) => x.text).join(" ").trim() ||
        (j.raw_text || "").replace(/\[[^\]]*\]/g, "").trim();
      if (!text) { window._beiluToast?.("未识别到语音内容", "warning"); return; }
      const ipt = document.getElementById("comp-say-input");
      if (ipt) { ipt.value = (ipt.value ? ipt.value + " " : "") + text; ipt.focus(); }
      window._beiluToast?.("已转文字,点「发送」", "success");
    }
  } catch (e) {
    _vRecording = false;
    _micUI(false);
    window._beiluToast?.("语音输入失败: " + e.message, "error");
  }
}

export function initCompanionChat() {
  document.getElementById("comp-say-send")?.addEventListener("click", _send);
  document.getElementById("comp-say-mic")?.addEventListener("click", _voiceToggle);
  if (!_streamListenerBound) {
    _streamListenerBound = true;
    window.addEventListener("beilu:companion-stream", _applyCompanionStream);
  }
  // 0725 对齐角色对话框工具条:上传(handleFilesSelect 单源链:校验/base64/预览渲染+删除,预览容器
  // comp-say-attach 复用 .chat-input-attachments 主题样式)+单次注入(点按展开/收起,发送即清)
  const _fileInp = document.getElementById("comp-say-file");
  document.getElementById("comp-say-upload")?.addEventListener("click", () => _fileInp?.click());
  _fileInp?.addEventListener("change", (e) => {
    handleFilesSelect(e, _selFiles, document.getElementById("comp-say-attach"));
    _fileInp.value = ""; // 允许重选同一文件
  });
  document.getElementById("comp-say-inject-btn")?.addEventListener("click", () => {
    const row = document.getElementById("comp-say-inject-row");
    if (!row) return;
    row.classList.toggle("hidden");
    if (!row.classList.contains("hidden")) document.getElementById("comp-say-inject")?.focus();
  });
  // isComposing:中文输入法候选确认的 Enter 不触发发送
  document.getElementById("comp-say-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) _send(); });
  // [0808 windowRuntime 机制] 3s 轮询接可见性生命周期：原 _visible() guard 只挡请求不停 timer
  //   （后台 3s 空转常醒），现后台真暂停、转可见立即 _refresh 补拉。_refresh 内部 _visible() 守卫
  //   保留（分段级二次防线）。首拉仍用 force=true 语义，故保留手动 _refresh(true)，工厂 tick 走增量。
  if (!_timer) {
    _timer = createVisibilityPoller({ tick: () => _refresh(false), intervalMs: 3000, visible: _visible, immediateOnShow: true, label: "companionChat" });
    _timer.start();
  }
  _refresh(true);
}
