/**
 * main.mjs — 兼容 re-export 薄壳（T3a·3.4 regex 组迁移，2026-07-02，按 B1_regex_归档任务.md）
 *
 * 实现体已迁：src/yonban/core/functions/regex/main.mjs（正则脚本引擎：TweakPrompt dl0 / ReplyHandler /
 * setdata CRUD / importFromSTFormat；适配=info.json、regexCore、CONFIG_FILE 三处指回原位）。
 * 用户规则数据 config_data.json 仍在本目录（数据不迁）。
 * P 型薄壳（walkBeiluPartFiles 认本目录 beilu-part.json + GetPartPath 硬映射）——永不删。
 */
export { default } from "../../../../yonban/core/functions/regex/main.mjs";
export { importFromSTFormat } from "../../../../yonban/core/functions/regex/main.mjs";
