/**
 * main.mjs — 兼容 re-export 薄壳（T3a·3.7 screenshot 组迁移，2026-07-02）
 * 实现体已迁：src/yonban/core/functions/screenshot/main.mjs（eye 子进程管理：Python 截图 3s 自启 +
 * Electron 桌宠 + 4s reconcile + _pythonToken 令牌闸；projectRoot 5 级回溯新旧位相同零适配，
 * 唯一适配=info.json 指回原位）。P 型薄壳（beilu-part.json + GetPartPath('plugins/beilu-eye')）——永不删。
 */
export { default } from "../../../../yonban/core/functions/screenshot/main.mjs";
