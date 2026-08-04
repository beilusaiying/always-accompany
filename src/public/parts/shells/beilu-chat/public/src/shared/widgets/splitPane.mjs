/**
 * splitPane.mjs — 左右主从面板的通用百分比分栏。
 *
 * 用户通过鼠标、触控笔或键盘调整左栏宽度；宽度写入统一 storage key，
 * 右栏继续由调用方的 flex:1/min-width:0 接管。组件只负责视图偏好，
 * 不读取或修改两侧业务数据。
 */

import { storage } from "../state/storage.mjs";

const isElement = (value) => value instanceof HTMLElement;

/**
 * @param {{
 *   container: HTMLElement,
 *   primary: HTMLElement,
 *   handle: HTMLElement,
 *   storageKey: string,
 *   defaultPercent?: number,
 *   minPercent?: number,
 *   maxPercent?: number,
 *   keyboardStep?: number,
 * }} options
 * @returns {{getPercent: () => number, setPercent: (value:number, options?:{persist?:boolean}) => number, destroy: () => void}}
 */
export function initHorizontalSplitPane(options = {}) {
  const {
    container,
    primary,
    handle,
    storageKey,
    defaultPercent = 45,
    minPercent = 15,
    maxPercent = 80,
    keyboardStep = 5,
  } = options;

  if (!isElement(container) || !isElement(primary) || !isElement(handle)) {
    throw new TypeError("splitPane 需要有效的 container、primary 和 handle 元素");
  }
  if (!container.contains(primary) || !container.contains(handle)) {
    throw new TypeError("splitPane 的 primary 和 handle 必须属于同一 container");
  }
  if (typeof storageKey !== "string" || !storageKey.trim()) {
    throw new TypeError("splitPane 需要非空 storageKey");
  }

  const numbers = [defaultPercent, minPercent, maxPercent, keyboardStep].map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new TypeError("splitPane 的比例参数必须是有限数值");
  }
  if (minPercent >= maxPercent || defaultPercent < minPercent || defaultPercent > maxPercent || keyboardStep <= 0) {
    throw new RangeError("splitPane 的默认值、边界或键盘步长无效");
  }

  const clamp = (value) => Math.min(maxPercent, Math.max(minPercent, value));
  let currentPercent = defaultPercent;
  let activePointerId = null;
  let destroyed = false;
  let bodyUserSelect = "";
  let bodyCursor = "";
  let handleBackground = "";

  const persistCurrent = () => storage.set(storageKey, currentPercent.toFixed(1));
  const applyPercent = (rawValue, { persist = false } = {}) => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) throw new TypeError("splitPane 宽度必须是有限数值");
    currentPercent = clamp(parsed);
    primary.style.width = `${currentPercent.toFixed(1)}%`;
    handle.setAttribute("aria-valuenow", currentPercent.toFixed(1));
    if (persist) persistCurrent();
    return currentPercent;
  };

  handle.setAttribute("role", "separator");
  handle.setAttribute("tabindex", "0");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", String(minPercent));
  handle.setAttribute("aria-valuemax", String(maxPercent));
  if (primary.id) handle.setAttribute("aria-controls", primary.id);
  if (!handle.hasAttribute("aria-label")) handle.setAttribute("aria-label", "调整左右面板宽度");
  handle.style.touchAction = "none";
  handle.style.cursor = "col-resize";

  const savedPercent = Number.parseFloat(storage.get(storageKey));
  applyPercent(Number.isFinite(savedPercent) && savedPercent >= minPercent && savedPercent <= maxPercent
    ? savedPercent
    : defaultPercent);

  const restoreDragVisuals = () => {
    handle.classList.remove("split-pane-dragging");
    delete handle.dataset.dragging;
    handle.style.background = handleBackground;
    document.body.style.userSelect = bodyUserSelect;
    document.body.style.cursor = bodyCursor;
  };

  const finishPointer = (event, { persist = true } = {}) => {
    if (activePointerId === null) return;
    if (event?.pointerId != null && event.pointerId !== activePointerId) return;
    const pointerId = activePointerId;
    activePointerId = null;
    try {
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    } catch {
      // 元素已脱离 DOM 时浏览器会自行释放；仍必须恢复全局拖动态。
    }
    restoreDragVisuals();
    if (persist) persistCurrent();
  };

  const onPointerDown = (event) => {
    if (destroyed || activePointerId !== null || (event.button != null && event.button !== 0)) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    bodyUserSelect = document.body.style.userSelect;
    bodyCursor = document.body.style.cursor;
    handleBackground = handle.style.background;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    handle.classList.add("split-pane-dragging");
    handle.dataset.dragging = "true";
    handle.style.background = "var(--beilu-amber-35, rgba(217, 119, 6, 0.35))";
    handle.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (destroyed || event.pointerId !== activePointerId) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    applyPercent(((event.clientX - rect.left) / rect.width) * 100);
  };

  const onPointerEnd = (event) => finishPointer(event);
  const onLostPointerCapture = (event) => finishPointer(event);
  const onKeyDown = (event) => {
    let next = null;
    if (event.key === "ArrowLeft") next = currentPercent - keyboardStep;
    if (event.key === "ArrowRight") next = currentPercent + keyboardStep;
    if (event.key === "Home") next = minPercent;
    if (event.key === "End") next = maxPercent;
    if (next === null) return;
    event.preventDefault();
    applyPercent(next, { persist: true });
  };
  const onDoubleClick = (event) => {
    event.preventDefault();
    applyPercent(defaultPercent, { persist: true });
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerEnd);
  handle.addEventListener("pointercancel", onPointerEnd);
  handle.addEventListener("lostpointercapture", onLostPointerCapture);
  handle.addEventListener("keydown", onKeyDown);
  handle.addEventListener("dblclick", onDoubleClick);

  return {
    getPercent: () => currentPercent,
    setPercent: applyPercent,
    destroy() {
      if (destroyed) return;
      finishPointer(null, { persist: false });
      destroyed = true;
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerEnd);
      handle.removeEventListener("pointercancel", onPointerEnd);
      handle.removeEventListener("lostpointercapture", onLostPointerCapture);
      handle.removeEventListener("keydown", onKeyDown);
      handle.removeEventListener("dblclick", onDoubleClick);
    },
  };
}
