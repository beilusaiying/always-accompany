// 桥接文件：chat Shell 已被 beilu-chat 替代，此文件保留仅为兼容其他模块的 import 路径。
// 框架硬化（2026-06-08）：原手写 `export { 4符号 } from`——若源端改名/删除会抛 SyntaxError 崩全部
// AI 生成器（与 chat.mjs 同类病）。改 `export *` 自动透传：源端增删自动同步，缺失也只是软失败不崩。
export * from '../../beilu-chat/src/prompt_struct.mjs';

