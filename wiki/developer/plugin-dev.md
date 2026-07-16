# 插件开发

always-accompany 的插件系统允许你编写自定义插件来扩展功能。插件通过标准化的接口参与[消息管线](message-pipeline.md)，可以向 AI 注入提示词、处理 AI 回复、提供配置面板等。

## 插件结构

一个 always-accompany 插件的最小目录结构：

```
plugins/my-plugin/
├── info.json          ← 插件元数据（必需）
├── main.mjs           ← 插件入口（必需）
└── (可选) display.mjs ← 前端配置面板
```

### info.json

插件的元数据文件，由 parts_loader 发现和读取：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "插件功能描述",
  "version": "1.0.0"
}
```

或使用 `beilu-part.json` 格式（两者均被 parts_loader 识别）。

### main.mjs

插件入口文件。导出一个包含 interfaces 的对象：

```javascript
export default {
  info: { /* 插件信息 */ },
  interfaces: {
    chat: {
      GetPrompt,     // 注入提示词
      TweakPrompt,   // 调整提示词
      ReplyHandler,  // 处理 AI 回复
    },
    config: {
      GetData,       // 读取配置
      SetData,       // 写入配置
    },
  },
};
```

## 接口详解

### GetPrompt

在消息发送前调用，返回插件要注入到提示词中的内容。

**参数**：`(chatReplyRequest)`

**返回值**：`single_part_prompt_t` 对象，包含：

```javascript
{
  text: [
    { content: "提示词文本", important: 0 }
  ],
  extension: {
    // 插件间传递的数据（不直接发给 AI）
  }
}
```

- `text[]`：要注入到提示词中的文本片段，按 important 排序
- `extension`：扩展数据，供其他插件在 TweakPrompt 阶段读取

### TweakPrompt

在所有 GetPrompt 之后调用，允许修改已组装的 prompt_struct。执行三轮：

**参数**：`(prompt_struct, chatReplyRequest, detail_level)`

- `prompt_struct`：当前的提示词结构（可直接修改）
- `detail_level`：当前轮次（2 -> 1 -> 0）

**返回值**：无（直接修改 prompt_struct）

典型用法：
- Round 1 (dl=2)：读取其他插件的 extension 数据
- Round 2 (dl=1)：重新组织消息序列
- Round 3 (dl=0)：最终调整

### ReplyHandler

AI 回复到达后调用，用于解析和处理回复中的特定标签。

**参数**：`(replyText, chatReplyRequest)`

**返回值**：处理后的文本（可修改回复内容）

典型用法：
- 解析 AI 回复中的自定义标签
- 执行标签对应的操作（文件读写、变量设置等）
- 将操作结果通过 GetPrompt 注入到下一轮

### GetData

前端或其他模块读取插件配置/状态时调用。

**参数**：`(request)`

**返回值**：配置数据对象

### SetData

前端或其他模块写入插件配置或触发动作时调用。

**参数**：`(data, request)`

`data` 中的 `_action` 字段可用于区分不同操作类型。

## 插件间通信

插件之间不直接 import，而是通过 `prompt_struct` 的 `extension` 字段间接通信：

1. 插件 A 在 GetPrompt 阶段将数据写入 `extension.my_data`
2. 插件 B 在 TweakPrompt 阶段从 `prompt_struct.plugin_prompts['plugin-a'].extension.my_data` 读取

这种松耦合设计确保插件可以独立开发和部署。

## 插件加载

### 自动加载

在 `defaultParts.plugins` 中列出的插件会在每次对话中自动加载。

### 加载时序

parts_loader 在服务器启动时按目录顺序加载插件。插件的模块级代码会在加载时执行，注意避免阻塞和循环依赖。

如需引用其他模块，推荐使用惰性动态 import（首次使用时加载），避免加载时序问题。

## 安全注意事项

### 安全敏感配置

如果你的插件有安全敏感的配置项（如开关沙箱、允许执行命令等），需要在 `security_policy.mjs` 的 `OWNER_ONLY_PART_CONFIG_WRITE` 表中注册，确保这些配置只能由 owner 修改。

### 用户数据隔离

在多用户场景下，插件的配置和数据应按用户隔离。推荐使用 `getUserDataDir(username)` 获取用户数据路径，或使用 AsyncLocalStorage 实现 per-user 上下文。

### 前端配置面板

通过 `GetConfigDisplayContent` 接口返回前端配置面板的 JavaScript 代码。面板在浏览器中执行，注意不要暴露敏感信息。

## 用户插件 (beilu-plugin-host)

通过 beilu-plugin-host，用户可以在运行时加载自定义插件脚本，无需重启服务。用户插件与内置插件享有相同的接口能力，但受安全策略约束。

## 测试

插件开发时建议：

- 使用 `BEILU_DIAG=<模块名>` 环境变量开启诊断日志
- 通过 whitebox 追踪系统（wbTrace / wbDetect）记录关键事件
- 使用 fakeSend（token 预览）模式测试 GetPrompt / TweakPrompt 输出

## 导航

- [插件概览](../plugins/overview.md) — 现有插件列表
- [消息管线](message-pipeline.md) — 插件在管线中的位置
- [系统架构](architecture.md) — 整体架构
- [API 端点参考](api-reference.md) — 端点接口
