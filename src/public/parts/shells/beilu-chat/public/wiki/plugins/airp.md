# AIRP 场景渲染（beilu-airp）

AIRP 把 AI 输出的 scene、char、desc 等 DSL 标签渲染成彩色文本、符号画和动态场景。它适合陪伴、角色扮演和互动叙事，不是图片生成器，也不会把数值状态交给模型随意计算。

## 它解决什么

普通角色回复只能依赖 Markdown、HTML 或一张固定背景。AIRP 把“叙事内容”和“确定性状态”分开：

- LLM 负责写场景与叙事标签；
- 确定性代码处理 set、delta、remove 等状态变更；
- 渲染器依据可编辑的能力谱生成 DOM；
- 原始数值指令从展示文本隐藏，状态随消息 extension 保存。

这样可以让场景有表现力，同时避免让模型自己维护不可靠的数值运算。

## 适合与不适合

适合：

- 角色陪伴、文字冒险、游戏叙事；
- 希望给场景、角色位置、情绪和描述增加视觉层次；
- 需要用户可编辑的色板、标签集和动效；
- 想把世界书 / MVU 状态与视觉表现组合。

不适合：

- 需要照片、插画或像素级生成图像；
- 只需要纯文本输出；
- 对动画敏感且不希望任何动态效果；
- 希望 DSL 本身成为不可修改的固定协议。

## 默认与开关

AIRP 的用户 store 默认 enabled=true；插件 Load 时会为有用户上下文的账号自注册。是否已经加载和参与当前对话，应以插件管理和实际消息链为准。

你可以关闭 AIRP 总开关。关闭后，GetPrompt 和 ReplyHandler 不参与；动态效果还可以单独关闭，并尊重系统的 reduced-motion 偏好。

## 可编辑能力谱

AIRP 的有效配置由出厂能力谱与用户差异层合并：

| 区域 | 用途 |
|---|---|
| palette | 语义颜色名到 CSS 色值 |
| tagSpec | 允许的 DSL 标签和属性 |
| dynEffects | glow、rain、flicker 等动效开关 |
| layout | 自适应布局、最小列宽、最大列数与窄屏断点 |
| fallback | 未知标签如何回退 |

配置按用户保存在：

    data/users/<user>/airp/config.json

出厂能力谱与用户差异分开，改单个颜色不应迫使你复制整个默认配置。

## 完整链路

    AIRP 配置 / 可编辑 DSL 引导
      ↓ GetPrompt
    模型输出 scene / char / desc 与 airp-patch
      ↓ ReplyHandler
    确定性代码更新数值状态，隐藏状态命令
      ↓ GetRenderView
    渲染为当前消息的 DOM 视图

渲染产物只进入显示层，不应重新写回 chatLog 充当新的真相源。持久状态放在消息 extension，视觉 DOM 可以重建。

## 与其他插件组合

| 组合 | 效果 |
|---|---|
| worldbook + AIRP | 固定世界设定影响场景标签与表现 |
| MVU + AIRP | 变量状态驱动视觉变化 |
| regex / EJS + AIRP | 在进入渲染前按规则或模板整理内容 |
| memory + P1 + AIRP | 召回旧事件后，用当前场景重新表现 |
| eye / STT + companion + AIRP | 外部输入影响陪伴场景和叙事 |

## 安全与回退

- 色值和标签属性应通过能力谱校验，不要把任意 HTML 当作 DSL；
- 未知标签按 fallback 处理，不应造成整条消息消失；
- 动效应允许关闭，并尊重系统减动效设置；
- 数值状态以确定性操作结果为准，不以模型展示文本为准；
- 出现异常时分别检查原始回复、extension 状态和渲染 DOM，不要只看最终颜色。

## 继续阅读

- [变量系统](mvu.md)
- [脚本引擎](scripts.md)
- [正则增强](regex.md)
- [世界书](../memory/worldbook-overview.md)
- [插件手册](overview.md)
