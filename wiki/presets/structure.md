# 预设条目结构

预设引擎（PresetEngine）兼容 SillyTavern 预设格式。一个预设 JSON 文件由两部分组成：**条目列表**（prompts）和**排序表**（prompt_order）。引擎负责解析这些数据，按规则排序后产出四段消息（beforeChat / afterChat / injectionAbove / injectionBelow），交给下游 provider 组装。

## 预设 JSON 结构

<div class="wiki-grid wiki-grid-3">
<div class="wiki-group" style="grid-column: span 3">
<div class="wiki-group-title">prompts[] — 条目数组</div>
<div class="wiki-grid wiki-grid-4">
<div class="wiki-card"><div class="wiki-card-title">identifier</div><div class="wiki-card-desc">唯一标识符</div></div>
<div class="wiki-card"><div class="wiki-card-title">name</div><div class="wiki-card-desc">显示名称</div></div>
<div class="wiki-card"><div class="wiki-card-title">role</div><div class="wiki-card-desc">消息角色 (system / user / assistant)</div></div>
<div class="wiki-card"><div class="wiki-card-title">content</div><div class="wiki-card-desc">条目文本内容（支持宏）</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_position</div><div class="wiki-card-desc">注入位置 (0=afterChat / 1=beforeChat)</div></div>
<div class="wiki-card"><div class="wiki-card-title">injection_depth</div><div class="wiki-card-desc">注入深度（插入聊天历史的位置）</div></div>
<div class="wiki-card"><div class="wiki-card-title">enabled</div><div class="wiki-card-desc">是否启用</div></div>
<div class="wiki-card"><div class="wiki-card-title">marker</div><div class="wiki-card-desc">是否为内置标记（如 chatHistory）</div></div>
</div>
</div>
</div>

<div class="wiki-grid wiki-grid-2">
<div class="wiki-group">
<div class="wiki-group-title">prompt_order[] — 排列顺序</div>
<div class="wiki-card"><div class="wiki-card-title">character_id</div><div class="wiki-card-desc">100000=系统级 / 100001=用户级</div></div>
<div class="wiki-card"><div class="wiki-card-title">order[]</div><div class="wiki-card-desc">该级别下的 identifier 排列</div></div>
</div>
<div class="wiki-group">
<div class="wiki-group-title">model_params — 模型参数（可选）</div>
<div class="wiki-card"><div class="wiki-card-desc">预设携带的温度、采样等模型参数</div></div>
</div>
</div>

## 条目分类

### 内置标记条目（Marker）

引擎预定义了 12 个内置标记，它们是预设结构的骨架：

| Marker | 作用 | 宏展开对象 |
|--------|------|-----------|
| main | 主系统提示 | - |
| nsfw | NSFW 相关指令 | - |
| jailbreak | 越狱/解锁指令 | - |
| chatHistory | 聊天历史分割点 | _chat_log |
| charDescription | 角色描述 | char_prompt |
| charPersonality | 角色性格 | char_personality |
| scenario | 场景设定 | scenario |
| personaDescription | 用户人设描述 | user_prompt |
| worldInfoBefore | 世界书（前置） | world_prompt |
| worldInfoAfter | 世界书（后置） | world_prompt_after |
| dialogueExamples | 对话示例 | dialogue_examples |
| enhanceDefinitions | 增强定义 | - |

Marker 条目在司令员模式下会展开为对应模块的实际内容（通过宏环境 env 注入）。

### 用户自定义条目

用户可自由添加条目，identifier 不与内置标记重复即可。通过 injection_position 和 injection_depth 控制条目在最终消息中的位置。

## 排序规则

### 两级排序

预设通过 prompt_order 定义排序：

- **系统级**（character_id = 100000）：包含内置 Marker 和系统指令，构成提示词骨架
- **用户级**（character_id = 100001）：用户添加的自定义条目

### 注入位置

| injection_position | 含义 | 放置位置 |
|-------------------|------|---------|
| 0 | afterChat | 聊天历史之后（尾部预设） |
| 1 | beforeChat | 聊天历史之前（头部预设） |

### 注入深度（injection_depth）

注入深度决定条目在聊天历史中的插入位置：

- **深度 0**：最底部，紧贴最新消息
- **深度 4**（ST 默认）：从底部往上数第 4 条消息处
- **深度 N**：从底部往上数第 N 条消息处

深度越小，条目离最新对话越近，AI 越容易"看到"并遵循。

## 引擎工作流

PresetEngine 的核心方法 `buildAllEntries()` 按以下步骤工作：

<div class="wiki-flow">
<div class="wiki-box wiki-box-amber"><b>1. 遍历 prompt_order</b><small>按系统级 → 用户级的顺序处理</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-blue"><b>2. 过滤未启用条目</b><small>跳过 enabled = false</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>3. Marker 展开</b><small>内置标记条目展开为宏环境中的实际内容</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>4. 宏替换</b><small>自定义条目执行 evaluateMacros</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>5. 按 injection_position 分组</b><small>→ beforeChat / afterChat</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-purple"><b>6. 按 injection_depth 分流</b><small>深度 >= 1 → injectionAbove / 深度 = 0 → injectionBelow</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-red"><b>7. 返回四段产物</b><small>供 TweakPrompt 消费</small></div>
</div>

## 宏替换

条目内容支持宏语法。在 buildAllEntries 阶段，引擎会调用 `evaluateMacros` 对条目文本进行替换。常用宏包括：

- `{{char}}` — 当前角色名
- `{{user}}` — 当前用户名
- `{{time}}` — 当前时间
- 自定义变量宏

详见 [宏系统](../macros/overview.md)。

## 模型参数提取

预设可携带模型参数。引擎通过 `extractModelParams` 从预设数据中提取以下 canonical 参数：

| 参数 | 说明 | 默认值 |
|------|------|-------|
| temperature | 生成温度 | 由 PARAM_SCHEMA 定义 |
| top_p | 核采样 | 由 PARAM_SCHEMA 定义 |
| top_k | Top-K 采样 | 由 PARAM_SCHEMA 定义 |
| max_tokens | 最大输出 token 数 | 由 PARAM_SCHEMA 定义 |
| frequency_penalty | 频率惩罚 | 由 PARAM_SCHEMA 定义 |
| presence_penalty | 存在惩罚 | 由 PARAM_SCHEMA 定义 |
| repetition_penalty | 重复惩罚 | 由 PARAM_SCHEMA 定义 |
| min_p | Min-P 采样 | 由 PARAM_SCHEMA 定义 |
| top_a | Top-A 采样 | 由 PARAM_SCHEMA 定义 |
| seed | 随机种子 | 由 PARAM_SCHEMA 定义 |

所有默认值统一由 `paramSchema.mjs` 的 PARAM_SCHEMA 定义，确保引擎层、应用层、前端 UI 三处同源。

## 导航

- [预设系统概览](overview.md) — 预设基础概念
- [司令员模式](commander.md) — 预设接管消息组装
