/**
 * main.mjs — 兼容 re-export 薄壳（T3a·3.8 web 组迁移，2026-07-02）
 *
 * 实现体已迁：src/yonban/core/functions/web/main.mjs（联网指令解析 part；适配=info.json 指回本目录 +
 * webSearch 动态 import 改同组文件）。
 * 本壳保证 part 加载链不断：walkBeiluPartFiles 认本目录 beilu-part.json + GetPartPath('plugins/beilu-web') →
 * 本文件 default 导出 part 对象。P 型薄壳永不删（GetPartPath 硬映射要求）。
 */
export { default } from "../../../../yonban/core/functions/web/main.mjs";
