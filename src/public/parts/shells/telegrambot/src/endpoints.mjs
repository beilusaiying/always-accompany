import * as botModule from './bot.mjs'
import { createBotEndpoints } from '../../../../../scripts/botContentShared.mjs'

// [0716 P1 件8] 13 标准端点收口 createBotEndpoints（botContentShared）——原 9 壳同构实现纯删
//（空白归一 diff 实证语义同构）。活跃会话端点统一 /activechannels（凛倾拍板 discord 系命名；
// 原 activechats 与前端 getActiveChannels 拼名不符=监控面板恒 404，0716 确诊一并修复）。
export const setEndpoints = createBotEndpoints('telegrambot', {
	botModule,
	getBotInterface: botModule.getBotTelegramInterface,
})
