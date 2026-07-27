/**
 * [storage-keys.mjs] — 前端 localStorage key 集中常量表（唯一权威来源）。
 *
 * 功能链：受控脚本 extract_localstorage_keys.mjs 扫全部 .mjs 中字面量 key → 去重生成本文件
 *   → storage-keys.mjs export KEYS 冻结对象 → storage.mjs re-export → 全前端消费方通过 KEYS.XXX 读写 key。
 *
 * why：历史上 localStorage key 字符串散落各文件手写，typo 导致读到错 key 的 bug 难以追查，
 *   且 key 改名时要全局搜改、极易漏改。本文件将所有 key 字面值收口为一处，
 *   禁止手敲常量名，由脚本自动生成以防 typo 和漂移（R2 / P2大重构）。
 *   key 字面值故意保持原始字符串不变，不加命名空间前缀——兼容用户浏览器中已存的旧数据，
 *   加前缀会导致旧数据全部失效（用户偏好重置）。Object.freeze() 防止运行时意外写入。
 *
 * 关联链：
 *   → storage.mjs（re-export 本文件 KEYS，消费方通常从 storage.mjs 一并 import）
 *   被 import → 全前端所有读写 localStorage 的模块（通过 storage.mjs 间接）
 *   生成来源 → extract_localstorage_keys.mjs 受控脚本（禁止手工增减常量）
 *
 * 影响范围：
 *   - 改动 key 字面值 → 直接导致浏览器旧存储读不到（用户偏好全部重置），高风险
 *   - 新增 key → 需先在脚本扫描后生成，禁止手敲
 *   - 删除 key → 对应模块的 KEYS.XXX 引用会报 undefined，需同步清理消费方
 *
 * 使用效果：
 *   - 消费方写 KEYS.BEILU_ACTIVE_MODE 而非字符串 "beilu-active-mode" → 拼写错误在开发期即可被 IDE 发现
 *   - 用户的所有浏览器端偏好（主题/模式/字体/聊天ID等）均通过这张表寻址
 */
// key 字面值保持不变（不加命名空间前缀，兼容浏览器中已存的旧数据）。
export const KEYS = Object.freeze({
  BEILU_ACTIVE_MODE: "beilu-active-mode",
  BEILU_AUTOCONTINUE_DELAY: "beilu-autocontinue-delay",
  BEILU_BG_BLUR: "beilu-bg-blur",
  BEILU_BG_FIT: "beilu-bg-fit",
  BEILU_BG_OPACITY: "beilu-bg-opacity",
  BEILU_BG_SOURCE: "beilu-bg-source",
  BEILU_BG_URL: "beilu-bg-url",
  BEILU_BOT_PLATFORM: "beilu-bot-platform",
  // 桌面 OS 通知开关：字面值与 pages/scripts/desktopNotify.mjs OPT_OUT_KEY 同键（读方在 app 层，写方=通知中心开关）
  BEILU_BROWSER_NOTIFY: "beilu-browser-notify",
  BEILU_CHAR_FAVORITES: "beilu-char-favorites",
  BEILU_CHAT_CHATID: "beilu-chat-chatid",
  BEILU_CHAT_DRAFT: "beilu-chat-draft",
  BEILU_CHAT_WIDTH: "beilu-chat-width",
  BEILU_CLAUDE_PREFILL_MODE: "beilu-claude-prefill-mode",
  BEILU_CLEANUP_MODE: "beilu-cleanup-mode",
  BEILU_CHAT_COLLAPSE_STATES: "beilu-chat-collapse-states",
  BEILU_CHAT_LAYOUT: "beilu-chat-layout",
  BEILU_CODE_CHATID: "beilu-code-chatid",
  BEILU_CODE_FOLD_ENABLED: "beilu-code-fold-enabled",
  BEILU_CODE_FOLD_MODE: "beilu-code-fold-mode",
  BEILU_COLOR_SCHEME: "beilu-color-scheme",
  BEILU_CONSOLE_ERROR_BRIDGE: "beilu-console-error-bridge",
  BEILU_CONVERSATION_META: "beilu-conversation-meta",
  BEILU_CONV_SHOW_ALL_MODES: "beilu-conv-show-all-modes",
  BEILU_CONTEXT_MSG_LIMIT: "beilu-context-msg-limit",
  BEILU_DEVICE_ID: "beilu-device-id",
  BEILU_DIAG_LEVEL: "beilu-diag-level",
  BEILU_DIAG_MODULES: "beilu-diag-modules",
  BEILU_DONE_SOUND: "beilu-done-sound",
  BEILU_DONE_SOUND_VOLUME: "beilu-done-sound-volume",
  BEILU_LOOP_ENABLED: "beilu-loop-enabled",
  BEILU_LOOP_STOP_N: "beilu-loop-stop-threshold", // [0724 双停退出] AI 连续停止几轮结束 Loop
  BEILU_LOOP_TEXT: "beilu-loop-text",
  BEILU_SCHEDULED_DAYS: "beilu-scheduled-days",
  BEILU_SCHEDULED_ENABLED: "beilu-scheduled-enabled",
  BEILU_SCHEDULED_TEXT: "beilu-scheduled-text",
  BEILU_SCHEDULED_TIME: "beilu-scheduled-time",
  BEILU_EDITOR_WINDOW_POS: "beilu-editor-window-pos",
  BEILU_EDITOR_WINDOW_SIZE: "beilu-editor-window-size",
  BEILU_ENHANCED_THEME: "beilu_enhanced_theme",
  BEILU_FILE_AUTO_CONTINUE: "beilu-file-auto-continue",
  BEILU_FILE_ROOT: "beilu-file-root",
  BEILU_FONT_FAMILY: "beilu-font-family",
  BEILU_FONT_SIZE: "beilu-font-size",
  BEILU_FIRST_RUN_GUIDE_DONE: "beilu-first-run-guide-done",
  BEILU_HIDE_CHAR_NAMES: "beilu-hide-char-names",
  BEILU_IMPORT_HISTORY: "beilu-import-history",
  BEILU_IMPORTED_THEME: "beilu-imported-theme",
  BEILU_IDE_AUTO_SAVE: "beilu-ide-auto-save",
  BEILU_IDE_CONN_SETTINGS: "beilu-ide-conn-settings",
  BEILU_IFRAME_SANDBOX: "beilu-iframe-sandbox",
  // 注入坞（0726）：仅两项本地 UI 偏好——排序方式 + 最近使用序。条目本体与开关都在后端
  //   injection_prompts，这里不存任何注入内容；单次注入队列是内存态，刻意不落任何存储。
  BEILU_INJECT_DOCK_SORT: "beilu-inject-dock-sort",
  BEILU_INJECT_DOCK_RECENT: "beilu-inject-dock-recent",
  BEILU_LAST_CHAR: "beilu-last-char",
  BEILU_MODAL_BG: "beilu-modal-bg",
  BEILU_MODAL_OPACITY: "beilu-modal-opacity",
  BEILU_MSG_DENSITY: "beilu-msg-density",
  BEILU_MSG_LOAD_LIMIT: "beilu-msg-load-limit",
  BEILU_PEER_FOLLOW: "beilu-peer-follow",
  BEILU_POST_PROCESSING: "beilu-post-processing",
  BEILU_NOTIFY_BADGES: "beilu-notify-badges",
  BEILU_NOTIFY_HISTORY: "beilu-notify-history",
  BEILU_NOTIFY_POPUP: "beilu-notify-popup",
  BEILU_NOTIFY_READ_AT: "beilu-notify-read-at",
  BEILU_PREFILL_ENABLED: "beilu-prefill-enabled",
  BEILU_PRESET_CATEGORIES: "beilu-preset-categories",
  BEILU_PRESET_CATEGORIES_LIST: "beilu-preset-categories-list",
  BEILU_PRESET_SPLIT: "beilu-preset-split",
  BEILU_PRESET_TAGS: "beilu-preset-tags",
  BEILU_RENDER_DEPTH: "beilu-render-depth",
  BEILU_RENDERER_ENABLED: "beilu-renderer-enabled",
  BEILU_SCRIPT_ACTIVATION: "beilu-script-activation",
  BEILU_SHOW_CHARNAME: "beilu-show-charname",
  BEILU_SHOW_ENTRY_CTRL: "beilu-show-entry-ctrl",
  BEILU_REGEX_ENABLED: "beilu-regex-enabled",
  BEILU_SETTINGS_WINDOW_POS: "beilu-settings-window-pos",
  BEILU_SHOW_HIDDEN: "beilu-show-hidden",
  BEILU_SHOW_SENSE_MESSAGES: "beilu-show-sense-messages",
  BEILU_SHOW_SYSINFO: "beilu-show-sysinfo",
  BEILU_ST_VARS_GLOBAL: "beilu-st-vars-global",
  BEILU_ST_VARS_PRESET: "beilu-st-vars-preset",
  BEILU_ST_VARS_EXTENSIONS: "beilu-st-vars-extensions",
  BEILU_ST_VARS_SCRIPTS: "beilu-st-vars-scripts",
  BEILU_SMART_CHATID: "beilu-smart-chatid",
  BEILU_SMART_COLLAPSE_STATE: "beilu-smart-collapse-state",
  BEILU_SMART_INTENT_RULES: "beilu-smart-intent-rules",
  BEILU_ST_COMPAT_ENABLED: "beilu-st-compat-enabled",
  BEILU_STREAM_ENABLED: "beilu-stream-enabled",
  BEILU_STREAM_RENDER_ENABLED: "beilu-stream-render-enabled",
  BEILU_TASKCARD_COLLAPSED: "beilu-taskcard-collapsed",
  // Token 条定时刷新间隔（秒，0=关闭定时只留事件驱动）。凛倾 0727「用户可以自己调节刷新时间,
  //   比如性能好1秒刷新一次都没啥大问题」——频率是用户的机器决定的，代码只持默认值（DEFAULTS.token.pollSec）。
  BEILU_TOKEN_POLL_SEC: "beilu-token-poll-sec",
  // BEILU_THINKING_FOLD 已删（0720 硬化）：凛倾硬性核心「人类必须看得到」,折叠块恒渲染无隐藏开关
  BEILU_THINKING_FOLD_LABEL: "beilu-thinking-fold-label",
  BEILU_THINKING_TAGS: "beilu-thinking-tags",
  // 「帮助教程」顶栏按钮显隐（功能可用但引导内容尚未制作完善→默认隐藏，设置→教程开发开关控制，settings.mjs 启动恢复）
  BEILU_TUTORIAL_HELP_BTN: "beilu-tutorial-help-btn",
  BEILU_USER_BLACKLIST: "beilu-user-blacklist",
  BEILU_MSG_BLACKLIST: "beilu-msg-blacklist",
  BEILU_BLACKLIST_FILTER_MODE: "beilu-blacklist-filter-mode",
  BEILU_WORK_CHATID: "beilu-work-chatid",
  BEILU_WHITEBOX_ENABLED: "beilu-whitebox-enabled",
  BEILU_WORK_WELCOME_SEEN: "beilu-work-welcome-seen",
  BEILU_XMODE_FORMAT: "beilu-xmode-format",
  BEILU_XMODE_REFCOUNT: "beilu-xmode-refcount",
  THEME: "theme",
  USERPREFERREDLANGUAGES: "userPreferredLanguages",
  BEILU_MONITOR_POLL_ENABLED: "beilu-monitor-poll-enabled",
  BEILU_PARALLEL_WINDOWS: "beilu-parallel-windows",
  BEILU_SUBMODES_CACHE: "beilu-submodes-cache",
  BEILU_COLLAPSED_CHAR_LINKS: "beilu-collapsed-char-links",
  // P2（一致性审计②）野键收编：旧字面 'beilu_current_api_source'/'beiluCompanionPreviewBoxH'
  //   命名逃逸 beilu- 前缀域（删号 clearAll 清不掉），消费方带一次性旧键迁移
  BEILU_API_SOURCE: "beilu-current-api-source",
  BEILU_COMPANION_PREVIEW_H: "beilu-companion-preview-h",
});
