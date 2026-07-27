/**
 * main.mjs — 兼容 re-export 薄壳（T3a·3.3 sandbox 组迁移，2026-07-02）
 *
 * 实现体已迁：src/yonban/core/functions/sandbox/main.mjs（EJS 沙箱 part：TweakPrompt dl=0 渲染 +
 * SetData sandboxOptOut；唯一适配 = info.json import 指回本目录）。
 * 本壳保证 part 加载链不断：GetPartPath('plugins/beilu-ejs') → 本文件 default 导出 part 对象。
 * partpath 字符串 'plugins/beilu-ejs'（security_policy.mjs:38 owner 闸键）不变。
 * 删除条件（T8）：本壳是 part 入口薄壳——按对照表 P 型永不删（GetPartPath 硬映射要求）。
 */
export { default } from "../../../../yonban/core/functions/sandbox/main.mjs";
