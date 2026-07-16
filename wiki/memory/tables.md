# 记忆表格(#0-#9)

记忆表格是 always-accompany 记忆系统的核心存储结构。AI 通过 `<tableEdit>` 标签对表格进行 CRUD（增删改查）操作，每张表对应一类信息。不同工作模式（[聊天模式](beilu:mode/chat) / code / [工作模式](beilu:mode/work)）使用不同的表格集。

## chat 模式表格

chat 模式使用 #0 到 #9 共 10 张表：

<div class="wiki-grid wiki-grid-2">
<div class="wiki-card"><div class="wiki-card-title">#0 时空</div><div class="wiki-card-desc">当前时间、地点、场景 — AI 感知"现在在哪、几点了"</div></div>
<div class="wiki-card"><div class="wiki-card-title">#1 角色特征</div><div class="wiki-card-desc">角色的性格、外貌、习惯等 — AI 保持角色一致性</div></div>
<div class="wiki-card"><div class="wiki-card-title">#2 社交</div><div class="wiki-card-desc">人际关系、好感度、互动历史 — AI 理解角色间的关系</div></div>
<div class="wiki-card"><div class="wiki-card-title">#3 任务</div><div class="wiki-card-desc">当前进行中的任务、目标 — AI 跟踪任务进度</div></div>
<div class="wiki-card"><div class="wiki-card-title">#4 临时记忆</div><div class="wiki-card-desc">短期事件、临时状态 — 本次对话中的临时信息</div></div>
<div class="wiki-card"><div class="wiki-card-title">#5 物品</div><div class="wiki-card-desc">持有的物品、道具 — 物品管理</div></div>
<div class="wiki-card"><div class="wiki-card-title">#6 日总结</div><div class="wiki-card-desc">每日总结信息 — 回顾过去发生了什么</div></div>
<div class="wiki-card"><div class="wiki-card-title">#7 关于用户</div><div class="wiki-card-desc">用户的偏好、习惯、个人信息 — AI 了解用户</div></div>
<div class="wiki-card"><div class="wiki-card-title">#8 永远记住</div><div class="wiki-card-desc">重要的、不应遗忘的信息 — 核心设定、重要承诺</div></div>
<div class="wiki-card"><div class="wiki-card-title">#9 时空记忆</div><div class="wiki-card-desc">与时空相关的长期记忆 — 地点关联的回忆</div></div>
</div>

## code 模式表格

code 模式使用 C0 到 C5 共 6 张表，面向编程辅助场景：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">C0</div><div class="wiki-card-desc">项目上下文</div></div>
<div class="wiki-card"><div class="wiki-card-title">C1</div><div class="wiki-card-desc">代码约定与规范</div></div>
<div class="wiki-card"><div class="wiki-card-title">C2</div><div class="wiki-card-desc">当前任务</div></div>
<div class="wiki-card"><div class="wiki-card-title">C3</div><div class="wiki-card-desc">技术栈与依赖</div></div>
<div class="wiki-card"><div class="wiki-card-title">C4</div><div class="wiki-card-desc">问题与解决方案</div></div>
<div class="wiki-card"><div class="wiki-card-title">C5</div><div class="wiki-card-desc">临时笔记</div></div>
</div>

## work 模式表格

work 模式使用 W0 到 W4 共 5 张表，面向工作流场景：

<div class="wiki-grid wiki-grid-3">
<div class="wiki-card"><div class="wiki-card-title">W0</div><div class="wiki-card-desc">工作上下文</div></div>
<div class="wiki-card"><div class="wiki-card-title">W1</div><div class="wiki-card-desc">任务与进度</div></div>
<div class="wiki-card"><div class="wiki-card-title">W2</div><div class="wiki-card-desc">联系人与协作</div></div>
<div class="wiki-card"><div class="wiki-card-title">W3</div><div class="wiki-card-desc">决策记录</div></div>
<div class="wiki-card"><div class="wiki-card-title">W4</div><div class="wiki-card-desc">临时笔记</div></div>
</div>

## AI 如何操作表格

AI 在回复中使用 `<tableEdit>` 标签进行表格操作。系统解析该标签后执行对应的 CRUD 动作：

- **Create**：新增一行记录
- **Read**：查询表格内容（通常通过召回引擎自动完成）
- **Update**：修改已有记录
- **Delete**：删除过时的记录

标签内部使用函数调用式语法（这也是系统注入给 AI 的操作格式）：

```
<tableEdit>
<!--
insertRow(表格编号, {列编号: "值", ...})
updateRow(表格编号, 行编号, {列编号: "新值", ...})
deleteRow(表格编号, 行编号)
-->
</tableEdit>
```

操作由记忆系统的 INJ 指令引导——INJ-1 会告诉 AI 当前模式下可用哪些表、每张表存什么、用什么格式写入。

## 运行链

<div class="wiki-flow">
<div class="wiki-box wiki-box-blue"><b>AI 生成回复</b><small>回复中包含 &lt;tableEdit&gt; 标签</small></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>后端记忆系统解析 &lt;tableEdit&gt; 标签</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>根据表编号定位对应表格文件</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-amber"><b>执行 CRUD 操作写入 hot 层</b></div>
<div class="wiki-arrow">↓</div>
<div class="wiki-box wiki-box-green"><b>下一轮对话时</b><small>hot 层表格内容自动注入上下文</small></div>
</div>

## 表格与三层架构的关系

<div class="wiki-layers">
<div class="wiki-layer wiki-layer-amber">
<span class="wiki-layer-label">hot 热层</span>
当前活跃的表格内容，每轮注入
</div>
<div class="wiki-layer wiki-layer-blue">
<span class="wiki-layer-label">warm 温层</span>
近期但不再活跃的表格条目，按需召回
</div>
<div class="wiki-layer wiki-layer-purple">
<span class="wiki-layer-label">cold 冷层</span>
归档的历史条目，搜索可达
</div>
</div>

表格条目随时间自动从 hot 搬迁到 warm，再到 cold。搬迁由记忆系统的归档管线自动执行。

## 数据表格编辑器

在[记忆管理](beilu:mode/memory)中点击工具栏的 **table** 按钮，或在记忆内容区切换到"表格"子 Tab，可打开数据表格编辑器。

### 表格切换

顶部显示 #0 到 #9（或 C0-C5 / W0-W4，按当前 viewMode）的 Tab 页签，点击切换不同表格。每张表的名称可直接点击编辑。

### 单元格编辑

点击任意单元格进入就地编辑状态，修改后自动保存。列头也可点击编辑，用于调整列名。

### 规则区

表格下方的规则区定义该表的写入规则与格式约束。每张表可独立配置，AI 写入时会参照这些规则。

### 行操作

- **新增行**：在表格底部追加新行
- **删除行**：支持多选批量删除
- **启用/禁用 toggle**：控制表格条目是否参与注入

### 搜索

表格内置搜索功能，可按关键词在当前表格中筛选匹配的行。

### 乐观并发控制

表格编辑采用版本号机制：每次保存时检查版本号，若其他来源（如 AI 的 `<tableEdit>`）已修改表格导致版本不一致，系统会提示冲突，防止覆盖丢失。

### 快照

表格编辑器内可创建当前表格的快照，便于在调整前留存备份。详见[记忆归档与检索](archival.md)中的快照管理部分。

## 注意事项

- 各模式的表格互相独立，切换模式时加载对应的表格集
- 表格编号是固定的，每个编号对应的职能由 INJ-1 指令定义
- AI 写入表格的格式需要符合系统解析要求，否则写入会被忽略
