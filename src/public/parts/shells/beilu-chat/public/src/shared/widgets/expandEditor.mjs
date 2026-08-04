/**
 * expandEditor.mjs — 全局唯一的通用放大编辑器
 *
 * 功能：
 * - 声明式入口：为 data-expandable textarea 的 expand-btn 绑定全屏编辑
 * - 程序化入口：openExpandEditor({ title, value, readOnly, onSave, onClose })
 * - 两类入口复用同一个 dialog；保存交给 adapter，取消/Escape/遮罩永不写源数据
 * - 有未保存修改时确认关闭；只读会话隐藏保存按钮
 *
 * 依赖：
 * - HTML 中已有 <dialog id="expand-editor-modal"> 容器
 * - CSS 中已有 .expand-editor-modal / .expand-btn 等样式
 */

import { beiluConfirm } from "./beiluDialog.mjs" // 6c尾·根级散件归位;

/** @type {HTMLDialogElement|null} */
let modal = null;
/** @type {HTMLTextAreaElement|null} */
let modalTextarea = null;
/** @type {HTMLElement|null} */
let modalTitle = null;
/** @type {HTMLButtonElement|null} */
let saveBtn = null;
/** @type {HTMLButtonElement|null} */
let cancelBtn = null;
let initialized = false;
let observer = null;
let saving = false;

/** 当前唯一编辑会话；onClose 收到 { saved, value }，可区分保存与取消。 */
let activeSession = null;

/**
 * 初始化放大编辑器
 * 在 DOM 加载完成后调用一次
 */
export function initExpandEditor() {
  modal = document.getElementById("expand-editor-modal");
  modalTextarea = document.getElementById("expand-editor-textarea");
  modalTitle = document.getElementById("expand-editor-title");
  saveBtn = document.getElementById("expand-editor-save");
  cancelBtn = document.getElementById("expand-editor-cancel");

  if (!modal || !modalTextarea) {
    console.warn("[expandEditor] dialog 元素未找到，放大编辑器未初始化");
    return;
  }

  if (initialized) {
    bindExpandButtons();
    return;
  }
  initialized = true;

  // 保存按钮
  saveBtn?.addEventListener("click", handleSave);

  // 关闭按钮
  cancelBtn?.addEventListener("click", handleClose);

  // 点击 dialog 遮罩关闭（::backdrop）
  modal.addEventListener("click", (e) => {
    if (e.target === modal) handleClose();
  });

  // Escape 键关闭（dialog 原生支持，但我们需要阻止默认以避免直接关闭丢失数据）
  modal.addEventListener("cancel", (e) => {
    e.preventDefault();
    handleClose();
  });

  // 为所有现有的 expand-btn 绑定事件
  bindExpandButtons();

  // 使用 MutationObserver 监听 DOM 变化，自动绑定新增的 expand-btn（debounced）
  let _expandDebounce = 0;
  observer = new MutationObserver(() => {
    clearTimeout(_expandDebounce);
    _expandDebounce = setTimeout(bindExpandButtons, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  console.log("[expandEditor] 放大编辑器已初始化");
}

/**
 * 绑定所有 .expand-btn 按钮的点击事件
 */
function bindExpandButtons() {
  document.querySelectorAll(".expand-btn:not([data-bound]):not([data-expand-programmatic])").forEach((btn) => {
    btn.dataset.bound = "true";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 找到关联的 textarea（同级的 data-expandable textarea）
      const container = btn.closest(".expandable-container");
      if (!container) return;
      const textarea = container.querySelector("textarea[data-expandable]");
      if (!textarea) return;

      try {
        openTextareaEditor(textarea);
      } catch (error) {
        console.error("[expandEditor] 打开放大编辑器失败:", error);
        window._beiluToast?.(error.message || "放大编辑器打开失败", "error");
      }
    });
  });
}

/**
 * 兼容现有 data-expandable textarea 的声明式入口。
 * @param {HTMLTextAreaElement} textarea - 源 textarea 元素
 */
function openTextareaEditor(textarea) {
  return openExpandEditor({
    title: textarea.dataset.expandTitle || textarea.placeholder || textarea.id || "编辑",
    value: textarea.value,
    readOnly: textarea.readOnly || textarea.disabled,
    onSave(value) {
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    },
  });
}

/**
 * 程序化打开放大编辑器。adapter 只在用户点保存时执行；关闭路径只通知 onClose。
 * @param {{title?: string, value?: unknown, readOnly?: boolean,
 *   onSave?: (value: string) => (void|Promise<void>),
 *   onClose?: (result: {saved: boolean, value: string}) => void}} options
 * @returns {true}
 */
export function openExpandEditor(options = {}) {
  if (!initialized) initExpandEditor();
  if (!modal || !modalTextarea) {
    throw new Error("放大编辑器 dialog 未初始化");
  }
  if (activeSession || modal.open) {
    throw new Error("已有放大编辑会话正在进行，请先关闭当前窗口");
  }

  const value = String(options.value ?? "");
  const readOnly = options.readOnly === true;
  activeSession = {
    initialValue: value,
    readOnly,
    onSave: typeof options.onSave === "function" ? options.onSave : null,
    onClose: typeof options.onClose === "function" ? options.onClose : null,
  };
  saving = false;
  if (modalTitle) modalTitle.textContent = options.title || "编辑";
  modalTextarea.value = value;
  modalTextarea.readOnly = readOnly;
  if (saveBtn) {
    saveBtn.style.display = readOnly ? "none" : "";
    saveBtn.disabled = false;
  }

  try {
    modal.showModal();
  } catch (error) {
    activeSession = null;
    modalTextarea.readOnly = false;
    if (saveBtn) saveBtn.style.display = "";
    throw error;
  }
  requestAnimationFrame(() => {
    if (!activeSession || !modalTextarea) return;
    modalTextarea.focus();
    modalTextarea.setSelectionRange(modalTextarea.value.length, modalTextarea.value.length);
  });
  return true;
}

/** 保存由当前 adapter 处理；adapter 抛错时保留弹窗，禁止假保存。 */
async function handleSave() {
  const session = activeSession;
  if (!session || !modalTextarea || session.readOnly || saving) return;
  saving = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const value = modalTextarea.value;
    await session.onSave?.(value);
    finishClose(true, value);
  } catch (error) {
    console.error("[expandEditor] 保存失败，编辑窗口保持打开:", error);
    window._beiluToast?.(error.message || "放大编辑保存失败", "error");
    modalTextarea.focus();
  } finally {
    saving = false;
    if (saveBtn && activeSession) saveBtn.disabled = false;
  }
}

/**
 * 关闭 modal（不保存）。
 * 界面9: 有未保存改动时先确认，防 ✕/Esc/点遮罩误丢大段编辑内容。
 */
async function handleClose() {
  const session = activeSession;
  if (!modal || !modalTextarea || !session || saving) return;
  const dirty =
    !session.readOnly && modalTextarea.value !== session.initialValue;
  if (dirty && !await beiluConfirm("有未保存的修改，确定不保存就关闭吗？")) return;
  finishClose(false, modalTextarea.value);
}

function finishClose(saved, value) {
  const session = activeSession;
  if (!session || !modal) return;
  activeSession = null;
  modal.close();
  modalTextarea.readOnly = false;
  if (saveBtn) {
    saveBtn.style.display = "";
    saveBtn.disabled = false;
  }
  try {
    session.onClose?.({ saved, value });
  } catch (error) {
    console.error("[expandEditor] onClose 回调失败:", error);
  }
}
