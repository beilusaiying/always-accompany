/**
 * enumFallback.mjs — pp/预填充选项集前端离线退化表（0715 V3 收口：原 subModePanel.mjs 与
 * memtool.mjs 各持一份等值副本，改选项集需人肉同步两处，已并为本单源）
 *
 * 权威 = 后端 paramSchema.mjs ENUM_SCHEMA（getSubModes 随包下发 enum_schema，各面板缓存优先消费）；
 * 本表只在下发不可用/离线时兜底（beilu 离线铁律），值/文案与后端表等值镜像——改选项集改 paramSchema.mjs，
 * 再同步本表。形状与下发同构：{ value, label, title? }[]。
 *
 * 拍板出处（原 subModePanel T072a 注释随值迁此）：
 * - 2026-07-08 凛倾「提示词后处理只有3个模式,合并,严格,半严格」——删混入的 "claude"（预填充概念泄漏）
 *   与 "single"（全并单条 user=效力全失）。存量旧值由写入层迁移表+消费端归一自愈。
 * - 2026-07-08 正名：旧枚举值 "claude" 是自造名词（凛倾:「互联网上有这个名词吗?」）→ to_user。
 * - title = 长停留 hover 提醒（凛倾 2026-07-08「在选择的时候加个长停留出现提醒,参考st」）。
 *
 * 关联链：← subModePanel.mjs _enumOptions / memtool.mjs _pseriesEnumOpts（fallback 分支）
 */

export const ENUM_FALLBACK = {
  prompt_post_processing: [
    { value: "none", label: "关闭" },
    { value: "merge", label: "合并 (Merge)" },
    { value: "merge_tools", label: "合并 (保留工具)",
      title: "合并连续同角色，保留 tool 角色消息" },
    { value: "semi", label: "半严格",
      title: "合并 + 历史对话中段 system→user（尾部保留）" },
    { value: "semi_tools", label: "半严格 (保留工具)",
      title: "半严格 + 保留 tool 角色消息" },
    { value: "strict", label: "严格",
      title: "半严格 + 首条 system 后插占位 user 保证交替" },
    { value: "strict_tools", label: "严格 (保留工具)",
      title: "严格 + 保留 tool 角色消息" },
  ],
  claude_prefill_mode: [
    { value: "prefill", label: "尾部 assistant（渠道支持预填充）",
      title: "尾部 assistant 原样发送=真预填充。需渠道支持 prefill；Claude 官方新模型已移除该能力，不支持的渠道会返回错误" },
    { value: "to_user", label: "尾部直接改 user",
      title: "尾部 assistant 直接改为 user 发送，内容不变。适用于强制 user 结尾的渠道（Claude 系新模型）" },
    { value: "user_assistant", label: "user 后加 assistant:（加强有效性）",
      title: "尾部改为 user 且内容末尾追加 assistant: 引导，在强制 user 结尾的渠道上加强预填充有效性" },
  ],
};
