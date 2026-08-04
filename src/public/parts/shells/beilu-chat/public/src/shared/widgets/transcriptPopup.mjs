/**
 * transcriptPopup.mjs — 语音转录结果弹窗（分段浏览 + 全文编辑 + 注入/复制）
 *
 * 功能链：
 *   调用方 await showTranscriptPopup(segments, rawText)
 *   → 首次调用创建 DOM（之后复用，hidden 控制显隐）
 *   → 渲染 segment 卡片列表（分段视图）+ 全文 textarea（全文编辑视图）
 *   → 用户可编辑各 segment 文本（contenteditable）或切换全文编辑
 *   → 点「注入输入框」→ 收集编辑后文本注入 #user-input + 触发 input 事件
 *   → 点「复制文本」→ clipboard.writeText + toast
 *   → 点「取消」/ ESC / 点遮罩 / 点× → resolve({action:'cancel', text:''})
 *
 * why：
 *   语音转录结果需要人工校对后再使用；分段视图保留说话人/时间戳上下文便于定位；
 *   全文编辑视图便于整体修改；注入输入框避免手动复制粘贴。
 *
 * 关联链：
 *   ← 语音转录功能调用处（传入 segments + rawText）
 *   → #user-input textarea（注入文本）
 *   → window._beiluToast（复制成功/失败反馈）
 *   → window._beiluEscRegistry（ESC 中央仲裁注册，priority 40）
 *
 * 影响范围：
 *   DOM：首次调用 append 弹窗节点到 body，之后复用（hidden 控制）；
 *   剪贴板：复制操作写入系统剪贴板；
 *   注入：resolve({action:'inject'}) 交还调用方 messageInput.mjs，由其写 #message-input 并触发 input 事件。
 */

import { storage } from "../state/storage.mjs";

// ── 说话人配色方案（半透明背景兼容亮/暗/鲜艳主题） ──
const SPEAKER_COLORS = [
  { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.4)', text: '#3b82f6' },   // 蓝
  { bg: 'rgba(34,197,94,0.15)', border: 'rgba(34,197,94,0.4)', text: '#22c55e' },     // 绿
  { bg: 'rgba(249,115,22,0.15)', border: 'rgba(249,115,22,0.4)', text: '#f97316' },   // 橙
  { bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.4)', text: '#a855f7' },   // 紫
  { bg: 'rgba(236,72,153,0.15)', border: 'rgba(236,72,153,0.4)', text: '#ec4899' },   // 粉
  { bg: 'rgba(20,184,166,0.15)', border: 'rgba(20,184,166,0.4)', text: '#14b8a6' },   // 青
];

/**
 * 秒数 → MM:SS.ss 格式（如 65.5 → "01:05.50"）
 * @param {number} sec
 * @returns {string}
 */
function formatTimestamp(sec) {
  if (sec == null || isNaN(sec)) return '00:00.00';
  const totalSec = Math.max(0, sec);
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
}

/**
 * 根据说话人名称获取颜色（相同名称始终同色），返回 SPEAKER_COLORS 中的一项。
 * @param {string} speaker
 * @param {Map<string,number>} speakerMap - 已分配索引的 map
 * @returns {{bg:string, border:string, text:string}}
 */
function getSpeakerColor(speaker, speakerMap) {
  if (!speakerMap.has(speaker)) {
    speakerMap.set(speaker, speakerMap.size);
  }
  return SPEAKER_COLORS[speakerMap.get(speaker) % SPEAKER_COLORS.length];
}

// ── 弹窗 DOM 单例 ──
let _container = null;   // 遮罩层（最外层）
let _popup = null;        // 弹窗主体
let _resolve = null;      // 当前 Promise 的 resolve
let _escEntry = null;     // ESC 注册表条目

// ── 内联样式（注入 <style> 到 head，仅一次） ──
let _styleInjected = false;
function _injectStyle() {
  if (_styleInjected) return;
  _styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
/* ── transcriptPopup 动画 ── */
.tp-overlay {
  position: fixed; inset: 0;
  background: var(--beilu-modal-overlay, rgba(0,0,0,0.5));
  z-index: var(--z-modal, 1000);
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.tp-overlay.tp-visible {
  opacity: 1;
  pointer-events: auto;
}
.tp-popup {
  background: var(--beilu-modal-bg, oklch(var(--b1)));
  border-radius: 16px;
  max-width: 680px; width: 94vw;
  max-height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 24px 48px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.05);
  transform: translateY(32px);
  transition: transform 0.25s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease;
  opacity: 0;
  overflow: hidden;
}
.tp-overlay.tp-visible .tp-popup {
  transform: translateY(0);
  opacity: 1;
}

/* ── 顶部标题栏 ── */
.tp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid oklch(var(--bc) / 0.1);
  flex-shrink: 0;
}
.tp-title {
  font-size: 1.05rem; font-weight: 700;
  color: oklch(var(--bc));
}
.tp-close-btn {
  width: 32px; height: 32px;
  border-radius: 8px; border: none;
  background: transparent;
  color: oklch(var(--bc) / 0.5);
  font-size: 1.2rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.tp-close-btn:hover {
  background: oklch(var(--bc) / 0.08);
  color: oklch(var(--bc) / 0.8);
}

/* ── Tab 切换 + 说话人图例 ── */
.tp-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 20px 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.tp-tabs {
  display: flex; gap: 2px;
  background: oklch(var(--bc) / 0.06);
  border-radius: 8px; padding: 3px;
}
.tp-tab {
  padding: 5px 14px; border-radius: 6px; border: none;
  background: transparent; cursor: pointer;
  font-size: 0.8rem; font-weight: 500;
  color: oklch(var(--bc) / 0.55);
  transition: all 0.15s;
}
.tp-tab.tp-tab-active {
  background: oklch(var(--b1));
  color: oklch(var(--bc));
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.tp-tab:hover:not(.tp-tab-active) {
  color: oklch(var(--bc) / 0.8);
}
.tp-legend {
  display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto;
}
.tp-legend-item {
  display: flex; align-items: center; gap: 4px;
  font-size: 0.7rem; font-weight: 600;
  padding: 2px 8px; border-radius: 4px;
}

/* ── 说话人选项 ── */
.tp-speaker-toggle {
  display: flex; align-items: center; gap: 5px;
  font-size: 0.75rem; color: oklch(var(--bc) / 0.6);
  margin-left: 8px; cursor: pointer; user-select: none;
}
.tp-speaker-toggle input { margin: 0; accent-color: var(--beilu-amber, oklch(var(--p))); }

/* ── 转录内容区 ── */
.tp-body {
  flex: 1; overflow-y: auto; padding: 12px 20px 12px;
  min-height: 0;
}
.tp-body::-webkit-scrollbar { width: 6px; }
.tp-body::-webkit-scrollbar-thumb {
  background: oklch(var(--bc) / 0.15); border-radius: 3px;
}

/* ── 分段卡片 ── */
.tp-segment {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 10px 12px; border-radius: 10px;
  margin-bottom: 6px;
  transition: background 0.15s;
}
.tp-segment:hover { background: oklch(var(--bc) / 0.04); }
.tp-seg-left {
  flex-shrink: 0; display: flex; flex-direction: column;
  align-items: flex-start; gap: 4px; min-width: 0;
}
.tp-seg-time {
  font-size: 0.65rem; font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: oklch(var(--bc) / 0.4);
  white-space: nowrap;
}
.tp-seg-speaker {
  display: inline-block;
  padding: 1px 8px; border-radius: 4px;
  font-size: 0.7rem; font-weight: 700;
  border: 1px solid;
  white-space: nowrap;
}
.tp-seg-text {
  flex: 1; min-width: 0;
  font-size: 0.9rem; line-height: 1.55;
  color: oklch(var(--bc) / 0.9);
  padding: 4px 8px; border-radius: 6px;
  border: 1px solid transparent;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
  cursor: text;
  word-break: break-word;
}
.tp-seg-text:hover {
  border-color: oklch(var(--bc) / 0.15);
  background: oklch(var(--bc) / 0.02);
}
.tp-seg-text:focus {
  border-color: var(--beilu-amber, oklch(var(--p)));
  background: oklch(var(--bc) / 0.03);
}

/* ── 全文编辑 ── */
.tp-fulltext {
  width: 100%; min-height: 200px;
  resize: vertical;
  font-size: 0.88rem; line-height: 1.6;
  font-family: inherit;
  color: oklch(var(--bc));
  background: oklch(var(--bc) / 0.03);
  border: 1px solid oklch(var(--bc) / 0.12);
  border-radius: 8px;
  padding: 12px 14px;
  outline: none;
  transition: border-color 0.15s;
}
.tp-fulltext:focus {
  border-color: var(--beilu-amber, oklch(var(--p)));
}

/* ── 底部操作栏 ── */
.tp-footer {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 12px 20px 16px;
  border-top: 1px solid oklch(var(--bc) / 0.08);
  flex-shrink: 0;
}
.tp-btn {
  padding: 8px 18px; border-radius: 8px; border: none;
  font-size: 0.82rem; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
  display: flex; align-items: center; gap: 6px;
}
.tp-btn-primary {
  background: var(--beilu-amber, oklch(var(--p)));
  color: oklch(var(--pc, var(--b1)));
}
.tp-btn-primary:hover { filter: brightness(1.08); }
.tp-btn-secondary {
  background: oklch(var(--bc) / 0.08);
  color: oklch(var(--bc) / 0.8);
}
.tp-btn-secondary:hover { background: oklch(var(--bc) / 0.14); }
.tp-btn-ghost {
  background: transparent;
  color: oklch(var(--bc) / 0.55);
}
.tp-btn-ghost:hover { background: oklch(var(--bc) / 0.06); color: oklch(var(--bc) / 0.8); }

/* ── 隐藏态 ── */
.tp-hidden { display: none !important; }

/* ── 录音审查弹窗 + 白盒 ── */
.tp-audio { width: 100%; margin: 4px 0 10px; }
.tp-whitebox {
  margin: 0 20px 10px; padding: 10px 12px;
  background: oklch(var(--bc) / 0.05);
  border-radius: 10px;
  font-size: 0.78rem; line-height: 1.7;
  color: oklch(var(--bc) / 0.75);
  font-family: ui-monospace, monospace;
  white-space: pre-wrap; word-break: break-all;
  max-height: 180px; overflow-y: auto;
}
.tp-level-ok   { color: #22c55e; font-weight: 700; }
.tp-level-low  { color: #eab308; font-weight: 700; }
.tp-level-mute { color: #ef4444; font-weight: 700; }
`;
  document.head.appendChild(style);
}

// ── DOM 构建（仅首次） ──
function _ensureDOM() {
  if (_container) return;
  _injectStyle();

  // 遮罩层
  _container = document.createElement('div');
  _container.className = 'tp-overlay tp-hidden';

  // 弹窗主体
  _popup = document.createElement('div');
  _popup.className = 'tp-popup';
  _popup.addEventListener('click', e => e.stopPropagation()); // 阻止点击穿透到遮罩

  _popup.innerHTML = `
    <div class="tp-header">
      <span class="tp-title">语音转录结果</span>
      <button class="tp-close-btn" data-role="close" title="关闭">&times;</button>
    </div>
    <div class="tp-toolbar">
      <div class="tp-tabs">
        <button class="tp-tab tp-tab-active" data-view="segments">分段视图</button>
        <button class="tp-tab" data-view="fulltext">全文编辑</button>
      </div>
      <label class="tp-speaker-toggle">
        <input type="checkbox" data-role="show-speakers" checked />
        显示说话人
      </label>
      <div class="tp-legend" data-role="legend"></div>
    </div>
    <div class="tp-whitebox tp-hidden" data-role="topinfo" style="max-height:90px"></div>
    <div class="tp-body" data-role="body">
      <div data-role="segments-view"></div>
      <textarea class="tp-fulltext tp-hidden" data-role="fulltext-view"></textarea>
    </div>
    <div class="tp-whitebox tp-hidden" data-role="whitebox"></div>
    <div class="tp-footer">
      <button class="tp-btn tp-btn-ghost" data-role="cancel">取消</button>
      <button class="tp-btn tp-btn-secondary" data-role="copy"><i data-ic="copy"></i> 复制文本</button>
      <button class="tp-btn tp-btn-primary" data-role="inject"><i data-ic="arrow-down-to-line"></i> 注入输入框</button>
    </div>
  `;

  _container.appendChild(_popup);
  document.body.appendChild(_container);

  // ── 事件绑定（一次性，永久生效） ──
  // 关闭按钮
  _popup.querySelector('[data-role="close"]').addEventListener('click', () => _finish('cancel'));
  // 取消按钮
  _popup.querySelector('[data-role="cancel"]').addEventListener('click', () => _finish('cancel'));
  // 遮罩点击
  _container.addEventListener('click', (e) => {
    if (e.target === _container) _finish('cancel');
  });
  // 注入按钮
  _popup.querySelector('[data-role="inject"]').addEventListener('click', () => {
    const text = _collectText();
    _injectToInput(text);
    _finish('inject', text);
  });
  // 复制按钮
  _popup.querySelector('[data-role="copy"]').addEventListener('click', async () => {
    const text = _collectText();
    try {
      await navigator.clipboard.writeText(text);
      window._beiluToast?.('已复制到剪贴板', 'success');
    } catch {
      window._beiluToast?.('复制失败', 'error');
    }
    _finish('copy', text);
  });
  // Tab 切换
  _popup.querySelectorAll('.tp-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchView(tab.dataset.view));
  });
}

// ── 当前弹窗状态 ──
let _currentSegments = [];
let _currentRawText = '';
let _speakerMap = new Map();
let _activeView = 'segments'; // 'segments' | 'fulltext'

/**
 * 切换分段/全文视图
 */
function _switchView(view) {
  _activeView = view;
  const segView = _popup.querySelector('[data-role="segments-view"]');
  const fullView = _popup.querySelector('[data-role="fulltext-view"]');
  const tabs = _popup.querySelectorAll('.tp-tab');

  tabs.forEach(t => t.classList.toggle('tp-tab-active', t.dataset.view === view));

  if (view === 'segments') {
    segView.classList.remove('tp-hidden');
    fullView.classList.add('tp-hidden');
  } else {
    segView.classList.add('tp-hidden');
    fullView.classList.remove('tp-hidden');
    // 同步分段编辑内容到全文
    fullView.value = _collectText();
  }
}

/**
 * 收集当前编辑后的文本（根据活动视图）
 */
function _collectText() {
  if (_activeView === 'fulltext') {
    return _popup.querySelector('[data-role="fulltext-view"]').value;
  }
  // 分段视图：逐 segment 收集
  const showSpeakers = _popup.querySelector('[data-role="show-speakers"]').checked;
  const editables = _popup.querySelectorAll('[data-role="seg-text"]');
  const lines = [];
  editables.forEach((el, i) => {
    const text = el.textContent.trim();
    if (!text) return;
    const seg = _currentSegments[i];
    if (showSpeakers && seg?.speaker) {
      lines.push(`[${seg.speaker}] ${text}`);
    } else {
      lines.push(text);
    }
  });
  return lines.join('\n');
}

/**
 * 注入文本到 #user-input textarea
 */
function _injectToInput(text) {
  const textarea = document.getElementById('message-input');
  if (!textarea) {
    window._beiluToast?.('未找到输入框', 'error');
    return;
  }
  textarea.value = text;
  // 触发 input 事件，使框架感知值变化（自动扩高/字数统计等）
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}

/**
 * 结束弹窗：隐藏 + resolve Promise + 清理 ESC 注册
 */
function _finish(action, text = '') {
  if (!_resolve) return;
  const r = _resolve;
  _resolve = null;
  _hide();
  r({ action, text });
}

/**
 * 显示弹窗（带动画）
 */
function _show() {
  _container.classList.remove('tp-hidden');
  // 强制重排后再加 visible 类触发 transition
  void _container.offsetHeight;
  _container.classList.add('tp-visible');

  // ESC 注册
  const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
  _escEntry = {
    _id: 'transcriptPopup-' + Date.now(),
    priority: 40, // 高于 modal(30)，语音转录弹窗在最上层
    isOpen: () => _container && !_container.classList.contains('tp-hidden'),
    close: () => _finish('cancel'),
  };
  reg.push(_escEntry);
}

/**
 * 隐藏弹窗（带动画）
 */
function _hide() {
  if (!_container) return;
  _container.classList.remove('tp-visible');

  // ESC 注销
  if (_escEntry) {
    const reg = window._beiluEscRegistry || [];
    const idx = reg.indexOf(_escEntry);
    if (idx >= 0) reg.splice(idx, 1);
    _escEntry = null;
  }

  // transition 结束后加 hidden（避免闪烁）
  const onEnd = () => {
    _container.removeEventListener('transitionend', onEnd);
    if (!_container.classList.contains('tp-visible')) {
      _container.classList.add('tp-hidden');
    }
  };
  _container.addEventListener('transitionend', onEnd);
  // 保底：transition 可能不触发（如已 hidden），300ms 后强制隐藏
  setTimeout(() => {
    if (_container && !_container.classList.contains('tp-visible')) {
      _container.classList.add('tp-hidden');
    }
  }, 300);
}

/**
 * 渲染 segments 内容到分段视图
 */
function _renderSegments(segments) {
  _speakerMap.clear();
  const segView = _popup.querySelector('[data-role="segments-view"]');
  segView.innerHTML = '';

  // 预扫说话人以稳定颜色分配
  const speakers = [...new Set(segments.map(s => s.speaker).filter(Boolean))];
  speakers.forEach(sp => getSpeakerColor(sp, _speakerMap));

  segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'tp-segment';
    card.dataset.idx = i;

    const color = seg.speaker ? getSpeakerColor(seg.speaker, _speakerMap) : null;

    // 左侧：时间戳 + 说话人
    const left = document.createElement('div');
    left.className = 'tp-seg-left';

    const timeEl = document.createElement('span');
    timeEl.className = 'tp-seg-time';
    timeEl.textContent = `[${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}]`;
    left.appendChild(timeEl);

    if (seg.speaker) {
      const spkEl = document.createElement('span');
      spkEl.className = 'tp-seg-speaker';
      spkEl.textContent = seg.speaker;
      if (color) {
        spkEl.style.background = color.bg;
        spkEl.style.borderColor = color.border;
        spkEl.style.color = color.text;
      }
      left.appendChild(spkEl);
    }

    // 右侧：可编辑文本
    const textEl = document.createElement('span');
    textEl.className = 'tp-seg-text';
    textEl.setAttribute('contenteditable', 'true');
    textEl.setAttribute('data-role', 'seg-text');
    textEl.setAttribute('spellcheck', 'false');
    textEl.textContent = seg.text;

    card.appendChild(left);
    card.appendChild(textEl);
    segView.appendChild(card);
  });

  // 渲染说话人图例
  _renderLegend(speakers);
}

/**
 * 渲染说话人颜色图例（多说话人时才显示）
 */
function _renderLegend(speakers) {
  const legend = _popup.querySelector('[data-role="legend"]');
  legend.innerHTML = '';
  if (speakers.length <= 1) {
    legend.classList.add('tp-hidden');
    return;
  }
  legend.classList.remove('tp-hidden');
  speakers.forEach(sp => {
    const color = getSpeakerColor(sp, _speakerMap);
    const item = document.createElement('span');
    item.className = 'tp-legend-item';
    item.textContent = sp;
    item.style.background = color.bg;
    item.style.color = color.text;
    item.style.border = `1px solid ${color.border}`;
    legend.appendChild(item);
  });
}

/**
 * 显示语音转录结果弹窗。
 *
 * @param {Array<{start: number, end: number, speaker: string, text: string}>} segments - 转录分段
 * @param {string} rawText - 原始转录全文
 * @param {object} [meta] - 服务端白盒元数据（audio 体检/prompt/token/耗时），有则显示白盒栏
 * @returns {Promise<{action: 'inject'|'copy'|'cancel', text: string}>}
 */
export function showTranscriptPopup(segments, rawText, meta) {
  _ensureDOM();

  // ── 白盒：语言+raw 原文置顶（凛倾 20260722 UI 调整），详细取证留底部 ──
  const top = _popup.querySelector('[data-role="topinfo"]');
  const wb = _popup.querySelector('[data-role="whitebox"]');
  if (meta) {
    top.textContent = `语言: ${meta.language}\nraw: ${rawText || '(空)'}`;
    top.classList.remove('tp-hidden');
    const a = meta.audio;
    const lines = [];
    if (a) lines.push(
      `服务端解码: ${a.duration_s}s · ${a.size_bytes} bytes · peak=${a.peak} · rms=${a.rms}` +
      (a.peak != null && a.peak < 0.01 ? '  ⚠静音' : ''));
    lines.push(`推理: ${meta.inference_time_s}s · prompt ${meta.prompt_tokens} tok · 生成 ${meta.generated_tokens} tok`);
    if (meta.prompt) lines.push(`prompt: ${meta.prompt}`);
    wb.textContent = lines.join('\n');
    wb.classList.remove('tp-hidden');
  } else {
    top.classList.add('tp-hidden');
    wb.classList.add('tp-hidden');
  }

  // 存储当前数据
  _currentSegments = segments || [];
  _currentRawText = rawText || '';

  // 渲染分段视图
  _renderSegments(_currentSegments);

  // 重置全文视图内容
  const fullView = _popup.querySelector('[data-role="fulltext-view"]');
  fullView.value = _currentRawText;

  // 重置到分段视图
  _switchView('segments');

  // "显示说话人"初值来自插件面板设置（beilu-stt-show-speakers），弹窗内勾选仅本次生效
  _popup.querySelector('[data-role="show-speakers"]').checked =
    storage.get("beilu-stt-show-speakers") !== "false";

  return new Promise((resolve) => {
    // 如果上一个弹窗还没关闭，先关掉
    if (_resolve) {
      const oldResolve = _resolve;
      _resolve = null;
      oldResolve({ action: 'cancel', text: '' });
    }
    _resolve = resolve;
    _show();
  });
}

// ============================================================
// 录音审查弹窗（转文本前的白盒审查步骤）
// 功能链：messageInput onstop(STT开且自动转录关) → showRecordingReviewPopup
//   → 用户试听回放 + 看白盒(格式/大小/时长/峰值/RMS/电平判定)
//   → 转文本(_handleSttTranscription) / 取消。主麦克风不承担音频附件语义。
// ============================================================

let _rrContainer = null;
let _rrPopup = null;
let _rrResolve = null;
let _rrObjectUrl = null;
let _rrEscEntry = null;

function _rrEnsureDOM() {
  if (_rrContainer) return;
  _injectStyle();
  _rrContainer = document.createElement('div');
  _rrContainer.className = 'tp-overlay tp-hidden';
  _rrPopup = document.createElement('div');
  _rrPopup.className = 'tp-popup';
  _rrPopup.style.maxWidth = '520px';
  _rrPopup.addEventListener('click', e => e.stopPropagation());
  _rrPopup.innerHTML = `
    <div class="tp-header">
      <span class="tp-title">录音审查</span>
      <button class="tp-close-btn" data-role="rr-close" title="关闭">&times;</button>
    </div>
    <div style="padding: 4px 20px 0;">
      <audio class="tp-audio" data-role="rr-audio" controls></audio>
    </div>
    <div class="tp-whitebox" data-role="rr-whitebox"></div>
    <div class="tp-footer">
      <button class="tp-btn tp-btn-ghost" data-role="rr-cancel">取消</button>
      <button class="tp-btn tp-btn-primary" data-role="rr-transcribe">转文本</button>
    </div>
  `;
  _rrContainer.appendChild(_rrPopup);
  document.body.appendChild(_rrContainer);

  const done = (action) => {
    if (!_rrResolve) return;
    const r = _rrResolve;
    _rrResolve = null;
    _rrContainer.classList.remove('tp-visible');
    setTimeout(() => {
      _rrContainer.classList.add('tp-hidden');
      if (_rrObjectUrl) { URL.revokeObjectURL(_rrObjectUrl); _rrObjectUrl = null; }
    }, 250);
    if (_rrEscEntry) {
      const reg = window._beiluEscRegistry || [];
      const idx = reg.indexOf(_rrEscEntry);
      if (idx >= 0) reg.splice(idx, 1);
      _rrEscEntry = null;
    }
    r(action);
  };
  _rrPopup.querySelector('[data-role="rr-close"]').addEventListener('click', () => done('cancel'));
  _rrPopup.querySelector('[data-role="rr-cancel"]').addEventListener('click', () => done('cancel'));
  _rrPopup.querySelector('[data-role="rr-transcribe"]').addEventListener('click', () => done('transcribe'));
  _rrContainer.addEventListener('click', (e) => { if (e.target === _rrContainer) done('cancel'); });
}

/**
 * 显示录音审查弹窗：回放试听 + 白盒诊断，用户决定转文本或取消。
 *
 * @param {Blob} audioBlob - 录音 Blob
 * @param {{duration:number, peak:number, rms:number}|null} stats - 前端 decodeAudioData 体检结果（null=解码失败）
 * @returns {Promise<'transcribe'|'cancel'>}
 */
export function showRecordingReviewPopup(audioBlob, stats) {
  _rrEnsureDOM();

  const audio = _rrPopup.querySelector('[data-role="rr-audio"]');
  if (_rrObjectUrl) URL.revokeObjectURL(_rrObjectUrl);
  _rrObjectUrl = URL.createObjectURL(audioBlob);
  audio.src = _rrObjectUrl;

  const wb = _rrPopup.querySelector('[data-role="rr-whitebox"]');
  wb.innerHTML = '';
  const lines = [
    `格式: ${audioBlob.type || '(未知)'} · 大小: ${audioBlob.size} bytes`,
  ];
  if (stats) {
    lines.push(`时长: ${stats.duration.toFixed(2)}s · peak=${stats.peak.toFixed(4)} · rms=${stats.rms.toFixed(5)}`);
  } else {
    lines.push('前端解码失败（格式或数据异常，转文本时服务端会再报）');
  }
  wb.textContent = lines.join('\n');
  if (stats) {
    // 电平判定行（依 20260722 实测阈值：静音录音 peak≤0.009，正常语音 peak≈0.5）
    const verdict = document.createElement('div');
    if (stats.peak < 0.01) {
      verdict.className = 'tp-level-mute';
      verdict.textContent = '电平判定: 静音 —— 麦克风没采到声音（检查系统麦克风权限/输入设备/音量）';
    } else if (stats.peak < 0.05) {
      verdict.className = 'tp-level-low';
      verdict.textContent = '电平判定: 偏低 —— 有信号但很弱，转录可能不准';
    } else {
      verdict.className = 'tp-level-ok';
      verdict.textContent = '电平判定: 正常';
    }
    wb.appendChild(document.createTextNode('\n'));
    wb.appendChild(verdict);
  }

  return new Promise((resolve) => {
    if (_rrResolve) { const old = _rrResolve; _rrResolve = null; old('cancel'); }
    _rrResolve = resolve;
    _rrContainer.classList.remove('tp-hidden');
    void _rrContainer.offsetHeight;
    _rrContainer.classList.add('tp-visible');
    const reg = (window._beiluEscRegistry = window._beiluEscRegistry || []);
    _rrEscEntry = {
      _id: 'recordingReview-' + Date.now(),
      priority: 40,
      isOpen: () => _rrContainer && !_rrContainer.classList.contains('tp-hidden'),
      close: () => { _rrPopup.querySelector('[data-role="rr-cancel"]').click(); },
    };
    reg.push(_rrEscEntry);
  });
}
