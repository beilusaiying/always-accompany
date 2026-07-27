/**
 * collapse.mjs — 折叠组展开/收起状态持久化 cluster
 *
 * 功能链：initCollapsePersistence() 扫描页面所有 input[data-collapse-id] → 从 localStorage 读取上次状态恢复 checked
 *   → 监听 change 事件 → saveCollapseState() 写回 localStorage
 *   → 折叠组从关闭到打开时派发 beilu:panel-expanded 事件触发懒加载
 * why：侧栏中有多个折叠分组（预设/世界书/人设等），用户调整的展开状态需要跨页面刷新持久化，
 *   同时懒加载事件避免关闭态的面板占用资源
 * 关联链：被 layout.mjs import（initCollapsePersistence 在 initLayout 时调用）；
 *   自身只 import storage.mjs，无其他 layout 内依赖；beilu:panel-expanded 事件被各懒加载面板监听
 * 影响范围：改动影响所有带 data-collapse-id 属性的折叠组的展开状态记忆和懒加载触发时机
 * 使用效果：用户展开「预设选择」折叠组后刷新页面，折叠组保持展开状态，且首次展开时才加载内部数据
 */
import { storage, KEYS } from "../state/storage.mjs";

// ============================================================
// 折叠组状态持久化
// ============================================================

// T5：原裸字符串 "beilu-chat-collapse-states" 与 storage-keys.mjs:46 KEYS.BEILU_CHAT_COLLAPSE_STATES
//   同值但游离于 KEYS 单源之外（mobileAdaptation.mjs 读侧已用 KEYS，写侧用裸串=键源分叉）。
//   改引 KEYS 常量，键名进单源。
const COLLAPSE_STORAGE_KEY = KEYS.BEILU_CHAT_COLLAPSE_STATES;

function initCollapsePersistence() {
  let savedStates = {};
  try {
    const raw = storage.get(COLLAPSE_STORAGE_KEY);
    if (raw) savedStates = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  const checkboxes = document.querySelectorAll(
    'input[type="checkbox"][data-collapse-id]',
  );
  checkboxes.forEach((cb) => {
    const id = cb.dataset.collapseId;
    if (!id) return;

    if (savedStates[id] !== undefined) {
      cb.checked = savedStates[id];
    }

    cb.addEventListener("change", () => {
      saveCollapseState(id, cb.checked);
      // 折叠组首开懒载触发总线（镜像 layout.mjs:439 beilu:tab-activated）。
      // 消费方各自闭包 loaded 幂等守卫 + collapse-id 白名单；初始已展开态由各闭包注册时自查（_lazyPanel(已开id)）补查。
      if (cb.checked) {
        window.dispatchEvent(
          new CustomEvent("beilu:panel-expanded", { detail: id }),
        );
      }
    });
  });
}

function saveCollapseState(id, isOpen) {
  let states = {};
  try {
    const raw = storage.get(COLLAPSE_STORAGE_KEY);
    if (raw) states = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  states[id] = isOpen;
  try {
    storage.set(COLLAPSE_STORAGE_KEY, JSON.stringify(states));
  } catch {
    /* ignore */
  }
}

export { initCollapsePersistence };
