/**
 * [messageInput.mjs] — 消息输入框的初始化与交互绑定。不管消息渲染（那是 messageList 的事），
 *   不管 WS 通信（那是 websocket.mjs 的事），不管消息队列（那是 virtualQueue 的事）。
 *
 * 职责：
 *   1. initializeMessageInput()：绑定输入框、发送按钮、文件/语音/照片按钮的所有交互事件
 *   2. sendMessage()：收集输入内容 + 附件，调 addUserReply() 发送，发送后清空输入框
 *   3. toggleVoiceRecording()：MediaRecorder 录音 → WAV Blob → 作为附件塞进 SelectedFiles
 *   4. autoResizeTextarea()：输入时自动撑开 textarea 高度
 *   5. 文件选择/拖拽支持：fileInputElement change → handleFilesSelect；拖入文件同样入 SelectedFiles
 *   6. uploadButton：直接打开文件选择器（原 code/work 技能菜单已随说明书库域删除 0723）
 *
 * 链路：initializeMessageInput() 在 chat.mjs initializeChat() 末尾调用，完成输入框装配
 *       用户点击"发送" / Ctrl+Enter → sendMessage() → addUserReply(endpoints.mjs) → 后端收消息
 *       用户点击"上传" → fileInput.click → handleFilesSelect → SelectedFiles
 *       用户点击"录音" → toggleVoiceRecording → MediaRecorder → WAV → handleFilesSelect
 * 影响：写 SelectedFiles（模块级附件暂存）；调 addUserReply 发后端请求；清空 #message-input；
 *       写 localStorage（草稿，通过 KEYS）；toast 提示（空消息/录音错误）
 * 相交：← chat.mjs（initializeMessageInput 调用）
 *       → endpoints.mjs（addUserReply: 发送消息到后端）
 *       → fileHandling.mjs（handleFilesSelect: 附件处理 + 预览渲染）
 *       → featureControls.mjs（switchModeTo: 模式切换）
 *       → dragAndDrop.mjs（拖入文件支持）
 *
 * 点击后发生什么：
 *   发送按钮点击 / Ctrl+Enter → sendMessage()：取 #message-input 内容 + SelectedFiles → addUserReply()
 *     → 后端接收 → WS 推 stream_update → virtualQueue → StreamRenderer 开始流式渲染
 *   上传按钮点击 → 直接弹文件选择器
 *   录音按钮点击（首次）→ 请求麦克风权限 → 开始录音（按钮变红）
 *   录音按钮点击（再次）→ 停止录音 → WAV Blob 写入 SelectedFiles → 显示附件预览
 */
import { console } from "../../../../../../scripts/i18n.mjs";
import { showToast, showToastI18n } from "../../../../../../scripts/toast.mjs";
import { addUserReply } from "../transport/endpoints.mjs";
import { handleFilesSelect } from "./fileHandling.mjs" // 6c尾·根级散件归位;
// U02 乐观本地气泡（T049）：发送瞬间本地先渲染用户气泡，回推到达认领落定，失败清占位。
import { showOptimisticUserMessage, clearOptimisticUserMessage } from "../render/virtualQueue.mjs";

import { addDragAndDropSupport } from "../widgets/dragAndDrop.mjs";
import { switchModeTo } from "../../panels/feature/featureControls.mjs";
import { TAB_TO_MODE, MODE_BADGE } from "../state/modeTabMap.mjs"; // D3 收口：tab→mode 权威表（_TAB_TO_INPUT_MODE 派生源）；D2：快速命令词典派生源
// skillPicker import 已删（凛倾 0723「说明书库可以删除,和inj重复」：说明书库整域删除，上传按钮回归直传）
// 注入坞（0726）：本轮 ⚡ 队列的读点与清点。队列是 injectDock 的模块态，发送链只读不持有，
//   避免「输入区自己存一份注入状态」再次长成第二个真值源（旧单次注入 textarea 就是这么烂掉的）。
import { getOnceInjectIds, clearOnceInjectQueue } from "./injectDock.mjs";
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中
import { layoutState, saveState } from "../layout/core.mjs"; // 布局态唯一权威（输入框定高与侧栏宽度同仓）

const messageInputElement = document.getElementById("message-input");
const sendButtonElement = document.getElementById("send-button");
const fileInputElement = document.getElementById("file-input");
const attachmentPreviewContainer =
  document.getElementById("attachment-preview");
const uploadButtonElement = document.getElementById("upload-button");
const voiceButtonElement = document.getElementById("voice-button");
const photoButtonElement = document.getElementById("photo-button");

const SelectedFiles = [];

let isRecording = false;
let mediaRecorder;
let audioChunks = [];
// [0713 病灶审计 C5] 录音停止→附件入列完成的 promise：stop 路径 await 它（onstop 是规范保证的确定性事件），
//   替代原 100ms×50 轮询 isRecording 的定时猜测。
let _recordingStopDone = null;

// ============================================================
// U01 草稿保留 / U08 附件按模式隔离（未发送输入态持久化，T049）
// ------------------------------------------------------------
// 断点根因：input 事件仅 autoResizeTextarea 不落盘 → 刷新/切卡/切 tab 后 DOM 重建，草稿凭空丢；
//   tab-activated 无差别清附件 → 同模式内切 tab 也丢附件。二者同属"用户已打字/已选但未发送"。
// U01 草稿=全局单份：#message-input 是全模式共享的同一个 DOM 元素（单 id，smart/work/skillPicker 都引它，
//   模式切换不清空它）——共享框对应"单份草稿"，落 localStorage(KEYS.BEILU_CHAT_DRAFT) 纯字符串，
//   刷新/切卡/切 tab 回来恢复；发送成功/命令消费后清。若强做"按模式分草稿"，共享框会与之打架
//   （切模式框内仍是上一模式文本、restore 因框非空被跳过），故不分模式。
// U08 附件=按模式隔离：SelectedFiles 虽同为模块级，但附件语义要求"防跨模式误带"（chat 选的附件不该带进 code 发），
//   故仅"切到不同对话模式"才清、同模式内切 tab / 切到非模式 tab 保留。
// 单次注入(single-inject)刻意不入草稿：语义=仅对本次生成一次性附加，发送即清，非"未发送内容"。
// [D3 收口 0713] 原手抄表靠注释承诺"与 layout 对齐"=人肉同步。改从 modeTabMap.TAB_TO_MODE
//   权威派生（键集刻意 4 模式 tab：附件隔离只关心模式间切换，辅助 tab 不构成模式）。
const _TAB_TO_INPUT_MODE = { chat: TAB_TO_MODE.chat, smart: TAB_TO_MODE.smart, files: TAB_TO_MODE.files, work: TAB_TO_MODE.work };

/** 当前对话模式（用于附件隔离判定）；非模式 tab（设置/编辑器等）返回 null（不构成模式切换）。 */
function _currentInputMode() {
  return _TAB_TO_INPUT_MODE[document.body.dataset.activeTab] || null;
}

// [多窗口 0727] 草稿真值源：**有窗口时按窗口存**，没有窗口时才是下面这个全局键。
//   上面 U01 那段注释说的「草稿=全局单份，若强做分草稿会与共享框打架」在多窗口下已不成立——
//   共享的是输入**框**（DOM 一个），草稿是**内容**，内容必须跟着窗口走：a 打了一半切到 b，
//   回来还得是 a 那半句（凛倾 0727 状态包明列「输入框草稿」）。
//   收口在 lineManager（窗口表在它手上），这里只委托，避免两套并行写同一个框：
//   程序给 .value 赋值不触发 input 事件 → 全局键会停在上一个窗口的文本 → 刷新后
//   _restoreDraft 把别的窗口的草稿恢复进当前窗口（双源的具体走法）。
//   桥不存在（lineManager 未加载）或当前没有登记窗口 → has() 假 → 走全局键，行为与改动前一致。
function _winDraft() {
  try { const w = window._beiluWinDraft; return w?.has?.() ? w : null; } catch { return null; }
}

/** 保存草稿（空串则删除，避免残留空草稿键值）。 */
function _saveDraft(text) {
  const w = _winDraft();
  if (w) { w.set(text); return; }
  if (text) storage.set(KEYS.BEILU_CHAT_DRAFT, text);
  else storage.remove(KEYS.BEILU_CHAT_DRAFT);
}

/** 清除草稿（发送成功 / 命令消费输入后调用，已发出不再是草稿）。 */
function _clearDraft() {
  const w = _winDraft();
  if (w) { w.clear(); return; }
  storage.remove(KEYS.BEILU_CHAT_DRAFT);
}

/** 恢复草稿到输入框（初始化=刷新/切卡后 DOM 重建时调用）。仅在框为空时恢复，不覆盖用户正在输入的内容。 */
function _restoreDraft() {
  if (!messageInputElement) return;
  if (messageInputElement.value) return; // 框已有内容 → 不覆盖
  const w = _winDraft();
  const draft = w ? w.get() : storage.get(KEYS.BEILU_CHAT_DRAFT);
  if (draft) {
    messageInputElement.value = draft;
    autoResizeTextarea(messageInputElement);
  }
}

// U08：记录附件被选中时所属的对话模式。切到"不同模式"才清附件；同模式/非模式 tab 保留。
let _attachmentMode = null;

/**
 * 自动调整 textarea 高度以适应内容
 * @param {HTMLTextAreaElement} el - textarea 元素
 */
function autoResizeTextarea(el) {
  // 先重置为最小高度，再根据 scrollHeight 撑开
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/**
 * 初始化消息输入框
 */
export function initializeMessageInput() {
  uploadButtonElement?.addEventListener("click", () => {
    // 全模式直接打开文件选择器（原 code/work「上传文件/技能」两选项菜单随说明书库域删除，凛倾 0723）
    fileInputElement.click();
  });
  fileInputElement?.addEventListener("change", (event) => {
    _attachmentMode = _currentInputMode(); // U08：记录附件所属模式，供 tab 切换判定是否跨模式
    handleFilesSelect(event, SelectedFiles, attachmentPreviewContainer);
  });
  // [0716 命中区扩大·凛倾「灵敏度不足…只有非常小的一块可以复制」] 拖放目标原=输入框 textarea
  //   （默认 3 行高的一小条），拖到消息区/聊天面板其余位置被 body 层 preventDefault 静默吞掉。
  //   升级为 #chat-container（消息列表+输入区整体，moveChatContainer 搬到哪个模式命中区跟到哪）；
  //   非文件拖（x-beilu-part 等）由 dragAndDrop.mjs 载荷分域守卫放行，body 层链不受影响。
  //   paste 冒泡自 textarea 到容器，行为不变。容器缺失时回退 textarea（防御性最小回退）。
  const _dropTarget = document.getElementById("chat-container") || messageInputElement;
  if (_dropTarget)
    addDragAndDropSupport(
      _dropTarget,
      SelectedFiles,
      attachmentPreviewContainer,
    );
  sendButtonElement?.addEventListener("click", sendMessage);
  messageInputElement?.addEventListener("keydown", handleKeyPress);
  // 输入时自动调整高度 + U01 落盘草稿（按当前模式隔离，刷新/切卡回来可恢复）
  messageInputElement?.addEventListener("input", () => {
    autoResizeTextarea(messageInputElement);
    _saveDraft(messageInputElement.value);
  });
  voiceButtonElement?.addEventListener("click", toggleVoiceRecording);
  // photo-button 已在 HTML 中移除（替换为 single-inject-btn）；?. 在元素不存在时自动跳过绑定
  photoButtonElement?.addEventListener("click", togglePhotoSection);
  window.addEventListener("beilu:tab-activated", () => {
    // U08：仅"切到不同对话模式"才清附件（防跨模式误带）；同模式内切 tab / 切到非模式 tab（设置/编辑器）保留。
    //   附件所属模式 _attachmentMode 在选附件时记录；tab-activated 时 body.dataset.activeTab 已是新 tab。
    if (SelectedFiles.length > 0) {
      const newMode = _currentInputMode();
      // 附件经拖拽/粘贴入列（未走 fileInput/photo 分支）时 _attachmentMode 可能为空：
      //   此刻惰性归属到当前模式，供下次 tab 切换判定（首次进入不清，符合"刚选就切"应保留）。
      if (!_attachmentMode) _attachmentMode = newMode;
      const crossMode = _attachmentMode && newMode && newMode !== _attachmentMode;
      if (crossMode) {
        SelectedFiles.length = 0;
        attachmentPreviewContainer.innerHTML = "";
        _attachmentMode = null;
      }
    }
    // U01：切 tab 回来恢复本模式草稿（输入框为空时才恢复，不覆盖用户正在输入的内容）
    _restoreDraft();
  });
  // U01：初始化（含刷新/切卡后 DOM 重建）恢复当前模式草稿
  _restoreDraft();
  initInputResize();
  messageInputElement?.focus();
}

// 输入框拖拽调高（凛倾2026-07-09「对话框要可以和侧栏的代码一样可以进行拉伸」）。
// 同 layout/core.mjs initSidebarResize 模式：handle 起拖 → move 改高 → up 落盘持久化。
// 持久化走 layoutState（core.mjs=唯一权威 UI 布局态，与侧栏宽度同仓同写法），
//   不开独立 storage 键——布局尺寸另立键=绕过收口/双轨不同步隐患。
// 与 autoResizeTextarea 共存方式：拖拽写 min/max-height 作为地板/天花板，
//   auto-grow（height=auto→scrollHeight）只在用户定高之上再撑、不回缩到定高之下。
function initInputResize() {
  const handle = document.getElementById("chat-input-resize-handle");
  if (!handle || !messageInputElement) return;

  // auto-grow 天花板基线从 CSS 现值读（.chat-input-textarea max-height / compact-chat 40vh），
  // 不在 JS 重复硬编码——CSS 是该值的单源，改 CSS 此处自动跟随
  const cssMaxH = parseInt(getComputedStyle(messageInputElement).maxHeight, 10) || 0;
  const applyHeight = (h) => {
    messageInputElement.style.minHeight = h + "px";
    // CSS 天花板会钳住更大的用户定高，随定高抬升
    messageInputElement.style.maxHeight = Math.max(cssMaxH, h) + "px";
    messageInputElement.style.height = h + "px";
  };
  if (layoutState.chatInputHeight > 0) applyHeight(layoutState.chatInputHeight);

  let dragging = false, startY = 0, startH = 0;
  const onDown = (e) => {
    dragging = true;
    startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    startH = messageInputElement.offsetHeight;
    handle.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const cy = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    // 向上拖=增高（handle 在输入框顶边），钳位同侧栏口径：下限一行可用、上限 60vh
    const newH = Math.max(60, Math.min(startH + (startY - cy), Math.round(window.innerHeight * 0.6)));
    applyHeight(newH);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    layoutState.chatInputHeight = messageInputElement.offsetHeight;
    saveState();
  };
  handle.addEventListener("mousedown", onDown);
  handle.addEventListener("touchstart", onDown, { passive: false });
  document.addEventListener("mousemove", onMove);
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("mouseup", onUp);
  document.addEventListener("touchend", onUp);
}

/**
 * 处理键盘按键事件。
 * @param {KeyboardEvent} event - 键盘事件对象。
 */
function handleKeyPress(event) {
  if (event.key === "Enter" && event.ctrlKey) {
    event.preventDefault();
    sendMessage();
  }
}

/**
 * 触发照片选择
 */
function togglePhotoSection() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", (event) => {
    const { files } = event.target;
    if (files.length) {
      _attachmentMode = _currentInputMode(); // U08：记录附件所属模式
      handleFilesSelect(
        { target: { files } },
        SelectedFiles,
        attachmentPreviewContainer,
      );
    }
  });
  input.click();
}

/**
 * 切换语音录制
 */
async function toggleVoiceRecording() {
  // 后端录音模式（凛倾 20260722"别把录音放到浏览器"）：浏览器音频栈遇虚拟麦矩阵
  // (NVIDIA Broadcast/Voicemeeter)会采到静音;改由 stt_service 用 sounddevice 直采
  // 系统/指定设备,浏览器只做遥控+试听。STT 开启时默认走后端。
  const _sttOn = storage.get("beilu-stt-enabled") === "true";
  if (_sttOn && storage.get("beilu-stt-backend-record") !== "false") {
    const r = await _toggleBackendRecording();
    // "fallback"=record 代理未注册(beilu 重启前的内存态),落回浏览器录音保持可用
    if (r !== "fallback") return;
  }
  if (isRecording) {
    try {
      mediaRecorder.stop();
      // R1-SKIP: 静态 svg 图标(.text())非 /api/*；apiFetch 的 401→/login 跳转不适用。
      voiceButtonElement.innerHTML = await fetch(
        "/parts/shells:beilu-chat/icons/material-symbols__mic.svg",
      ).then((res) => res.text()).catch(() => '\u{1F3A4}');
      // [C5] stop() 规范保证触发 onstop；await 其完成（音频已转附件入列），无需定时轮询
      if (_recordingStopDone) await _recordingStopDone;
      isRecording = false;
    } catch (err) {
      console.error("Error stopping recording:", err);
      isRecording = false;
    }
  } else
    try {
      // Start recording
      // 降噪走浏览器原生音频处理链（WebRTC APM）。Chrome 对 audio:true 默认开，
      // 但 Firefox/Safari 默认值不一，显式声明才能跨浏览器保证；关掉开关=原始音频。
      const denoise = storage.get("beilu-stt-denoise") !== "false";
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: denoise
          ? { noiseSuppression: true, echoCancellation: true, autoGainControl: true }
          : { noiseSuppression: false, echoCancellation: false, autoGainControl: false },
      });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      /**
       * 处理可用数据事件。
       * @param {BlobEvent} event - 包含音频数据的 BlobEvent 对象。
       */
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      /**
       * 处理停止事件。完成信号经 _recordingStopDone 通知 stop 路径（[C5] 确定性事件替代轮询）。
       */
      let _resolveStopDone;
      _recordingStopDone = new Promise((resolve) => { _resolveStopDone = resolve; });
      mediaRecorder.onstop = async () => {
        try {
          const actualMime = mediaRecorder.mimeType || "audio/webm";
          const audioBlob = new Blob(audioChunks, { type: actualMime });
          stream.getTracks().forEach((track) => track.stop());

          const sttEnabled = storage.get("beilu-stt-enabled") === "true";
          // 自动转录默认开（凛倾 20260722 调试闭环后拍板:不需要审查步骤）；
          // 关闭时保留审查窗流程（试听+白盒）作为调试入口。
          const autoTranscribe = storage.get("beilu-stt-auto-transcribe") !== "false";

          if (sttEnabled && autoTranscribe) {
            await _handleSttTranscription(audioBlob);
          } else if (sttEnabled) {
            await _reviewThenTranscribe(audioBlob);
          } else {
            isRecording = await _attachRecording(audioBlob);
          }
        } finally {
          _resolveStopDone();
        }
      };

      mediaRecorder.start();
      // R1-SKIP: 静态 svg 图标(.text())非 /api/*。
      voiceButtonElement.innerHTML = await fetch(
        "/parts/shells:beilu-chat/icons/line-md__square.svg",
      ).then((res) => res.text()).catch(() => '\u25A0');
      isRecording = true;
    } catch (error) {
      console.error("Error accessing microphone:", error);
      showToastI18n("error", "chat.voiceRecording.errorAccessingMicrophone");
    }
}

// ── 后端录音（系统麦直采,遥控 stt_service /record/*） ──
let _backendRecording = false;
let _backendRecStarting = false; // 进行中守卫:record/start 挂起等服务冷启动期间(可达2分钟)防重复点击刷 409

async function _setVoiceIcon(recording) {
  // R1-SKIP: 静态 svg 图标(.text())非 /api/*。
  const icon = recording ? "line-md__square.svg" : "material-symbols__mic.svg";
  const fallback = recording ? "\u25A0" : "\u{1F3A4}";
  voiceButtonElement.innerHTML = await fetch(
    `/parts/shells:beilu-chat/icons/${icon}`,
  ).then((res) => res.text()).catch(() => fallback);
}

async function _toggleBackendRecording() {
  const port = storage.get("beilu-stt-port") || "7861";
  if (!_backendRecording) {
    if (_backendRecStarting) {
      // 已有一次启动在途:再点只提示,不再发 record/start(409 "already recording" 刷屏根因)
      window._beiluToast?.("正在连接 STT 服务,请稍候…", "info");
      return;
    }
    _backendRecStarting = true;
    // 服务冷启动进度:record/start 会挂起等服务自动拉起+模型加载,期间轮询启动态给用户反馈
    const { startSttStartupNotifier } = await import("./sttStartupNotice.mjs");
    const stopNotifier = startSttStartupNotifier(port);
    try {
      const device = storage.get("beilu-stt-record-device") || "";
      const resp = await fetch(`/api/parts/plugins:beilu-stt/record/start?port=${encodeURIComponent(port)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: device === "" ? null : Number(device), port: Number(port) }),
      });
      if (resp.status === 404) {
        // beilu 未重启,内存 main.mjs 还没有 record 代理——降级浏览器录音,不打断可用链
        window._beiluToast?.("后端录音代理未生效（beilu 需重启一次），本次使用浏览器录音", "warning");
        return "fallback";
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        window._beiluToast?.(
          `后端录音启动失败: ${e.error || "HTTP " + resp.status}——请确认 STT 服务已启动;可在插件面板「测电平」选活的麦克风设备`,
          "error",
        );
        return;
      }
      const data = await resp.json();
      console.log("[stt-chain] ①后端录音开始:", data);
      _backendRecording = true;
      await _setVoiceIcon(true);
      window._beiluToast?.(`录音中（后端 · ${data.device_name || "系统默认设备"}）`, "info");
    } catch (err) {
      console.error("[stt-chain] 后端录音启动失败:", err);
      window._beiluToast?.("后端录音启动失败: " + err.message, "error");
    } finally {
      _backendRecStarting = false;
      stopNotifier();
    }
  } else {
    _backendRecording = false;
    await _setVoiceIcon(false);
    try {
      const stopResp = await fetch(`/api/parts/plugins:beilu-stt/record/stop?port=${encodeURIComponent(port)}`, { method: "POST" });
      if (!stopResp.ok) {
        const e = await stopResp.json().catch(() => ({}));
        window._beiluToast?.(`停止录音失败: ${e.error || "HTTP " + stopResp.status}`, "error");
        return;
      }
      const stop = await stopResp.json();
      console.log("[stt-chain] ①后端录音节点:", stop);
      // 试听音频从服务端取回(WAV)
      let blob = null;
      try {
        const a = await fetch(`/api/parts/plugins:beilu-stt/record/audio?port=${encodeURIComponent(port)}`);
        if (a.ok) blob = await a.blob();
      } catch { /* 试听拿不到不阻塞审查流程 */ }
      const stats = stop.audio
        ? { duration: stop.audio.duration_s, peak: stop.audio.peak, rms: stop.audio.rms }
        : null;
      const { showRecordingReviewPopup } = await import("../widgets/transcriptPopup.mjs");
      const action = await showRecordingReviewPopup(blob || new Blob([], { type: "audio/wav" }), stats);
      if (action === "transcribe") await _transcribeBackendRecording();
      else if (action === "attach" && blob) await _attachRecording(blob);
    } catch (err) {
      console.error("[stt-chain] 后端录音停止失败:", err);
      window._beiluToast?.("停止录音失败: " + err.message, "error");
    }
  }
}

async function _transcribeBackendRecording() {
  const port = storage.get("beilu-stt-port") || "7861";
  const language = storage.get("beilu-stt-language") || "auto";
  const maxTokens = storage.get("beilu-stt-max-tokens") || "8192";
  const hotwords = storage.get("beilu-stt-hotwords") || "";
  window._beiluToast?.("正在转录语音...", "info");
  try {
    const resp = await fetch(`/api/parts/plugins:beilu-stt/record/transcribe?port=${encodeURIComponent(port)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language, max_new_tokens: Number(maxTokens), hotwords, port: Number(port),
        denoise: storage.get("beilu-stt-server-denoise") !== "false",
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const result = await resp.json();
    await _showTranscribeResult(result, resp.status);
  } catch (err) {
    console.error("[stt] 转录失败:", err);
    window._beiluToast?.("语音转录失败: " + err.message, "error");
  }
}

/** 录音转附件（STT 关闭时的原路径；文件名/类型沿用历史行为） */
async function _attachRecording(audioBlob) {
  const audioFile = new File(
    [audioBlob],
    `voice_message_${Date.now()}.wav`,
    { type: "audio/wav" },
  );
  const fakeEvent = { target: { files: [audioFile] } };
  return await handleFilesSelect(fakeEvent, SelectedFiles, attachmentPreviewContainer);
}

/** 前端录音体检：decodeAudioData → 时长/峰值/RMS（白盒链路第一节点） */
async function _analyzeAudioBlob(audioBlob) {
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await actx.decodeAudioData(await audioBlob.arrayBuffer());
    const ch = decoded.getChannelData(0);
    let peak = 0, sum = 0, n = 0;
    for (let i = 0; i < ch.length; i += 8) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
      sum += v * v; n++;
    }
    return { duration: decoded.duration, peak, rms: Math.sqrt(sum / n) };
  } finally {
    actx.close();
  }
}

/** 两步流程：录音审查弹窗（试听+白盒）→ 用户点「转文本」才送模型 */
async function _reviewThenTranscribe(audioBlob) {
  const stats = await _analyzeAudioBlob(audioBlob).catch((e) => {
    console.warn("[stt-chain] 前端解码失败:", e?.message);
    return null;
  });
  console.log("[stt-chain] ①录音节点:", {
    mime: audioBlob.type, size: audioBlob.size,
    ...(stats ? { duration: +stats.duration.toFixed(2), peak: +stats.peak.toFixed(4), rms: +stats.rms.toFixed(5) } : { decode: "failed" }),
  });
  const { showRecordingReviewPopup } = await import("../widgets/transcriptPopup.mjs");
  const action = await showRecordingReviewPopup(audioBlob, stats);
  if (action === "transcribe")
    await _handleSttTranscription(audioBlob, { skipGate: true });
  else if (action === "attach")
    await _attachRecording(audioBlob);
}

async function _handleSttTranscription(audioBlob, { skipGate = false } = {}) {
  const port = storage.get("beilu-stt-port") || "7861";
  const language = storage.get("beilu-stt-language") || "auto";
  const maxTokens = storage.get("beilu-stt-max-tokens") || "8192";
  const hotwords = storage.get("beilu-stt-hotwords") || "";

  try {
    // 静音门（20260722 取证定案）：麦克风流为静音时（系统未授权/输入设备选错），模型收到
    // 静音会退化生成拒答文本（"I'm sorry, I can't assist..."）——在源头边界拦下并给出可行动
    // 诊断，不把静音送进模型。阈值依实测：静音录音 peak≤0.009，正常语音 peak≈0.5。
    // skipGate：审查弹窗流程已把电平亮给用户看，用户明确点了「转文本」就放行（便于做实验）。
    if (!skipGate) {
      const stats = await _analyzeAudioBlob(audioBlob).catch((e) => {
        console.warn("[stt-chain] 静音门解码失败,跳过检测:", e?.message);
        return null;
      });
      if (stats) {
        console.log("[stt-chain] ①录音节点:", {
          mime: audioBlob.type, size: audioBlob.size,
          duration: +stats.duration.toFixed(2), peak: +stats.peak.toFixed(4), rms: +stats.rms.toFixed(5),
        });
        if (stats.peak < 0.01) {
          window._beiluToast?.(
            `录音是静音的（峰值 ${stats.peak.toFixed(4)}）——麦克风没有采到声音。` +
            "请检查:①Windows 设置→隐私→麦克风 是否允许浏览器 ②系统默认输入设备是否是你在用的麦克风 ③输入音量",
            "error",
          );
          return;
        }
      }
    }

    window._beiluToast?.("正在转录语音...", "info");

    const reader = new FileReader();
    const b64 = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(audioBlob);
    });
    console.log("[stt-chain] ②base64节点:", { b64Len: b64.length, approxBytes: Math.floor(b64.length * 0.75) });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600_000);

    const resp = await fetch("/api/parts/plugins:beilu-stt/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        audioBuffer: b64,
        mimeType: audioBlob.type || "audio/webm",
        fileName: `voice_${Date.now()}.${(audioBlob.type || "").includes("wav") ? "wav" : "webm"}`,
        port: Number(port),
        language, max_new_tokens: Number(maxTokens), hotwords,
        denoise: storage.get("beilu-stt-server-denoise") !== "false",
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const result = await resp.json();
    await _showTranscribeResult(result, resp.status);
  } catch (err) {
    console.error("[stt] 转录失败:", err);
    window._beiluToast?.("语音转录失败: " + err.message, "error");
  }
}

/** 转录结果统一出口（浏览器上传路径 + 后端录音路径共用）：白盒日志 + 结果弹窗 + 注入 */
async function _showTranscribeResult(result, httpStatus) {
  console.log("[stt-chain] ③服务端返回:", {
    http: httpStatus, segments: result.segments?.length ?? 0,
    serverAudio: result.meta?.audio || "(旧服务无音频体检,需重启STT服务)",
    inference_s: result.meta?.inference_time_s, tokens: result.meta?.generated_tokens,
  });
  console.log("[stt-chain] ④raw输出:", result.raw_text);
  if (!result.segments?.length && !result.raw_text) {
    window._beiluToast?.("未检测到语音内容", "warning");
    return;
  }

  // 空段落也弹窗：全文视图显示 raw + 白盒栏显示服务端体检,问题现场可见,不再只给一条 toast
  const { showTranscriptPopup } = await import("../widgets/transcriptPopup.mjs");
  const action = await showTranscriptPopup(result.segments || [], result.raw_text, result.meta);

  if (action.action === "inject" && action.text.trim()) {
    const input = document.getElementById("message-input");
    if (input) {
      input.value = action.text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
  }
}

// ============================================================
// 发送消息 + 快速命令拦截
// ============================================================
// ★ Phase 3 模块1：快速命令前端拦截（不走后端，直接执行）
const _QUICK_COMMANDS = [
  { pattern: /^[\/\/]?切换?(?:到|为)?(.+?)模式$/,   action: _qcSwitchMode },
  { pattern: /^[\/\/]?(?:切换?模式|mode)\s*(.+)$/i, action: _qcSwitchMode },
];

function _qcSwitchMode(match) {
  // [D2 收口 0713] 命令词典从 MODE_BADGE 单源派生（中文名=徽章 label，天然同步）+ 英文/别名扩展。
  //   原手抄表缺 smart —— 0706 smart 升独立模式后没跟，用户说「切换到全智能模式」不被识别=真缺陷。
  const modeMap = { "ide": "code" };
  for (const [_m, _cfg] of Object.entries(MODE_BADGE)) {
    modeMap[_cfg.label] = _m;
    modeMap[_m] = _m;
  }
  const target = modeMap[(match[1] || "").trim().toLowerCase()];
  if (!target) return false;
  // T3：原 fire-and-forget switchModeTo + 无条件显示"✓已切换"=假成功（切换失败仍报成功，下轮生成走错模式）。
  //   switchModeTo(_doSwitchMode)返回三态：true=成功 / false=确定失败 / undefined=无操作。
  //   [0716 模式轴时序修] 并发不再丢弃（featureControls 串行队列，本次意图必达后端）；
  //   undefined 仅剩「同模式无需切/用户取消确认」两类真无操作，不提示语义不变。
  //   同步 return true 保持拦截语义（命令已识别，不发给 AI）；结果异步据三态更新提示。
  switchModeTo(target)
    .then((res) => {
      if (res === false) _showQuickResponse(`切换到${match[1]}模式失败`, "error");
      else if (res === true) _showQuickResponse(`✓ 已切换到${match[1]}模式`);
      // undefined（真无操作：同模式/用户取消）：不提示，与 layout 侧同 by design。
    })
    .catch((err) => _showQuickResponse(`切换到${match[1]}模式失败: ${err?.message || ""}`, "error"));
  return true;
}

function _showQuickResponse(text, kind) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;
  const el = document.createElement("div");
  el.className = "chat-message system-message beilu-quick-response";
  const _s = document.createElement("div");
  _s.className = "message-content";
  const _color = kind === "error" ? "var(--beilu-error)" : "var(--beilu-success)";
  _s.style.cssText = `color:${_color};font-weight:600;padding:8px 12px;`;
  _s.textContent = text;
  el.appendChild(_s);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  setTimeout(() => el.remove(), 5000);
}

function _tryQuickCommand(text) {
  for (const cmd of _QUICK_COMMANDS) {
    const m = text.match(cmd.pattern);
    if (m && cmd.action(m)) return true;
  }
  return false;
}

// ============================================================
// FT6 D1：全智能(smart)意图链 A 路 — 规则关键词秒切
// ------------------------------------------------------------
// 凛倾拍板 A+B 叠加：A 路在前端发送前过「关键词规则表」(可配置 JSON: 词→模式),
//   命中明显词 → 直接走现成 modeSwitch 链(websocket.mjs smart 分支同款事件
//   beilu:smart-mode-switch → tempConversation 用户确认 + 自动新建 chatId), 不发给 AI;
//   不命中 → 正常发给 AI 走 B 路(AI 标签判定, 后半链已存在)。
// 守 C7「框架只做管道不做内容识别」: 规则表是用户可改 JSON(localStorage), 默认仅由
//   凛倾预设的 greeting 大类归类种子化, 非前端"理解"用户语义; 用户可清空/改写。
// 守 Req6「AI/规则自动开窗需用户先确认」: A 路只 dispatch beilu:smart-mode-switch
//   (= 弹临时对话确认卡), 不直接切 Tab/开会话, 与 B 路确认门完全一致。
// ============================================================
const _SMART_INTENT_RULES_KEY = KEYS.BEILU_SMART_INTENT_RULES;

// 默认规则表(词→模式): 仅 work/code 两个子模式可由 A 路秒切(chat 留 AI)。
// 种子词来自 greeting 大类(编程/工作)归类语义, 用户可在 localStorage 覆盖。
const _DEFAULT_SMART_INTENT_RULES = {
  code: ["写代码", "写一段代码", "帮我写代码", "review代码", "代码审查", "修复bug", "修一个bug", "debug", "调试", "重构", "写个函数", "写脚本"],
  work: ["帮我翻译", "翻译文档", "翻译成", "整理笔记", "总结会议", "写一封邮件", "写邮件", "整理资料", "做个表格", "批量处理"],
};

function _loadSmartIntentRules() {
  try {
    const raw = storage.get(_SMART_INTENT_RULES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch { /* 损坏的配置回退默认 */ }
  return _DEFAULT_SMART_INTENT_RULES;
}

/**
 * A 路意图分类: 仅在 smart 模式下生效。命中关键词 → 触发 modeSwitch 链并返回 true(拦截发送)。
 * @param {string} text 用户输入
 * @returns {boolean} 命中并已触发确认链 = true; 未命中/非 smart = false(继续正常发送)
 */
function _trySmartIntentSwitch(text) {
  // 仅全智能模式启用 A 路秒切; 其它模式不拦截(各自有独立发送语义)
  if (document.body.dataset.activeTab !== "smart") return false;
  const rules = _loadSmartIntentRules();
  const lower = text.toLowerCase();
  // 07-09 收口审计：遍历目标由规则数据驱动（原写死 ["code","work"]——规则本身用户可覆盖却切不到别的模式）。
  //   安全边界：命中后走确认卡（用户点确认才切）+ 后端 isValidModeId 兜非法键，任意规则键安全。
  for (const mode of Object.keys(rules)) {
    const kws = rules[mode];
    if (!Array.isArray(kws)) continue;
    for (const kw of kws) {
      if (!kw) continue;
      if (lower.includes(String(kw).toLowerCase())) {
        // 走与 AI <modeSwitch> 在 smart 下完全相同的链路: 弹临时对话确认卡 + 自动新建 chatId,
        // 不切 Tab、不直接开会话(用户在临时对话点[确认开始]才接续)。
        window.dispatchEvent(new CustomEvent("beilu:smart-mode-switch", {
          detail: { from: "smart", to: mode, taskTitle: text.slice(0, 60), source: "rule" },
        }));
        return true;
      }
    }
  }
  return false;
}

let _isSending = false;
async function sendMessage() {
  if (_isSending) return;
  if (isRecording) await toggleVoiceRecording();

  const messageText = messageInputElement.value.trim();
  if (!messageText && !SelectedFiles.length) return;

  // ★ 快速命令拦截：匹配成功直接执行，不走后端
  if (messageText && !SelectedFiles.length && _tryQuickCommand(messageText)) {
    messageInputElement.value = "";
    messageInputElement.style.height = "auto";
    _clearDraft(); // 命令已消费输入 → 清草稿，防切 tab 回来又被恢复
    return;
  }

  // ★ FT6 D1：全智能 A 路意图秒切 — smart 模式下命中关键词规则 → 走 modeSwitch 确认链, 不发给 AI
  //   (不命中则继续往下正常发送, 由 AI 走 B 路标签判定)
  if (messageText && !SelectedFiles.length && _trySmartIntentSwitch(messageText)) {
    messageInputElement.value = "";
    messageInputElement.style.height = "auto";
    _clearDraft(); // 意图秒切已消费输入 → 清草稿
    return;
  }

  // 单次注入·两条通道，都只对本次生成生效、发送后清空：
  //   ① 文本：注入坞底部「临时一句话」textarea（id 仍是 single-inject，注入坞未打开过时元素不存在
  //      → ?. 取空串，安全）——不存条目的一次性话。
  //   ② 条目引用：注入坞 ⚡ 队列（getOnceInjectIds），后端按 id 从 INJ 条目库取当前内容注入，
  //      条目的 role/depth/order/宏 全部照常生效。前端不传原文副本（副本形态见 injectDock.mjs 头注释）。
  const injectEl = document.getElementById("single-inject");
  const singleInject = injectEl?.value?.trim() || "";
  const onceInjectIds = getOnceInjectIds();

  _isSending = true;
  wbTrace("input", "sendMessage", { len: messageText.length, files: SelectedFiles.length, hasInject: !!singleInject, onceIds: onceInjectIds.length });
  const sendBtn = document.getElementById("send-button");
  if (sendBtn) sendBtn.disabled = true;
  // U02：点发送瞬间本地先渲染"发送中"气泡，填补 POST→WS 回推空窗期（不等 await）。
  //   成功：WS message_added(user) 到达时 handleMessageAdded 认领落定；失败：catch 清除占位。
  //   输入框内容/草稿在 await 成功后才清（失败保留文本可重发），与占位气泡互不影响。
  let _optimisticId = null;
  try {
    _optimisticId = await showOptimisticUserMessage({ content: messageText, files: SelectedFiles });
  } catch (e) { /* 乐观气泡失败不阻断真实发送，降级为无占位 */ }
  try {
    // [20260726] 窗口模式随请求上送：模式是窗口的运行时事实（TAB_TO_MODE 是 tab→mode 单一权威），
    //   不该让后端去磁盘 active_modes_map 里反查——那张表两个窗口同时写会互相覆盖。
    //   辅助视图（TAB_TO_MODE=null，如"记忆"tab）不带，后端维持原兜底。
    const _winMode = TAB_TO_MODE[document.body.dataset.activeTab] || "";
    await addUserReply({ content: messageText, files: SelectedFiles }, singleInject, onceInjectIds, _winMode);
    messageInputElement.value = "";
    messageInputElement.style.height = "auto";
    _clearDraft(); // U01：已发送成功，清本模式草稿（失败走 catch 不清空 value，草稿也保留可重发）
    SelectedFiles.length = 0;
    attachmentPreviewContainer.innerHTML = "";
    _attachmentMode = null;
    // 单次语义=发完即散：两条通道都只清「本次真的送出去的那份」，不是清当前状态——
    //   await 期间浮窗仍可操作，用户可能已在给下一条挑条目/打下一句临时话，无条件清会吃掉它们。
    // [0716 死广播清理] 原 dispatch beilu:single-inject-cleared 已删——其消费者 skillInjectBar
    //   经凛倾 0706 D6 拍板整删，此 dispatch 是整删时漏掉的孤儿 producer（全库零监听）。
    if (singleInject && injectEl && injectEl.value.trim() === singleInject) injectEl.value = "";
    clearOnceInjectQueue(onceInjectIds);
  } catch (error) {
    // U02：HTTP 超时但 WS 可能已送达（连接拥塞场景：POST 延迟到达后端，后端处理+WS广播成功，
    //   但 HTTP 响应回不来超时）。clearOptimisticUserMessage 返回 false = 气泡已被 WS message_added
    //   认领替换 = 消息实际已送达，此时按成功处理（清输入+草稿），不误导用户重发造成重复消息。
    const _stillPending = _optimisticId ? clearOptimisticUserMessage(_optimisticId) : true;
    if (!_stillPending && _optimisticId) {
      console.warn("[chat] HTTP 超时但消息已通过 WS 送达，视为成功");
      messageInputElement.value = "";
      messageInputElement.style.height = "auto";
      _clearDraft();
      SelectedFiles.length = 0;
      attachmentPreviewContainer.innerHTML = "";
      _attachmentMode = null;
    } else {
      wbDetect("input", "sendMessage", false, error.message || String(error));
      showToast("error", error.stack || error.message || error);
      console.error(error);
    }
  } finally {
    _isSending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}
