/**
 * main.mjs — 兼容 re-export 薄壳（live 插件，实现体在 yonban functions 域）。
 *
 * 实现体：src/yonban/core/functions/live/main.mjs（直播弹幕接入引擎：
 *   config GetData/SetData per-user 存储 + HTTP getdata/setdata 端点）。
 * 用户配置数据 data/users/<user>/live/config.json（per-user，实现体内 configFileFor 定位）。
 * P 型薄壳（walkBeiluPartFiles 认本目录 beilu-part.json + GetPartPath 硬映射）——永不删。
 */
export { default } from "../../../../yonban/core/functions/live/main.mjs";