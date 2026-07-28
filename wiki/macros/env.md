# env 自定义变量宏

插件通过 `extension.macro_env` 注入自定义键值对，这些键自动成为可用宏。

## 机制原理

```
插件设置 extension.macro_env.my_key = "my_value"
  -> 宏环境中出现 my_key
  -> 预设中写 {{my_key}} 会被替换为 "my_value"
```

这是一个**完全动态**的机制——插件可以随时更新 `macro_env` 中的值，下次宏替换时就会使用新值。

## 已有的 env 宏

以下是目前由 always-accompany 官方插件注入的 env 宏：

| 宏 | 注入来源 | 说明 |
|----|----------|------|
| `{{workspace_root}}` | beilu-files | 当前工作区的根目录路径 |
| `{{workspace_tree}}` | beilu-files | 当前工作区的目录树结构 |
| `{{active_preset_name}}` | 预设系统（核心） | 当前激活预设的名称 |
| `{{active_preset_description}}` | 预设系统（核心） | 当前激活预设的介绍（description 字段） |
| `{{work_sub_modes_list}}` | beilu-memory | 工作模式的全部子模式清单（含介绍），非工作模式时为空。动态内容——只应在尾部条目 `INJ-work-submodes-data` 使用（见「数据注入条目与数据宏」页） |
| `{{code_sub_modes_list}}` | beilu-memory | 编程模式的全部子模式清单（含介绍），非编程模式时为空。动态内容——只应在尾部条目 `INJ-code-submodes-data` 使用 |
| `{{current_mode}}` | beilu-memory | 当前激活的模式（chat/code/work 等） |
| `{{active_project}}` | beilu-memory | 当前活跃的项目名 |
| `{{browser_status}}` | beilu-browser | 浏览器连接状态（connected / disconnected）。动态内容——只应在尾部条目 `INJ-browser-status-data` 使用（0722 从 INJ-browser 头部拆出） |
| `{{browser_port}}` | beilu-browser | Chrome CDP 调试端口号（随状态行走尾部条目） |

> **动态宏位置铁律**：会逐轮/频繁变化的宏（状态、清单、数据类）禁止用在头部（`depth >= 1`）条目模板里——头部一字变化=提示词缓存前缀整体失效。动态宏一律放尾部 `*-data` 条目，详见「数据注入条目与数据宏」页。

### {{workspace_root}}

由 beilu-files 插件注入。值为当前文件工作区的根目录路径。编程模式下，AI 可以通过这个宏知道项目在哪里。

### {{workspace_tree}}

由 beilu-files 插件注入。值为当前工作区的目录树文本表示。让 AI 了解项目的文件结构，不需要逐个列举文件。

### {{active_preset_name}} 与 {{active_preset_description}}

由预设系统在组装提示词时挂载（与本轮实际使用的预设引擎同源）。分别替换为当前激活预设的名称与介绍。

主要用途是预设思考骨架（beilu_think）里的**身份自检**：

```
当前任务身份={{active_preset_name}}
!!!现在的需要做的事情是否是我的身份范围!!!:{{active_preset_name}}—{{active_preset_description}}
```

AI 每轮回复前用真实的预设身份与介绍核对当前工作是否在身份范围内，不再靠空白填空凭感觉判断。预设介绍可在预设管理界面编辑，编辑后宏值即时跟随。

### {{work_sub_modes_list}} 与 {{code_sub_modes_list}}

由 beilu-memory 导出。替换为对应模式下全部子模式的实时清单，每行格式 `- id: 名称 — 介绍`。只在各自模式激活时有内容（工作宏在 work 模式、编程宏在 code 模式），其他模式下替换为空字符串，因此两个宏可以并排写、互不干扰：

```
当前身份的工作是否符合现在的身份:{{work_sub_modes_list}}{{code_sub_modes_list}}
```

清单来自子模式配置的实时数据——预设里引用宏即可，无需手写子模式列表（手写列表会随配置变更漂移）。

## 插件如何注入自定义宏

对于插件开发者，注入自定义宏的方式是在插件中设置 `extension.macro_env`：

```
extension.macro_env = {
    my_custom_key: "值会在宏替换时填入",
    another_key: String(dynamicValue)  // 值必须是字符串，非字符串会被静默忽略
};
```

设置后，预设和角色卡中就可以使用 `{{my_custom_key}}` 和 `{{another_key}}`。

### 要点

- **键名即宏名**：`macro_env` 中的键直接对应 `{{键名}}` 宏
- **值必须是字符串**：非字符串值会被静默忽略（不会自动转成字符串），想传数字/对象请先自己转好
- **值可以动态更新**：插件可以在运行时更新 `macro_env` 的值，下次宏替换自动生效
- **多插件合并，先到先得**：多个插件的 `macro_env` 会合并到同一个宏环境中；同名键谁先被收集到谁生效，后来者的同名声明被静默丢弃
- **后端替换**：env 宏在后端宏引擎（evaluateMacros）阶段被替换

## 运行链路

```
各插件在初始化或运行时设置 extension.macro_env
  -> 用户发送消息
  -> 后端组装提示词
  -> TweakPrompt Round1: buildMacroEnvFromPromptStruct
     合并所有插件的 macro_env 到宏环境
  -> Round2: PresetEngine.buildAllEntries -> evaluateMacros
     遇到 {{key}} 时从宏环境中查找并替换
  -> 替换后的提示词发给 AI
```

## 与其他宏的关系

| 对比维度 | env 宏 | 内置宏（如 {{user}}） | 变量宏（如 {{getvar::x}}） |
|----------|--------|----------------------|--------------------------|
| 定义方式 | 插件通过 macro_env 注入 | 硬编码在宏引擎中 | 用户通过 setvar 设置 |
| 值来源 | 插件运行时计算 | 系统状态（用户名等） | macroMemory 存储 |
| 可扩展性 | 任意扩展 | 固定集合 | 任意键名 |
| 持久性 | 插件生命周期内有效 | 始终有效 | 持久化到预设 |
| 适用场景 | 插件向 AI 暴露数据 | 基本信息占位 | 对话状态追踪 |

## 注意事项

- env 宏只在后端替换阶段生效，前端不会处理
- 同名宏是**先到先得**：如果多个插件声明了同名的宏，先被收集到的插件生效，后来者的同名声明会被静默丢弃——既不会覆盖核心宏（`{{user}}`、`{{char}}` 等），也不会覆盖先声明的插件宏。所以你的自定义宏"不生效"时，先检查是不是撞了已有的键名
- env 宏的值**必须是字符串**：非字符串值（数字、对象、布尔等）会被静默忽略，不会自动转成字符串
- 插件卸载或禁用后，其注入的 env 宏不再可用，对应的 `{{宏名}}` 会保持原样不被替换
