// [yonban T3d re-export 薄壳] beilu-mvu 实现体已迁入 functions/prompt/mvu/main.mjs（组2 prompt）。
//
// why：随 prompt 组集中。parts_loader 发现旧位壳 → 转新位实现。mvu 数据经 setDefaultPart(username,
//   "plugins","beilu-mvu") 按 part 名 keyed 落盘，与文件物理位置无关。
// 导出面（827）：default(pluginExport 含 interfaces.chat.GetPrompt/TweakPrompt + ReplyHandler 解析变量命令)，无 named。
// 【P 型永不删】：parts_loader 按约定加载此 main.mjs，壳是永久入口。
export { default } from "../../../../yonban/core/functions/prompt/mvu/main.mjs";
