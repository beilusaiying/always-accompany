/**
 * [modeTabMap.mjs] — 前端模式（mode）↔ Tab 的双向映射表（单一权威）。
 *
 * 功能链：
 *   正向（mode→tab）：后端返回当前模式（chat/code/work）→ modeToTab(mode) / MODE_TO_TAB[mode]
 *     → 得到应激活的 Tab 名称 → layout/taskOverlay 切换前端 Tab 显示。
 *   反向（tab→mode）：用户点击前端 Tab → TAB_TO_MODE[tabName]
 *     → 得到应切换的后端模式（null 表示不切）→ switchMode() 通知后端切换。
 *
 * why：layout / websocket / taskOverlay / tempConversation 等多个模块历史上各自内联 mode↔tab 映射字典，
 *   出现过"某处改了映射其他处未同步"的 bug（T-3 问题）。本文件将映射抽出为唯一真相来源，
 *   改一处全局生效。
 *   特别注意：正反向 **不是双射**（code→files 但 files→file；chat/airp/smart/bot/helper 都→chat），
 *   所以必须分两张表独立维护，不可从一张表反推另一张（会引入隐式 bug）。
 *   回退/守卫逻辑（未知 mode 时用 "chat"）属各调用点的局部决策，不属本模块职责，
 *   调用方自行决定 `|| m` / `|| "chat"` / 无回退，本模块只提供 modeToTab() 便捷 helper（含 || "chat" 回退）。
 *
 * 关联链：
 *   被 import → layout.mjs / websocket.mjs / taskOverlay.mjs / tempConversation.mjs / index*.mjs 等
 *   无外部 import（纯常量/纯函数，不依赖任何 shared/state/ 模块）
 *
 * 影响范围：
 *   - 改动 MODE_TO_TAB → 影响后端模式变化时前端 Tab 的自动切换
 *   - 改动 TAB_TO_MODE → 影响用户点击 Tab 时后端收到的 switchMode 指令（null 改成值会意外触发后端切换）
 *   - 新增 Tab → 需同时在 TAB_TO_MODE 中声明（值为 null 或对应 mode），否则点击该 Tab 行为未定义
 *
 * 使用效果：
 *   - 用户点击"记忆"Tab → TAB_TO_MODE["memory"] = null → 不切后端模式，保持当前聊天状态，仅显示记忆表格
 *   - 用户点击"文件"Tab → TAB_TO_MODE["files"] = "code" → 后端切到 IDE(code) 模式 → 前端显示代码编辑器界面
 *   - 后端主动推送 mode="code" → modeToTab("code") = "files" → 前端自动激活文件浏览器 Tab
 *   - 用户点击"陪伴"Tab → TAB_TO_MODE["companion"] = null → 仅切换前端视图，不打断当前对话模式
 */
// 单一权威：模式 ↔ Tab 映射（T-3，抽自 layout/websocket/taskOverlay/tempConversation 的重复定义）。
// ⚠️ 正反向非双射（code→files 但 files→file；chat/airp/smart/bot/helper 都→chat），必须分两张表，不可互推。
// 回退/守卫是各调用点的局部决策，不属本模块职责——调用点自己决定 `|| m` / `|| "chat"` / 无回退。

// 正向 mode→tab：某后端模式该激活哪个 Tab。注意 code 的 IDE Tab 名为 "files"。
// smart 独立模式值（凛倾0706「4个模式就是现在前端的4个模式」，原 smart→chat 坍缩已拆）；
// bot 模式值仅 bot shell 生成链用（web 无 bot 对话窗口），后端推 "bot" 时 modeToTab 回退 chat 属预期。
export const MODE_TO_TAB = { chat: "chat", smart: "smart", code: "files", work: "work" };

// 反向 tab→mode：切到某 Tab 时后端该置什么模式。null = 不切后端模式（辅助视图/弹窗）。
export const TAB_TO_MODE = {
  chat: "chat",     // AIRP模式 (原chat改名)
  airp: "chat",     // AIRP别名兼容
  smart: "smart",   // 全智能模式（凛倾0706升独立模式值，原坍缩 "chat" 已拆）
  bot: "chat",      // Bot管理(隐藏Tab)
  helper: "chat",   // 正则脚本(隐藏Tab)
  files: "code",    // IDE模式。[多窗口审计 2026-07-11 C2] 原值 "file" 是 A 通道(beilu-files
                    //   file/memory 值域)语义残留混进本表——后端 isValidModeId 不认 "file"，且
                    //   layout._MODE_TAB_TO_MODE/messageInput._TAB_TO_INPUT_MODE 两张表同键都是
                    //   "code"（三表反向值分叉）。唯一值消费方 subModePanel._workflowGroupFromTab
                    //   已同批随改。A 通道区分 file/memory 靠 switchMode 的 tab 透传字段，不靠本表。
  memory: null,     // W41修复: 记忆Tab不切后端模式，保持当前模式的记忆表格
  work: "work",     // 工作模式
  companion: null,  // N15: 陪伴是辅助视图不切后端模式（原漏键=undefined 穿过 !==null 守卫，
                    //   被映射成后端不存在的 "companion" 值→switchMode 每次静默拒。语义同 memory/W41）
  settings: null,   // 设置弹窗(不切后端模式)
  editor: null,     // 编辑弹窗(不切后端模式)
  extensions: null, // 额外插件管理(辅助视图不切后端模式)
};

// 正向取 Tab，未知模式回退 chat（与原 taskOverlay `|| "chat"` 同口径）。仅需此回退的点用本 helper。
export function modeToTab(mode) {
  return MODE_TO_TAB[mode] || "chat";
}

// Tab 显示名单源。[D2 收口 0713·凛倾「哪里来的设计?」] 0709 审计注释自称"场景化文案刻意不同
//   不收口"——查证=当时审计 AI 的自我判定,无凛倾拍板;按病型原文（同一节点多处不一样质量不齐）收口。
//   权威对齐 index.html:105-112 顶部 tab 按钮文案（HTML 静态无法 import,两处互指:改文案必须同步双处）。
//   消费:layout 模式选择器/多模式横幅等 tab 域文案,全部由此派生,勿再手抄。
export const TAB_LABEL = {
  smart: "全智能", chat: "AIRP", files: "IDE", work: "工作",
  memory: "记忆", bot: "Bot", companion: "陪伴", helper: "ST适配",
  extensions: "额外插件",
};

// 子模式未配预设时的显示文案单源（[D6 0713] 原 ide.mjs/subModePanel/workPanel 三处手抄"继承大模式"，
//   注释靠"三口统一"人肉对齐=漂移源）。语义：子模式无 presetName=后端生成时继承大模式「当前正在使用的预设」
//   （resolveActivePresetName map[cid:mode]→全局 active_preset），非"未绑定"（凛倾 0708 定调禁用该文案；
//   [0716 定案] 模式级绑定概念已删）。
export const PRESET_INHERIT_LABEL = "继承大模式";

// 子模式"清除模型绑定=使用绑定源默认模型"选项的显示文案单源（[0716 散写收口] 同 D6 范式：
//   原 subModePanel 触发栏模型弹窗与 extendMenuW28 底栏生效绑定视图各持一份字面量=漂移源）。
//   语义：选它写回空串 → 后端 getPromptHandler `_subModeModel || undefined` 折叠为无覆盖 → 生成用源默认模型。
export const MODEL_SOURCE_DEFAULT_LABEL = "（使用源默认模型）";

// 模式展示徽章单源（图标+中文标签）。[系统病型审计 0713·D2 迁移] 原住 conversationManager.mjs
//   （该处保留 re-export 兼容既有消费者）——backendMonitor/crossModeNotification 等各自内联
//   modeMap 副本，backendMonitor 漏 smart 键=全智能模式下监视器显示英文裸值。展示映射与
//   tab/mode 映射同属"模式概念权威表"，收口本文件（纯常量无依赖，任何层可安全 import）。
export const MODE_BADGE = {
  chat: { icon: '<i data-ic="message"></i>', label: "聊天" },
  smart: { icon: '<i data-ic="star"></i>', label: "全智能" },
  code: { icon: '<i data-ic="code"></i>', label: "编程" },
  work: { icon: '<i data-ic="clipboard"></i>', label: "工作" },
};
