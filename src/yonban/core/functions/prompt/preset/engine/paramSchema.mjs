/**
 * paramSchema.mjs — 模型参数元数据单源（PARAM_SCHEMA）
 *
 * why（2026-07-08 硬编码链路优化·链路2）：凛倾「我要做到用户可以掌控全部参数」+
 *   T072a「所有可操作处禁硬编码——控件的选项集/限值/标签必须来自后端/配置/单源表」。
 *   旧状：default 兜底散落多处独立维护（extractModelParams ??值 / applyModelParams:113 /
 *   preset/main.mjs:612 各一份 2048；thinking_budget 8000 三处），min/max/step 写死在
 *   beilu-chat index.html 与 YonBan chat-modes.js 两侧且上限打架（1000000 vs 131072）。
 *   本表为唯一权威：default/min/max/step/label 全部从此读。
 *
 * 取值来源（等值迁移，未改任何数值——数值域是凛倾的设计取舍）：
 *   - default = preset_engine.mjs extractModelParams 原 ?? 兜底值
 *   - min/max/step = beilu-chat index.html 参数控件原 HTML 属性值（主 UI 为准，YonBan 侧对齐）
 *   - 无 UI 控件的字段只带 default，不自造 min/max（将来加控件时再补）
 *
 * 下发链：getDataHandler.mjs GetData 附 param_schema 字段 → 前端参数控件渲染时覆盖
 *   min/max/step（HTML 静态值作离线退化），与 web_search_engines 同为"后端权威清单下发"范式。
 *
 * 消费方（改此表即全局生效）：
 *   - preset_engine.mjs extractModelParams（预设缺省兜底）
 *   - _shared/applyModelParams.mjs（anthropic shape max_tokens 空窗兜底）
 *   - prompt/preset/main.mjs（_effective_max_tokens 空窗兜底）
 *   - api/proxy lib（thinking_budget 兜底）
 *   - getDataHandler → 前端四处参数 UI（beilu-chat 滑块/右栏/子模式表单/YonBan 子模式表单）
 *
 * 键名注意：max_context/max_tokens 在预设 JSON 里是 openai_max_context/openai_max_tokens
 *   （ST 键名），extractModelParams 导出层做镜像——本表用归一后的键名。
 */

export const PARAM_SCHEMA = {
  // ---- 采样参数（有 UI 控件，带完整元数据）----
  temperature:     { default: 1,      min: 0,    max: 2,        step: 0.01, label: "温度" },
  top_p:           { default: 1,      min: 0,    max: 1,        step: 0.01, label: "Top P" },
  top_k:           { default: 0,      min: 0,    max: 500,      step: 1,    label: "Top K" },
  min_p:           { default: 0,      min: 0,    max: 1,        step: 0.01, label: "Min P" },
  max_context:     { default: 200000, min: 1024, max: 10000000, step: 1,    label: "上下文上限" },
  max_tokens:      { default: 2048,   min: 256,  max: 1000000,  step: 256,  label: "回复长度上限" },
  thinking_budget: { default: 8000,   min: 1024, max: 32000,    step: 1024, label: "思考预算" },
  // penalty 类：合法范围 -2~2（OpenAI 官方约束），有 UI 控件（T11-A 接链补入 index.html number 输入框）。
  //   哨兵=null（不能用 -1，-1 是合法值）——buildRuntimeParamsView:617-620 以 == null 判"不覆盖用预设值"。
  frequency_penalty:  { default: 0,  min: -2, max: 2, step: 0.1, label: "频率惩罚" },
  presence_penalty:   { default: 0,  min: -2, max: 2, step: 0.1, label: "存在惩罚" },

  // ---- 数值参数（暂无 UI 控件，只带 default）----
  top_a:              { default: 0,  label: "Top A" },
  repetition_penalty: { default: 1,  label: "重复惩罚" },
  seed:               { default: -1, label: "随机种子" },
  n:                  { default: 1,  label: "生成数" },

  // ---- 开关/枚举参数 ----
  stream:                 { default: true,   label: "流式输出" },
  names_behavior:         { default: 0,      label: "名字注入行为" },
  wrap_in_quotes:         { default: false,  label: "引号包裹" },
  max_context_unlocked:   { default: false,  label: "解锁上下文上限" },
  squash_system_messages: { default: false,  label: "合并 system 消息" },
  function_calling:       { default: false,  label: "函数调用" },
  show_thoughts:          { default: false,  label: "显示思考过程" },
  reasoning_effort:       { default: "auto", label: "推理力度" },
  image_inlining:         { default: false,  label: "图片内联" },
};

/** 便捷取 default（消费端兜底用）：paramDefault("max_tokens") → 2048 */
export function paramDefault(key) {
  return PARAM_SCHEMA[key]?.default;
}

/**
 * ENUM_SCHEMA — 枚举型可操作项的选项集单源（2026-07-09 链路2扩展）
 *
 * why：凛倾「YonBan 很多硬编码，子模式/参数要同步+映射不是写死」。枚举选项集此前
 *   只有本体前端单源（subModePanel.mjs T072a POST_PROCESS_MODE_* / PREFILL_MODE_*），
 *   跨库客户端（YonBan 是独立仓库，无法 import 本体前端 mjs）只能手抄副本→必漂移
 *   （实证：YonBan 曾滞留已删的 "claude" 自造值 + 已废的 "off/prefill/claude" 三项旧集）。
 *   后端是两侧唯一共享通道，故选项集权威上移到此，随 getSubModes 下发（enum_schema 字段），
 *   与 PARAM_SCHEMA（param_schema 字段）同为"后端权威清单下发"范式。
 *
 * 取值来源（等值迁移，值/文案/顺序均未改）：
 *   - 值集=消费端定稿：prompt_post_processing → messageTransform.mjs postProcessMessages switch；
 *     claude_prefill_mode → providerPatch.mjs applyTailPrefill 四模式（off=不处理，无选项化必要
 *     的场景由各表单空项承担）
 *   - label/title 原文=本体前端离线退化表（0715 收口：原 subModePanel/memtool 两份副本已并为
 *     shared/state/enumFallback.mjs 单源）；改选项集须改这里，再同步 enumFallback.mjs 一处即可
 *
 * 空项策略归各表单（本体 T072a 约定）："（使用默认）"/"不改变" 等空 option 是表单自身的
 *   默认语义（空=不覆盖/继承），不属于选项集，本表不含。
 *
 * 消费方：setDataActions.mjs getSubModes（enum_schema 下发）→ YonBan chat-modes.js
 *   子模式表单两 select + YonBanProvider 运行参数面板 pp select。
 */
export const ENUM_SCHEMA = {
  prompt_post_processing: {
    label: "提示词后处理",
    options: [
      { value: "none",   label: "关闭" },
      { value: "merge",  label: "合并 (Merge)" },
      { value: "merge_tools", label: "合并 (保留工具)",
        title: "合并连续同角色，保留 tool 角色消息" },
      { value: "semi",   label: "半严格",
        title: "合并 + 历史对话中段 system→user（尾部保留）" },
      { value: "semi_tools", label: "半严格 (保留工具)",
        title: "半严格 + 保留 tool 角色消息" },
      { value: "strict", label: "严格",
        title: "半严格 + 首条 system 后插占位 user 保证交替" },
      { value: "strict_tools", label: "严格 (保留工具)",
        title: "严格 + 保留 tool 角色消息" },
    ],
  },
  claude_prefill_mode: {
    label: "尾部预填充",
    options: [
      { value: "prefill",        label: "尾部 assistant（渠道支持预填充）",
        title: "尾部 assistant 原样发送=真预填充。需渠道支持 prefill；Claude 官方新模型已移除该能力，不支持的渠道会返回错误" },
      { value: "to_user",        label: "尾部直接改 user",
        title: "尾部 assistant 直接改为 user 发送，内容不变。适用于强制 user 结尾的渠道（Claude 系新模型）" },
      { value: "user_assistant", label: "user 后加 assistant:（加强有效性）",
        title: "尾部改为 user 且内容末尾追加 assistant: 引导，在强制 user 结尾的渠道上加强预填充有效性" },
    ],
  },
};
