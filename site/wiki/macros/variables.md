# 变量宏

在预设和角色卡中**存储和读取数据**，用于状态追踪（好感度、HP、物品数量等）。分为**局部变量**（当前角色/聊天专属）和**全局变量**（所有角色共享），操作完全对称。

## 核心概念

### 变量存储位置

变量数据存储在 `macroMemory` 中，并持久化到预设的 `macro_variables` 字段。这意味着：

- 变量在对话之间**持久保留**，不会因刷新页面而丢失
- 局部变量与当前角色/聊天绑定
- 全局变量在所有角色之间共享

### 变量类型

变量值可以是**字符串**或**数字**。做数学运算（add/inc/dec）时，系统会尝试将值当作数字处理。

## 局部变量操作

局部变量只在当前角色/聊天的范围内有效。

| 宏 | 说明 | 示例 |
|----|------|------|
| `{{setvar::名称::值}}` | 设置变量 | `{{setvar::hp::100}}` |
| `{{getvar::名称}}` | 读取变量 | `{{getvar::hp}}` -> `100` |
| `{{addvar::名称::值}}` | 加上一个数值 | `{{addvar::hp::-20}}` (hp 变为 80) |
| `{{incvar::名称}}` | 自增 1 | `{{incvar::turn}}` |
| `{{decvar::名称}}` | 自减 1 | `{{decvar::hp}}` |

### 使用示例

**设定初始状态**（角色卡首条消息中）：
```
{{setvar::hp::100}}{{setvar::mp::50}}{{setvar::gold::0}}
冒险开始了！{{user}}的初始状态：HP {{getvar::hp}} / MP {{getvar::mp}}
```

**战斗中扣血**：
```
{{addvar::hp::-15}}
{{char}}的攻击命中了！{{user}}受到 15 点伤害，剩余 HP：{{getvar::hp}}
```

**回合计数**：
```
{{incvar::turn}}
=== 第 {{getvar::turn}} 回合 ===
```

## 全局变量操作

全局变量在所有角色和聊天之间共享。操作函数与局部变量完全对称，名称加上 `global` 前缀。

| 宏 | 说明 | 示例 |
|----|------|------|
| `{{setglobalvar::名称::值}}` | 设置全局变量 | `{{setglobalvar::reputation::neutral}}` |
| `{{getglobalvar::名称}}` | 读取全局变量 | `{{getglobalvar::reputation}}` |
| `{{addglobalvar::名称::值}}` | 加上一个数值 | `{{addglobalvar::total_kills::1}}` |
| `{{incglobalvar::名称}}` | 自增 1 | `{{incglobalvar::day_count}}` |
| `{{decglobalvar::名称}}` | 自减 1 | `{{decglobalvar::energy}}` |

### 使用示例

**跨角色共享的世界状态**：
```
{{setglobalvar::world_time::morning}}
{{setglobalvar::weather::sunny}}
```

不同角色的预设中都可以读取：
```
现在是{{getglobalvar::world_time}}，天气{{getglobalvar::weather}}。
```

**跨对话的累积统计**：
```
{{incglobalvar::total_chats}}
这是你的第 {{getglobalvar::total_chats}} 次对话。
```

## 局部 vs 全局：如何选择

| 场景 | 推荐 | 原因 |
|------|------|------|
| 角色好感度 | 局部变量 | 每个角色独立 |
| HP/MP/状态 | 局部变量 | 属于当前角色的冒险 |
| 全局时间/天气 | 全局变量 | 所有角色共享世界 |
| 玩家成就/统计 | 全局变量 | 跨角色累积 |
| 通用设定偏好 | 全局变量 | 不依赖特定角色 |

## 完整操作对照表

| 操作 | 局部变量 | 全局变量 |
|------|----------|----------|
| 设置 | `{{setvar::key::val}}` | `{{setglobalvar::key::val}}` |
| 读取 | `{{getvar::key}}` | `{{getglobalvar::key}}` |
| 加值 | `{{addvar::key::N}}` | `{{addglobalvar::key::N}}` |
| 自增 | `{{incvar::key}}` | `{{incglobalvar::key}}` |
| 自减 | `{{decvar::key}}` | `{{decglobalvar::key}}` |

## 注意事项

- 读取不存在的变量会返回空字符串，不会报错
- `addvar` 可以传负数来实现减法：`{{addvar::hp::-10}}`
- `setvar` 会覆盖已有的值
- 变量名建议使用英文和下划线，避免特殊字符
- 变量的设置和读取都发生在后端宏替换阶段（发送给 AI 之前）
