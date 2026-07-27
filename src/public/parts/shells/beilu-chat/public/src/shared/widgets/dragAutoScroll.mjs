/**
 * dragAutoScroll.mjs — HTML5 拖拽会话中的列表边缘自动滚动（单例引擎 + 容器注册）
 *
 * why（0722 凛倾「拉动改位置的时候滚轮无效,向上拖动不会把条目上移」）：
 *   浏览器在 HTML5 DnD 会话期间抑制 wheel 事件派发——平台行为，页面侧无法恢复滚轮。
 *   长列表拖拽排序因此拖不出可视区：用户把条目拖过列表顶（悬停在搜索框/头部等无 drop
 *   handler 区域）松手=拖拽取消，条目纹丝不动，体感即「向上拖不上移」。
 *   成熟 DnD 实现的标准机制=拖拽中靠近滚动容器上下边缘时按距离比例自动滚动，本模块即该机制。
 *
 * 机制：
 *   - document 捕获级 dragover 全程可收（指针悬停在容器外的搜索框/头部也触发）→
 *     指针在注册容器的水平带内且靠近/越过其上下可视边缘 → rAF 循环按比例滚 scrollTop。
 *   - dragstart 门控：仅当拖拽源在某注册容器内才激活该容器（OS 文件拖入无页面 dragstart，
 *     天然不触发；消息拖出等他源拖拽命不中容器=不滚，互不干扰）。
 *   - 注册表 Set 持强引用：dragstart 时剔除已脱离 DOM 的旧容器（面板重渲染的新实例重复注册
 *     由 Set 按节点身份去重，旧节点下次拖拽即被清）。
 *
 * 消费方（同型拖拽排序列表全量接入，缺一处=该列表保留原病）：
 *   panels.mjs #pp-entry-list（预设条目）/ memtool.mjs #pseries-prompt-list（p系列条目）/
 *   regexEditor.mjs #regex-list（正则规则）/ subModePanel.mjs #submode-detail-panel（组内步骤）。
 *
 * 无后端请求，无存储，纯事件绑定；document 监听器模块级仅绑一次。
 */

const _containers = new Set();
let _activeContainer = null;
let _rafId = 0;
let _vy = 0;

const EDGE = 48; // 距边缘多少 px 内开始滚动（越过边缘=满速）
const MAX_SPEED = 16; // px/帧 上限

function _prune() {
  for (const c of _containers) if (!c.isConnected) _containers.delete(c);
}

function _stop() {
  _activeContainer = null;
  _vy = 0;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
}

function _tick() {
  _rafId = 0;
  if (!_activeContainer || !_vy) return;
  _activeContainer.scrollTop += _vy;
  _rafId = requestAnimationFrame(_tick);
}

function _onDragStart(ev) {
  _prune();
  _activeContainer = null;
  for (const c of _containers) {
    if (c.contains(ev.target)) { _activeContainer = c; break; }
  }
}

function _onDragOver(ev) {
  const c = _activeContainer;
  if (!c) return;
  if (c.scrollHeight <= c.clientHeight) return; // 无溢出无需滚
  const r = c.getBoundingClientRect();
  // 水平带外（拖去别的面板）不滚；左右各放宽 24px 容忍手抖
  if (ev.clientX < r.left - 24 || ev.clientX > r.right + 24) { _vy = 0; return; }
  const topDist = ev.clientY - r.top; // 越过顶边为负=满速向上
  const bottomDist = r.bottom - ev.clientY;
  if (topDist < EDGE) _vy = -Math.min(MAX_SPEED, Math.ceil(((EDGE - topDist) / EDGE) * MAX_SPEED));
  else if (bottomDist < EDGE) _vy = Math.min(MAX_SPEED, Math.ceil(((EDGE - bottomDist) / EDGE) * MAX_SPEED));
  else _vy = 0;
  if (_vy && !_rafId) _rafId = requestAnimationFrame(_tick);
}

document.addEventListener("dragstart", _onDragStart, true);
document.addEventListener("dragover", _onDragOver, true);
document.addEventListener("dragend", _stop, true);
document.addEventListener("drop", _stop, true);

/**
 * 注册一个滚动容器参与拖拽自动滚动。幂等（Set 按节点去重），重渲染后用新节点再调即可。
 * @param {HTMLElement} container - overflow-y 可滚的列表容器
 */
export function enableDragAutoScroll(container) {
  if (container instanceof HTMLElement) _containers.add(container);
}
