/**
 * expandEditor.mjs — 通用 textarea 放大编辑器
 *
 * 功能：
 * - 为所有带 data-expandable 属性的 textarea 添加放大按钮
 * - 点击放大按钮 → 打开 dialog modal → 全屏编辑
 * - 保存时将内容同步回原 textarea 并触发 input 事件
 * - 支持 Escape 关闭、点击遮罩关闭
 *
 * 依赖：
 * - HTML 中已有 <dialog id="expand-editor-modal"> 容器
 * - CSS 中已有 .expand-editor-modal / .expand-btn 等样式
 */

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

/** 当前正在编辑的源 textarea */
let sourceTextarea = null;

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

  // 使用 MutationObserver 监听 DOM 变化，自动绑定新增的 expand-btn
  const observer = new MutationObserver(() => {
    bindExpandButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  console.log("[expandEditor] 放大编辑器已初始化");
}

/**
 * 绑定所有 .expand-btn 按钮的点击事件
 */
function bindExpandButtons() {
  document.querySelectorAll(".expand-btn:not([data-bound])").forEach((btn) => {
    btn.dataset.bound = "true";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 找到关联的 textarea（同级的 data-expandable textarea）
      const container = btn.closest(".expandable-container");
      if (!container) return;
      const textarea = container.querySelector("textarea[data-expandable]");
      if (!textarea) return;

      openExpandEditor(textarea);
    });
  });
}

/**
 * 打开放大编辑器
 * @param {HTMLTextAreaElement} textarea - 源 textarea 元素
 */
function openExpandEditor(textarea) {
  if (!modal || !modalTextarea) return;

  sourceTextarea = textarea;

  // 设置标题（优先用 data-expand-title，其次用 placeholder，最后用 id）
  const title =
    textarea.dataset.expandTitle ||
    textarea.placeholder ||
    textarea.id ||
    "编辑";
  if (modalTitle) modalTitle.textContent = title;

  // 同步内容
  modalTextarea.value = textarea.value;

  // 同步只读状态
  modalTextarea.readOnly = textarea.readOnly;
  if (saveBtn) {
    saveBtn.style.display = textarea.readOnly ? "none" : "";
  }

  // 打开 dialog
  modal.showModal();

  // 聚焦到 textarea 末尾
  requestAnimationFrame(() => {
    modalTextarea.focus();
    modalTextarea.setSelectionRange(
      modalTextarea.value.length,
      modalTextarea.value.length,
    );
  });
}

/**
 * 保存并关闭
 */
function handleSave() {
  if (!sourceTextarea || !modalTextarea) return;

  // 回写内容
  sourceTextarea.value = modalTextarea.value;

  // 触发 input 和 change 事件，确保其他监听器感知到变化
  sourceTextarea.dispatchEvent(new Event("input", { bubbles: true }));
  sourceTextarea.dispatchEvent(new Event("change", { bubbles: true }));

  handleClose();
}

/**
 * 关闭 modal（不保存）
 */
function handleClose() {
  if (!modal) return;
  sourceTextarea = null;
  modal.close();
}
