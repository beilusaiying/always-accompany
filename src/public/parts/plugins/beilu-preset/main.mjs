// [yonban T3d re-export 薄壳] beilu-preset 实现体已迁入 functions/prompt/preset/main.mjs（组2 prompt）。
//
// why：yonban 迁移把「通用无状态后端功能库」集中到 core/functions/<组>/，preset 归 prompt 组。
//   本文件保留为薄壳——parts_loader 仍按约定发现旧位 main.mjs，壳 re-export 新位实现，
//   使消费方（prompt_struct 经 parts_loader 拿 interfaces、beilu-toggle 动态 import 拿单例 engine）零改动。
// 关联链：新位 preset/main.mjs 的 import.meta 路径锚回旧位 → config.json/registry.json/presets/ 用户数据仍在此目录。
// 影响范围：pluginExport（default）含 interfaces.chat.GetPrompt/TweakPrompt + interfaces.config.GetData/SetData。
//   preset 无 named export（2320 仅 export default），故壳只转 default。
// 【P 型永不删】：info.json 无 main 字段，parts_loader 按约定加载此 main.mjs——壳是永久入口，删则 part 加载失败。
export { default } from "../../../../yonban/core/functions/prompt/preset/main.mjs";
