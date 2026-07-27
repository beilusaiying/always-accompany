/**
 * [contentFilter.mjs] — 内容过滤（黑名单）单一 owner。
 * 职能：消息关键词黑名单 / 用户名黑名单 / 过滤范围(display|both) 的读写、后端同步、多入口 UI 双向同步。
 * 数据链：本模块写 localStorage(KEYS.BEILU_MSG_BLACKLIST/BEILU_USER_BLACKLIST/BEILU_BLACKLIST_FILTER_MODE)
 *   ├─ 显示侧消费：shared/render/messageList.mjs 渲染时直读 KEYS（仅 beilu-chat 显示层）
 *   └─ 后端同步：setSetting(server:user, key="contentFilter") → user.contentFilter
 *        ├─ chat 生成消费：beilu-chat/src/lib/requestBuilder._applyContentFilter（mode=both 过滤 chat_log）
 *        └─ bot 生成消费：scripts/botContentShared.applyBotContentFilter（9 平台壳 chat_log，mode=both）
 * 入口（消费方，调 bindContentFilterControls）：
 *   ① 设置面板（settings.mjs，ids: ui-msg-blacklist/ui-user-blacklist, radio name=blacklist-filter-mode）
 *   ② bot 面板（discordBotPanel.mjs，ids: dc-cf-*, radio name=dc-blacklist-filter-mode）
 * why 收口：0722 前设置面板私有绑定+私有后端同步；bot 面板加同域窗口若再抄一份 = 同键双写路
 *   （教训_修复自身也过病征清单）。改成本模块 own 读写+同步，任一入口改动即时镜像到其他入口 DOM。
 */
import { storage, KEYS } from "./storage.mjs";
import { sendAction } from "../transport/sendAction.mjs";

/** 已绑定控件组：{ msgEl, userEl, radios, onChange } */
const _groups = [];

const _splitLines = (v) => (v || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** 黑名单三键 → 后端 user.contentFilter 同步（生成侧过滤的数据源，写失败静默=下次改动重试） */
export function syncContentFilterToBackend() {
  sendAction({
    verb: "setSetting", target: "server:user", source: "web",
    payload: {
      key: "contentFilter",
      value: {
        mode: storage.get(KEYS.BEILU_BLACKLIST_FILTER_MODE) || "display",
        msgKeywords: _splitLines(storage.get(KEYS.BEILU_MSG_BLACKLIST)),
        userNames: _splitLines(storage.get(KEYS.BEILU_USER_BLACKLIST)),
      },
    },
  }).catch(() => {});
}

/** 单组回显：从 storage 读当前值写进该组控件 */
function _refreshGroup(g) {
  g.msgEl.value = storage.get(KEYS.BEILU_MSG_BLACKLIST) || "";
  g.userEl.value = storage.get(KEYS.BEILU_USER_BLACKLIST) || "";
  const mode = storage.get(KEYS.BEILU_BLACKLIST_FILTER_MODE) || "display";
  g.radios.forEach((r) => { r.checked = r.value === mode; });
}

/** 提交：写 storage → 同步后端 → 镜像其他已绑定入口 DOM → 触发本组回调（如设置面板 display 类刷新） */
function _commit(key, value, sourceGroup) {
  storage.set(key, value);
  syncContentFilterToBackend();
  for (const g of _groups) if (g !== sourceGroup) _refreshGroup(g);
  sourceGroup.onChange?.();
}

/**
 * 绑定一组内容过滤控件（幂等：同 msgEl 重复调用只回显不重复挂监听）。
 * @param {{ msgId: string, userId: string, radioName: string, onChange?: () => void }} spec
 */
export function bindContentFilterControls({ msgId, userId, radioName, onChange }) {
  const msgEl = document.getElementById(msgId);
  const userEl = document.getElementById(userId);
  if (!msgEl || !userEl) return;
  const existing = _groups.find((g) => g.msgEl === msgEl);
  if (existing) { _refreshGroup(existing); return; }
  const g = { msgEl, userEl, radios: [...document.querySelectorAll(`input[name="${radioName}"]`)], onChange };
  _groups.push(g);
  _refreshGroup(g);
  msgEl.addEventListener("change", () => _commit(KEYS.BEILU_MSG_BLACKLIST, msgEl.value, g));
  userEl.addEventListener("change", () => _commit(KEYS.BEILU_USER_BLACKLIST, userEl.value, g));
  g.radios.forEach((r) => r.addEventListener("change", () => { if (r.checked) _commit(KEYS.BEILU_BLACKLIST_FILTER_MODE, r.value, g); }));
  // 首绑同步一次后端（保持原设置面板初始化行为：本地已有黑名单时登录后端值对齐）
  syncContentFilterToBackend();
}
