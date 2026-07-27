// main.mjs — P 型 re-export 薄壳（T3e·memory 组迁移，2026-07-02）
// 实现体已迁：src/yonban/core/functions/memory/main.mjs（beilu-memory 插件入口 Facade：Load/Unload/interfaces）。
// parts_loader 按 partpath 加载 plugins/beilu-memory/main.mjs → 经本壳到达实现体（default 导出为插件对象）。
// 部件元数据（info.json / beilu-part.json / default_memory_presets.json）留本目录不迁；实现体对其 import 指回本位。
// 原 main.mjs 无 named export（只 export default），故壳只转发 default。P 型壳永不删（part 入口物理位约定）。
export { default } from "../../../../yonban/core/functions/memory/main.mjs";
