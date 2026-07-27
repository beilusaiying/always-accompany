// [yonban T3d re-export 薄壳] beilu-worldbook 实现体已迁入 functions/prompt/worldbook/main.mjs（组2 prompt）。
//
// why：随 prompt 组集中。parts_loader 发现旧位壳 → 转新位实现；config_data.json（282KB 用户世界书条目）
//   留旧位，新位 __pluginDir 路径锚回此目录。
// 导出面（1668/1674）：default(pluginExport 含 interfaces.chat.GetPrompt/TweakPrompt) + named convertSTEntries
//   （被 beilu-home import-char 磁盘 fallback 复用，单一权威源）→ 两者都要转发。
// 【P 型永不删】：parts_loader 按约定加载此 main.mjs，壳是永久入口。
export { default } from "../../../../yonban/core/functions/prompt/worldbook/main.mjs";
export { convertSTEntries } from "../../../../yonban/core/functions/prompt/worldbook/main.mjs";
