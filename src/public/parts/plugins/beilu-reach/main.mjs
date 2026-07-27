/**
 * main.mjs — P 型薄壳 re-export（beilu-reach 平台触达插件）
 *
 * 实现体：src/yonban/core/functions/reach/main.mjs
 * 本壳保证 part 加载链不断：walkBeiluPartFiles 认本目录 beilu-part.json + GetPartPath('plugins/beilu-reach') →
 * 本文件 default 导出 part 对象。P 型薄壳永不删（GetPartPath 硬映射要求）。
 */
export { default } from "../../../../yonban/core/functions/reach/main.mjs";
