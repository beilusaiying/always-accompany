# frontend/ — X 型逻辑锚点（本目录刻意为空，不是"没做"）

真实前端四分区落位在 `src/public/parts/shells/beilu-chat/public/src/`（config / panels 12 组 / shared 8 子域 / stCompat）。

**为什么不搬进这里**：浏览器静态可达性约束——前端文件必须留在 shell public 下才能被 web server 服务（`_骨架路径对照表.md` §三，T0 裁定）。本目录仅作 yonban 骨架树完整性锚点。

T6 6c 四分区搬迁已于 2026-07-03 收官（全库旧路径清零 + 终版探针 10/10），见
`beilu的工作日志和项目日志/项目文档/任务md/yonban迁移任务集_20260702/00_索引.md` T6 行。

⚠ 判断"前端搬迁做没做"以 `<FE>/src/` 实况为准，不以本目录空/非空为准（2026-07-08 曾因此误报"阶段6未做"）。
