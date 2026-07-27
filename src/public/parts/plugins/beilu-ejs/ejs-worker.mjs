// ejs-worker.mjs — 兼容副作用 import 薄壳（T3a·3.3 sandbox 组迁移，2026-07-02）
// 实现体已迁：src/yonban/core/functions/sandbox/ejs-worker.mjs（权限全关 Worker 沙箱入口，一字未改）。
// Worker 入口靠副作用（self.onmessage 注册）——本壳 import 新位即在 worker 上下文执行同一注册，行为等价。
// 唯一起点是本组 main.mjs（已指新位同目录），本壳兜底未知的旧 URL 引用。T8 举证后删。
import "../../../../yonban/core/functions/sandbox/ejs-worker.mjs";
