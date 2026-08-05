# 启动链路与 P1 更新修复

## 用户目标

- 后端启动后再打开前端，启动前在控制台检查并完成代码更新。
- 删除前端/运行中更新入口，避免启动后再走复杂的更新链。
- 修复 P1 长时间停在 Initialize 2/5、`getData` 与 `getRunLogInfo` 30 秒超时，确保安装依赖后能继续启动 Python。

## 链路证据

`PowerShell 启动器 → 依赖完整性检查 → Deno server → p1 serviceRuntime → Python p1_server → /health,/getData`。
前端只通过 `sendAction → shells:p1 → requestP1Service` 访问服务。

## 根因

`serviceRuntime.mjs` 原先先执行 Python 依赖安装，再创建 `data/p1` 运行目录；依赖安装成功后写入 `.p1-deps-installed` 会因父目录不存在而静默失败，导致每次重启重复执行 pip，阻塞 P1 服务进入可连接状态。前端 30 秒超时是该启动阻塞的下游表现；readiness 未认证、8931 token 和 9222 浏览器连接是独立告警。

更新职责原先由服务启动后的 `autoupdate.mjs` 定时检查并向前端发布状态。目标控制流改为：PowerShell 启动器依赖安装完成后 → 启动前检查/确认/安全快进 → 启动 Deno；运行时更新调度关闭。

## 完成标准

1. P1 运行目录在依赖安装前建立，安装标记可持久写入并在后续启动跳过 pip。
2. 启动器在 `Start-Server` 前完成更新检查；本地有未提交改动或非快进时不覆盖用户文件。
3. 服务运行期间不再由 `autoupdate.mjs` 设置检查定时器或向前端提供可执行更新任务。
4. 通过语法、契约和回归测试；不触碰用户 data 与未相关工作区改动。

## 验证方案

- `node --check`：改动的 MJS。
- PowerShell 解析检查。
- P1 目录顺序与启动更新契约静态测试。
- 依赖导入与工作区状态检查；真实服务启动需在用户环境中复测。
