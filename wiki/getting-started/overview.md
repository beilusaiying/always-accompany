# 快速开始

## 第一步：添加 AI 服务源

[设置 → AI服务源](beilu:settings/api) → 添加：

| 项目 | 填什么 |
|------|--------|
| 名称 | 随便取，用来区分不同源 |
| 服务地址 | API 地址（如 `https://api.openai.com/v1/chat/completions`） |
| API Key | 服务商给的密钥 |
| 渠道 | 选对应的服务商（OpenAI / Claude / Gemini 等） |
| 模型 | 选一个可用模型 |

保存后，在左栏的模型选择器里确认已选中这个源。详见 [配置 AI 服务源](install.md)。

## 第二步：选角色开始对话

左侧栏点一个角色卡，底部输入框发消息，AI 就会回复。

没有角色？点角色列表上方的「+」创建一个，填个名字就行。

## 第三步：按需求切模式

顶部四个按钮切换模式：

| 模式 | 快捷键 | 干什么用 |
|------|--------|---------|
| 全智能 | Ctrl+1 | 任务看板 + 审批 |
| AIRP | Ctrl+2 | 角色对话（默认） |
| IDE | Ctrl+3 | AI 写代码 + 文件操作 |
| 工作 | Ctrl+4 | 工作流 + 定时任务 |

详见 [模式系统](beilu:wiki/modes/overview.md)。

## 接下来

- 调 AI 回复风格 → 换预设，详见 [预设与参数](first-chat.md)
- 让 AI 记东西 → [记忆系统](beilu:wiki/memory/overview.md)自动工作，也可手动管理
- 加世界观设定 → [编辑界面 Tab2](beilu:editor/worldbook) 写世界书
- 调参数 → 左栏模型参数面板（temperature / top_p 等）
- 用宏 → [宏系统](beilu:wiki/macros/overview.md)在预设里插入动态内容
