# 插件开发与接入

always-accompany 的插件系统允许你编写自定义插件来扩展功能。插件通过标准化的接口参与[消息管线](message-pipeline.md)，可以向 AI 注入提示词、处理 AI 回复、注册自己的 HTTP 端点、提供配置面板。

本页两部分：**怎么做插件**（结构、生命周期、接口）和**怎么链接**（接入对话管线、接入前端、接入外部应用）。

## 三条路，选一条

给 AI 加新能力，不是只有"写插件"一条路。先看你手头有什么，再决定往下怎么读：

| 你手头有什么 | 选哪条路 | 要不要写代码 | 大概多久跑通 |
|---|---|---|---|
| 一个别人已经做好的 MCP 服务器（天气查询、数据库、浏览器自动化……网上搜"xxx MCP server"通常都有现成的） | **MCP 接入** | 不用 | 5 分钟（粘一段 JSON） |
| 一个你自己写的 Python / Node 脚本，想让 AI 能"看到"它算出来的东西 | **用户级插件宿主** | 只写你自己的脚本，插件框架不用碰 | 10~20 分钟 |
| 要深度参与对话——改提示词组装结构、拦截并解析 AI 回复里的自定义标签、注册自己的设置面板 | **内建插件** | 要写标准插件三件套 | 半小时起 |

记一句话就够：**能粘 JSON 解决就别写代码，能写一个独立脚本解决就别碰插件框架。**

### 路径一：MCP 接入 —— 零代码，粘 JSON 就行

1. 进入编程模式，点活动栏的 **mcp** 按钮，打开 MCP 面板
2. 把服务器的 JSON 配置粘进去，比如一个文件系统访问的 MCP 服务器：

   ```json
   {
     "mcpServers": {
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/你的/文件夹/路径"]
       }
     }
   }
   ```

3. 这是"命令型"服务器（配置里有 `command`），导入后不会立刻启动——面板会弹一张确认卡片，写清楚它要在你电脑上跑什么命令，你点**批准**，它才会真正启动
4. 批准后，AI 立刻就能用这个服务器提供的工具，不用重启

远程型服务器（配置里是 `url` 而不是 `command`）导入后直接可用，无需批准。完整的安全模型（为什么要批准、环境变量怎么控制、防伪装机制）看 [MCP 外部工具](../yonban/mcp.md)。

### 路径二：用户级插件宿主 —— 你有一个脚本，想让 AI 调用它

不用学插件框架的三件套，把脚本丢进你的用户目录、写一个几行的清单文件就行。

1. 找到你的用户插件目录（没有就自己建一个）：`data/users/<你的用户名>/user-plugins/`
2. 在里面新建一个子目录，比如 `hello/`，放两个文件：

   `plugin.json`（清单）：
   ```json
   {
     "id": "hello",
     "name": "Hello 插件",
     "runtime": { "type": "python", "entry": "main.py" }
   }
   ```

   `main.py`（你的脚本）：
   ```python
   import sys, time, json, urllib.request

   # 宿主启动脚本时会传 --port <本插件端口> --main-port <主程序端口> --token <认证令牌>
   args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
   main_port, token = args.get("--main-port", "1314"), args.get("--token", "")

   def push(content):
       req = urllib.request.Request(
           f"http://127.0.0.1:{main_port}/api/user-plugins/hello/push",
           data=json.dumps({"content": content}).encode(),
           headers={"Content-Type": "application/json", "X-Plugin-Token": token},
           method="POST")
       urllib.request.urlopen(req)

   push("Hello from my Python plugin!")
   while True: time.sleep(60)  # 常驻进程，之后可以按需再 push
   ```

3. 回到插件管理面板，点**重新加载**——宿主会重新扫描 `user-plugins/` 目录并拉起你的脚本，**不需要重启整个服务**
4. 下一轮对话，AI 的提示词里就会看到 `[用户插件 hello]\nHello from my Python plugin!`

完整的运行机制、安全提醒（本地放行 / 多用户部署需 owner 显式开启）见本页下方「用户插件 (beilu-plugin-host)」一节。

### 路径三：内建插件 —— 深度参与消息管线

要拦截 AI 回复、维护自己的持久化配置、注册前端设置面板，就要写一个标准插件了。三个文件起步，往下翻到「一、怎么做插件」看完整结构。

**5 分钟最小骨架**（改自内置插件 beilu-sysinfo，砍掉了缓存/持久化，只留最核心的注入逻辑）：

```javascript
// main.mjs
import info from "./info.json" with { type: "json" };

export default {
  info,
  interfaces: {
    chat: {
      GetPrompt: async () => ({
        text: [{ content: "现在是学习时间，请多鼓励用户。", important: 0 }],
      }),
    },
  },
};
```

把这个 `main.mjs`，加上 `beilu-part.json`（`{"type":"plugins","dirname":"my-plugin"}`）和 `info.json`（本地化展示信息），三个文件放进 `plugins/my-plugin/`，重启服务，AI 每一轮都会看到这句话。往下看「一、怎么做插件」了解完整的生命周期钩子和管线接口。

## 插件能做什么（4 个管线阶段一览）

写内建插件前，先知道你能插手对话的哪些环节：

| 阶段 | 你在这里能干什么 |
|---|---|
| **GetPrompt**（回复前注入） | 往 AI 即将看到的提示词里塞内容——说明文字、动态数据（时间/系统状态/查询结果）、工具清单 |
| **TweakPrompt**（组装后改写） | 提示词已经拼好之后直接修改结构——重排消息顺序、读其他插件塞的数据、做最终微调 |
| **ReplyHandler**（回复后解析） | AI 回复出来之后，解析你自定义的标签（比如 `<my-tag>...</my-tag>`），执行动作，还能让 AI 重新生成 |
| **HTTP 端点**（前端通信） | 注册自己的 `config/getdata` / `config/setdata` 或任意路径，给前端设置面板、按钮提供后端逻辑 |

这四个阶段的完整签名和时序，看下面「二、怎么链接：接入对话管线」。

## 一、怎么做插件

### 目录结构

一个插件的最小目录结构：

```
plugins/my-plugin/
├── beilu-part.json    ← 部件清单（必需，发现机制只认它）
├── info.json          ← 本地化展示信息（必需）
└── main.mjs           ← 插件入口（必需）
```

### beilu-part.json（部件清单）

部件树的发现机制**只扫描 `beilu-part.json`**。目录里有 `main.mjs` 但没有此清单时，插件不会进入部件枚举，且后端会打出 `orphan_part_no_manifest` 告警。

```json
{
  "type": "plugins",
  "dirname": "my-plugin"
}
```

- `type`：部件类型路径（插件固定为 `plugins`）
- `dirname`：目录名，必须与实际目录一致

### info.json（展示信息）

按语言键组织的本地化信息，供插件列表/详情页展示：

```json
{
  "zh-CN": {
    "name": "我的插件",
    "avatar": "https://api.iconify.design/mdi/puzzle.svg",
    "description": "一句话描述",
    "description_markdown": "**详细描述**，支持 Markdown。",
    "version": "0.1.0",
    "author": "你的名字",
    "tags": ["标签"]
  },
  "en-UK": { "name": "My Plugin", "description": "..." }
}
```

### main.mjs（入口）

导出一个包含生命周期钩子和 interfaces 的对象：

```javascript
export default {
  info,                // 通常 import info.json
  Init,                // 可选：安装初始化（每用户一次性）
  Load,                // 可选：每次运行时加载
  Unload,              // 可选：卸载（进程内移除）
  Uninstall,           // 可选：删除插件时清理
  interfaces: {
    chat: {
      GetPrompt,       // 注入提示词
      TweakPrompt,     // 调整已组装的 prompt_struct
      ReplyHandler,    // 处理 AI 回复（可触发重新生成）
    },
    config: {
      GetData,         // 读取配置/状态
      SetData,         // 写入配置/触发动作
    },
  },
};
```

### 生命周期与时序

由 `server/parts_loader.mjs` 驱动，顺序是固定的：

```
Init({ router, username })   ← 每用户 install-once（parts_init 记录门）
  ↓
Load({ router, username })   ← 每次运行时首次加载
  ↓
interfaces.config.SetData(已保存的配置)   ← 框架回灌 parts_config 持久化配置
```

要点：

- **SetData 在 Load 之后**——`Load` 内部拿不到框架注入的持久化配置，依赖配置的初始化要放在 SetData 里或惰性执行。
- `Init` 只在安装后第一次加载时执行一次（磁盘 `parts_init` 记录）；worker isolate 里则每 isolate 各执行一次（内存门）。
- 启动时框架先**浅加载**（只 `import` 暖模块缓存，不跑钩子），再后台**全量预载**（完整生命周期）；用户请求路径上懒加载兜底。
- 内置插件放进 `plugins/` 目录即自动注册为默认插件（`plugins/main.mjs` 容器在 Load 时扫描全部含 `main.mjs` 的子目录）；加载失败的插件不会被注册（防脏条目复活）。
- **热重载 = 重启进程**（Deno 不支持单文件 ESM 卸载），改完代码要重启服务才生效。
- 拿到的插件引用是惰性代理（FullProxy），重载后旧引用自动指向新实例。

## 二、怎么链接：接入对话管线

对话每一轮，管线按固定顺序触碰插件的 `interfaces.chat` 三个钩子。参与方式：把插件放进 `plugins/`（自动注册后即参与），无需额外配置。

### GetPrompt —— 回复前注入

所有插件的 GetPrompt **并发发起、统一 await**，返回值进 `prompt_struct.plugin_prompts[插件名]`。

**签名**：`GetPrompt(args)`（args = chatReplyRequest，含 `chatid` / `username` / `chat_log` 等）

**返回值**：

```javascript
{
  text: [
    { content: "提示词文本", important: 0 }   // 按 important 排序后进「插件」段
  ],
  additional_chat_log: [],   // 可选：追加进聊天记录段的条目
  extension: {},             // 可选：插件间传递的数据（不直接发给 AI）
}
```

### TweakPrompt —— 组装后调整

所有 GetPrompt 完成后按 `detail_level` 轮数执行（默认 3 轮，dl = 2 → 1 → 0），每轮内各插件并发。

**签名**：`TweakPrompt(args, prompt_struct, my_prompt, detail_level)`

- `prompt_struct`：完整提示词结构（可直接修改）
- `my_prompt`：本插件在 GetPrompt 阶段的返回值
- 返回值：无（直接改 `prompt_struct`）

典型分轮用法：dl=2 读其他插件的 extension → dl=1 重组消息序列 → dl=0 最终调整。

### ReplyHandler —— 回复后处理

AI 回复到达后，在重新生成循环里**逐插件串行**调用。

**签名**：`ReplyHandler(result, { ...args, prompt_struct, AddLongTimeLog })`

- `result`：回复对象，改 `result.content` 即修改回复内容（`content_for_show` 是展示层文本）
- `AddLongTimeLog(entry)`：把工具调用轨迹寄生到本条消息上落盘（跨轮可见）
- **返回值：truthy = 触发重新生成**（regen 循环无次数上限，由你的语义控制终止）；falsy = 放行
- 单插件抛异常会被隔离跳过，不中断其他插件的 ReplyHandler

典型用法：解析 AI 回复中的自定义标签 → 执行操作（文件读写、变量设置）→ 结果通过下一轮 GetPrompt 注入。

### 插件间通信

插件之间不直接 import，通过 `prompt_struct` 的 extension 字段间接传递：

1. 插件 A 在 GetPrompt 返回值里写 `extension.my_data`
2. 插件 B 在 TweakPrompt 阶段读 `prompt_struct.plugin_prompts['plugin-a'].extension.my_data`

### 模式管线（进阶）

生成走 ModeDef 管线（chat/code/work 等模式各一条）。已迁入管线菜单的插件由 dispatch 按模式派发，菜单外插件走直调——**新插件默认直调即可参与所有模式**，不需要注册进管线菜单。

## 三、怎么链接：接入前端

### 自注册 HTTP 端点

`Init` / `Load` 收到的 `router` 是插件专属的 Express 路由器，挂载在：

```
/(api|ws|virtual_files)/parts/plugins:<插件名>/<你注册的路径>
```

例如插件里 `router.post('/config/setdata', handler)`，前端就请求 `POST /api/parts/plugins:my-plugin/config/setdata`。所有 parts API 请求先过登录认证，未认证返回 401。

### config getdata/setdata 惯例

前端与插件通信的通用约定：

- `GET  /api/parts/plugins:<名>/config/getdata` → `interfaces.config.GetData()`
- `POST /api/parts/plugins:<名>/config/setdata` → `interfaces.config.SetData(data)`

`data._action` 字段用于区分动作类型（读文件/写配置/触发操作……），一个 SetData 分发多种操作。

### 安全敏感配置必须注册 owner 闸

多用户部署下，`config/setdata` 任何登录用户都能调。如果你的配置项写的是**进程级全局安全态**（开关沙箱、允许执行命令、改工作区根……），必须在 `security_policy.mjs` 的安全敏感写清单里注册——框架会在路由 seam 上强制仅 owner 可写（大小写变体也被覆盖），否则任一注册用户可翻你的开关（RCE/沙箱逃逸面）。

### 用户数据隔离

多用户场景下插件配置和数据按用户隔离：用用户数据目录存盘，或用 AsyncLocalStorage 实现 per-user 上下文（beilu-files 的做法）。注意 GetPrompt/ReplyHandler 的 `args.username` 是隔离键来源。

## 四、怎么链接：外部应用接入

外部程序（游戏、脚本、第三方工具）不走插件，走 **`/api/v1` 外部接口**：

1. 设置 → 外部应用集成 → 新建 API Key（选择权限 scope，Key 只显示一次）
2. REST 调用：`Authorization: Bearer <key>`，端点见 [API 端点参考](api-reference.md)（chat / characters / variables / memory / presets / worldbooks / tools / webhooks）
3. 实时桥接：`ws://host/api/v1/game/connect?chatId=<id>&token=<key>`——发 `{type:"send", content, sender}` 触发 AI 回复，自动收到流式 token 与消息事件
4. 出站推送：注册 Webhook 后，AI 回复完成时 HMAC 签名 POST 到你的 URL

外部输入会被消毒（剥不可见字符、转义协议标签、`<external_user>` 身份包裹）；跳过消毒需要单独的 `chat:raw` scope。危险操作（删对话/改预设）需要 `X-Beilu-Confirm: true` 确认头。

## 用户插件 (beilu-plugin-host)

通过 beilu-plugin-host，用户可以在运行时加载自定义插件脚本（Python / Node / 任意可执行文件），无需重启整个服务。5 分钟跑通的步骤见上方「三条路，选一条 → 路径二」，这里补完整的运行机制和安全边界。

### 谁负责什么

| 谁负责 | 做什么 |
|---|---|
| 你的脚本 | 干活（读文件、查数据、调用外部 API……），算出结果后 `POST /api/user-plugins/<id>/push` 推给主程序 |
| 宿主（beilu-plugin-host） | 扫描 `user-plugins/` 目录、按 `plugin.json` 里的 `runtime` 配置拉起子进程、把推送内容在下一轮 `GetPrompt` 时注入提示词、进程退出/重载时清理 |

`plugin.json` 的 `runtime.type` 支持三种：

- `python`——如果同目录下有依赖文件（`runtime.deps` 指定文件名，如 `requirements.txt`），宿主会先自动 `pip install -r` 再启动
- `node`
- `executable`——任意可执行文件

不写 `runtime` 字段则只注册不启动子进程（内容由别的机制触发注入的场景）。

### 脚本怎么把内容送进 AI 的提示词

宿主启动你的脚本时会追加三个命令行参数：`--port <本插件分配的端口> --main-port <主程序端口> --token <认证令牌>`。脚本把想让 AI 看到的内容 POST 到：

```
POST http://127.0.0.1:<main-port>/api/user-plugins/<你的插件id>/push
Header: X-Plugin-Token: <token>
Body: { "content": "...", "hook_target": "GetPrompt", "position": "system_bottom", "ttl": 60000 }
```

这条推送接口**只认本机（localhost）请求 + 你脚本拿到的 token**，外部网络请求进不来。推送的内容会在下一轮对话的 `GetPrompt` 阶段被消费并清空（有 TTL，默认 60 秒过期未消费则丢弃，不会陈旧堆积）。

### 管理面板能做什么

用户插件的管理端点走 `config/getdata` / `config/setdata`（同「三、怎么链接：接入前端」的惯例）：

- 查看所有已注册用户插件的状态（运行中 / 已停止 / 出错）
- `_action: "reload"`——重新扫描目录并加载新增/修改的插件，不用重启服务
- `_action: "start"` / `"stop"`——单独启停某个插件
- `_action: "push"`——脚本推送数据的另一条内部通路（供框架内部中转，脚本自己走上面的 HTTP 端点即可）

### 安全提醒

- **本地单用户部署**：默认放行，你自己的机器、自己放的脚本，随便跑
- **多用户 server 部署**：默认**不会**自动启动任何用户脚本的子进程——防止某个注册用户的目录被服务端自动拉起，变成远程代码执行入口。owner 需要在安全中心显式开启（或设环境变量 `BEILU_USER_PLUGIN_SPAWN=on` / 配置 `allowUserPluginSpawn: true`）才会放行
- 这和 [MCP 外部工具](../yonban/mcp.md) 里"命令型服务器需要批准"是同一套哲学：会在你电脑上跑任意程序的动作，默认拦下来，你说了算

## 调试

- `BEILU_DIAG=<模块名>` 环境变量开启诊断日志
- whitebox 追踪（wbTrace / wbDetect）记录关键事件，错误面板可见
- fakeSend（token 预览）模式测试 GetPrompt / TweakPrompt 输出，不真实发送

## 导航

- [插件概览](../plugins/overview.md) — 现有插件列表
- [MCP 外部工具](../yonban/mcp.md) — 零代码接入已有 MCP 服务器
- [消息管线](message-pipeline.md) — 插件在管线中的位置
- [系统架构](architecture.md) — 整体架构
- [API 端点参考](api-reference.md) — 端点接口
