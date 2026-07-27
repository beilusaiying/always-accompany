// [yonban T3d re-export 薄壳] beilu-sysinfo 实现体已迁入 functions/prompt/sysinfo/main.mjs（组2 prompt）。
//
// why：随 prompt 组集中。parts_loader 发现旧位壳 → 转新位实现。配置持久化于 data/beilu-sysinfo-settings.json（0710 补）。
// 导出面（126）：default(内联对象含 interfaces.chat.GetPrompt env 上下文注入)，无 named。
// 【P 型永不删】：parts_loader 按约定加载此 main.mjs，壳是永久入口。
export { default } from "../../../../yonban/core/functions/prompt/sysinfo/main.mjs";
