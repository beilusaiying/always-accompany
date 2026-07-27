// re-export 薄壳（T3c·api 组迁移，2026-07-02）——P 型 part 入口永不删（GetPartPath 硬映射要求）。
// 实现体已迁：src/yonban/core/functions/api/claude/main.mjs（唯一逻辑适配=info.json/prompt_struct/serviceSources 回指旧位或按新位级数重算，已 deno check 验证）。
// part loader（serviceGenerators/AI/main.mjs → GetPartPath）仍加载本文件为 part 入口；本壳原样导出新位 default（AIsource part 对象）。
// 【why】凛倾迁移范式：相关文件移进去、写 index.mjs 做 facade、旧位留 re-export 兼容；P 型 main.mjs + beilu-part.json 留原位保发现链。
export { default } from '../../../../../yonban/core/functions/api/claude/main.mjs'
