# config/ — 本目录刻意为空（T2 执行时按实况裁剪，不是"没做"）

T2 config 收口（2026-07-02 完成）的真实落位：

- **前端镜像三文件**：`src/public/parts/shells/beilu-chat/public/src/config/{ports,paths,defaults}.mjs`（脚本生成，禁手改）
- **生成脚本**：`tools/extract_config_ports.mjs`（从后端权威源抽值，storage-keys.mjs 同款范式）
- **后端权威源**：既有文件即权威（如 `core/transport/ideClient.mjs` DEFAULT_PORT=8931），不另建镜像层——18931/19000 经实测判不存在/零消费不收（T2 完成记录）

改端口/默认值 → 改后端权威源 → 跑生成脚本同步前端镜像。

⚠ 判断"config 收口做没做"以上述落位 + grep 散落常量清零为准，不以本目录空/非空为准。
