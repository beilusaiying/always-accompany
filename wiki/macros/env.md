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

| 宏 | 注入插件 | 说明 |
|----|----------|------|
| `{{workspace_root}}` | beilu-files | 当前工作区的根目录路径 |
| `{{workspace_tree}}` | beilu-files | 当前工作区的目录树结构 |

### {{workspace_root}}

由 beilu-files 插件注入。值为当前文件工作区的根目录路径。编程模式下，AI 可以通过这个宏知道项目在哪里。

### {{workspace_tree}}

由 beilu-files 插件注入。值为当前工作区的目录树文本表示。让 AI 了解项目的文件结构，不需要逐个列举文件。

## 插件如何注入自定义宏

对于插件开发者，注入自定义宏的方式是在插件中设置 `extension.macro_env`：

```
extension.macro_env = {
    my_custom_key: "值会在宏替换时填入",
    another_key: dynamicValue
};
```

设置后，预设和角色卡中就可以使用 `{{my_custom_key}}` 和 `{{another_key}}`。

### 要点

- **键名即宏名**：`macro_env` 中的键直接对应 `{{键名}}` 宏
- **值可以动态更新**：插件可以在运行时更新 `macro_env` 的值，下次宏替换自动生效
- **多插件合并**：多个插件的 `macro_env` 会合并到同一个宏环境中
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
- 如果多个插件注入了同名的宏，后注入的会覆盖先注入的
- env 宏的值可以是字符串或会被转为字符串的值
- 插件卸载或禁用后，其注入的 env 宏不再可用，对应的 `{{宏名}}` 会保持原样不被替换
