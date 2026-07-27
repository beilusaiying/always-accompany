/**
 * [storage.mjs] — 前端 localStorage 行为镜像封装。不管 key 定义（那是 storage-keys.mjs 的事），
 *   不管后端持久化（那是后端 chatStorage/storage.mjs 的事）。
 *
 * 功能链：前端所有模块 → storage.get/set/remove(key) → try/catch 容错 → 浏览器 localStorage
 *   → 返回裸字符串（get）/ 无返回（set/remove）。
 *   同时 re-export KEYS 常量，让消费方可以 `import { storage, KEYS } from "./storage.mjs"` 一行搞定。
 *
 * why：浏览器 localStorage 在私隐模式 / 存储配额满 / 跨域时会抛异常，直接裸调会导致整个模块崩溃。
 *   同时前端 localStorage 读写散落在各处，key 字符串手写极易 typo。本模块将两个问题一并解决：
 *   统一 try/catch 容错（异常静默降级），并集中 import KEYS 常量（key 字面值统一来源）。
 *   不做自动 JSON.parse/stringify 是刻意设计——全前端用裸字符串比对（`=== "true"`），
 *   自动解析会导致所有比对全挂、非 JSON 值抛错（如 `JSON.parse("google")`）。
 *
 * 关联链：
 *   被 import → chat.mjs / sharedState.mjs / diagLogger.mjs / featureControls.mjs / index*.mjs 等全前端消费
 *   → 浏览器原生 localStorage（本模块是 localStorage 的唯一权威封装）
 *   → storage-keys.mjs（re-export KEYS 常量枚举）
 *
 * 影响范围：
 *   - 改动 get() 逻辑 → 影响全前端所有偏好/状态读取（模式、主题、聊天 ID 等）
 *   - 改动 set()/remove() → 影响偏好持久化，降级策略变化会影响私隐模式用户体验
 *   - 改动 KEYS re-export → 影响所有 import { KEYS } from "./storage.mjs" 的消费方
 *
 * 使用效果：
 *   - 用户切换主题 / 模式 / 字体大小 → set() 持久化到 localStorage → 下次刷新仍生效
 *   - 用户使用私隐模式 → set() 静默降级（不写入）→ 页面仍正常运行，不报错
 *   - 需要 JSON 的场景：消费方自行 `JSON.parse(storage.get(k))`，本模块不介入
 *
 * 复用：import { storage, KEYS } from "./storage.mjs";
 */

export { KEYS } from "./storage-keys.mjs"; // 便于单 import：import { storage, KEYS } from "./storage.mjs"
import { KEYS as _K } from "./storage-keys.mjs";

// 诊断 config 模块常驻埋点（配置写路失败可见化——原全静默，私隐模式/配额满时偏好丢失无任何信号）。
// 必须动态 import：diagLogger 静态 import 本模块且其底部启动块求值期就调 storage.get，
// 反向静态 import 会让本模块 const storage 在循环求值期处于 TDZ 直接崩。get() 禁埋点（emit 自身读 storage.get=无限递归）。
let _cfgDiag = null;
if (typeof window !== "undefined") {
  import("./diagLogger.mjs").then((m) => { _cfgDiag = m.createDiag("config"); }).catch(() => { /* 诊断不可用不影响存储 */ });
}

/**
 * 窗口局部键类别（0715 多窗口审计 LS-1 框架修）。
 * why：localStorage 是 per-origin 单例，而「当前角色」这类身份态语义是 per-window——
 *   窗口A操作角色X、窗口B切到角色Y 会互相覆盖，A 的 25+ 直读点全部读到 B 的值
 *   （getModeChatIdKey 分区键错乱→恢复错对话）。机制=接受域集合+成员判定：类别内的键
 *   get 走 sessionStorage（per-tab）优先、无值时从 localStorage 兜底并「首读钉住」进本窗；
 *   set/remove 双写（sessionStorage=本窗真值，localStorage=新窗口继承默认）。
 *   消费方零改动（25 处直读自动获得 per-window 语义）；加新窗口局部键=只扩本集合。
 */
const WINDOW_LOCAL_KEYS = new Set([
  _K.BEILU_LAST_CHAR,
  // LS-1：当前模式显示态也是 per-window 语义（窗口A=code、窗口B=chat 合法并存，后端
  //   active_modes_map per-chatid 支持）。三个读点（featureControls init 恢复/审批通知 fromMode/
  //   done-sound 模式判定）全部指"本窗口模式"——跨窗覆盖对三者都是污染；后端权威不受影响
  //   （syncModeFromBackend/WS mode_changed 照常修正本窗值）。
  _K.BEILU_ACTIVE_MODE,
  // 草稿=输入框态（per-window）：messageInput 单键纯字符串，窗A打字中被窗B清空/覆盖=丢输入。
  //   （messageInput:72"单份草稿"指本窗内跨对话/模式共享一份，非跨窗共享的设计决策。）
  _K.BEILU_CHAT_DRAFT,
]);

export const storage = {
  /** @returns {string|null} 同 localStorage.getItem；异常返 null。窗口局部键 per-tab 优先+首读钉住 */
  get(key) {
    try {
      if (WINDOW_LOCAL_KEYS.has(key)) {
        const s = sessionStorage.getItem(key);
        if (s !== null) return s;
        const g = localStorage.getItem(key);
        if (g !== null) sessionStorage.setItem(key, g); // 首读钉住：此后跨窗写不再漂移本窗身份
        return g;
      }
      return localStorage.getItem(key);
    } catch { return null; }
  },
  /** 同 localStorage.setItem（val 原生 String 强制）；异常静默（quota/private-mode）。窗口局部键双写 */
  set(key, val) {
    try {
      if (WINDOW_LOCAL_KEYS.has(key)) { try { sessionStorage.setItem(key, val); } catch { /* 静默 */ } }
      localStorage.setItem(key, val);
    } catch (e) {
      // quota/private-mode: 行为仍静默降级，但埋点出信号（偏好写失败=刷新后丢失的根因，原完全不可见）
      _cfgDiag?.warn("set 失败（quota/私隐模式?）:", key, e?.name || e?.message);
    }
  },
  /** 同 localStorage.removeItem；异常静默。窗口局部键双删 */
  remove(key) {
    try {
      if (WINDOW_LOCAL_KEYS.has(key)) { try { sessionStorage.removeItem(key); } catch { /* 静默 */ } }
      localStorage.removeItem(key);
    } catch (e) {
      _cfgDiag?.warn("remove 失败:", key, e?.name || e?.message);
    }
  },
  /**
   * 清空全部 beilu 前端状态（"beilu-" 前缀域）。仅限账号级终结场景（删号/等价重置）调用。
   * why：批量清理语义收进门面——前缀而非 KEYS 枚举，是因为存在动态后缀键
   *   （如 BEILU_CHAT_CHATID + ":" + charName），枚举清单必漏。
   *   前缀即清理域契约：账号级状态键必须 "beilu-" 开头；设备级偏好（theme/beiluHomeLang/
   *   userPreferredLanguages）刻意不带前缀=删号后保留，是特性不是遗漏。
   *   页面层 base.mjs:126 因层级隔离（pages 层不 import 壳模块）保有同语义副本，改这里须同步改那里。
   */
  clearAll() {
    try {
      _cfgDiag?.warn("clearAll：清空全部 beilu- 前缀键（账号级终结场景）");
      for (const k of Object.keys(localStorage)) if (k.startsWith("beilu-")) localStorage.removeItem(k);
      // 窗口局部镜像同域清理（sessionStorage 侧，删号后本窗不残留钉住身份）
      try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("beilu-")) sessionStorage.removeItem(k); } catch { /* 静默 */ }
    } catch { /* 静默 */ }
  },
};
