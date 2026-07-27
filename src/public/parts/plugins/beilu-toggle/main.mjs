// [yonban T3d re-export 薄壳] beilu-toggle 实现体已迁入 functions/prompt/toggle/main.mjs（组2 prompt）。
//
// why：随 prompt 组集中。parts_loader 发现旧位壳 → 转新位实现。toggle 翻转经动态 import preset 组内单例
//   持久化（新位已改指 ../preset/main.mjs，同一 ESM 模块实例，engine 单例身份不变）。
// 导出面（61）：default(内联对象含 interfaces.chat.GetPrompt + ReplyHandler <toggle> 翻转)，无 named。
// 【P 型永不删】：parts_loader 按约定加载此 main.mjs，壳是永久入口。
export { default } from "../../../../yonban/core/functions/prompt/toggle/main.mjs";
