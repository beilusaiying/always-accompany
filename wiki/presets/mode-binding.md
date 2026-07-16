# 预设与模式联动

always-accompany 的模式系统（[聊天模式](beilu:mode/chat) / Code / [工作模式](beilu:mode/work) / [Bot管理](beilu:mode/bot)）与预设引擎深度联动。每个模式可以绑定独立的预设，切换模式时系统自动切换预设，保证不同工作场景下 AI 收到合适的指令。

## 绑定数据结构

### mode_preset_bindings

模式绑定关系存储在记忆系统的全局配置中（`_config.json` 的 `mode_preset_bindings` 字段）：

```
mode_preset_bindings: {
  chat: "预设名A",
  code: "预设名B",
  work: "预设名C",
  bot:  "预设名D"
}
```

每个模式只绑定一个预设名。当你在某个模式下选择预设时，该绑定会自动更新。

### active_preset_map

除了模式级绑定，每个对话窗口可以独立绑定预设。`active_preset_map` 以对话 ID（或模式+角色复合键）为索引，记录每个对话使用的预设：

```
active_preset_map: {
  "abc1234": "预设名X",         // 某个对话使用的预设
  "chat:角色名": "预设名Y",      // chat 模式下某角色的预设
  "code:角色名": "预设名Z"       // code 模式下某角色的预设
}
```

## 预设选择优先级

当系统需要确定某次对话使用哪个预设时，按以下优先级解析：

```
对话级 active_preset_map[chatId]
    ↓ 无 → 模式+角色复合键 active_preset_map[mode:charName]
    ↓ 无 → 模式绑定 mode_preset_bindings[mode]
    ↓ 无 → 全局默认 active_preset
```

## 模式切换时的联动

用户切换模式后，预设引擎的行为：

1. 前端通知后端切换模式（switchMode）
2. 后端读取目标模式的活跃对话（using 指针）
3. 从 active_preset_map 解析该对话的预设
4. 如果对话没有独立预设，回退到 mode_preset_bindings
5. 加载对应预设到引擎，后续对话使用新预设

## 子模式绑定

Code 和 Work 模式各拥有 11 个子模式。每个子模式可以独立绑定：

- 预设
- AI 服务源
- 模型名称
- 采样参数（temperature 等）

子模式参数在 TweakPrompt Round 2 阶段覆盖引擎参数。覆盖链：

```
子模式参数 > runtime model_overrides_by_char > 全局 runtime_params > 预设 eng.modelParams
```

子模式信息通过 beilu-memory 的 extension 传递给预设引擎（`sub_mode_*` 字段），预设引擎据此合并参数。

## P1 预设切换信号

记忆系统的 P1 管线可以在运行时触发预设切换。当 extension 中出现 `preset_switch_to` 字段时，预设引擎会：

1. TweakPrompt Round 1 检测到信号
2. 切换到指定预设
3. 持久化写盘（saveConfigToDisk）
4. 同步正则预设（`_resyncPresetRegex`）
5. 后续轮次使用新预设

这使得 AI 可以根据对话内容自动切换预设（例如从聊天预设切到编程预设）。

## Bot 模式的预设解析

Bot 模式的预设解析有特殊逻辑：

- Bot 对话通过 `resolveBotModeFromRequest` 单源函数解析模式
- Bot 的预设映射键使用 `bot:角色名` 格式
- Bot 模式复用 chat 后端模式，但预设绑定独立

## 数据持久化

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| mode_preset_bindings | 记忆系统 _config.json | 模式级绑定 |
| active_preset_map | 预设 config.json | 对话/角色级绑定 |
| active_preset | 预设 config.json | 全局默认预设 |

预设 config.json 按用户隔离（`data/users/<user>/presets/config.json`），每个用户拥有独立的预设配置。

## 清理机制

删除对话时，系统会自动清理 active_preset_map 中该对话 ID 对应的残键，防止配置文件积累孤儿条目。

## 导航

- [预设系统概览](overview.md) — 预设基础概念
- [模式系统概览](../modes/overview.md) — 模式架构
- [子模式与切换](../modes/submodes.md) — 子模式详解
