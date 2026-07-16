# 变量系统 (beilu-mvu)

beilu-mvu（Model-View-Update）是 always-accompany 的变量系统插件。它让预设、角色卡和 AI 回复能够读写变量，实现跨轮次的状态追踪。例如角色的好感度、HP、任务进度等动态数值，都可以通过变量系统管理。

## 变量类型

| 类型 | 作用域 | 生命周期 | 宏语法 |
|------|--------|---------|--------|
| 局部变量 | 当前对话 | 对话存续期间 | `{{getvar::名称}}` / `{{setvar::名称::值}}` |
| 全局变量 | 跨对话 | 持久化 | `{{getglobalvar::名称}}` / `{{setglobalvar::名称::值}}` |

## 变量宏

### 读取变量

```
{{getvar::hp}}           → 读取局部变量 hp 的值
{{getglobalvar::score}}  → 读取全局变量 score 的值
```

### 写入变量

```
{{setvar::hp::100}}           → 设置局部变量 hp = 100
{{setglobalvar::score::50}}   → 设置全局变量 score = 50
```

### 数值运算

```
{{addvar::hp::-10}}           → hp 减少 10
{{addglobalvar::score::5}}    → score 增加 5
```

## 管线接口

### GetPrompt

beilu-mvu 的 GetPrompt 接口可以将当前变量状态注入到提示词中，让 AI 了解当前的变量值。

### TweakPrompt

在 TweakPrompt 阶段，beilu-mvu 处理消息中的变量宏替换。

### ReplyHandler

AI 回复到达后，beilu-mvu 解析回复中的变量操作命令（如果 AI 使用了特定的变量操作标签），执行对应的读写操作。

## 与宏系统的关系

beilu-mvu 的变量宏是宏系统的一个子集。变量宏在后端替换阶段（发送给 AI 之前）执行。宏替换引擎 `evaluateMacros` 在遇到变量宏时会调用 beilu-mvu 的读写函数。

详见 [变量宏](../macros/variables.md)。

## 使用场景

| 场景 | 变量示例 |
|------|---------|
| RPG 游戏 | HP、MP、金币、等级 |
| 好感度系统 | 好感度数值、关系阶段 |
| 任务追踪 | 任务状态（进行中/完成）、进度百分比 |
| 计数器 | 对话轮次、事件触发次数 |
| 条件分支 | 根据变量值决定 AI 回复风格 |

## 数据存储

- 局部变量随对话存储
- 全局变量通过 SetData 持久化

## 导航

- [插件概览](overview.md) — 插件系统简介
- [变量宏](../macros/variables.md) — 变量宏语法详解
- [脚本引擎](scripts.md) — 更复杂的逻辑控制
