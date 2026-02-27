# beilu-always accompany 项目总结

> 版本: v1.0
> 日期: 2026-02-21
> 状态: 1.0 正式版 — 核心功能全部完成，已通过完整功能验证

---

## 一、项目定位

**beilu-always accompany** 是一个集成化 AI 交互平台，融合了四大核心能力：

| 能力             | 说明                                                            |
| ---------------- | --------------------------------------------------------------- |
| **IDE**          | VSCode 风格三栏布局，集成文件管理与代码编辑                     |
| **AI 引擎**      | 多 AI 协作架构（聊天 AI + 6 个辅助 AI），commanderMode 消息控制 |
| **原创记忆算法** | 4 层分级记忆系统，参照人类海马体结构与记忆曲线原理设计          |
| **聊天系统**     | 兼容 SillyTavern 预设 / 角色卡 / 世界书格式                     |

### 1.1 核心理念

**让 AI 真正记住。** 记忆是核心，对话只是表层。

当前 LLM 面临两个根本性限制：**上下文窗口有限** 和 **注意力随上下文增长而分散**。本项目的记忆算法通过分层存储、结构化注入和按需检索，直接缓解这两个问题。

### 1.2 记忆算法的设计原理

记忆系统的分层架构参照人类大脑海马体的记忆形成机制与艾宾浩斯遗忘曲线，通过**多 AI 协作 + 分层存储 + 按需检索**，从根本上绕过上下文窗口限制——理论上实现**无限期记忆**。

**纯提示词驱动**：所有记忆操作（注入、提取、归档、总结）均由 AI 通过提示词完成，而非硬编码逻辑。记忆表格的含义和操作方式随时可通过修改提示词调整，无需改动代码。这使得系统天然无技术债务，且用户可自行适配不同使用场景。

#### 三层记忆架构

```
🔥 热记忆层 (Hot) — 每轮注入
   📂 hot/remember_about_user/   — 按日期归档（>400条自动归档至<250条）
   📄 hot/forever.json           — 无上限存储，Top-K 注入 Top-100
   📄 hot/appointments.json      — 未完成任务常驻，完成即归档
   📄 hot/user_profile.json      — 用户画像（永不移出热层）
   📄 hot/items_archive.json     — 物品仓库（按需检索，不每轮注入）
   📄 hot/warm_monthly_index.json — 温层月份索引（供检索 AI 导航）

🌤️ 温记忆层 (Warm) — 按需检索，最近 1 个月
   📂 warm/{year}/{month}/{day}_summary.json    — 日总结
   📂 warm/{year}/{month}/{day}_details/         — 临时记忆归档（10条/文件）
   📄 warm/cold_yearly_index.json               — 冷层年份索引

❄️ 冷记忆层 (Cold) — 深度检索，超过 1 个月
   📂 cold/{year}/{month}/                      — 温层数据迁入
   📄 cold/{year}/{month}/monthly_summary.json   — 月度总结
```

#### 记忆衰减与优先级

借鉴艾宾浩斯遗忘曲线，每条永久记忆携带 `weight`（重要度）和 `last_triggered`（最近触发时间），注入排序公式：

```
score = weight × (1 / (1 + days_since_triggered × 0.1))
```

确保重要且近期触发的记忆优先注入有限的上下文空间，而非简单的时间顺序。

### 1.3 容量与性能计算

#### 热层 Token 开销

| 数据源                      | 估算内容量        | Token 占用               |
| --------------------------- | ----------------- | ------------------------ |
| L0 表格（#0-#9 CSV）        | 10 张表格全量     | ~2,000-4,000             |
| remember_about_user（30天） | 30天 × 5条 × 50字 | ~3,000-5,000             |
| forever.json Top-100        | 100条 × 30字      | ~1,500                   |
| appointments + user_profile | 任务 + 画像       | ~500                     |
| warm_monthly_index          | 月份索引          | ~300                     |
| **热层总注入量**            |                   | **~7,000-11,000 tokens** |

在 128K 上下文窗口中，热层记忆仅占 **5-9%**，剩余 **100K+ tokens** 全部留给当前对话。

#### 注意力集中机制

这是本算法最核心的设计优势。传统方案将全部记忆塞入单个 AI 上下文，导致注意力随上下文增长而急剧分散。本方案通过 **AI 职责分离** 彻底解决：

| AI 角色                             | 上下文内容                 | 上下文长度 | 注意力分布                  |
| ----------------------------------- | -------------------------- | ---------- | --------------------------- |
| **检索 AI**（Gemini 2.0/2.5 Flash） | 用户消息 + 索引文件        | <5K tokens | 100% 专注于**找到相关记忆** |
| **回复 AI**（用户自选模型）         | 精选记忆（~10K）+ 当前对话 | 按需       | 100% 专注于**回复质量**     |

回复 AI 只看到经过检索 AI 筛选后的**精准记忆片段**，而非全量历史。上下文干净、信噪比高，注意力**完全不会发散**。

#### 存储容量估算

记忆系统使用纯 JSON 文件存储，**零数据库依赖、零额外成本**。

假设每日活跃交互产生约 50 条临时记忆（触发 1 次归档）：

| 层级         | 每日新增文件    | 容量        |
| ------------ | --------------- | ----------- |
| 热层         | 固定 ~20 个文件 | 常驻        |
| 温层（30天） | ~7 文件/天      | ~210 文件   |
| 冷层         | 月总结 + 日总结 | ~31 文件/月 |

**按 5,000 个文件/文件夹计算**（普通电脑的文件系统轻松支持）：

```
可用空间 = 5,000 - 200(温层) - 20(热层) = 4,780 文件
冷层增长 = 31 文件/月
可持续时间 = 4,780 ÷ 31 ≈ 154 个月 ≈ 12.8 年
```

**单角色记忆可持续运行超过 12 年**，总存储体积仅约 **5-50 MB**。

实际上文件系统支持的文件数远超 5,000——NTFS 支持 40 亿+、ext4 支持数千万。若按 100,000 文件计算，理论上可持续运行 **260+ 年**。因此在实际使用中，存储容量**可视为无限**。

### 1.4 技术应用前景

记忆算法不局限于角色扮演，其分层存储与按需检索的架构可扩展至：

| 领域          | 应用方式                                              |
| ------------- | ----------------------------------------------------- |
| 大型项目编程  | AI 记住项目架构、历史决策和代码约定，跨会话保持一致性 |
| AI 管理与调度 | 多 AI 协作中的共享记忆池，任务上下文持久化            |
| 长期 AI 陪伴  | 跨越数月乃至数年的对话记忆，关系和偏好的长期积累      |
| AI 游戏       | 持久化游戏世界状态、角色关系、剧情线索                |

### 1.5 技术栈

| 维度     | 说明                                                        |
| -------- | ----------------------------------------------------------- |
| 运行时   | Fount（Deno 后端 + 浏览器前端）                             |
| AI 接入  | 通过 ServiceSource 配置，支持 proxy / gemini 等 14 种生成器 |
| 预设兼容 | SillyTavern 预设格式、角色卡、世界书                        |
| 桌面能力 | Python 桌面截图工具（beilu-eye）                            |

---

## 二、系统架构

### 2.1 三层模式

| 层         | 模式                          | AI 工具注入            | 对话持久性           |
| ---------- | ----------------------------- | ---------------------- | -------------------- |
| **聊天层** | 角色扮演                      | ❌ 不注入工具说明       | ✅ 持久保存           |
| **文件层** | AI 辅助文件操作               | ✅ beilu-files 工具说明 | ❌ 临时（切走即清除） |
| **记忆层** | 记忆查看/编辑 + P1-P6 AI 操作 | ✅ 记忆 AI 独立运行     | ❌ 单次注入           |

### 2.2 两层 AI 系统

- **聊天 AI**：在「聊天层」进行角色扮演 / 在「文件层」通过 beilu-files 修改用户项目文件
- **记忆 AI（P1-P6）**：在「记忆层」工作，操控记忆目录下的温/冷层文件
- INJ-1（tableData 说明）：autoMode=`always`，向聊天 AI 注入表格数据
- INJ-2（文件层 AI 提示词）：autoMode=`manual`，手动开关控制

### 2.3 5 段式消息结构

```
[beforeChat]        — 预设头部, system only, 按 order 排序
[injectionAbove]    — @D>=1 注入, any role, 按 order 排序
[chatHistory]       — 实际对话
[injectionBelow]    — @D=0 注入, any role, 按 order 排序
[afterChat]         — 预设尾部, system only, 按 order 排序
```

数据流：`preset_engine.mjs buildAllEntries()` → `beilu-preset TweakPrompt` → `serviceGenerator StructCall (commanderMode)`

---

## 三、核心模块

### 3.1 beilu 插件体系（11 个插件）

| 插件                | 功能                                            | 关键文件                           |
| ------------------- | ----------------------------------------------- | ---------------------------------- |
| **beilu-preset**    | 预设引擎，5 段式消息构建                        | `plugins/beilu-preset/main.mjs`    |
| **beilu-memory**    | 4 层记忆系统（L0 表格 / L1 热 / L2 温 / L3 冷） | `plugins/beilu-memory/main.mjs`    |
| **beilu-files**     | 文件操作能力（路径安全 + 批准机制）             | `plugins/beilu-files/main.mjs`     |
| **beilu-eye**       | 桌面截图注入（Python 截图 → 前端 files 管线）   | `plugins/beilu-eye/main.mjs`       |
| **beilu-logger**    | 服务器日志收集（console 劫持 + HTTP API）       | `plugins/beilu-logger/main.mjs`    |
| **beilu-toggle**    | 功能开关管理                                    | `plugins/beilu-toggle/main.mjs`    |
| **beilu-agents**    | 多 AI 协作（远期）                              | `plugins/beilu-agents/main.mjs`    |
| **beilu-regex**     | 正则替换（美化系统）                            | `plugins/beilu-regex/main.mjs`     |
| **beilu-worldbook** | 世界书管理                                      | `plugins/beilu-worldbook/main.mjs` |
| **beilu-web**       | 网络搜索能力                                    | `plugins/beilu-web/main.mjs`       |
| **beilu-sysinfo**   | 系统信息注入                                    | `plugins/beilu-sysinfo/main.mjs`   |

### 3.2 Shell 体系

| Shell                   | 功能                                                                                                   | 路径                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **beilu-home**          | 管理首页（角色卡 / 预设 / 世界书 / 记忆 / 人设 / 系统查看器 / 调试 / 日志），支持多语言（中/英/日/繁） | `shells/beilu-home/`          |
| **beilu-chat**          | 聊天界面（三栏 IDE 布局、记忆浏览器、文件操作、图片收发）                                              | `shells/beilu-chat/`          |
| **chat**                | Fount 后端聊天逻辑（含 deleteMessagesRange）                                                           | `shells/chat/`                |
| **serviceSourceManage** | 服务源管理                                                                                             | `shells/serviceSourceManage/` |
| **proxy**               | AI 代理（commanderMode 版）                                                                            | `shells/proxy/`               |
| **install**             | 角色卡导入处理                                                                                         | `shells/install/`             |

### 3.3 ImportHandlers

| Handler         | 功能                                  |
| --------------- | ------------------------------------- |
| **SillyTavern** | ST 格式角色卡 / 预设 / 世界书导入     |
| **Risu**        | Risu 格式导入（ccv3 / charx / rpack） |
| **fount**       | Fount 原生导入（git / zip）           |
| **MCP**         | MCP 协议导入（模板 + 引擎）           |

### 3.4 ServiceGenerators

| 类型          | 可用生成器                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------- |
| **AI**        | proxy, gemini, claude, claude-api, ollama, grok, cohere, blackbox, duckduckgo, notdiamond 等 14 种 |
| **Search**    | google, google-api, brave, duckduckgo 等 8 种                                                      |
| **Translate** | google-translate 等 5 种                                                                           |

---

## 四、记忆系统

> 详细设计见 `beilu_memory_设计文档.md` v4.0
> AI 操作规范见 `beilu_memory_AI操作文档.md` v4.0

### 4.1 四层记忆架构

| 层      | 存储                  | 注入方式                 | 内容                                                          |
| ------- | --------------------- | ------------------------ | ------------------------------------------------------------- |
| L0 表格 | `tables.json` (#0-#9) | 每轮全量注入 CSV         | 时空 / 角色 / 社交 / 任务 / 临时记忆 / 物品 / 总结 / 永远记住 |
| L1 热   | `hot/` 目录           | 每轮注入（Top-K / 全量） | forever / appointments / user_profile / remember_about_user   |
| L2 温   | `warm/` 目录          | 检索 AI 按需读取         | 日总结 / 批次归档 / 月总结（最近 1 个月）                     |
| L3 冷   | `cold/` + `dialogue/` | 检索 AI 导航查找         | 月总结 / 日总结（超过 1 个月）                                |

### 4.2 记忆预设系统

| ID  | 名称             | 触发              | 用途                      |
| --- | ---------------- | ----------------- | ------------------------- |
| P1  | 检索 AI          | auto_on_message   | 多轮深度检索（最多 5 轮） |
| P2  | 表格总结/归档 AI | auto_on_threshold | 临时记忆超阈值归档        |
| P3  | 每日总结 AI      | manual_button     | 日终汇总                  |
| P4  | 热→温转移 AI     | manual_button     | 热层过期记忆移入温层      |
| P5  | 月度总结/归档 AI | manual_or_auto    | 温→冷月总结               |
| P6  | 格式检查/修复 AI | manual_button     | 表格和记忆文件修复        |

### 4.3 注入提示词

| ID    | 名称             | autoMode | 用途                              |
| ----- | ---------------- | -------- | --------------------------------- |
| INJ-1 | dataTable 说明   | always   | 表格 CSV + `<tableEdit>` 操作规则 |
| INJ-2 | 记忆文件操作说明 | manual   | 温/冷层文件操作能力               |

### 4.4 预设加载与导出

#### 三级加载优先级

```
用户已有 _memory_presets.json → 直接加载（已有用户不受影响）
     ↓ 不存在
模板文件 default_memory_presets.json → 复制到用户目录
     ↓ 不存在
代码骨架 DEFAULT_MEMORY_PRESETS → 最终兜底（空提示词）
```

#### 导出安全清洗

| 导出功能              | 清洗内容                                                  | 状态 |
| --------------------- | --------------------------------------------------------- | ---- |
| 预设导出（前端 JSON） | `api_config.source` 清空、`use_custom` 重置               | ✅    |
| 记忆导出（后端 zip）  | `_memory_presets.json` + `_config.json` 中的 API 密钥清除 | ✅    |
| 世界书导出            | 仅含 entries 条目数据                                     | ✅    |

### 4.5 "无需检索"判定

P1 检索 AI 返回结果判定为"无需检索"的条件（满足其一）：

- 包含关键词：`无需检索` / `不需要检索` / `no retrieval` / `no search` / `not needed`
- 返回文本长度 < 5

### 4.6 实施阶段（全部完成）

- ✅ Phase 1：基础骨架（文件系统、表格读写、解析器、API）
- ✅ Phase 2：归档系统（热/温/冷归档、日终 9 步、前端维护按钮）
- ✅ Phase 2.5：提示词系统（P1-P6 + INJ-1/INJ-2 + 宏替换 + 前端管理）
- ✅ Phase 3：检索系统（P1 多轮检索、自动触发、输出解析、token 预算、dialogue 层）
- ✅ Phase 4：前端管理（表格编辑器、管理面板、记忆浏览器、自定义表格）
- ✅ Phase 5：预设解耦 + 导出/导入 + 安全清洗

---

## 五、beilu-eye（桌面截图系统）

> 详细开发日志见 `beilu_worklog_贝露的眼睛.md`

### 5.1 架构

```
[Python 桌面截图工具 beilu_eye.py]
  │ 桌面悬浮球(tkinter 置顶) + Alt+Shift+S + 托盘菜单
  │ mss 截图 → tkinter 框选 → Pillow 裁剪 → 5MB 压缩
  │
  ▼ HTTP POST localhost:1314
[Fount 后端 web_server/endpoints.mjs]
  │ /api/eye/inject → setPendingInjection() (含 mode)
  │ /api/eye/status → getPendingStatus()
  │ /api/eye/consume → consumePendingInjection()
  │
  ▼ 前端轮询
[beilu-chat/index.mjs pollEyeStatus]
  │ 检测到 hasPending + mode=active
  │ consume → 构建 file 对象 → addUserReply(files)
  │
  ▼ 正常消息 + 文件管线（与浏览器上传图片完全相同）
[后端 POST /message → AI 多模态回复]
```

### 5.2 技术栈

| 组件       | 实现             | 说明                               |
| ---------- | ---------------- | ---------------------------------- |
| 系统托盘   | pystray          | 金色 ✦ 图标                        |
| 全局快捷键 | keyboard         | Alt+Shift+S                        |
| 桌面截图   | mss              | DPI 感知，支持高分辨率             |
| 框选裁剪   | tkinter Canvas   | 拖拽选区 + 遮罩 + PhotoImage 防 GC |
| 桌面悬浮球 | tkinter Toplevel | 44px 金色圆形置顶无边框窗口        |
| HTTP 通信  | urllib.request   | base64 编码 + 5MB 压缩             |
| 自启动     | beilu-eye 插件   | 模块 import 时 3 秒延迟自启动      |

### 5.3 关键设计决策

- 截图走前端 files 管线（非 GetPrompt），避免被 P1 记忆 AI 提前消费
- Python 替代 Electron（Chromium 在目标系统上存在 0xC0000005 崩溃）
- 模块顶层自启动（shallowLoadDefaultPartsForUser 只 import 不调 Load）

---

## 六、美化系统

> 详细日志见 `beilu_worklog_美化系统.md`

### 6.1 渲染管线

| 功能             | 状态 | 说明                                                            |
| ---------------- | ---- | --------------------------------------------------------------- |
| 正则替换         | ✅    | CRUD / 测试 / 导入导出 / 角色卡绑定                             |
| 正则按角色分组   | ✅    | scoped/preset 规则按角色过滤，"显示全部"折叠分组，新建自动绑定  |
| 思维链折叠       | ✅    | `<details>` 默认折叠 + CSS max-height                           |
| HTML iframe 渲染 | ✅    | 检测 full-html → iframe 沙箱渲染                                |
| ST API 注入      | ✅    | base64 编码原始消息注入 iframe bridgeScript，解决自定义标签丢失 |
| 正则引擎对齐     | ✅    | 前端 `computeReplacement` + 后端 `runRegex` 对齐酒馆回调模式    |
| 渲染器开关       | ✅    | localStorage `beilu-renderer-enabled`                           |
| 渲染深度设置     | ✅    | 只渲染最近 N 楼 `beilu-render-depth`                            |
| 代码折叠         | ✅    | 折叠代码块，支持全部/仅前端模式                                 |
| 流式渲染         | ✅    | 流式输出时 500ms 间隔更新 iframe                                |
| 思维链节流       | ✅    | StreamRenderer MIN_RENDER_INTERVAL = 80ms                       |
| 聊天宽度滑块     | ✅    | 30%-100% 可调，localStorage 持久化                              |
| vh 全局替换      | ✅    | iframe 内所有 CSS vh 单位替换为浏览器视口等效值                 |

### 6.3 iframe 数据注入（ST API 兼容）

角色卡美化 HTML 通过 `<div id="st-data-injection">$1</div>` 注入游戏数据。`$1` 被正则捕获组替换后，其中的自定义 HTML 标签（如 `<content>`、`<status>`）会被浏览器 DOM 解析为 HTMLUnknownElement，导致 Vue 通过 `innerText` 读取时标签本身丢失。

**解决方案**：在 iframe 的 bridgeScript 中注入 SillyTavern 兼容 API，将原始消息文本通过 base64 编码传入。角色卡优先走 ST API 路径获取完整原始字符串（与酒馆行为一致），绕过 DOM 解析导致的标签丢失。

### 6.4 图片处理

| 功能         | 实现文件                 | 说明                                     |
| ------------ | ------------------------ | ---------------------------------------- |
| 格式检测修正 | `imageProcessing.mjs`    | magic bytes 检测实际格式，修正 mime_type |
| 图片压缩     | `imageProcessing.mjs`    | >5MB 自动压缩（sharp 优先，Python 回退） |
| 多开场白     | `usage.mjs` + `chat.mjs` | 角色卡编辑多开场白 + swipe 切换          |

---

## 七、关键技术决策汇总

| #   | 决策                                        | 理由                                        |
| --- | ------------------------------------------- | ------------------------------------------- |
| 1   | 5 段式消息结构替代 ST 的 depth 系统         | 简化注入逻辑，清晰分段                      |
| 2   | 日终归档手动触发                            | 避免超时 / API 失败丢数据                   |
| 3   | P1 异步非阻塞（结果下轮注入）               | 不影响用户体验                              |
| 4   | #8 forever Top-K 活跃注入                   | 避免无关永久记忆浪费 token                  |
| 5   | 预设配置全局化                              | P1-P6 + INJ 存 `_global/`，表格按角色分     |
| 6   | 热记忆通过 `{{hotMemory}}` 宏控制           | 删除硬编码注入，用户完全可控                |
| 7   | P1 防重复触发（p1TriggeredForCurrentReply） | 流式 ReplyHandler 多次调用问题              |
| 8   | INJ-2 autoMode 改为 manual                  | file 模式自动启用不可靠                     |
| 9   | 文件模式退出彻底删除相关消息                | 文件操作对话对后续聊天无价值                |
| 10  | 记忆独立于对话                              | 开新对话记忆不变，绑定角色卡                |
| 11  | 截图走 files 管线而非 GetPrompt             | 避免被 P1 记忆 AI 提前消费                  |
| 12  | Python 替代 Electron 桌面截图               | Chromium 系统级崩溃无法修复                 |
| 13  | beilu-eye 模块顶层自启动                    | shallow load 不调 Load()                    |
| 14  | i18n 采用"翻译覆盖"方案而非重写             | 不破坏现有代码结构，通过 data-i18n 属性覆盖 |
| 15  | 预设三级加载（用户 > 模板 > 骨架）          | 解耦硬编码，用户修改不被代码更新覆盖        |
| 16  | 导出清洗 API 密钥和服务源信息               | 安全：导出文件不含任何敏感配置              |
| 17  | 正则引擎对齐酒馆回调模式                    | 原生 replace 的 `$$`/`$&` 会破坏美化 HTML   |
| 18  | iframe 注入 ST API（base64 原始消息）       | 解决自定义 HTML 标签被 DOM 解析丢失的问题   |
| 19  | 字体控制统一到 home 端 class 切换           | CSS 变量方案在 iframe 嵌套中不可靠          |

---

## 八、目录结构

```
beilu-always accompany/
├── run.bat / run.sh             ← 启动脚本
├── deno.json                    ← Deno 配置
├── desktop-eye/                 ← Python 桌面截图工具
│   ├── beilu_eye.py             ← 主程序（截图 + 悬浮球 + 托盘）
│   └── renderer/                ← Electron 遗留文件（已弃用）
├── data/
│   ├── config.json              ← HTTP:1314, defaultParts（11 个插件）
│   ├── beilu-files-settings.json ← 文件操作安全设置
│   └── users/
│       ├── _default/            ← 默认记忆模板
│       │   └── chars/_global/memory/  ← 记忆预设 + 默认表格
│       └── {username}/          ← 用户数据目录
│           ├── settings/        ← parts_config / parts_init / char_data
│           ├── serviceSources/AI/ ← AI 服务源配置
│           ├── personas/        ← 用户人设
│           └── chars/           ← 角色卡数据
│               ├── _global/memory/ ← 全局记忆预设（P1-P6 + INJ）
│               └── {charName}/
│                   ├── chats/   ← 该角色的聊天记录
│                   └── memory/  ← 该角色的记忆数据
│                       ├── _config.json
│                       ├── _memory_presets.json
│                       ├── tables.json
│                       ├── hot/
│                       ├── warm/
│                       └── cold/
├── src/
│   ├── decl/                    ← TypeScript 类型声明
│   ├── scripts/                 ← 后端工具脚本（12 个）
│   ├── server/                  ← 后端核心（修改版）
│   │   ├── auth.mjs             ← 自动登录
│   │   ├── base.mjs             ← 去 SW / Sentry / 更新
│   │   ├── parts_loader.mjs     ← 模块加载器
│   │   └── web_server/
│   │       ├── endpoints.mjs    ← eye API 端点 + verifycode stub
│   │       └── index.mjs        ← 主路由
│   └── public/
│   ├── locales/             ← 20 个语言文件（Fount 框架级）
│       ├── pages/               ← 前端公共脚本和样式
│       └── parts/
│           ├── shells/          ← 6 个 shell
│           ├── plugins/         ← 11 个 beilu 插件
│           ├── serviceGenerators/ ← AI / Search / Translate 生成器
│           ├── ImportHandlers/  ← SillyTavern / Risu / fount / MCP
│           └── personas/        ← 人设管理模块
└── default/                     ← 默认配置模板
```

---

## 九、前端页面结构

### 9.1 beilu-home（管理首页）

**多语言支持**：zh-CN（默认）/ en-UK / ja-JP / zh-TW，通过 `i18n.mjs` + `data-i18n` 属性实现翻译覆盖，语言偏好存储在 `localStorage('beiluHomeLang')`。

**字体大小控制**：5 级字体选择（最小 11px / 小 12px / 中 14px / 中大 15px / 大 16px），通过 `html` 元素 class 切换控制 `font-size`，直接影响所有 `rem` 单位。统一由 home 端管理，chat 端通过 rem 继承自动生效。

导航项（11 个标签）：

- 📋 使用（角色卡管理 — 网格展示 + 导入 + 新建 + 编辑 + 删除 + 附属资源提取）
- 🌍 世界书管理
- 📝 聊天预设
- 🧠 记忆预设（P1-P6 + INJ-1/INJ-2 + 检索配置 + 宏参考 + 导出/导入）
- 📊 记忆管理（表格编辑器 + 维护面板）
- 👤 用户人设（多人设管理 — 新建 / 编辑 / 删除 / 搜索）
- 📖 系统查看器（内置文档）
- ⚙️ 系统设置（AI 源配置 + 功能插件开关）
- 🐛 调试面板（伪发送预览）
- 📜 服务器日志（beilu-logger 实时日志查看）
- 🔬 AI 诊断（记忆 AI 运行输出 + 注入状态 + P1 缓存查看）

### 9.2 beilu-chat（聊天界面）

三栏 IDE 布局：

- **左栏**：预设管理 + 世界书绑定 + 人设选择 + 角色快捷编辑
- **中栏**：聊天 / 文件 / 记忆 三标签切换
  - 聊天 Tab：消息流 + 记忆 AI 输出面板
  - 文件 Tab：IDE 文件编辑器
  - 记忆 Tab：P2-P6 操作 + 记忆文件浏览器 + 导入导出
- **右栏**：角色信息 + 功能开关（渲染器 / 代码折叠 / 流式渲染 / 渲染深度 / 聊天宽度） + 记忆 AI 操作（P2-P6 手动按钮）

### 9.3 前端模块清单（beilu-chat）

| 模块         | 文件                   | 职责                                         |
| ------------ | ---------------------- | -------------------------------------------- |
| 聊天核心     | `chat.mjs`             | 消息发送 / 接收 / 编辑 / 删除                |
| 流式输出     | `stream.mjs`           | WebSocket 流式接收                           |
| 布局管理     | `layout.mjs`           | 三栏布局 + 功能开关绑定                      |
| 消息渲染     | `displayRegex.mjs`     | 正则替换 + HTML / markdown 检测              |
| 图片处理     | `imageProcessing.mjs`  | 格式检测 + 压缩（后端）                      |
| 文件浏览器   | `fileExplorer.mjs`     | IDE 文件树                                   |
| 文件编辑     | `files.mjs`            | 文件创建 / 编辑 / 删除                       |
| 记忆浏览器   | `memoryBrowser.mjs`    | 记忆文件查看 / 导入导出                      |
| 记忆预设     | `memoryPresetChat.mjs` | P2-P6 手动操作面板                           |
| 数据表格     | `dataTable.mjs`        | 记忆表格编辑器                               |
| API 配置     | `apiConfig.mjs`        | AI 源选择 / 参数调整                         |
| 正则编辑器   | `regexEditor.mjs`      | 正则脚本 CRUD / 测试 / 导入导出              |
| 提示词查看器 | `promptViewer.mjs`     | 完整提示词预览                               |
| UI 子模块    | `ui/*.mjs`             | 消息列表 / 输入框 / 侧边栏 / 拖拽 / 模态框等 |

---

## 十、宏变量支持

| 宏                    | P1-P6 | INJ | 预览 | 说明                 |
| --------------------- | ----- | --- | ---- | -------------------- |
| `{{tableData}}`       | ✅     | ✅   | ✅    | 全部表格 CSV 数据    |
| `{{hotMemory}}`       | ✅     | ✅   | ✅    | 热记忆层文件内容     |
| `{{char}}`            | ✅     | ✅   | ✅    | 角色名               |
| `{{user}}`            | ✅     | ✅   | ✅    | 用户名               |
| `{{current_date}}`    | ✅     | ✅   | ✅    | 当前日期             |
| `{{chat_history}}`    | ✅     | ✅   | 占位 | 最近对话记录         |
| `{{lastUserMessage}}` | ✅     | ✅   | 占位 | 最后用户消息         |
| `{{time}}`            | ✅     | ✅   | ✅    | 当前时间             |
| `{{date}}`            | ✅     | ✅   | ✅    | 当前日期（本地格式） |
| `{{weekday}}`         | ✅     | ✅   | ✅    | 星期几               |
| `{{idle_duration}}`   | ✅     | ✅   | 占位 | 距上次消息的时间     |
| `{{lasttime}}`        | ✅     | ✅   | 占位 | 最后消息时间         |
| `{{lastdate}}`        | ✅     | ✅   | 占位 | 最后消息日期         |

---

## 十一、相对于干净 Fount 的修改文件

### 服务器端

| 文件                              | 修改性质                                      |
| --------------------------------- | --------------------------------------------- |
| `server/base.mjs`                 | 去 SW / Sentry / 更新 / 愚人节                |
| `server/auth.mjs`                 | 自动登录                                      |
| `server/index.mjs`                | 移除 Sentry                                   |
| `server/server.mjs`               | 移除 Tray / DiscordRPC / AutoUpdate           |
| `server/info.mjs`                 | 品牌名 + 移除节日彩蛋                         |
| `server/autoupdate.mjs`           | 空 stub                                       |
| `server/parts_loader.mjs`         | doProfile stub + 移除 git                     |
| `server/web_server/index.mjs`     | 移除 Sentry + sentrytunnel                    |
| `server/web_server/endpoints.mjs` | verifycode stub + PoW disabled + eye API 端点 |

### 客户端

| 文件                            | 修改性质      |
| ------------------------------- | ------------- |
| `pages/base.mjs`                | SW 注销       |
| `pages/scripts/i18n.mjs`        | 移除 Sentry   |
| `pages/scripts/toast.mjs`       | 移除 Sentry   |
| `ImportHandlers/fount/main.mjs` | 移除 git 操作 |

### Shell 修改

| 文件                                           | 修改性质                                           |
| ---------------------------------------------- | -------------------------------------------------- |
| `shells/chat/src/chat.mjs`                     | 移除 achievements + deleteMessagesRange + fakeSend |
| `shells/chat/src/endpoints.mjs`                | deleteMessagesRange 路由 + fake-send 路由          |
| `shells/serviceSourceManage/src/actions.mjs`   | 移除 achievements                                  |
| `shells/serviceSourceManage/src/endpoints.mjs` | 移除 achievements                                  |
| `shells/serviceSourceManage/src/manager.mjs`   | 合并保存 + config shell import 替换                |
| `serviceGenerators/AI/gemini/main.mjs`         | commanderMode 版                                   |
| `serviceGenerators/AI/proxy/main.mjs`          | commanderMode 版                                   |
| `serviceGenerators/AI/proxy/display.mjs`       | 模型选择器                                         |

---

## 十二、已知问题

| 问题                    | 严重度 | 状态                              |
| ----------------------- | ------ | --------------------------------- |
| i18n 500 错误           | 🟢      | 未解决，非致命，有 try-catch 处理 |
| 世界书条目高亮 CSS 泄漏 | 🟢      | 未解决，待后续确认                |

---

## 十三、工作日志索引

| 日志文件                                    | 内容                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `beilu_worklog_永伴构建.md`                 | 项目完整构建日志（压缩版），从 Fount 采购到 beilu 模块注入          |
| `beilu_memory_设计文档.md`                  | 记忆系统设计文档 v4.0（Phase 1-4 全部完成）                         |
| `beilu_memory_AI操作文档.md`                | 记忆系统 AI 操作规范 v4.0                                           |
| `beilu_worklog_记忆框架制作.md`             | 记忆前端框架：导入导出 zip、P2-P6 手动按钮                          |
| `beilu_worklog_P1多轮检索与文件模式隔离.md` | P1 多轮深度搜索 + 文件模式上下文隔离                                |
| `beilu_worklog_系统查看器与聊天诊断.md`     | 空气泡诊断修复 + 热记忆硬编码修复 + 预设全局化 + P1 防重复 + 时间宏 |
| `beilu_worklog_记忆AI操作.md`               | P2 描述修正 + 自动触发补完 + 手动按钮                               |
| `beilu_worklog_层级权限与插件配置.md`       | 三层模式设计 + beilu-files 可展开配置面板                           |
| `beilu_worklog_世界书与人设.md`             | 世界书绑定 + 用户人设管理（方案设计 + 实现）                        |
| `beilu_worklog_角色卡绑定.md`               | 角色卡导入时自动提取正则/世界书并绑定                               |
| `beilu_worklog_贝露的眼睛.md`               | 桌面截图系统完整开发日志（9 轮迭代）                                |
| `beilu_worklog_美化系统.md`                 | 渲染管线 6 项增强（开关 / 深度 / 折叠 / 节流 / 流式渲染）           |
| `beilu_worklog_美化与开场白.md`             | 多开场白 + iframe ST API 注入 + 正则引擎对齐（10 轮完整诊断）       |
| `beilu_worklog_国际化.md`                   | beilu-home 多语言支持实现（i18n 模块 + 4 语言文件 + DOM 翻译覆盖）  |
| `beilu_worklog_预设解耦.md`                 | 预设三级加载 + 宏替换修复 + "无需检索"判定优化                      |
| `beilu_worklog_正则条目绑定.md`             | 正则规则按角色分组管理（前端过滤 + 新建自动绑定 + 折叠分组）        |
| `beilu_worklog_聊天界面优化.md`             | vh 全局替换 + 消息宽度 + 聊天宽度滑块                               |
| `beilu_worklog_字体比例修复.md`             | 字体控制统一到 home 端 5 级 class 切换                              |
| `项目和修改汇报.md`                         | 变更记录：模型选择器、DryRun、serviceSourceManage 修复等            |
| `AGENTS(与你之诗).md`                       | 模块说明文档                                                        |
| `参考项目分析与功能对标.md`                 | JS-Slash-Runner / st-memory-enhancement / APT 对标分析              |

---

## 十四、已完成的原远期目标

| 功能                           | 状态 | 说明                                  |
| ------------------------------ | ---- | ------------------------------------- |
| JS-Slash-Runner 渲染引擎       | ✅    | 已完成，效果优于原 displayRegex       |
| st-memory-enhancement 表格增强 | ✅    | 已完成                                |
| 多 AI 协作                     | ✅    | 已完成（记忆 AI + 回复 AI 协作体系）  |
| AI 引擎（代码编辑能力）        | ✅    | 已完成（内置 IDE 文件编辑与 AI 操作） |

## 十五、远期规划

### 近期

| 功能            | 说明                       |
| --------------- | -------------------------- |
| APT 条目切换    | 增强 beilu-toggle          |
| Vector DB / RAG | 语义检索，增强记忆检索精度 |
| Embedding API   | 以 OpenAI embedding 为主   |

### 中远期愿景

| 方向                 | 说明                                                             |
| -------------------- | ---------------------------------------------------------------- |
| 跨平台 Bot 接入      | 接入 Discord 等平台，作为 Bot 运行                               |
| 插件生态（创意工坊） | 支持第三方插件安装，类似创意工坊的高拓展性                       |
| Live2D 集成          | 接入 Live2D 模型 + AI 实时操控模型表情/动作                      |
| AI 游戏引擎          | 对话界面可用代码构建 AI 游戏（代码兼容、功能多样、油猴脚本有效） |
| TTS / 文生图         | 接入语音合成和文本生图能力                                       |
| VSCode 扩展兼容      | 支持使用 VSCode 扩展插件                                         |
| 本体高拓展性         | 架构层面保持开放，支持用户深度自定义                             |

### 项目愿景

**一个陪伴与工作一体的 AI 伴侣平台。**

不仅是聊天工具或编程助手，而是一个创新的综合 AI 平台——融合持久记忆、多 AI 协作、IDE 能力、桌面感知、高拓展性插件生态，旨在开启一个新的 LLM 使用时代。

---

*此文档综合了 beilu-always accompany 项目截至 2026-02-21 的所有工作日志、设计文档和代码分析。如需详细了解某个模块，请参考对应的工作日志文件。*
