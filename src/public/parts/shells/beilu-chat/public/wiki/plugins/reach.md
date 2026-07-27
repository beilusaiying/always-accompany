# 平台触达 (beilu-reach)

beilu-reach 让 AI 获取 13 个互联网平台的结构化数据——比通用网页抓取更深层（API/CLI 级数据而非 HTML 正文）。AI 通过 `<reach>` 标签调用，结果注入下一轮对话。

## 三条触发路径

```
① AI 主动调用：回复中写 <reach platform="..." action="...">query</reach>
② 搜索自动路由：搜索词含 site:已知平台域名 → 自动补充该平台结构化结果
③ URL 智能提取：<browse> 一个已知平台 URL → 优先用平台适配器取结构化数据，失败降级通用抓取
```

## 标签格式

```xml
<reach platform="v2ex" action="hot">latest</reach>
<reach platform="github" action="search-repos" limit="5">AI agent</reach>
<reach platform="bilibili" action="video">BV1xx411c7mD</reach>
```

## 平台一览

| 平台 | 操作 | 后端 | 配置 |
|------|------|------|------|
| V2EX | hot / node / topic / user | 公开 API | 零配置 |
| RSS/Atom | read | 原生解析 | 零配置 |
| Jina Reader | read | r.jina.ai | 零配置 |
| GitHub | search-repos / search-code / repo / issues / prs | gh CLI | Token 可选（提升限额） |
| YouTube | info / subtitle / search | yt-dlp | Cookie 来源浏览器可选 |
| Bilibili | search / video / hot / rank | bili-cli / opencli / 公开 API | SESSDATA 可选 |
| Twitter/X | search / read / user / feed | twitter-cli / opencli | Cookie |
| Reddit | search / read / subreddit / hot | opencli / rdt-cli | — |
| 小红书 | search / note / comments / feed | opencli / mcporter | Cookie |
| 雪球 | quote / search-stock / hot-posts / hot-stocks | 公开 API | Cookie（xq_a_token） |
| Facebook | search / profile / feed | opencli | — |
| Instagram | search / profile / user / explore | opencli | — |
| LinkedIn | profile / search-people / search-jobs / company | mcporter / Jina | — |

面板的「平台状态」卡实时探测各平台工具可用性（每个平台的实际操作与后端以状态卡为准——单一来源是后端注册表）。

## 配置

「额外插件 → 平台触达」面板：

- **基础开关**：总开关 / 搜索平台路由 / URL 智能提取
- **平台凭据**：各平台 Cookie / Token（只在服务端请求平台时使用，不会出现在 AI 上下文里）
- **网络与安全**：CLI 代理地址、命令超时、平台白名单（限制 AI 可用的平台范围）

配置改动即时同步后端并落盘，重启不丢。

## 安全

- **SSRF 防护**：AI 传入的 URL 型参数（订阅源地址、视频链接等）经统一出站安全校验，私网/回环/云元数据地址一律拒绝。
- **内容边界**：平台返回内容注入 AI 前经不可信内容边界处理（尖括号中性化 + nonce 边界标注），阻断平台内容对 AI 的间接指令注入。
- **凭据隔离**：Cookie/Token 只在适配器内部用于请求，不进入 AI 可见上下文。
- **命令注入防护**：外部 CLI 一律参数数组调用，不经 shell。

## 能力引导

AI 的 `<reach>` 用法说明走注入文本配置链（`reach.capabilities` 键），可在设置的注入文本编辑器中修改；可用平台列表由后端实时探测动态生成，不随文案固化。
