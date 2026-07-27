/**
 * beiluDialog.mjs — 共享异步确认/输入弹窗（替代原生 confirm/prompt）
 *
 * 功能链：
 *   调用方 await beiluConfirm(msg) / beiluPrompt(msg) → _dialogQueue 串行化
 *   → _mountDialog（body append <dialog class="modal">）→ showModal()
 *   → 用户点确认/取消/ESC → resolve(true/false/string/null) → dialog 自移除
 *
 * why：
 *   原生 confirm/prompt 同步阻塞 UI 线程、样式不随主题；
 *   Promise 化后可配合 async/await 使用，同时保持「同一时刻最多一个弹窗」的用户预期（队列串行）；
 *   用原生 <dialog> + showModal() 获得浏览器内置居中/backdrop/ESC 支持，不引入额外依赖；
 *   textContent/value 注入用户文案，天然免 XSS，无需 escapeHtml。
 *
 * 关联链：
 *   ← featureControls.mjs、tokenProgressBar.mjs、settingsSlots.mjs、mcpPanel.mjs、permissionPanel.mjs 等（广泛使用）
 *   无外部依赖（0 import），纯 DOM 操作。
 *
 * 影响范围：
 *   DOM：动态 append/remove body 下 <dialog class="modal">；
 *   样式：复用 DaisyUI modal/modal-box/modal-action/btn/btn-primary，不新增 CSS；
 *   无后端请求、无 localStorage 读写。
 *
 * 使用效果：
 *   await beiluConfirm("确认删除？") → true/false；
 *   await beiluPrompt("请输入名称", "默认值") → string/null；
 *   await beiluChoice("去向？", [{label,value}...]) → value/null（2-3 个按钮式选项）；
 *   await beiluSelect("选哪个？", ["a","b",...], {defaultValue}) → value/null（长列表下拉选择）；
 *   并发调用自动排队，前一个关闭后再弹下一个。
 */

// 并发守卫：原生 confirm/prompt 是同步阻塞的，不可能双击打开两个弹窗。
// 异步 beiluConfirm/beiluPrompt 不阻塞 UI 线程，双击可触发两次。用队列串行化：
// 后到的调用等前一个关闭后再 showModal，保持"同一时刻最多一个确认弹窗"的用户预期。
let _dialogQueue = Promise.resolve();

/**
 * 创建一个挂在 body 上的 <dialog class="modal">，注入 modal-box 内容，showModal 后返回 dialog 元素。
 * 关闭即从 DOM 移除（self-cleaning），不复用同一节点以免事件/状态残留。
 * @param {string} innerHtml - modal-box 内部的 HTML（结构固定、无用户插值，安全）。
 * @returns {HTMLDialogElement}
 */
function _mountDialog(innerHtml) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.innerHTML = `<div class="modal-box max-w-sm">${innerHtml}</div>`;
  document.body.appendChild(dlg);
  return dlg;
}

/**
 * 异步确认对话框，替代原生 confirm。
 * @param {string} message - 提示文案。
 * @param {Object} [options]
 * @param {string} [options.title] - 可选标题（不传则不渲染标题行）。
 * @param {string} [options.confirmText="确认"] - 确认按钮文案。
 * @param {string} [options.cancelText="取消"] - 取消按钮文案。
 * @returns {Promise<boolean>} 确认→true，取消/ESC/点遮罩→false。
 */
function beiluConfirm(message, options = {}) {
  const {
    title = "",
    confirmText = "确认",
    cancelText = "取消",
    // 0716 收口：危险确认变体（收编 dataTable._dangerConfirm 第二套 dialog）。
    // danger=true：确认钮降为红字次级样式 + 默认焦点给「取消」（R9/R10 设计：防 Enter 误删）。
    danger = false,
  } = options;

  const task = () => new Promise((resolve) => {
    const dlg = _mountDialog(
      (title ? `<h3 class="font-bold text-base mb-2" data-role="title"></h3>` : "") +
        `<p class="text-sm mb-4" data-role="msg" style="white-space:pre-wrap;opacity:0.9;"></p>` +
        `<div class="modal-action" style="display:flex;gap:0.5rem;justify-content:flex-end;">` +
        `<button type="button" class="btn btn-sm" data-role="cancel"></button>` +
        (danger
          ? `<button type="button" class="btn btn-sm btn-ghost" style="color:var(--beilu-error);font-size:0.8em;" data-role="ok"></button>`
          : `<button type="button" class="btn btn-sm btn-primary" data-role="ok"></button>`) +
        `</div>`,
    );

    if (title) dlg.querySelector('[data-role="title"]').textContent = title;
    dlg.querySelector('[data-role="msg"]').textContent = message;
    const okBtn = dlg.querySelector('[data-role="ok"]');
    const cancelBtn = dlg.querySelector('[data-role="cancel"]');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 已关闭 */ }
      dlg.remove();
      resolve(val);
    };

    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); }); // ESC=取消
    // 点击遮罩（dialog 本体而非 modal-box 子元素）=取消
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(false); });

    dlg.showModal();
    (danger ? cancelBtn : okBtn).focus(); // danger：取消默认焦点，防 Enter 误删
  });
  _dialogQueue = _dialogQueue.then(task, task);
  return _dialogQueue;
}

/**
 * 异步输入对话框，替代原生 prompt。
 * @param {string} message - 提示文案。
 * @param {string} [defaultValue=""] - 输入框默认值。
 * @param {Object} [options]
 * @param {string} [options.title] - 可选标题。
 * @param {string} [options.confirmText="确认"] - 确认按钮文案。
 * @param {string} [options.cancelText="取消"] - 取消按钮文案。
 * @param {string} [options.placeholder=""] - 输入框占位符。
 * @returns {Promise<string|null>} 确认→输入值（字符串），取消/ESC/点遮罩→null。
 */
function beiluPrompt(message, defaultValue = "", options = {}) {
  const {
    title = "",
    confirmText = "确认",
    cancelText = "取消",
    placeholder = "",
  } = options;

  const task = () => new Promise((resolve) => {
    const dlg = _mountDialog(
      (title ? `<h3 class="font-bold text-base mb-2" data-role="title"></h3>` : "") +
        `<p class="text-sm mb-3" data-role="msg" style="white-space:pre-wrap;opacity:0.9;"></p>` +
        `<input type="text" class="input input-bordered input-sm w-full mb-4" data-role="field" />` +
        `<div class="modal-action" style="display:flex;gap:0.5rem;justify-content:flex-end;">` +
        `<button type="button" class="btn btn-sm" data-role="cancel"></button>` +
        `<button type="button" class="btn btn-sm btn-primary" data-role="ok"></button>` +
        `</div>`,
    );

    if (title) dlg.querySelector('[data-role="title"]').textContent = title;
    dlg.querySelector('[data-role="msg"]').textContent = message;
    const field = dlg.querySelector('[data-role="field"]');
    const okBtn = dlg.querySelector('[data-role="ok"]');
    const cancelBtn = dlg.querySelector('[data-role="cancel"]');
    field.value = defaultValue != null ? String(defaultValue) : "";
    field.placeholder = placeholder;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 已关闭 */ }
      dlg.remove();
      resolve(val);
    };

    okBtn.addEventListener("click", () => finish(field.value));
    cancelBtn.addEventListener("click", () => finish(null));
    // 输入框回车=确认
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(field.value); }
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); }); // ESC=取消
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(null); });

    dlg.showModal();
    field.focus();
    field.select();
  });
  _dialogQueue = _dialogQueue.then(task, task);
  return _dialogQueue;
}

/**
 * 异步多选项对话框（如删除去向选择：回收站 vs 彻底删）。
 * T026：凛倾原话「询问用户是否让api等的数据进回收站还是说直接完全删除，防止留痕」——
 *   两个动作按钮 + 取消，beiluConfirm 的布尔语义装不下三态，故独立成通用组件。
 * @param {string} message - 提示文案。
 * @param {Array<{label:string,value:string,className?:string}>} choices - 选项按钮（从左到右渲染）。
 * @param {Object} [options]
 * @param {string} [options.title] - 可选标题。
 * @param {string} [options.cancelText="取消"] - 取消按钮文案。
 * @returns {Promise<string|null>} 选中项的 value；取消/ESC/点遮罩→null。
 */
function beiluChoice(message, choices = [], options = {}) {
  const { title = "", cancelText = "取消" } = options;

  const task = () => new Promise((resolve) => {
    const dlg = _mountDialog(
      (title ? `<h3 class="font-bold text-base mb-2" data-role="title"></h3>` : "") +
        `<p class="text-sm mb-4" data-role="msg" style="white-space:pre-wrap;opacity:0.9;"></p>` +
        `<div class="modal-action" style="display:flex;gap:0.5rem;justify-content:flex-end;flex-wrap:wrap;">` +
        `<button type="button" class="btn btn-sm" data-role="cancel"></button>` +
        choices.map((_, i) => `<button type="button" class="btn btn-sm" data-role="choice" data-idx="${i}"></button>`).join("") +
        `</div>`,
    );

    if (title) dlg.querySelector('[data-role="title"]').textContent = title;
    dlg.querySelector('[data-role="msg"]').textContent = message;
    const cancelBtn = dlg.querySelector('[data-role="cancel"]');
    cancelBtn.textContent = cancelText;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 已关闭 */ }
      dlg.remove();
      resolve(val);
    };

    dlg.querySelectorAll('[data-role="choice"]').forEach((btn) => {
      const c = choices[parseInt(btn.dataset.idx)];
      btn.textContent = c.label;
      if (c.className) btn.className = `btn btn-sm ${c.className}`;
      btn.addEventListener("click", () => finish(c.value));
    });
    cancelBtn.addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); }); // ESC=取消
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(null); });

    dlg.showModal();
    cancelBtn.focus(); // 默认焦点落取消：删除类选择不给回车误触的默认动作
  });
  _dialogQueue = _dialogQueue.then(task, task);
  return _dialogQueue;
}

/**
 * 异步下拉选择对话框（长列表选一个：导出角色卡/世界书/预设等；按钮式 beiluChoice 只适合 2-3 个选项）。
 * @param {string} message - 提示文案。
 * @param {Array<string|{label:string,value:string}>} items - 候选项（字符串或 {label,value}）。
 * @param {Object} [options]
 * @param {string} [options.title] - 可选标题。
 * @param {string} [options.confirmText="确认"] - 确认按钮文案。
 * @param {string} [options.cancelText="取消"] - 取消按钮文案。
 * @param {string} [options.defaultValue] - 默认选中项的 value。
 * @returns {Promise<string|null>} 选中项的 value；取消/ESC/点遮罩→null。
 */
function beiluSelect(message, items = [], options = {}) {
  const { title = "", confirmText = "确认", cancelText = "取消", defaultValue = "" } = options;

  const task = () => new Promise((resolve) => {
    const dlg = _mountDialog(
      (title ? `<h3 class="font-bold text-base mb-2" data-role="title"></h3>` : "") +
        `<p class="text-sm mb-2" data-role="msg" style="white-space:pre-wrap;opacity:0.9;"></p>` +
        `<select class="select select-sm select-bordered w-full mb-4" data-role="select"></select>` +
        `<div class="modal-action" style="display:flex;gap:0.5rem;justify-content:flex-end;">` +
        `<button type="button" class="btn btn-sm" data-role="cancel"></button>` +
        `<button type="button" class="btn btn-sm btn-primary" data-role="ok"></button>` +
        `</div>`,
    );

    if (title) dlg.querySelector('[data-role="title"]').textContent = title;
    dlg.querySelector('[data-role="msg"]').textContent = message;
    const sel = dlg.querySelector('[data-role="select"]');
    for (const it of items) {
      const opt = document.createElement("option");
      const value = typeof it === "string" ? it : it.value;
      opt.value = value;
      opt.textContent = typeof it === "string" ? it : it.label; // textContent 注入，免 XSS
      if (value === defaultValue) opt.selected = true;
      sel.appendChild(opt);
    }
    const okBtn = dlg.querySelector('[data-role="ok"]');
    const cancelBtn = dlg.querySelector('[data-role="cancel"]');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { dlg.close(); } catch { /* 已关闭 */ }
      dlg.remove();
      resolve(val);
    };

    okBtn.addEventListener("click", () => finish(sel.value || null));
    cancelBtn.addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); }); // ESC=取消
    dlg.addEventListener("click", (e) => { if (e.target === dlg) finish(null); });

    dlg.showModal();
    sel.focus();
  });
  _dialogQueue = _dialogQueue.then(task, task);
  return _dialogQueue;
}

export { beiluConfirm, beiluPrompt, beiluChoice, beiluSelect };
