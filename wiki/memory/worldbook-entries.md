# 条目与触发机制

世界书条目的完整字段和三种触发模式。条目在[世界书编辑](beilu:editor/worldbook)中创建和管理。

## 条目结构

每个世界书条目由以下字段组成：

### 核心字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **key** | 字符串/数组 | 主关键词，用于触发匹配 |
| **keysecondary** | 字符串/数组 | 辅助关键词，与主关键词配合使用 |
| **content** | 字符串 | 注入给 AI 的信息内容 |

### 触发控制字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **constant** | 布尔 | 是否为常驻条目（每轮注入） |
| **useRegex** | 布尔 | 关键词是否使用正则表达式匹配 |
| **selective** | 布尔 | 是否启用辅助关键词的联合判定 |

### 注入控制字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **position** | 枚举 | 注入位置：before（角色描述前）/ after（角色描述后）/ atDepth（聊天记录指定深度）/ AN / EM |
| **depth** | 数字 | 当 position 为 atDepth 时，指定插入深度（第 N 轮对话前） |

### 概率与节奏字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **probability** | 数字(0-100) | 触发概率，100 表示必定触发 |
| **sticky** | 数字 | 触发后持续注入的轮次数 |
| **cooldown** | 数字 | 触发后冷却的轮次数（冷却期间不再触发） |
| **delay** | 数字 | 匹配后延迟几轮才实际注入 |

### 开关字段

| 字段 | 类型 | 说明 |
|------|------|------|
| **enabled** | 布尔 | 全局启用开关，各角色互通 |
| **boundCharName** | 字符串 | 角色绑定，只在指定角色时生效 |

## 三种触发模式详解

### 1. constant（常驻模式）

```
constant: true
```

条目始终注入，不检查关键词。适用于：
- 基本世界观设定
- 通用行为规则
- 始终需要 AI 知道的信息

### 2. regex（关键词/正则匹配模式）

```
constant: false
useRegex: true/false
selective: true/false
```

根据对话内容匹配关键词来决定是否触发。

**匹配逻辑**：

- `useRegex: false`：关键词作为纯文本匹配（包含即触发）
- `useRegex: true`：关键词作为正则表达式匹配

**selective 的作用**：

- `selective: false`：只看主关键词（key），任一匹配即触发
- `selective: true`：主关键词（key）和辅助关键词（keysecondary）都必须匹配才触发

selective 模式用于精确控制触发条件。例如：key 设为"魔法"，keysecondary 设为"禁忌"，则只有当对话中同时出现"魔法"和"禁忌"时才注入关于禁忌魔法的设定。

### 3. dynamic（动态检查模式）

动态模式不检查对话文本，而是检查记忆表格中的特定值。例如：

- 检查 #0 时空表中"地点"字段是否为"森林"
- 检查 #2 社交表中"好感度"是否超过某个阈值

这允许世界书条目根据角色当前状态动态生效。

## 注入位置详解

### before / after

注入到角色描述（character description）的前方或后方。这些位置距离系统提示词较近，AI 会给予较高的注意力。

### atDepth

注入到聊天记录的指定深度。depth 的含义：

- `depth: 0`：最近一条消息之后
- `depth: 1`：最近一条消息之前
- `depth: N`：第 N 轮对话之前

depth 越小，离最新消息越近，AI 越重视。

### AN / EM

AN（Author's Note）和 EM 是原生的注入位置，由上游框架定义。

## 概率与节奏控制

概率和节奏字段配合使用，可以创造自然的信息出现模式：

**示例：随机事件**
- `probability: 30`、`sticky: 3`、`cooldown: 10`
- 每轮有 30% 概率触发；触发后持续注入 3 轮；然后冷却 10 轮

**示例：延迟伏笔**
- `delay: 5`
- 关键词匹配后，延迟 5 轮再注入，制造"事后才揭示"的效果

## 双开关的交互

```
enabled: true  + boundCharName: ""      → 所有角色都生效
enabled: true  + boundCharName: "Alice"  → 仅角色 Alice 时生效
enabled: false + (任意)                  → 完全不生效
```

enabled 是全局开关，跨角色共享状态。boundCharName 是角色级过滤。两者是 AND 关系。

## 运行链

```
系统构建上下文
    ↓
遍历所有世界书条目
    ↓
对每个条目：
  1. 检查 enabled → false 则跳过
  2. 检查 boundCharName → 不匹配则跳过
  3. 检查 cooldown → 冷却中则跳过
  4. 判断触发模式：
     - constant → 直接通过
     - regex → 匹配对话内容
     - dynamic → 检查记忆表格值
  5. 检查 probability → 随机判定
  6. 检查 delay → 未到则暂不注入
    ↓
通过的条目按 position 和 depth 放入上下文的对应位置
    ↓
更新 sticky / cooldown 计数器
```
