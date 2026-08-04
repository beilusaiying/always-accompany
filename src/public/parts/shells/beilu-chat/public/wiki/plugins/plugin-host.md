# 用户插件宿主（beilu-plugin-host）

beilu-plugin-host 让外部 Python、Node 或独立程序把数据接入下一轮 AI 提示词。它适合连接传感器、本地服务和已有脚本，但本质上具有启动子进程与注入内容的能力，必须按部署模式控制权限。

## 它替你省掉什么

如果没有插件宿主，每接一个外部程序都要自己重做：

- 进程启动与停止；
- 端口分配；
- 插件身份认证；
- 状态与错误查询；
- 外部数据进入哪一轮提示词；
- 插件卸载时的进程清理。

宿主把这些公共部分收口，让外部程序只关注产生什么数据。

## 默认状态与目录

beilu-plugin-host 在新用户 defaultParts 中。加载时，它按当前用户扫描：

    data/users/<user>/user-plugins/

每个子目录必须包含 plugin.json。缺少 id、JSON 无法解析或 runtime 不支持时会跳过并记录错误。

最小 Node 运行时清单示例：

~~~json
{
  "id": "my-sensor",
  "name": "My Sensor",
  "runtime": {
    "type": "node",
    "entry": "index.js"
  }
}
~~~

支持的 runtime.type：

| 类型 | 启动方式 | 额外字段 |
|---|---|---|
| python | Windows 使用 python，其他系统使用 python3 | entry；可选 deps 指向 requirements.txt |
| node | 使用 node 启动 | entry |
| executable | 直接启动目录内可执行文件 | entry |

宿主启动外部程序时会追加 port、main-port 和 token 参数。外部程序不应把 token 写入日志或持久化到公开位置。

## 本地与 server 模式不同

- **local 单用户模式**：owner 自己放入的用户插件允许按设计启动；
- **server 多用户模式**：用户插件子进程默认禁止，防止服务器任意命令执行和跨账号影响；
- server 模式只有实例 owner 显式开启 allowUserPluginSpawn 或设置 BEILU_USER_PLUGIN_SPAWN=on 后才允许启动。

不要为了“插件能跑”在 server 上全局放开权限。先确认插件来源、用户边界、运行账号、可访问目录和网络能力。

## 数据怎样进入 AI

    外部插件产生内容
      ↓ localhost POST + plugin token
    /api/user-plugins/<id>/push
      ↓ pending injection（默认 TTL 60 秒）
    beilu-plugin-host GetPrompt
      ↓ 一次性消费
    下一轮 AI 请求

push 请求至少包含 content，可选 hook_target、position 和 ttl。端点只接受 localhost，并验证启动时生成的插件 token。

待注入内容是一次性消费：进入一轮 GetPrompt 后即清除；超过 TTL 也会丢弃。这适合“最新传感器读数”或“刚发生的外部事件”，不应替代长期持久化。

## 状态与操作

插件管理接口可以读取：

- id 与显示名；
- stopped、starting、running、blocked 或 error 状态；
- 错误信息；
- 分配端口；
- 是否存在待注入数据；
- manifest 声明的 hooks。

SetData 支持 start、stop 和 push 等动作。停止或卸载时，宿主应终止对应子进程并释放端口。

## 它与内置插件开发不是同一件事

| 内置插件接口 | 用户插件宿主 |
|---|---|
| 直接实现 GetPrompt、TweakPrompt、ReplyHandler 等框架接口 | 外部进程通过 localhost push 把数据交给宿主 |
| 位于源码 parts/plugins 中 | 位于用户数据目录 user-plugins 中 |
| 与主程序在同一插件加载体系中 | 可以有独立运行时和进程 |
| 适合深度参与框架管线 | 适合接已有程序、传感器与服务 |

需要直接开发内置接口时，请看[插件开发](../developer/plugin-dev.md)。不要把两种插件的部署和安全假设混用。

## 适合组合的场景

- 本地传感器 + Chat / companion；
- 自定义抓取器 + Work；
- 专用知识服务 + memory；
- 游戏状态服务 + MVU / AIRP；
- 企业内部接口 + Bot（需单独设计用户和权限边界）。

## 常见问题

### 目录里有插件但状态列表没有

确认 plugin.json 可解析且包含 id，目录位于当前用户而不是其他用户的 user-plugins 下，然后查看 Load 日志。

### server 模式显示 blocked

这是安全默认，不是启动故障。只有实例 owner 在评估风险后才能开启子进程权限。

### push 返回 401

确认请求来自宿主实际启动的进程，并使用本次启动下发的 token。重启后不要复用旧 token。

### 数据没有进入下一轮

检查插件是否 running、push 是否在 localhost 成功、content 是否非空、TTL 是否过期，以及数据是否已经被上一轮 GetPrompt 一次性消费。

## 继续阅读

- [插件开发接口](../developer/plugin-dev.md)
- [安全中心](../security/overview.md)
- [插件手册](overview.md)
