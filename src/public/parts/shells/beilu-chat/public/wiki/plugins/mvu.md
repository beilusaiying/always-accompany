# 变量系统 (beilu-mvu)

beilu-mvu 是 always-accompany 的**状态追踪引擎**：让角色卡拥有跨轮次的动态状态——好感度、HP、任务进度、关系阶段——AI 每轮都能看到当前状态，也能在回复里更新它。

它兼容社区流行的"世界模拟器 / 好感度卡"写法（JS-Slash-Runner / 酒馆助手生态的 `stat_data` 模式）。

## 先分清：这是哪一套变量系统

always-accompany 里有**两套完全独立的变量系统**，别混：

| | beilu-mvu（本页） | 变量宏（另一套） |
|---|---|---|
| 数据形状 | 一个嵌套对象 `stat_data`（如 `{角色:{好感度:50, 状态:"开心"}}`） | 扁平键值对（`hp=100`） |
| 写入方式 | AI 在回复里输出 `<UpdateVariable>` 更新指令 | 提示词里写 `{{setvar::hp::100}}` 宏 |
| 读取方式 | 变量状态自动注入上下文，AI 直接看到 | 提示词里写 `{{getvar::hp}}` 宏 |
| 谁在用 | "世界模拟器"类角色卡、好感度系统 | ST 老式预设/角色卡的宏写法 |

`{{getvar}}` / `{{setvar}}` / `{{addvar}}` / `{{getglobalvar}}` 这些宏语法**不属于 beilu-mvu**——它们由独立的宏引擎在预设/世界书宏替换阶段处理，详见[变量宏](../macros/variables.md)。两套系统是两个互不相通的变量空间：用宏写的 `hp` 和 `stat_data` 里的 `hp` 是两个不同的东西。

如果你导入的角色卡说明书里出现 `<UpdateVariable>`、`stat_data`、`[InitVar]` 这些词，它用的就是本页这一套。

## 工作原理：一轮对话中变量做了什么

```
对话开始（无变量时）
    ↓
从世界书的 [InitVar] 条目读取初始变量（YAML 格式）
    ↓
每轮发消息前：把当前变量状态注入上下文
（AI 看到类似 <status_current_variables> 的状态面板）
    ↓
AI 回复中带变量更新指令
    ↓
beilu-mvu 解析指令，更新 stat_data，随对话持久化
    ↓
下一轮 AI 看到的就是新状态
```

## AI 怎么更新变量

beilu-mvu 支持三种更新格式（角色卡作者在提示词里教 AI 用哪种）：

**1. `_.set()` 函数式**（简洁）

```
_.set('角色.好感度', 55);
```

**2. `<UpdateVariable>` + JSONPatch**（社区标准写法）

```xml
<UpdateVariable>
<JSONPatch>
[{"op": "replace", "path": "/角色/好感度", "value": 55}]
</JSONPatch>
</UpdateVariable>
```

**3. 独立 `<JSONPatch>` 标签**

JSONPatch 遵循标准 RFC 6902 操作（add / replace / remove 等），并扩展了 `delta` 操作用于数值增减（好感度 +5 这类场景不用先读再写）。

## 给角色卡作者

- **初始变量**放在世界书的 `[InitVar]` 条目里，YAML 格式书写嵌套结构。
- **状态注入**：当前变量以 YAML 状态面板形式注入对话上下文，AI 每轮可见——你的提示词可以直接引用"当前状态"来约束剧情。
- **兼容性**：变量存储兼容 JS-Slash-Runner 的 `mvu_variables` 格式，从 SillyTavern 生态迁移的"世界模拟器"卡通常不需要改造变量部分。

## 使用场景

| 场景 | 变量示例 |
|------|---------|
| RPG 游戏 | HP、MP、金币、等级 |
| 好感度系统 | 好感度数值、关系阶段 |
| 任务追踪 | 任务状态（进行中/完成）、进度百分比 |
| 世界模拟 | 时间、地点、天气、NPC 状态的嵌套结构 |

## 数据存储

变量随对话存储（跟着聊天记录走，回档/分支时变量状态也跟着回去），逐层深度合并——每轮只记录变化，读取时合并出完整状态。

## 导航

- [插件概览](overview.md) — 插件系统简介
- [变量宏](../macros/variables.md) — 另一套变量系统：{{getvar}}/{{setvar}} 宏语法
- [脚本引擎](scripts.md) — 更复杂的逻辑控制
