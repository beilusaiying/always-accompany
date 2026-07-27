/**
 * [defaults] — 数据常量单一来源。
 *
 * 从 storage.mjs 提取的纯数据常量/纯函数（零副作用、零磁盘 I/O、零 import）。
 * storage.mjs 通过 re-export 保持所有外部消费者的 import 路径不变。
 *
 * 包含：DEFAULT_CODE_TABLES / DEFAULT_WORK_TABLES / DEFAULT_TABLES
 *       DEFAULT_MEMORY_PRESETS / DEFAULT_SYSTEM_TEXTS / DEFAULT_TOKEN_REMINDER
 *       DEFAULT_COMPACT_MERGE_INSTRUCTIONS / DEFAULT_INJECTION_PROMPTS
 *       DEFAULT_CODE_SUB_MODES / DEFAULT_WORK_SUB_MODES / PERM_LEVEL_META
 *       pickPresetPromptSet / p7HasMeaningfulPrompts / buildDefaultSkillGroups
 */

// ============================================================
// 编程模式专用表格模板（#0-#5，含 #5 {{user}}画像）
// #0 任务原话记录  — 用户需求原文，不改写
// #1 代码定位表    — 文件/函数/行号，省token快速定位
// #2 文档索引表    — MD文件路径和摘要，快速找历史文档
// #3 流程·架构索引 — 流程图/项目图/架构文档的索引
// #4 错误·经验表   — bug根因和修复方案，避免重复踩坑
// #5 {{user}}画像  — 用户画像（跨模式共通，与聊天 #10 / 工作 #4 同列结构）
// ============================================================

export const DEFAULT_CODE_TABLES = [
  {
    id: 0,
    name: "任务原话记录",
    columns: ["任务摘要", "用户原话", "状态", "关联文件", "日期"],
    rows: [],
    rules: {
      insert: "当用户提出新的编程任务时，完整记录原话，不改写不省略",
      update: "当任务状态变化（进行中/完成/搁置）或完成后补充关联文件时",
      delete: "当任务已完成并归档到任务MD文件后",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 1,
    name: "代码定位表",
    columns: ["文件路径", "关键函数·区域", "行号范围", "功能说明", "最后更新"],
    rows: [],
    rules: {
      insert: "当读完一个文件后，提取关键函数/代码区域的位置信息，路径用相对项目根的格式",
      update: "当代码变更导致行号或函数名变化时及时更新，保持定位准确",
      delete: "当文件被删除或函数被移除时",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 2,
    name: "文档索引表",
    columns: ["文档名", "路径", "类型", "摘要", "日期"],
    rows: [],
    rules: {
      insert: "当创建新的MD文件、设计文档、bug记录、变更日志时自动记录路径和摘要",
      update: "当文档内容大幅变更时更新摘要，类型可选：设计文档/变更记录/bug记录/API文档/工作日志",
      delete: "当文档被删除或合并到其他文档时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 3,
    name: "流程·架构索引",
    columns: ["名称", "类型", "文档路径", "覆盖范围", "版本"],
    rows: [],
    rules: {
      insert: "当发现新的流程图、项目图、架构文档时记录，类型可选：流程图/项目图/架构图/模块说明",
      update: "当文档更新版本或覆盖范围变化时",
      delete: "当文档被废弃或被新版本完全替代时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 4,
    name: "错误·经验表",
    columns: ["问题现象", "根因", "修复方案", "涉及文件", "日期"],
    rows: [],
    rules: {
      insert: "当修复一个bug或发现一个重要经验后自动记录，重点记录根因和修复方案",
      update: "当发现相关问题的新信息或更好的解决方案时",
      delete: "当问题已完全解决且不再有参考价值时",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 5,
    name: "{{user}}画像",
    columns: [
      "认知图式",
      "语义网络",
      "依恋与人际",
      "沟通特征",
      "情绪表达信号",
      "用户语言映射表",
      "模式特化观察",
    ],
    rows: [],
    rules: {
      insert: "观察到用户特征时记录到对应列。单次观察直接写入，标注(单次)。多次验证(>=3次同模式)后去掉标注",
      update: "用户纠正时直接修正。新信息与旧条目矛盾→不覆盖而是两面并存标注情境(AGM修正原则)",
      delete: "用户明确否定某条目时移除(AGM收缩)。长期未引用→置信度降低可清理",
      column_guide: "认知图式(Piaget): 已识别的概念框架/同化倾向/顺应记录/矛盾或多面性 | 语义网络(Collins&Loftus): 核心概念节点与连接/高激活概念簇/已验证联想路径 | 依恋与人际(Bowlby): 对AI关系期待/安全感信号与不安信号/回避与趋近模式 | 沟通特征(Grice+Accommodation): 准则违反模式/表达习惯情境差异/信息密度波动 | 情绪表达信号(Plutchik): 基础情绪映射/情绪触发模式/情绪表达方式 | 用户语言映射(DRT): 私有缩写代号→含义/高频句式指代/省略模式/跨对话持续性指称 | 模式特化: code=技术栈熟悉度+代码风格+调试推理路径+架构切入层级 / work=工作流图式+信息呈现偏好+协作主动度 / chat=话题偏好雷区+情感交互模式+对AI角色期待",
    },
    description: "用户画像(跨模式共通)。穿透规则: 特化层信号跨模式反复出现→写入共通列。更新遵循AGM信念修正+最小改变原则",
    required: false,
    user_customizable: true,
    enabled: true,
  },
];

// ============================================================
// 默认表格模板（#0-#4，含 #4 {{user}}画像）— 工作模式
// ============================================================

export const DEFAULT_WORK_TABLES = [
  {
    id: 0,
    name: "任务原话记录",
    columns: ["任务摘要", "用户原话", "类型", "状态", "关联文档", "日期"],
    rows: [],
    rules: {
      insert: "当用户提出新的工作任务时，完整记录原话，不改写不省略",
      update: "当任务状态变化（待办/设计中/执行中/验证中/完成）或补充关联文档路径时",
      delete: "当任务已完成并由收尾归档到MD文件后",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 1,
    name: "工作文档索引",
    columns: ["文档名", "路径", "类型", "摘要", "日期"],
    rows: [],
    rules: {
      insert: "当在 work/active/ 创建新MD文件时记录路径和摘要",
      update: "当文档内容变更时更新摘要，类型可选：任务计划/流程设计/提示词设计/skill脚本/执行日志/归档报告",
      delete: "当文档被删除或合并时",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 2,
    name: "产出索引",
    columns: ["产出名", "类型", "路径", "关联任务", "日期"],
    rows: [],
    rules: {
      insert: "当完成一个可交付的工作产出时（翻译稿/报告/PPT/脚本/流程组等）",
      update: "当产出被修改或补充时",
      delete: "当产出已过时或被新版本替代时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 3,
    name: "经验记录",
    columns: ["问题", "原因", "解决方案", "关联任务", "日期"],
    rows: [],
    rules: {
      insert: "当发现工作流程中的问题或总结出有效经验时",
      update: "当有更好的解决方案时",
      delete: "当经验不再适用时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 4,
    name: "{{user}}画像",
    columns: [
      "认知图式",
      "语义网络",
      "依恋与人际",
      "沟通特征",
      "情绪表达信号",
      "用户语言映射表",
      "模式特化观察",
    ],
    rows: [],
    rules: {
      insert: "观察到用户特征时记录到对应列。单次观察直接写入，标注(单次)。多次验证(>=3次同模式)后去掉标注",
      update: "用户纠正时直接修正。新信息与旧条目矛盾→不覆盖而是两面并存标注情境(AGM修正原则)",
      delete: "用户明确否定某条目时移除(AGM收缩)。长期未引用→置信度降低可清理",
      column_guide: "认知图式(Piaget): 已识别的概念框架/同化倾向/顺应记录/矛盾或多面性 | 语义网络(Collins&Loftus): 核心概念节点与连接/高激活概念簇/已验证联想路径 | 依恋与人际(Bowlby): 对AI关系期待/安全感信号与不安信号/回避与趋近模式 | 沟通特征(Grice+Accommodation): 准则违反模式/表达习惯情境差异/信息密度波动 | 情绪表达信号(Plutchik): 基础情绪映射/情绪触发模式/情绪表达方式 | 用户语言映射(DRT): 私有缩写代号→含义/高频句式指代/省略模式/跨对话持续性指称 | 模式特化: code=技术栈熟悉度+代码风格+调试推理路径+架构切入层级 / work=工作流图式+信息呈现偏好+协作主动度 / chat=话题偏好雷区+情感交互模式+对AI角色期待",
    },
    description: "用户画像(跨模式共通)。穿透规则: 特化层信号跨模式反复出现→写入共通列。更新遵循AGM信念修正+最小改变原则",
    required: false,
    user_customizable: true,
    enabled: true,
  },
];

// ============================================================
// 默认表格模板（#0-#10，含 #10 {{user}}画像）— 聊天模式
// ============================================================

export const DEFAULT_TABLES = [
  {
    id: 0,
    name: "时空表格",
    columns: ["日期", "时间", "地点（当前描写）", "此地角色"],
    rows: [],
    rules: {
      insert: "当时间/地点/在场角色发生变化时",
      update: "当当前行的信息需要更新时",
      delete: "当转场到新场景且旧场景不再需要时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 1,
    name: "角色特征表格",
    columns: [
      "角色名",
      "身体特征",
      "性格",
      "职业",
      "爱好",
      "喜欢的事物",
      "住所",
      "其他重要信息",
    ],
    rows: [],
    rules: {
      insert: "当出现新的角色时",
      update: "当角色特征发生变化时",
      delete: "当角色永久退场时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 2,
    name: "角色与{{user}}社交表格",
    columns: [
      "角色名",
      "对{{user}}关系",
      "对{{user}}态度",
      "对{{user}}的好感度",
    ],
    rows: [],
    rules: {
      insert: "当出现新的角色与{{user}}的关系时",
      update: "当关系/态度/好感度变化时",
      delete: "当角色永久退场时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 3,
    name: "任务、命令或者约定表格",
    columns: ["角色", "任务", "地点", "持续时间"],
    rows: [],
    rules: {
      insert: "当出现新的任务/命令/约定时",
      update: "当任务状态变化时",
      delete: "当任务完成且已归档时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 4,
    name: "当日临时记忆",
    columns: ["角色", "事件简述", "日期", "地点", "情绪"],
    rows: [],
    rules: {
      insert: "当发生需要记住的事件时",
      update: "当事件状态变化时",
      delete: "仅在归档时由系统执行",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 5,
    name: "重要物品表格（背包）",
    columns: ["拥有人", "物品描述", "物品名", "重要原因"],
    rows: [],
    rules: {
      insert: "当出现随身携带或当前装备的重要物品时",
      update: "当物品信息变化时",
      delete: "当物品放入仓库（不再随身携带）时，使用moveToStash操作归档",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 6,
    name: "当天事件大总结",
    columns: ["时间", "地点", "事件概述"],
    rows: [],
    rules: {
      insert: "当临时记忆归档时由总结AI生成",
      update: "当总结需要修正时",
      delete: "当日终归档完成后清空",
    },
    required: true,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 7,
    name: "{{char}}想要记住的关于{{user}}的事情",
    columns: ["日期", "想要记住的事情", "原因"],
    rows: [],
    rules: {
      insert: "当发现值得记住的关于{{user}}的事情时",
      update: "当相关信息需要补充时",
      delete: "当超过3天的条目已归档到热记忆层时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 8,
    name: "{{char}}永远记住的事情",
    columns: ["事件", "日期"],
    rows: [],
    rules: {
      insert: "当发生永远值得记住的重要事件时",
      update: "当事件需要补充信息时",
      delete: "合并重复项时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 9,
    name: "时空记忆表格",
    columns: ["日期", "当日总结"],
    rows: [],
    rules: {
      insert: "当日终归档时从#6转入",
      update: "当总结需要修正时",
      delete: "当超过两天的条目需要清理时",
    },
    required: false,
    user_customizable: true,
    enabled: true,
  },
  {
    id: 10,
    name: "{{user}}画像",
    columns: [
      "认知图式",
      "语义网络",
      "依恋与人际",
      "沟通特征",
      "情绪表达信号",
      "用户语言映射表",
      "模式特化观察",
    ],
    rows: [],
    rules: {
      insert: "观察到用户特征时记录到对应列。单次观察直接写入，标注(单次)。多次验证(>=3次同模式)后去掉标注",
      update: "用户纠正时直接修正。新信息与旧条目矛盾→不覆盖而是两面并存标注情境(AGM修正原则)",
      delete: "用户明确否定某条目时移除(AGM收缩)。长期未引用→置信度降低可清理",
      column_guide: "认知图式(Piaget): 已识别的概念框架/同化倾向/顺应记录/矛盾或多面性 | 语义网络(Collins&Loftus): 核心概念节点与连接/高激活概念簇/已验证联想路径 | 依恋与人际(Bowlby): 对AI关系期待/安全感信号与不安信号/回避与趋近模式 | 沟通特征(Grice+Accommodation): 准则违反模式/表达习惯情境差异/信息密度波动 | 情绪表达信号(Plutchik): 基础情绪映射/情绪触发模式/情绪表达方式 | 用户语言映射(DRT): 私有缩写代号→含义/高频句式指代/省略模式/跨对话持续性指称 | 模式特化: code=技术栈熟悉度+代码风格+调试推理路径+架构切入层级 / work=工作流图式+信息呈现偏好+协作主动度 / chat=话题偏好雷区+情感交互模式+对AI角色期待",
    },
    description: "用户画像(跨模式共通)。穿透规则: 特化层信号跨模式反复出现→写入共通列。更新遵循AGM信念修正+最小改变原则",
    required: false,
    user_customizable: true,
    enabled: true,
  },
];

// ============================================================
// 默认记忆预设模板（8个内置预设 P1-P8）— 最小骨架
// P1 检索AI / P2 表格总结·归档AI / P3 每日总结AI / P4 热→温转移AI
// P5 月度总结·归档AI / P6 格式检查·修复AI / P7 压缩AI / P8 联网搜索AI
// ============================================================

// 记忆 AI 默认模型（单一定义点，P1-P8 + token_reminder + storage 初始 _config.json 共用）
export const DEFAULT_MEMORY_MODEL = "gemini-2.0-flash";

export const DEFAULT_MEMORY_PRESETS = [
  {
    id: "P1",
    name: "检索AI",
    description: "根据当前对话上下文从温/冷层检索相关记忆",
    enabled: true,
    builtin: true,
    deletable: false,
    trigger: "auto_on_message",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 2000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P1_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "system",
        content: "{{presetList}}",
        identifier: "P1_preset_list",
        enabled: true,
        builtin: true,
        deletable: false,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P1_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P2",
    name: "表格总结/归档AI",
    description: "临时记忆超阈值时生成总结并归档到温层",
    enabled: true,
    builtin: true,
    deletable: false,
    trigger: "auto_on_threshold",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P2_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P2_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P3",
    name: "每日总结AI",
    description: "日终时汇总当天事件生成日总结",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "manual_button",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P3_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P3_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P4",
    name: "热→温转移AI",
    description: "将热层中过期/低权重的记忆移入温层",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "manual_button",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P4_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P4_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P5",
    name: "月度总结/归档AI",
    description: "为满归档期的温层月份编纂月总结（归档天数按系统配置，物理搬移由系统自动执行）",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "manual_or_auto",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P5_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P5_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P6",
    name: "格式检查/修复AI",
    description: "检查并修复表格和记忆文件中的格式问题",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "manual_button",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.1,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P6_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P6_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P7",
    name: "压缩AI",
    description: "上下文超长时压缩历史对话为结构化摘要",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "auto_on_threshold",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P7_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P7_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
  {
    id: "P8",
    name: "联网搜索AI",
    description: "根据对话上下文判断是否需要联网搜索，执行搜索+过滤+注入",
    enabled: false,
    builtin: true,
    deletable: false,
    trigger: "auto_on_message",
    api_config: {
      use_custom: false,
      source: "",
      model: DEFAULT_MEMORY_MODEL,
      temperature: 0.3,
      max_tokens: 3000,
    },
    prompts: [
      {
        role: "system",
        content: "",
        identifier: "P8_system",
        enabled: true,
        builtin: false,
        deletable: true,
      },
      {
        role: "user",
        content: "{{chat_history}}",
        identifier: "P8_chat_history",
        enabled: true,
        builtin: true,
        deletable: false,
      },
    ],
  },
];

// ============================================================
// 系统注入文案默认值（单一来源 / SINGLE SOURCE OF TRUTH）
// 2026-07-08 链路3·代码零提示词方向：此前逐字写死在 getPromptHandler 注入点。
// 用户可改路径: config.system_texts 逐键覆盖（updateConfig 写口，与 token_reminder 同层）。
// 注意:
//   - daily_greeting 的 <daily_greeting streak> XML 包裹是注入结构（代码域），此处只存指令文案
//   - delegation_report 里的 <report status> 标签名是协议契约（解析器按此标签收报告），
//     用户可改措辞但删掉标签说明=委派AI不知道怎么汇报=功能自断
// 文本原样迁移未改一字（文本内容归用户/凛倾域，此处仅机制收敛）。
// ============================================================
export const DEFAULT_SYSTEM_TEXTS = {
  daily_greeting: "今日首次对话，请自然问候并续接上次话题（勿打卡、勿报数）。",
  summary_prefix: "[上下文摘要 - 以下是之前对话的压缩摘要，请将其视为已发生的对话背景]",
  delegation_report: '\n完成后请使用 <report status="completed">报告内容</report> 标签汇报结果。如果遇到阻碍，使用 <report status="blocked">阻碍说明</report>。',
  // ---- agent/分身循环引导（占位符由消费点填充；<searchResult>/<searchQuery>/<memorySearch> 等
  //      标签名是协议契约——解析器按标签收内容，改文案须保留标签说明，否则循环链自断）----
  // aiRunner 记忆/搜索循环
  search_feedback: "以下是搜索返回的结果：\n\n{content}\n\n请对搜索结果进行分析和过滤。评估每条结果的可信度，提取关键信息，然后用 <searchResult> 标签输出精选的有用信息。如果需要更多搜索，继续使用 <searchQuery> 标签。",
  memory_feedback: "以下是你请求的记忆文件内容：\n\n{content}\n\n请继续分析这些内容。如果需要更多文件，继续使用 <memorySearch> 标签。如果已获取足够信息，直接输出最终结果。",
  // replyHandler 分身循环（clone_*）与 setDataActions testClone（testclone_*）同功能文案原样各自迁移，
  // 差异（"搜索/读取"措辞、testclone 强调 write_file 写 MD）是既有状态，合并=改文案（凛倾域）不做
  clone_resume: "[续接] 上一次因「{stop_reason}」中断（已做 {rounds} 轮/{total_tools} 次工具，快照时间 {saved_at}）。原任务摘要：{instruction_preview}。请先核对这是否就是你要续接的任务（快照按编号存储，跨会话同编号会覆盖——摘要对不上=拿错了快照，按全新任务处理并说明）；确认无误则从中断处继续完成任务，不要重头再来。",
  clone_repeat_warning: "⚠️ 你已经连续5轮执行相同的工具 ({tool_sig})，这看起来像死循环。请用 search_files 搜索关键词定位，不要逐页翻读大文件。如果任务已完成，直接输出最终报告。",
  clone_tool_result: "[工具执行结果]\n{results}\n[/工具执行结果]\n\n继续任务。如果还需要更多信息，继续使用工具搜索/读取。信息足够后输出最终报告。",
  clone_rounds_left: "\n\n⚠️ 注意：你还剩{rounds_left}轮，请尽快完成并输出最终报告（不要再调用工具）。",
  testclone_tool_result: "[工具执行结果]\n{results}\n[/工具执行结果]\n\n继续任务。如果还需要更多信息，继续使用工具。信息足够后输出最终报告。",
  testclone_rounds_left: "\n\n⚠️ 你还剩{rounds_left}轮。请立即输出最终报告（包括write_file写MD文件），不要再搜索了。",
  // 输出过滤警告（<output_filter_warning> XML 包裹=注入结构留代码；{rules}=用户设定的限制清单）
  output_filter: "你上次输出中包含了被过滤的内容。用户设定了以下输出限制：\n{rules}\n请注意调整你的输出，避免再次触发过滤。",
  // 子模式创建预设时播种的 Main Prompt 骨架（播种进用户预设 JSON 后 airp 面板可改；
  // 原 setDataActions 两处（getSubModes 自动建/迁移补建）各写死一份=双副本，收敛于此）
  submode_main_prompt: "你现在是「{label}」角色。\n{desc}",
  // AI P1 前置向量初筛头（0722 vectordb 接入 P1；措辞出自凛倾拍板文档"未来技术演进§1.6 步骤5：
  // 告诉它'以下是系统预筛选的相关记忆'"；{candidates}=vectorBridge formatVectorCandidates 填充）
  p1_vector_prefilter: "以下是系统预筛选的相关记忆（向量语义初筛，供精选参考；不确定时可用 <memorySearch> 核实补充）：\n{candidates}",
  // 上下文清理占位（0722 铁律迁移：原 getPromptHandler 清理标记两处写死；这些占位文本会随
  //   chatLog 进后续提示词。{path} 由消费点填充）
  cleaned_tool_results: "[已清理的工具结果]",
  cleaned_file: "[已清理: {path}]",
  // 摘要注入包裹（0722 铁律迁移：原 setDataActions injectSummaryMessage 写死；system 条目正文进
  //   后续提示词。{count}/{summary} 由消费点填充；content_for_show 展示层文案不进 AI、留代码）
  summary_replaced_wrap: "[对话摘要 - 替代了{count}条旧消息]\n{summary}\n[/对话摘要]",
};

// ============================================================
// token 提醒默认配置（单一来源 / SINGLE SOURCE OF TRUTH）
// 2026-07-08 链路3·TOKEN_WARNING 双源收敛：此前 getPromptHandler:1932-1975 另有一份
// 独立写死的四级阈值+动态 cleanup_hint 兜底，与本表三级阈值内容不一致——旧用户 config
// 缺 token_reminder 字段时第二份生效=双源漂移。裁决（按实际链路）：本表在"用户可改"
// 路径上（播种进用户 config，UI 可编辑），为唯一权威；getPromptHandler 改为
// {...DEFAULT_TOKEN_REMINDER, ...用户config} 合并读取，第二份副本删除。
// 文本内容原样保留（提示词文本归凛倾/用户域，此处仅机制收敛）。
// ============================================================
export const DEFAULT_TOKEN_REMINDER = {
  enabled: true,
  max_tokens: 120000,
  injection_depth: 0,
  // 多级阈值
  thresholds: [
    { percent: 50, level: "info", text: "上下文已过半，建议开始规划压缩" },
    { percent: 70, level: "warning", text: "请及时将重要内容记录到MD文件，清理不需要的读取内容" },
    { percent: 85, level: "urgent", text: "上下文即将满载！立即压缩：记录MD + 清理文件读取 + 精简代码输出" },
  ],
  // 提醒格式: "xml" | "emphasis" | "plain"
  format: "xml",
  // 自定义提醒语言（覆盖默认text）
  custom_text: "",
  // 是否告诉AI可以自主清理
  allow_ai_cleanup: true,
  // AI清理提示（告诉AI可以用什么标签清理）
  cleanup_hint: "你可以使用 <contextClean> 标签主动清理上下文中占空间的内容:\n<contextClean>read_file:路径</contextClean> — 清理之前读取的文件内容\n<contextClean>code_output:最近N条</contextClean> — 清理之前输出的代码块\n<contextClean>tool_results:all</contextClean> — 清理所有IDE工具执行结果",
};

// ============================================================
// 上下文压缩默认合并指令（单一来源 / SINGLE SOURCE OF TRUTH）
// P7 preset 用户未配置有效 prompts 时的回退默认。
// compactContext(setDataActions) 与 T09 自动压缩(getPromptHandler) 两处 consumer 共用，
// 禁止再各自硬编码副本——改这里一处即生效两处。
// ============================================================
export const DEFAULT_COMPACT_MERGE_INSTRUCTIONS = [
  "将以下对话历史压缩为结构化摘要。",
  "",
  "必须保留：",
  "- 活跃任务及其当前状态（进行中/阻塞/待办）",
  "- 批处理进度（如：已完成5/17项）",
  "- 用户最后请求的内容和正在做的事",
  "- 已做的决策及其理由",
  "- TODO、未解决的问题、约束条件",
  "- 承诺的后续行动",
  "",
  "优先保留近期上下文。AI需要知道自己在做什么，而不只是讨论了什么。",
  "保留所有标识符原样（UUID、文件名、路径、API key等）。",
  "",
  "返回JSON: {\"summary\":\"压缩后的摘要\",\"keep_indices\":[需保留的消息索引],\"reasoning\":\"压缩理由\"}",
].join("\n");

// P7 prompts 接通：按当前模式选出应使用的 promptSet（与 aiRunner runMemoryPresetAI Phase2 同逻辑）。
export function pickPresetPromptSet(preset, mode) {
  if (!preset) return [];
  if (mode === "work" && Array.isArray(preset.prompts_work) && preset.prompts_work.length > 0) return preset.prompts_work;
  if (mode === "code" && Array.isArray(preset.prompts_code) && preset.prompts_code.length > 0) return preset.prompts_code;
  return preset.prompts || [];
}

// 判定 P7 promptSet 是否含"用户/模板提供的有效压缩指令"。
// 仅 builtin {{chat_history}} 占位 + 空 system（代码骨架那种）= 无意义 → 调用方回退 DEFAULT_COMPACT_MERGE_INSTRUCTIONS。
export function p7HasMeaningfulPrompts(promptSet) {
  if (!Array.isArray(promptSet) || promptSet.length === 0) return false;
  return promptSet.some((p) =>
    p.enabled &&
    (p.content || "").trim() !== "" &&
    (p.content || "").trim() !== "{{chat_history}}"
  );
}

// ============================================================
// 默认注入提示词（聊天AI用，5条内置：INJ-1-chat/write-code/work 表格说明 + INJ-2 文件层 + INJ-3 Bot 平台）— 最小骨架
// ============================================================

export const DEFAULT_INJECTION_PROMPTS = [
  {
    id: "INJ-1-chat",
    name: "聊天表格说明",
    description: "向聊天AI注入聊天模式的表格数据和操作规则",
    enabled: true,
    builtin: true,
    deletable: false,
    role: "system",
    depth: 999,
    order: 100,
    autoMode: "chat",
    content: "",
  },
  {
    id: "INJ-1-write-code",
    name: "编程表格说明",
    description: "向聊天AI注入编程模式的表格数据和操作规则",
    enabled: true,
    builtin: true,
    deletable: false,
    role: "system",
    depth: 999,
    order: 101,
    autoMode: "code",
    content: "",
  },
  {
    id: "INJ-1-work",
    name: "工作表格说明",
    description: "向聊天AI注入工作模式的表格数据和操作规则",
    enabled: true,
    builtin: true,
    deletable: false,
    role: "system",
    depth: 999,
    order: 102,
    autoMode: "work",
    content: "",
  },
  {
    id: "INJ-2",
    name: "文件层AI提示词",
    description:
      "告诉聊天AI如何通过beilu-files修改用户项目文件（类似Cursor IDE）",
    enabled: true,
    builtin: true,
    deletable: false,
    role: "system",
    depth: 999,
    order: 200,
    autoMode: "file",
    content: "",
  },
  {
    id: "INJ-3",
    name: "Bot 平台提示词",
    description:
      "告诉聊天AI在 Bot 平台（Discord/Telegram 等 10 平台共用）上如何回复（格式、语气、提及用户等规则）",
    enabled: false,
    builtin: true,
    deletable: false,
    role: "system",
    depth: 999,
    order: 300,
    autoMode: "bot", // bot 门控（原 manual=开启后全模式注入含 web 端）：开启后仅 bot 会话（extension.platform 派生 mode="bot"）注入
    content: "",
  },
];

// ============================================================
// 默认子模式配置（9个代码角色 DEFAULT_CODE_SUB_MODES + 12个工作角色 DEFAULT_WORK_SUB_MODES）
// ============================================================

// 子模式定义唯一源=后端（本种子播入 smConfig.sub_modes，经 getSubModes 下发）；
// 前端 DEFAULT_SUB_MODES 副本已删（T010），前端只持运行时镜像 _subModes。
export const DEFAULT_CODE_SUB_MODES = [
  { id: "前置任务专家",   label: "前置任务专家",   icon: "🎯", desc: "需求理解+现状调查+设计出案，一体化前置（确认师+设计师合并）", presetName: "前置任务专家", modeGroup: "code" },
  { id: "框架审查员",     label: "框架审查员",     icon: "🔎", desc: "原话对齐审计：独立理解-承接四态-完备抽查-范围对齐",             presetName: "框架审查员", modeGroup: "code" },
  { id: "算法与推演专家", label: "算法与推演专家", icon: "🔬", desc: "可衡量化+严谨推导+算法白盒实验，数值支撑后交代码专家",         presetName: "算法与推演专家", modeGroup: "code" },
  { id: "代码专家",       label: "代码专家",       icon: "💻", desc: "外科手术式改代码，流水线唯一改代码角色",                       presetName: "代码专家", modeGroup: "code" },
  { id: "链路审计专家",   label: "链路审计专家",   icon: "🛡️", desc: "传导链走查+AI结构病扫+白盒布点+实测收讫（错误生产+测试合并）", presetName: "链路审计专家", modeGroup: "code" },
  { id: "纠错专家",       label: "纠错专家",       icon: "🔧", desc: "三不继承+假设验证循环+无差别调查，根因层修复",                 presetName: "纠错专家", modeGroup: "code" },
  { id: "任务交接员",     label: "任务交接员",     icon: "📋", desc: "SBAR/ADR/Postmortem归档交接，完成度写实",                       presetName: "任务交接员", modeGroup: "code" },
  { id: "大项目协调",     label: "大项目协调",     icon: "🏗️", desc: "大项目协调中枢：scope锁定+依赖链排序+增量合并+多分身编排+完整输出", presetName: "大项目协调", modeGroup: "code" },
  { id: "前端美化",       label: "前端美化",       icon: "🎨", desc: "双战场分流：产品UI优先序铁律+营销页anti-slop全流程",           presetName: "前端美化专家", modeGroup: "code" },
];

// 工作模式子模式统一用 work- 前缀避免与编程模式ID冲突
export const DEFAULT_WORK_SUB_MODES = [
  { id: "work-task-confirm",   label: "任务确认师",     icon: "🎯", desc: "理解需求，核对理解，记录原话到#0，建active/xx.md",         presetName: "任务确认",  modeGroup: "work" },
  { id: "work-task-design",    label: "任务设计",       icon: "📝", desc: "读取任务MD，通过最终效果反推设计执行流程",                  presetName: "任务设计",   modeGroup: "work" },
  { id: "work-flow-optimize",  label: "流程优化",       icon: "⚡", desc: "优化设计好的流程，减少token消耗，精简步骤",                 presetName: "流程优化", modeGroup: "work" },
  { id: "work-frame-review",   label: "框架审查",       icon: "🔍", desc: "审查流程设计是否有错误，联想可能的问题，只优化不打回",      presetName: "框架审查",   modeGroup: "work" },
  { id: "work-prompt-design",  label: "提示词设计",     icon: "✏️", desc: "为任务设计所需的提示词，参考提示词指南",                    presetName: "提示词设计",   modeGroup: "work" },
  { id: "work-preset-design",  label: "提示词+预设设计", icon: "📐", desc: "设计beilu提示词与预设本身(提示词工程作者)，内含教程+017示例+方法论", presetName: "预设设计",   modeGroup: "work" },
  { id: "work-skill-script",   label: "Skill/脚本制作", icon: "🔧", desc: "制作任务所需的脚本、skill、MCP接入",                       presetName: "脚本制作",    modeGroup: "work" },
  { id: "work-flow-assemble",  label: "流程组装",       icon: "🧩", desc: "将提示词+skill+脚本组装为可执行的流程组",                   presetName: "流程组装", modeGroup: "work" },
  { id: "work-flow-execute",   label: "执行流程组",     icon: "▶️", desc: "运行组装好的流程组，按顺序执行各步骤，记录执行日志",        presetName: "执行流程组",  modeGroup: "work" },
  { id: "work-verify",         label: "验证",           icon: "✅", desc: "用户验证或自动验证执行结果",                                presetName: "验证",   modeGroup: "work" },
  { id: "work-wrapup",         label: "收尾归档",       icon: "📦", desc: "归档任务MD到archive/，更新表格索引，记录经验，生成完成报告", presetName: "收尾归档",   modeGroup: "work" },
  // 尾部追加安全：流水线 steps 按 map/索引引用本数组，禁在中间插入（:955/:967）
  { id: "work-ppt",            label: "PPT制作",        icon: "📊", desc: "类型判定→主张句骨架→草稿给用户审查→美化生成→字符画核对", presetName: "PPT制作", modeGroup: "work" },
];

// ============================================================
// T011 权限档位显示元数据（L0-L4）——单一权威源。
// 权限是安全面：双源不同步=授权误导（用户按前端描述授权、后端按另一语义执行），故元数据只在此定义，
// 经 setDataActions getPermissionLevel 附带下发，前端（YonBan 徽章/本体侧栏 select）零副本。
// 只是"显示元数据"：enforcement 执行点（replyHandler L 判断/commandGate 规则集）不读此表、零关联。
// color 含 VSCode 主题变量+通用 hex 回退，本体侧可忽略 color。
// ============================================================
export const PERM_LEVEL_META = [
  { level: 0, label: "L0 只读",     desc: "只读(全询问)：所有写/命令操作均需审批",                       color: "var(--vscode-descriptionForeground, #888)" },
  { level: 1, label: "L1 安全写",   desc: "安全写(全询问)：写入仍逐项审批",                             color: "var(--vscode-charts-blue, #60a5fa)" },
  { level: 2, label: "L2 基础",     desc: "基础：写放行/命令询问",                                     color: "var(--vscode-testing-iconPassed, #4caf50)" },
  { level: 3, label: "L3 高级",     desc: "高级：写+命令放行",                                         color: "var(--vscode-charts-yellow, #f59e0b)" },
  { level: 4, label: "L4 完全信任", desc: "完全信任：写+命令放行（区外/危险/敏感 ask 规则仍必问）",     color: "var(--vscode-errorForeground, #f44)" },
  { level: 5, label: "L5 全部放行", desc: "全部放行：所有操作自动执行，包括危险/敏感操作，无任何审批阻塞", color: "var(--vscode-errorForeground, #d00)" },
];

// ============================================================
// skill 组（= flowGroup）：多个子模式 = 一套完整工作流程。
// 蓝图：skill 组=多子模式=一套工作流；大型项目=8 角色流水线，小型=确认+代码+测试+汇报。
// steps 引用 DEFAULT_CODE_SUB_MODES（单一权威源，子模式定义改动自动同步，不重复维护）。
// 文件形态与 createFlowGroup 落盘一致：{name,description,steps:[{mode,preset_name,label,...}],auto_advance,approval_before}。
// startFlowGroup 据 steps[].mode 切 active_sub_mode，auto_advance 逐级流转。
// ============================================================
export function buildDefaultSkillGroups() {
  const _step = (m) => ({ mode: m.id, preset_name: m.presetName, label: m.label, icon: m.icon, desc: m.desc, modeGroup: m.modeGroup });
  // [0724 schema4] code组skill组按凛倾拍板收为2个（大项目/小项目）；steps 改按 id 查表——
  //   此前索引硬编码（slice(0,9)/[0,4,6,8]）在子模式表重组时会静默错位甚至越界，id 引用表变动即报错不带病运行。
  const _codeById = (id) => {
    const m = DEFAULT_CODE_SUB_MODES.find((x) => x.id === id);
    if (!m) throw new Error(`buildDefaultSkillGroups: code子模式id不存在: ${id}`);
    return _step(m);
  };
  return [
    {
      name: "大项目",
      filename: "大项目.json",
      description: "大型任务全流程：前置任务→框架审查→算法推演→代码→链路审计→纠错→交接",
      skill_group: true,
      builtin: true,
      modeGroup: "code",
      steps: ["前置任务专家", "框架审查员", "算法与推演专家", "代码专家", "链路审计专家", "纠错专家", "任务交接员"].map(_codeById),
      auto_advance: true,
      approval_before: [],
      created_by: "default",
    },
    {
      name: "小项目",
      filename: "小项目.json",
      description: "快速任务：前置任务→代码→链路审计→交接",
      skill_group: true,
      builtin: true,
      modeGroup: "code",
      steps: ["前置任务专家", "代码专家", "链路审计专家", "任务交接员"].map(_codeById),
      auto_advance: true,
      approval_before: [],
      created_by: "default",
    },
    {
      name: "工作全流程",
      filename: "工作全流程.json",
      description: "工作模式全流程：确认→设计→优化→审查→提示词→Skill→组装→执行→验证→归档",
      skill_group: true,
      builtin: true,
      modeGroup: "work",
      steps: DEFAULT_WORK_SUB_MODES.map(_step),
      auto_advance: true,
      approval_before: [],
      created_by: "default",
    },
    {
      name: "快速工作",
      filename: "快速工作.json",
      description: "快速工作：确认→设计→执行→归档",
      skill_group: true,
      builtin: true,
      modeGroup: "work",
      steps: [0, 1, 7, 9].map((i) => _step(DEFAULT_WORK_SUB_MODES[i])),
      auto_advance: true,
      approval_before: [],
      created_by: "default",
    },
    // [0724 schema4] PPT制作(code版)删除——凛倾拍板"ppt不需要,那个是work的,code不需要ppt"；
    //   code组不再有 ppt-designer 子模式，work版保留。
    {
      name: "PPT制作(工作)",
      filename: "PPT制作(工作).json",
      description: "PPT生成流程(工作模式)：类型判定→主张句骨架→草稿给用户审查→美化生成→字符画核对",
      skill_group: true,
      builtin: true,
      modeGroup: "work",
      steps: [_step(DEFAULT_WORK_SUB_MODES[11])],
      auto_advance: false,
      approval_before: [],
      created_by: "default",
    },
    // [0716 二级细化·凛倾原话] "注意我们有很多区分.然后细化我是说全部都细化.比如code可以细化大中小项目,等等"
    //   → 补"中型项目"(code, 大项目9步中的6步) 与"标准工作"(work, 10步中的6步)；
    //   加组=尾部追加，DEFAULT_CODE/WORK_SUB_MODES 索引核对: code[0,1,4,5,6,8]=确认/前置设计/代码/前置错误/测试/交接;
    //   work[0,1,3,7,9,10]=确认/设计/审查/组装(执行流程组前置)/验证/归档.
    //   种子播入 setDataActions.mjs:4221 "同名文件不存在才写"，存量用户主动打开 skill 组库时自动补齐。
    // [0724 schema4] 中型项目删除——code组skill组收为2个（大项目/小项目），凛倾拍板。
    {
      name: "标准工作",
      filename: "标准工作.json",
      description: "标准工作：确认→设计→审查→执行→验证→归档",
      skill_group: true,
      builtin: true,
      modeGroup: "work",
      steps: [0, 1, 3, 7, 9, 10].map((i) => _step(DEFAULT_WORK_SUB_MODES[i])),
      auto_advance: true,
      approval_before: [],
      created_by: "default",
    },
  ];
}
